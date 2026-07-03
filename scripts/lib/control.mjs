import { TERMINAL_STATUSES } from "./constants.mjs";

export function defaultControl(overrides = {}) {
  return {
    status: "continue",
    confidence: "medium",
    agreements: [],
    pushbacks: [],
    improvements: [],
    open_questions: [],
    evidence_used: [],
    evidence_requests: [],
    concessions: [],
    ready_to_converge: false,
    operator_intervention_points: [],
    next_prompt_suggestion: "",
    ...overrides
  };
}

export function normalizeControl(control = {}) {
  const normalized = defaultControl(control);
  for (const key of [
    "agreements",
    "pushbacks",
    "improvements",
    "open_questions",
    "evidence_used",
    "evidence_requests",
    "concessions",
    "operator_intervention_points"
  ]) {
    normalized[key] = Array.isArray(normalized[key]) ? normalized[key] : [];
  }
  if (!TERMINAL_STATUSES.has(normalized.status) && normalized.status !== "continue") {
    normalized.status = "continue";
  }
  normalized.ready_to_converge = Boolean(normalized.ready_to_converge);
  return normalized;
}

export function parseParticipantOutput(output, { nonce } = {}) {
  if (output && typeof output === "object" && !Buffer.isBuffer(output)) {
    return {
      message: String(output.message || ""),
      control: normalizeControl(output.control || {}),
      evidence: Array.isArray(output.evidence) ? output.evidence : []
    };
  }
  const text = String(output || "");
  const parsed = tryJson(text);
  if (parsed) {
    return parseParticipantOutput(parsed, { nonce });
  }
  if (nonce) {
    const pattern = new RegExp(`<<<CONVERGE_LOOP_CONTROL ${escapeRegex(nonce)}>>>([\\s\\S]*?)<<<END_CONVERGE_LOOP_CONTROL ${escapeRegex(nonce)}>>>`, "g");
    let match;
    let last = null;
    while ((match = pattern.exec(text)) !== null) {
      last = match[1].trim();
    }
    if (last) {
      const control = tryJson(last);
      if (control) {
        return {
          message: text.replace(pattern, "").trim(),
          control: normalizeControl(control),
          evidence: []
        };
      }
    }
  }
  return {
    message: text.trim(),
    control: normalizeControl(),
    evidence: []
  };
}

export function hasProgress(control) {
  const c = normalizeControl(control);
  return Boolean(
    c.status !== "continue" ||
    c.ready_to_converge ||
    c.agreements.length ||
    c.pushbacks.length ||
    c.improvements.length ||
    c.open_questions.length ||
    c.evidence_used.length ||
    c.evidence_requests.length ||
    c.concessions.length ||
    c.operator_intervention_points.length
  );
}

export function hasMaterialPushback(control) {
  const c = normalizeControl(control);
  return Boolean(
    c.pushbacks.length ||
    c.improvements.length ||
    c.evidence_requests.length ||
    c.open_questions.length ||
    c.operator_intervention_points.length
  );
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
