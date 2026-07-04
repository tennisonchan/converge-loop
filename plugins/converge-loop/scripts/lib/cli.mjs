import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_RUN_OPTIONS, RESULT_SCHEMA, RESUMABLE_STATUSES } from "./constants.mjs";
import { checkLocalCliReadiness, localAdapterConfigPath, readLocalAdapterConfig, resolveHost, writeLocalAdapterConfig } from "./adapters.mjs";
import { runSession } from "./orchestrator.mjs";
import { StateStore } from "./state-store.mjs";
import {
  copyDir,
  createSessionId,
  gitRoot,
  hasWorkingTreeMaterial,
  isGitWorktree,
  nowIso,
  pathInside,
  processExists,
  resolveReadablePath,
  runGit
} from "./util.mjs";

export async function runCli(argv, io) {
  const command = argv[0] || "help";
  try {
    if (command === "run") return await runRun(argv.slice(1), io);
    if (command === "setup") return await runSetup(argv.slice(1), io);
    if (command === "status") return runStatus(argv.slice(1), io);
    if (command === "result") return runResult(argv.slice(1), io);
    if (command === "cancel") return runCancel(argv.slice(1), io);
    if (command === "resume") return await runResume(argv.slice(1), io);
    if (command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(helpText());
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function runSetup(args, io) {
  const options = parseSetupArgs(args);
  const hostAgent = resolveHost(io.env);
  const warnings = setupWarnings(io.env);
  if (options.disable) {
    const payload = {
      enabled: false,
      disabled_at: nowIso(),
      mode: "disable",
      host_agent: hostAgent,
      checks: {},
      read_only_controls: {
        codex: "sandbox-read-only",
        claude: "tool-denylist-plan-mode"
      }
    };
    writeLocalAdapterConfig(io.env, payload);
    const result = {
      ok: true,
      enabled: false,
      mode: "disable",
      host_agent: hostAgent,
      config_path: localAdapterConfigPath(io.env),
      checks: payload.checks,
      read_only_controls: payload.read_only_controls,
      verified_at: payload.disabled_at,
      smoke: { requested: false, ok: null, participants: [] },
      actions: [{ action: "write-config", status: "disabled" }],
      warnings,
      config_changed: true,
      next_step: "Local Codex and Claude adapters are disabled. Rerun `converge-loop setup` to enable them."
    };
    writeSetupResult(result, options, io);
    return 0;
  }

  const readiness = checkLocalCliReadiness(io.env);
  const verifiedAt = nowIso();
  const currentConfig = readLocalAdapterConfig(io.env);
  let enabled = readiness.ok;
  let smoke = { requested: options.smoke, ok: null, participants: [] };
  let ok = readiness.ok;
  if (options.smoke && readiness.ok) {
    smoke = await runSetupSmoke({ io, hostAgent });
    ok = readiness.ok && smoke.ok === true;
    enabled = ok;
  } else if (options.smoke && !readiness.ok) {
    smoke = { requested: true, ok: false, participants: [], reason: "readiness checks failed before smoke" };
    ok = false;
    enabled = false;
  }

  const result = {
    ok,
    enabled: options.checkOnly ? Boolean(currentConfig?.enabled) : enabled,
    mode: options.checkOnly ? "check-only" : "setup",
    host_agent: hostAgent,
    config_path: readiness.config_path,
    checks: readiness.checks,
    read_only_controls: readiness.read_only_controls,
    verified_at: verifiedAt,
    smoke,
    actions: [],
    warnings,
    config_changed: !options.checkOnly,
    next_step: ok
      ? (options.checkOnly
          ? "Checks passed. Rerun `converge-loop setup` without --check-only to enable local adapters."
          : "Run converge-loop normally; local Codex and Claude adapters are enabled by setup.")
      : "Install and authenticate Codex and Claude Code, then rerun `converge-loop setup`."
  };
  if (options.checkOnly) {
    result.actions = [];
    result.config_changed = false;
  } else {
    const payload = {
      enabled,
      verified_at: verifiedAt,
      mode: "setup",
      host_agent: hostAgent,
      checks: readiness.checks,
      read_only_controls: readiness.read_only_controls,
      smoke
    };
    writeLocalAdapterConfig(io.env, payload);
    result.actions = [{ action: "write-config", status: enabled ? "enabled" : "disabled" }];
  }
  writeSetupResult(result, options, io);
  return 0;
}

async function runSetupSmoke({ io, hostAgent }) {
  if (io.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE === "1") {
    return {
      requested: true,
      ok: false,
      participants: [],
      diagnostic_path: null,
      reason: "setup --smoke cannot run with CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE=1 because it must prove real local CLI invocation"
    };
  }
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "converge-loop-smoke-"));
  const smokeEnv = {
    ...io.env,
    CONVERGE_LOOP_STATE_HOME: smokeRoot,
    CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS: "1"
  };
  const smokeOptions = {
    ...DEFAULT_RUN_OPTIONS,
    cwd: io.cwd,
    hostAgent,
    topic: "converge-loop setup smoke",
    focus: "This is a readiness smoke, not open-ended deliberation. If your local CLI invocation and control block work, set status to agreed, ready_to_converge to true, and do not ask for follow-up evidence.",
    scope: "none",
    web: "off",
    output: "quiet",
    maxTurns: 2,
    maxMinutes: 2,
    turnTimeoutSeconds: Math.min(DEFAULT_RUN_OPTIONS.turnTimeoutSeconds, 60),
    agents: ["codex", "claude"],
    roles: ["proposer", "critic"],
    json: false,
    background: false,
    fixture: null,
    turnDelayMs: 0
  };
  try {
    const store = StateStore.fromEnv(smokeEnv);
    const result = await runSession({
      store,
      options: smokeOptions,
      stdout: { write() {} },
      env: smokeEnv
    });
    const participants = result.participants.map((participant) => participant.adapter);
    const acceptableStatuses = new Set(["agreed", "clear_disagreement"]);
    const ok = acceptableStatuses.has(result.status) &&
      result.independent_provider_coverage === true &&
      Array.isArray(result.fallbacks_used) &&
      result.fallbacks_used.length === 0 &&
      participants.join(",") === "codex,claude";
    if (ok) {
      fs.rmSync(smokeRoot, { recursive: true, force: true });
    }
    return {
      requested: true,
      ok,
      status: result.status,
      participants,
      independent_provider_coverage: result.independent_provider_coverage,
      fallbacks_used: result.fallbacks_used || [],
      diagnostic_path: ok ? null : smokeRoot,
      reason: ok ? null : "smoke result did not prove real codex+claude independent provider coverage"
    };
  } catch (error) {
    return {
      requested: true,
      ok: false,
      participants: [],
      diagnostic_path: smokeRoot,
      reason: error.message
    };
  }
}

export function parseRunArgs(args, io) {
  const options = {
    ...DEFAULT_RUN_OPTIONS,
    cwd: io.cwd,
    hostAgent: resolveHost(io.env),
    sessionId: null,
    fixture: null,
    turnDelayMs: 0,
    backgroundChild: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return args[i];
    };
    if (arg === "--topic") options.topic = next();
    else if (arg === "--context") options.context = resolveReadablePath(io.cwd, next(), "--context");
    else if (arg === "--artifact") options.artifact = resolveReadablePath(io.cwd, next(), "--artifact");
    else if (arg === "--scope") options.scope = enumValue("--scope", next(), ["none", "working-tree", "branch"]);
    else if (arg === "--base") options.base = next();
    else if (arg === "--web") options.web = enumValue("--web", next(), ["off", "shared"]);
    else if (arg === "--focus") options.focus = next();
    else if (arg === "--agents") options.agents = splitList(next());
    else if (arg === "--roles") options.roles = splitList(next());
    else if (arg === "--output") options.output = enumValue("--output", next(), ["compact", "verbose", "quiet"]);
    else if (arg === "--intervene") options.intervene = true;
    else if (arg === "--max-turns") options.maxTurns = positiveInt("--max-turns", next());
    else if (arg === "--max-minutes") options.maxMinutes = positiveInt("--max-minutes", next());
    else if (arg === "--turn-timeout-seconds") options.turnTimeoutSeconds = positiveInt("--turn-timeout-seconds", next());
    else if (arg === "--max-tool-calls-per-turn") options.maxToolCallsPerTurn = positiveInt("--max-tool-calls-per-turn", next());
    else if (arg === "--max-control-retries") options.maxControlRetries = nonNegativeInt("--max-control-retries", next());
    else if (arg === "--json") options.json = true;
    else if (arg === "--background") options.background = true;
    else if (arg === "--background-child") options.backgroundChild = true;
    else if (arg === "--session-id") options.sessionId = next();
    else if (arg === "--fixture") options.fixture = path.resolve(io.cwd, next());
    else if (arg === "--turn-delay-ms") options.turnDelayMs = positiveInt("--turn-delay-ms", next());
    else throw new Error(`unknown run option: ${arg}`);
  }
  validateRunOptions(options, io);
  return options;
}

