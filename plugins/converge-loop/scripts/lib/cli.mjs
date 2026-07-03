import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_RUN_OPTIONS, RESULT_SCHEMA, RESUMABLE_STATUSES } from "./constants.mjs";
import { normalizeHostAgent } from "./adapters.mjs";
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

export function parseRunArgs(args, io) {
  const options = {
    ...DEFAULT_RUN_OPTIONS,
    cwd: io.cwd,
    hostAgent: normalizeHostAgent(io.env.CONVERGE_LOOP_HOST),
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
    else if (arg === "--max-control-retries") options.maxControlRetries = positiveInt("--max-control-retries", next());
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
  const options = parseRunArgs(args, io);
  const store = StateStore.fromEnv(io.env);
  if (options.background && !options.backgroundChild) {
    return startBackgroundRun(args, options, io, store);
  }
  const controller = new AbortController();
  const abortOnSigterm = () => controller.abort();
  process.once("SIGTERM", abortOnSigterm);
  let result;
  try {
    result = await runSession({ store, options, stdout: io.stdout, env: io.env, sessionId: options.sessionId, signal: controller.signal });
  } finally {
    process.removeListener("SIGTERM", abortOnSigterm);
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
    turn_timeout_seconds: options.turnTimeoutSeconds
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
    ensureCanceledResult({ store, sessionId, job });
    store.writeJob(sessionId, { ...job, status: "canceling", last_heartbeat_at: nowIso() });
    io.stdout.write(`${sessionId} canceling\n`);
  } else {
    ensureCanceledResult({ store, sessionId, job });
    store.writeJob(sessionId, { ...job, status: "stale", last_heartbeat_at: nowIso() });
    io.stdout.write(`${sessionId} stale\n`);
  }
  return 0;
}

async function runResume(args, io) {
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
  if (!stale && !RESUMABLE_STATUSES.has(status)) {
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

function ensureCanceledResult({ store, sessionId, job }) {
  if (store.resultExists(sessionId)) return;
  let session;
  try {
    session = store.loadSession(sessionId);
  } catch {
    session = store.createSession({
      sessionId,
      cwd: job.cwd,
      options: { cwd: job.cwd, scope: "none", web: "off", output: "quiet" },
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
    host_agent: "codex",
    participants: session.participants || [],
    independent_provider_coverage: false,
    fallbacks_used: [],
    scope: session.options?.scope || "none",
    web_scope: session.options?.web || "off",
    output_mode: session.options?.output || "quiet",
    agreements: [],
    pushbacks_resolved: [],
    remaining_disagreements: [],
    improvements: [],
    operator_intervention_points: [],
    evidence_summary: { observed: [], self_reported: [], residual_asymmetry_risk: "low" },
    recommended_next_actions: [],
    transcript_path: "transcript.md",
    evidence_ledger_path: "evidence-ledger.jsonl"
  };
  store.writeConclusion(sessionId, result.summary);
  store.writeResult(sessionId, result);
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

function splitList(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function helpText() {
  return `Usage:
  converge-loop run [options]
  converge-loop status [session-id]
  converge-loop result <session-id> [--export <path>] [--allow-versioned-export]
  converge-loop cancel <session-id>
  converge-loop resume <session-id>

Run examples:
  CONVERGE_LOOP_HOST=akx converge-loop run --topic "Improve this plan"
  converge-loop run --artifact plan.md --focus "Ask for pushback"
`;
}
