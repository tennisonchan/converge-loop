import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RESULT_SCHEMA, TERMINAL_STATUSES } from "./constants.mjs";
import { buildParticipants, getAdapter, preflightParticipants } from "./adapters.mjs";
import { hasMaterialPushback, hasProgress, normalizeControl, parseParticipantOutput } from "./control.mjs";
import { nowIso, sha256 } from "./util.mjs";

export async function runSession({ store, options, stdout, env, sessionId = null, resume = false, signal = null }) {
  const participants = resume
    ? store.loadSession(sessionId).participants
    : buildParticipants(options, env);
  const preflight = preflightParticipants(participants, options, env);
  let session;
  if (resume) {
    session = store.loadSession(sessionId);
    const resumedFrom = session.state;
    session.state = "running";
    session.options = { ...session.options, ...options, resumed_from: resumedFrom };
    store.writeSession(session);
    store.writeTranscript(session.id, `\n## Resume ${nowIso()}\n\n`);
  } else {
    session = store.createSession({
      sessionId: options.sessionId || sessionId || undefined,
      cwd: options.cwd,
      options,
      participants
    });
  }

  if (!preflight.ok) {
    const result = buildResult({
      session,
      participants,
      status: "blocked",
      summary: `Cannot start converge-loop: ${preflight.reason}`,
      turnCount: store.readTurns(session.id).length,
      agreements: [],
      improvements: [],
      remainingDisagreements: [preflight.reason],
      evidenceSummary: summarizeEvidence([])
    });
    finishSession({ store, session, result, conclusion: result.summary });
    printResult(stdout, options, result);
    return result;
  }

  const adapters = new Map(preflight.checked.map((entry) => [entry.participant.id, entry.adapter]));
  const startTurn = store.readTurns(session.id).length;
  const deadline = Date.now() + options.maxMinutes * 60_000;
  const allEvidence = [];
  const agreements = [];
  const improvements = [];
  const pushbacks = [];
  let noProgressCount = 0;
  let result = null;

  const onCancel = () => {
    if (!result) {
      result = buildResult({
        session,
        participants,
        status: "canceled",
        summary: "Session canceled.",
        turnCount: store.readTurns(session.id).length,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      finishSession({ store, session, result, conclusion: result.summary });
    }
  };
  if (signal) {
    signal.addEventListener("abort", onCancel, { once: true });
  }

  for (let turnIndex = startTurn; turnIndex < options.maxTurns; turnIndex += 1) {
    if (result) break;
    if (signal?.aborted) break;
    if (Date.now() > deadline) {
      result = buildResult({
        session,
        participants,
        status: "timeout",
        summary: "Session reached the configured wall-clock timeout.",
        turnCount: turnIndex,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }

    const participant = participants[turnIndex % participants.length];
    const adapter = adapters.get(participant.id) || getAdapter(participant.adapter, env);
    const nonce = randomBytes(6).toString("hex");
    const transcript = store.readTurns(session.id);
    const prompt = buildTurnPrompt({ options, participant, transcript, nonce });
    let parsed;
    try {
      const raw = await adapter.invoke({ participant, turnIndex, options, transcript, prompt, nonce });
      if (raw?.violation) {
        parsed = {
          message: raw.message || "Adapter reported a read-only enforcement violation.",
          control: normalizeControl({ status: "blocked" }),
          evidence: raw.evidence || [],
          violation: raw.violation
        };
      } else {
        parsed = parseParticipantOutput(raw, { nonce });
      }
    } catch (error) {
      parsed = {
        message: `Adapter failed: ${error.message}`,
        control: normalizeControl({ status: "blocked" }),
        evidence: [],
        violation: { type: "adapter_failure", detail: error.message }
      };
    }
    if (result) break;

    const control = normalizeControl(parsed.control);
    const evidence = normalizeEvidence(parsed.evidence, {
      turnIndex,
      participant,
      control
    });
    allEvidence.push(...evidence);
    for (const item of evidence) {
      store.appendEvidence(session.id, item);
    }
    agreements.push(...control.agreements);
    improvements.push(...control.improvements);
    pushbacks.push(...control.pushbacks);

    const turn = {
      session_id: session.id,
      turn_index: turnIndex,
      at: nowIso(),
      participant_id: participant.id,
      participant_role: participant.role,
      adapter: participant.adapter,
      message: parsed.message,
      control,
      evidence,
      violation: parsed.violation || null
    };
    store.appendTurn(session.id, turn);
    store.writeTranscript(session.id, renderTurn(turn, options.output));
    session.current_turn_index = turnIndex + 1;
    store.writeSession(session);
    if (options.backgroundChild) {
      const job = store.loadJob(session.id);
      if (job) {
        store.writeJob(session.id, { ...job, status: "running", last_heartbeat_at: nowIso() });
      }
    }
    printTurn(stdout, options, turn);

    if (parsed.violation) {
      result = buildResult({
        session,
        participants,
        status: "blocked",
        summary: `Read-only enforcement violation: ${parsed.violation.detail || parsed.violation.type}`,
        turnCount: turnIndex + 1,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }

    if (control.evidence_requests.length && control.ready_to_converge) {
      result = buildResult({
        session,
        participants,
        status: "needs_evidence",
        summary: "A participant requested evidence during convergence.",
        turnCount: turnIndex + 1,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }

    if (control.status === "agreed" && turnIndex + 1 < participants.length) {
      noProgressCount = 0;
      continue;
    }

    if (TERMINAL_STATUSES.has(control.status) && control.status !== "canceled") {
      result = buildResult({
        session,
        participants,
        status: control.status,
        summary: terminalSummary(control.status, control, options),
        turnCount: turnIndex + 1,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }

    if (control.ready_to_converge && !hasMaterialPushback(control) && turnIndex + 1 >= participants.length) {
      result = buildResult({
        session,
        participants,
        status: "agreed",
        summary: "Participants converged with no material pushback.",
        turnCount: turnIndex + 1,
        agreements,
        improvements,
        remainingDisagreements: [],
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }

    if (!hasProgress(control)) noProgressCount += 1;
    else noProgressCount = 0;
    if (noProgressCount >= participants.length) {
      result = buildResult({
        session,
        participants,
        status: pushbacks.length ? "clear_disagreement" : "blocked",
        summary: pushbacks.length
          ? "Participants repeated unresolved disagreements without new progress."
          : "No progress was detected and the system cannot determine the next useful move.",
        turnCount: turnIndex + 1,
        agreements,
        improvements,
        remainingDisagreements: pushbacks,
        evidenceSummary: summarizeEvidence(allEvidence)
      });
      break;
    }
  }

  if (!result) {
    result = buildResult({
      session,
      participants,
      status: "max_turns",
      summary: "Session reached the configured turn cap.",
      turnCount: options.maxTurns,
      agreements,
      improvements,
      remainingDisagreements: pushbacks,
      evidenceSummary: summarizeEvidence(allEvidence)
    });
  }
  finishSession({ store, session, result, conclusion: result.summary });
  printResult(stdout, options, result);
  return result;
}

function buildResult({ session, participants, status, summary, turnCount, agreements, improvements, remainingDisagreements, evidenceSummary }) {
  return {
    schema_version: RESULT_SCHEMA,
    status,
    summary,
    conclusion_path: "conclusion.md",
    turn_count: turnCount,
    host_agent: session.options.hostAgent || "codex",
    participants,
    independent_provider_coverage: independentCoverage(participants),
    fallbacks_used: participants.filter((p) => p.fallback_for),
    scope: session.options.scope,
    web_scope: session.options.web,
    output_mode: session.options.output,
    agreements: dedupe(agreements),
    pushbacks_resolved: [],
    remaining_disagreements: dedupe(remainingDisagreements),
    improvements: dedupe(improvements),
    operator_intervention_points: [],
    evidence_summary: evidenceSummary,
    recommended_next_actions: [],
    transcript_path: "transcript.md",
    evidence_ledger_path: "evidence-ledger.jsonl"
  };
}

function finishSession({ store, session, result, conclusion }) {
  session.state = result.status;
  session.completed_at = nowIso();
  store.writeSession(session);
  store.writeConclusion(session.id, `# Conclusion\n\n${conclusion}\n`);
  store.writeResult(session.id, result);
}

function buildTurnPrompt({ options, participant, transcript, nonce }) {
  return [
    `You are ${participant.role} in a converge-loop deliberation.`,
    `Topic: ${options.topic || "(none)"}`,
    options.focus ? `Focus: ${options.focus}` : "",
    `Return natural discussion plus a final control block for nonce ${nonce}.`,
    `Prior turns: ${transcript.length}`
  ].filter(Boolean).join("\n");
}

function normalizeEvidence(evidence, { turnIndex, participant, control }) {
  const fromControl = control.evidence_used.map((item) => ({ source: "self_reported", kind: "summary", detail: item }));
  return [...(Array.isArray(evidence) ? evidence : []), ...fromControl].map((item) => ({
    at: nowIso(),
    turn_index: turnIndex,
    participant_id: participant.id,
    participant_role: participant.role,
    source: item.source || "self_reported",
    kind: item.kind || "summary",
    path: item.path || null,
    url: item.url || null,
    query: item.query || null,
    detail: item.detail || item.message || "",
    hash: item.detail ? sha256(item.detail) : null
  }));
}

function summarizeEvidence(evidence) {
  return {
    observed: evidence.filter((item) => item.source === "observed"),
    self_reported: evidence.filter((item) => item.source !== "observed"),
    residual_asymmetry_risk: evidence.some((item) => item.source !== "observed") ? "medium" : "low"
  };
}

function renderTurn(turn, mode) {
  const heading = `## Turn ${turn.turn_index + 1}: ${turn.participant_role} (${turn.adapter})\n\n`;
  if (mode === "compact") {
    return `${heading}${turn.message}\n\nStatus: ${turn.control.status}\n\n`;
  }
  return `${heading}${turn.message}\n\n\`\`\`json\n${JSON.stringify(turn.control, null, 2)}\n\`\`\`\n\n`;
}

function printTurn(stdout, options, turn) {
  if (options.output === "quiet" || options.json) return;
  if (options.output === "verbose") {
    stdout.write(renderTurn(turn, "verbose"));
  } else {
    stdout.write(`turn ${turn.turn_index + 1} ${turn.participant_role}: ${turn.control.status}\n`);
  }
}

function printResult(stdout, options, result) {
  if (options.json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (options.output === "quiet") {
    stdout.write(`${result.status} ${result.transcript_path}\n`);
    return;
  }
  stdout.write(`result: ${result.status}\n${result.summary}\n`);
}

function terminalSummary(status, control, options) {
  if (status === "agreed") return `Participants agreed on ${options.topic || options.focus || "the topic"}.`;
  if (status === "clear_disagreement") return "Participants ended with a clear actionable disagreement.";
  if (status === "needs_evidence") return "More evidence is needed before convergence.";
  if (status === "operator_intervention") return "Operator intervention is needed.";
  if (status === "blocked") return "The session is blocked.";
  return `Session ended as ${status}.`;
}

function independentCoverage(participants) {
  const providers = new Set(participants.map((p) => p.provider));
  return providers.size === participants.length && !participants.some((p) => p.tier === "fallback");
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}