function validateRunOptions(options, io) {
  if (options.intervene && options.background) {
    throw new Error("--intervene cannot be combined with --background");
  }
  if (options.scope === "branch" && !options.base) {
    throw new Error("--scope branch requires --base <ref>");
  }
  if (options.web === "shared" && !(options.topic || options.focus || options.context || options.artifact)) {
    throw new Error("--web shared requires a topic, focus, context, or artifact");
  }
  if (options.agents && options.agents.length < 2) {
    throw new Error("--agents requires at least two participants");
  }
  if (options.roles && options.agents && options.roles.length !== options.agents.length) {
    throw new Error("--roles and --agents must have the same number of entries when both are supplied");
  }
  const hasInput = Boolean(options.topic || options.focus || options.context || options.artifact || options.web === "shared");
  if (!hasInput && options.scope === "working-tree" && !hasWorkingTreeMaterial(io.cwd)) {
    throw new Error("clean working tree requires --topic, --focus, --context, --artifact, --web shared, or branch/base scope");
  }
}

async function runRun(args, io) {
  assertNotParticipant(io.env);
  const options = parseRunArgs(args, io);
  const store = StateStore.fromEnv(io.env);
  if (options.background && !options.backgroundChild) {
    return startBackgroundRun(args, options, io, store);
  }
  const controller = new AbortController();
  const abortOnSignal = () => controller.abort();
  process.once("SIGTERM", abortOnSignal);
  process.once("SIGINT", abortOnSignal);
  let result;
  try {
    result = await runSession({ store, options, stdout: io.stdout, env: io.env, sessionId: options.sessionId, signal: controller.signal });
  } finally {
    process.removeListener("SIGTERM", abortOnSignal);
    process.removeListener("SIGINT", abortOnSignal);
  }
  if (options.backgroundChild && options.sessionId) {
    const job = store.loadJob(options.sessionId);
    if (job) {
      const status = result.status === "canceled" ? "canceled" : "completed";
      store.writeJob(options.sessionId, { ...job, status, last_heartbeat_at: nowIso() });
    }
  }
  return 0;
}

function startBackgroundRun(originalArgs, options, io, store) {
  const sessionId = createSessionId();
  const childArgs = [
    io.binPath,
    "run",
    ...originalArgs.filter((arg) => arg !== "--background"),
    "--background-child",
    "--session-id",
    sessionId
  ];
  store.writeJob(sessionId, {
    id: sessionId,
    pid: null,
    command: [process.execPath, ...childArgs],
    cwd: io.cwd,
    created_at: nowIso(),
    last_heartbeat_at: nowIso(),
    status: "starting",
    session_path: store.sessionPath(sessionId),
    turn_timeout_seconds: options.turnTimeoutSeconds,
    host_agent: options.hostAgent
  });
  const child = spawn(process.execPath, childArgs, {
    cwd: io.cwd,
    env: io.env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  const job = store.loadJob(sessionId);
  store.writeJob(sessionId, { ...job, pid: child.pid, status: "running", last_heartbeat_at: nowIso() });
  io.stdout.write(`${sessionId}\n`);
  return 0;
}

function runStatus(args, io) {
  const store = StateStore.fromEnv(io.env);
  const sessionId = args[0] && !args[0].startsWith("--") ? args[0] : null;
  if (sessionId) {
    let session = null;
    try {
      session = store.loadSession(sessionId);
    } catch {
      const job = withDerivedJobStatus(store.loadJob(sessionId));
      if (job) {
        io.stdout.write(`${sessionId} ${job.derived_status} job=${job.derived_status}\n`);
        return 0;
      }
      throw new Error(`session not found: ${sessionId}`);
    }
    const result = store.resultExists(sessionId) ? store.loadResult(sessionId) : null;
    const job = withDerivedJobStatus(store.loadJob(sessionId));
    io.stdout.write(`${session.id} ${result?.status || session.state}${job ? ` job=${job.derived_status}` : ""}\n`);
    return 0;
  }
  const jobsById = new Map(store.listJobs().map((job) => [job.id, withDerivedJobStatus(job)]));
  for (const { session, result } of store.listSessions().slice(0, 20)) {
    const job = jobsById.get(session.id);
    io.stdout.write(`${session.id} ${result?.status || session.state}${job ? ` job=${job.derived_status}` : ""}\n`);
  }
  return 0;
}

function runResult(args, io) {
  if (!args[0]) throw new Error("result requires <session-id>");
  const sessionId = args[0];
  const options = parseResultArgs(args.slice(1));
  const store = StateStore.fromEnv(io.env);
  const result = store.loadResult(sessionId);
  if (options.exportPath) {
    exportSession({ store, sessionId, exportPath: path.resolve(io.cwd, options.exportPath), allowVersioned: options.allowVersionedExport, cwd: io.cwd });
  }
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function runCancel(args, io) {
  if (!args[0]) throw new Error("cancel requires <session-id>");
  const sessionId = args[0];
  const store = StateStore.fromEnv(io.env);
  const job = store.loadJob(sessionId);
  if (!job) throw new Error(`no background job found for ${sessionId}`);
  if (processExists(job.pid)) {
    process.kill(job.pid, "SIGTERM");
    ensureCanceledResult({ store, sessionId, job, env: io.env });
    store.writeJob(sessionId, { ...job, status: "canceling", last_heartbeat_at: nowIso() });
    io.stdout.write(`${sessionId} canceling\n`);
  } else {
    ensureCanceledResult({ store, sessionId, job, env: io.env });
    store.writeJob(sessionId, { ...job, status: "stale", last_heartbeat_at: nowIso() });
    io.stdout.write(`${sessionId} stale\n`);
  }
  return 0;
}

async function runResume(args, io) {
  assertNotParticipant(io.env);
  if (!args[0]) throw new Error("resume requires <session-id>");
  const sessionId = args[0];
  const store = StateStore.fromEnv(io.env);
  let session;
  try {
    session = store.loadSession(sessionId);
  } catch {
    const job = withDerivedJobStatus(store.loadJob(sessionId));
    if (job) {
      throw new Error(`session ${sessionId} is not initialized yet; current job status is ${job.derived_status}`);
    }
    throw new Error(`session not found: ${sessionId}`);
  }
  const result = store.resultExists(sessionId) ? store.loadResult(sessionId) : null;
  const job = withDerivedJobStatus(store.loadJob(sessionId));
  const stale = job?.derived_status === "stale";
  const status = result?.status || session.state;
  // Recovery paths: an interrupted foreground run leaves state "running" with
  // no result and no live process; a dual adapter failure leaves a blocked
  // result that is safe to retry once adapters are healthy again.
  const stuckRunning = status === "running" && !result && (!job || !processExists(job.pid));
  const adapterFailureBlocked = status === "blocked" && result?.blocked_reason === "adapter_failure";
  if (!stale && !stuckRunning && !adapterFailureBlocked && !RESUMABLE_STATUSES.has(status)) {
    throw new Error(`session ${sessionId} cannot be resumed from status ${status}`);
  }
  const options = { ...session.options, ...parseResumeOverrides(args.slice(1), io), sessionId };
  await runSession({ store, options, stdout: io.stdout, env: io.env, sessionId, resume: true });
  return 0;
}

function parseResultArgs(args) {
  const options = { exportPath: null, allowVersionedExport: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--export") {
      i += 1;
      if (!args[i]) throw new Error("--export requires a path");
      options.exportPath = args[i];
    } else if (args[i] === "--allow-versioned-export") {
      options.allowVersionedExport = true;
    } else {
      throw new Error(`unknown result option: ${args[i]}`);
    }
  }
  return options;
}

function parseSetupArgs(args) {
  const options = { json: false, checkOnly: false, disable: false, smoke: false };
  for (const arg of args) {
    if (arg === "--json") options.json = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--disable") options.disable = true;
    else if (arg === "--smoke") options.smoke = true;
    else throw new Error(`unknown setup option: ${arg}`);
  }
  if (options.disable && options.checkOnly) throw new Error("--disable cannot be combined with --check-only");
  if (options.disable && options.smoke) throw new Error("--disable cannot be combined with --smoke");
  if (options.checkOnly && options.smoke) throw new Error("--check-only cannot be combined with --smoke");
  return options;
}

function parseResumeOverrides(args, io) {
  if (!args.length) return {};
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      if (i + 1 >= args.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return args[i];
    };
    if (arg === "--fixture") options.fixture = path.resolve(io.cwd, next());
    else if (arg === "--max-turns") options.maxTurns = positiveInt("--max-turns", next());
    else if (arg === "--max-minutes") options.maxMinutes = positiveInt("--max-minutes", next());
    else if (arg === "--turn-timeout-seconds") options.turnTimeoutSeconds = positiveInt("--turn-timeout-seconds", next());
    else if (arg === "--output") options.output = enumValue("--output", next(), ["compact", "verbose", "quiet"]);
    else if (arg === "--json") options.json = true;
    else throw new Error(`unsupported resume override: ${arg}`);
  }
  return options;
}

function exportSession({ store, sessionId, exportPath, allowVersioned, cwd }) {
  const root = gitRoot(cwd);
  if (root && pathInside(root, exportPath)) {
    const rel = path.relative(root, exportPath);
    const ignored = runGit(root, ["check-ignore", "-q", rel]).status === 0;
    if (!ignored && !allowVersioned) {
      throw new Error(`export destination is not ignored by git: ${rel}; pass --allow-versioned-export to proceed`);
    }
  }
  copyDir(store.sessionPath(sessionId), exportPath);
}

function withDerivedJobStatus(job) {
  if (!job) return null;
  if (["completed", "canceling", "canceled", "failed"].includes(job.status)) {
    return { ...job, derived_status: job.status };
  }
  const heartbeat = Date.parse(job.last_heartbeat_at || job.created_at || 0);
  const staleByHeartbeat = heartbeat && Date.now() - heartbeat > (job.turn_timeout_seconds || 180) * 2000;
  const staleByPid = job.pid && !processExists(job.pid);
  return {
    ...job,
    derived_status: staleByHeartbeat || staleByPid ? "stale" : job.status
  };
}

function ensureCanceledResult({ store, sessionId, job, env = process.env }) {
  if (store.resultExists(sessionId)) return;
  const hostAgent = job.host_agent || resolveHost(env);
  let session;
  try {
    session = store.loadSession(sessionId);
  } catch {
    session = store.createSession({
      sessionId,
      cwd: job.cwd,
      options: { cwd: job.cwd, scope: "none", web: "off", output: "quiet", hostAgent },
      participants: []
    });
  }
  session.state = "canceled";
  session.completed_at = nowIso();
  store.writeSession(session);
  const result = {
    schema_version: RESULT_SCHEMA,
    status: "canceled",
    summary: "Background session canceled before completion.",
    conclusion_path: "conclusion.md",
    turn_count: store.readTurns(sessionId).length,
    host_agent: session.options?.hostAgent || hostAgent,
    participants: session.participants || [],
    independent_provider_coverage: false,
    fallbacks_used: [],
    scope: session.options?.scope || "none",
    web_scope: session.options?.web || "off",
    output_mode: session.options?.output || "quiet",
    agreements: [],
    pushbacks_resolved: [],
    remaining_disagreements: [],
    minor_reservations: [],
    improvements: [],
    operator_intervention_points: [],
    fake_coverage: (session.participants || []).some((participant) => participant.tier === "fake"),
    evidence_summary: { observed: [], self_reported: [], residual_asymmetry_risk: "low" },
    recommended_next_actions: [],
    transcript_path: "transcript.md",
    evidence_ledger_path: "evidence-ledger.jsonl"
  };
  store.writeConclusion(sessionId, result.summary);
  store.writeResult(sessionId, result);
}

function assertNotParticipant(env) {
  if (env.CONVERGE_LOOP_PARTICIPANT === "1") {
    throw new Error("converge-loop cannot be invoked from inside a converge-loop participant turn");
  }
}

function enumValue(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function positiveInt(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be zero or a positive integer`);
  }
  return parsed;
}

function splitList(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function renderSetup(result) {
  const status = result.ok ? "ready" : "not ready";
  const lines = [
    `converge-loop setup: ${status}`,
    `mode: ${result.mode}`,
    `host: ${result.host_agent}`,
    `config: ${result.config_path}`,
    "",
    "Checks:"
  ];
  for (const [name, check] of Object.entries(result.checks)) {
    lines.push(`  ${name}: ${check.ok ? "ok" : `blocked - ${check.reason}`}`);
    if (check.auth) {
      lines.push(`    auth: ${check.auth.ok ? "ok" : `blocked - ${check.auth.reason}`}`);
    }
  }
  if (result.smoke?.requested) {
    lines.push("", `Smoke: ${result.smoke.ok ? "ok" : `blocked - ${result.smoke.reason || "failed"}`}`);
  }
  if (result.warnings?.length) {
    lines.push("", "Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push("", result.next_step, "");
  return lines.join("\n");
}

function helpText() {
  return `Usage:
  converge-loop setup [--json] [--check-only] [--disable] [--smoke]
  converge-loop run [options]
  converge-loop status [session-id]
  converge-loop result <session-id> [--export <path>] [--allow-versioned-export]
  converge-loop cancel <session-id>
  converge-loop resume <session-id>

Run examples:
  converge-loop setup
  converge-loop run --topic "Improve this plan"
  converge-loop run --artifact plan.md --focus "Ask for pushback"
`;
}

function setupWarnings(env) {
  const warnings = [];
  if (env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS === "1") {
    warnings.push("CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS=1 overrides setup config and enables local adapters.");
  }
  if (env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE === "1") {
    warnings.push("CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE=1 is for deterministic tests only; setup --smoke will refuse to enable config from fake turns.");
  }
  return warnings;
}

function writeSetupResult(result, options, io) {
  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.stdout.write(renderSetup(result));
  }
}
