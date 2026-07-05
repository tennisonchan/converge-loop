import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseParticipantOutput } from "./control.mjs";
import { commandExists, defaultStateRoot, nowIso, readJson, redact, signalProcessTree, writeJson } from "./util.mjs";
import { knownBadVerdict } from "./adapter-health.mjs";

const LOCAL_ADAPTER_CONFIG_SCHEMA = "converge-loop.local-adapters.v1";
// Keep this in sync with LocalCliAdapter.invoke; setup and runtime preflight assert these flags.
export const LOCAL_CLI_REQUIRED_FLAGS = Object.freeze({
  codex: ["--sandbox", "--cd", "--ignore-user-config", "--output-schema", "--output-last-message", "--model"],
  claude: ["--print", "--permission-mode", "--disallowedTools", "--output-format", "--safe-mode", "--json-schema", "--model", "--verbose", "--include-partial-messages"]
});

export const PARTICIPANT_SCHEMA_PATH = fileURLToPath(new URL("../../schemas/participant-output.schema.json", import.meta.url));

// Single source of truth for the deterministic verification adapters; CLI
// validation, adapter construction, and tier/provider classification must
// agree on this set so fake coverage can never masquerade as real deliberation.
export const FAKE_ADAPTERS = Object.freeze(["fake-sequence", "fake-replay", "fake-tooling"]);

// claude --json-schema silently skips structured output when the schema
// carries a $schema meta key, so strip it before passing the schema inline.
function participantSchemaInline() {
  const schema = JSON.parse(fs.readFileSync(PARTICIPANT_SCHEMA_PATH, "utf8"));
  delete schema.$schema;
  return JSON.stringify(schema);
}

const BASE_FAKE_CAPABILITIES = {
  class: "tool-proxy",
  file_scope: ["none", "working-tree", "branch"],
  web_scope: ["off", "shared"],
  control_output: ["json-schema", "nonce-block"],
  read_only_enforcement: "orchestrator-fake",
  observed_evidence: ["file", "web"],
  timeouts: true
};

export function buildParticipants(options, env = process.env) {
  const host = options.hostAgent || resolveHost(env);
  const agents = options.agents || (host === "claude" ? ["claude", "codex"] : ["codex", "claude"]);
  const roles = options.roles || ["proposer", "critic"];
  return agents.map((adapter, index) => {
    const provider = providerFor(adapter);
    return {
      id: `p${index + 1}`,
      adapter,
      provider,
      role: roles[index] || `participant-${index + 1}`,
      tier: FAKE_ADAPTERS.includes(adapter) ? "fake" : "external",
      fallback_for: null
    };
  });
}

export function normalizeHostAgent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["akc", "claude", "claude-code", "anthropic"].includes(normalized)) return "claude";
  if (["akx", "codex", "openai"].includes(normalized)) return "codex";
  throw new Error(`unsupported CONVERGE_LOOP_HOST: ${value}`);
}

export function resolveHost(env = process.env) {
  const explicit = normalizeHostAgent(env.CONVERGE_LOOP_HOST);
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_ROOT) return "claude";
  if (env.PLUGIN_ROOT) return "codex";
  return "codex";
}

export function preflightParticipants(participants, options, env = process.env) {
  const checked = checkParticipants(participants, options, env);
  const failed = checked.find((entry) => !entry.preflight.ok);
  if (failed) {
    if (options.requireIndependent) {
      return {
        ok: false,
        blockedReason: "require_independent",
        reason: `independent provider coverage was required but ${failed.participant.adapter} is unavailable: ${failed.preflight.reason}`,
        checked,
        participants
      };
    }
    const fallback = maybeBuildFallback({ participants, options, env, failed });
    if (fallback) {
      const fallbackChecked = checkParticipants(fallback.participants, options, env);
      const fallbackFailure = firstPreflightOrCapabilityFailure(fallbackChecked, options);
      if (!fallbackFailure) {
        return { ok: true, checked: fallbackChecked, participants: fallback.participants };
      }
      return {
        ok: false,
        reason: `${failed.participant.adapter} unavailable: ${failed.preflight.reason}; degraded fallback ${fallback.adapter} unavailable: ${fallbackFailure.reason}`,
        checked: fallbackChecked,
        participants: fallback.participants
      };
    }
    return {
      ok: false,
      reason: failed.preflight.reason,
      checked
    };
  }
  const capabilityFailure = firstCapabilityFailure(checked, options);
  if (capabilityFailure) return { ...capabilityFailure, checked };
  if (options.requireIndependent && !independentProviderCoverage(participants)) {
    return {
      ok: false,
      blockedReason: "require_independent",
      reason: "selected participants do not provide independent provider coverage",
      checked,
      participants
    };
  }
  return { ok: true, checked };
}

export function localAdapterConfigPath(env = process.env) {
  return path.join(defaultStateRoot(env), "config", "local-adapters.json");
}

export function readLocalAdapterConfig(env = process.env) {
  try {
    return readJson(localAdapterConfigPath(env));
  } catch {
    return null;
  }
}

export function writeLocalAdapterConfig(env = process.env, payload) {
  writeJson(localAdapterConfigPath(env), {
    schema_version: LOCAL_ADAPTER_CONFIG_SCHEMA,
    ...payload
  });
}

// Per-adapter model selection: run flag first, then the operator-maintained
// `adapters.<name>.model` block in local-adapters.json, then the CLI default.
export function adapterModel(name, options, env = process.env) {
  const flag = name === "claude" ? options.claudeModel : name === "codex" ? options.codexModel : null;
  if (flag) return flag;
  const configured = readLocalAdapterConfig(env)?.adapters?.[name]?.model;
  return typeof configured === "string" && configured.trim() ? configured.trim() : null;
}

export function checkLocalCliReadiness(env = process.env) {
  const checks = {
    node: checkCommand(process.execPath, ["--version"], { requiredText: /^v\d+/, env }),
    codex: withAuthCheck("codex", checkLocalCliAdapter("codex", env), env),
    claude: withAuthCheck("claude", checkLocalCliAdapter("claude", env), env)
  };
  const ok = checks.node.ok && checks.codex.ok && checks.claude.ok;
  return {
    ok,
    checks,
    config_path: localAdapterConfigPath(env),
    read_only_controls: {
      codex: "sandbox-read-only",
      claude: "tool-denylist-plan-mode"
    }
  };
}

function checkParticipants(participants, options, env) {
  return participants.map((participant) => {
    const adapter = getAdapter(participant.adapter, env);
    // A remembered deterministic failure fails preflight fast with the stored
    // diagnosis, so a session does not rediscover it turn-by-turn and swap.
    const verdict = participant.tier && participant.tier.startsWith("fake") ? null : knownBadVerdict(env, participant.adapter);
    if (verdict) {
      return {
        participant,
        adapter,
        preflight: { ok: false, reason: `${participant.adapter} recently failed (${verdict.category}): ${verdict.reason}${verdict.hint ? ` — ${verdict.hint}` : ""}`, known_bad: true }
      };
    }
    const preflight = adapter.preflight({ participant, options, env });
    return { participant, adapter, preflight };
  });
}

function maybeBuildFallback({ participants, options, env, failed }) {
  if (options.agents) return null;
  const failedIndex = participants.findIndex((participant) => participant.id === failed.participant.id);
  if (failedIndex !== 1) return null;
  const fallbackAdapter = options.hostAgent || resolveHost(env);
  const participant = {
    ...failed.participant,
    adapter: fallbackAdapter,
    provider: providerFor(fallbackAdapter),
    tier: "fallback",
    fallback_for: failed.participant.adapter,
    fallback_reason: failed.preflight.reason || "preflight failed"
  };
  const fallbackParticipants = participants.slice();
  fallbackParticipants[failedIndex] = participant;
  return { adapter: fallbackAdapter, participants: fallbackParticipants };
}

function independentProviderCoverage(participants) {
  const providers = new Set(participants.map((participant) => participant.provider || providerFor(participant.adapter)));
  return providers.size === participants.length && !participants.some((participant) => participant.tier === "fallback");
}

function firstPreflightOrCapabilityFailure(checked, options) {
  const failed = checked.find((entry) => !entry.preflight.ok);
  if (failed) return { reason: failed.preflight.reason };
  return firstCapabilityFailure(checked, options);
}

function firstCapabilityFailure(checked, options) {
  const scopes = checked.map((entry) => entry.preflight.capabilities.file_scope);
  const webScopes = checked.map((entry) => entry.preflight.capabilities.web_scope);
  const supportsScope = scopes.every((values) => values.includes(options.scope));
  const supportsWeb = webScopes.every((values) => values.includes(options.web));
  if (!supportsScope) {
    return { ok: false, reason: `requested file scope '${options.scope}' is not supported by all participants` };
  }
  if (!supportsWeb) {
    return { ok: false, reason: `requested web scope '${options.web}' is not supported by all participants` };
  }
  return null;
}

export function getAdapter(name, env = process.env) {
  if (FAKE_ADAPTERS.includes(name)) {
    return new FakeAdapter(name);
  }
  if (name === "codex") return new LocalCliAdapter("codex", env);
  if (name === "claude") return new LocalCliAdapter("claude", env);
  return new UnsupportedAdapter(name);
}

export function providerFor(adapter) {
  if (adapter === "codex") return "openai";
  if (adapter === "claude") return "anthropic";
  if (FAKE_ADAPTERS.includes(adapter)) return "local-fake";
  return "unknown";
}

class UnsupportedAdapter {
  constructor(name) {
    this.name = name;
  }

  preflight() {
    return { ok: false, reason: `unsupported adapter: ${this.name}` };
  }
}

class FakeAdapter {
  constructor(name) {
    this.name = name;
  }

  preflight() {
    return {
      ok: true,
      capabilities: {
        adapter: this.name,
        provider: "local-fake",
        ...BASE_FAKE_CAPABILITIES
      }
    };
  }

  async invoke({ participant, turnIndex, options, transcript }) {
    let scripted = loadFixtureTurn(options.fixture, turnIndex, participant);
    const turnDelayMs = scripted?.delay_ms ?? options.turnDelayMs;
    if (scripted && Array.isArray(scripted.attempts)) {
      const attempt = Math.min(options.__attempt || 0, scripted.attempts.length - 1);
      scripted = scripted.attempts[attempt];
    }
    const attemptDelayMs = scripted?.delay_ms ?? turnDelayMs;
    if (attemptDelayMs) {
      await delay(attemptDelayMs);
    }
    if (typeof scripted === "string") return scripted;
    const response = scripted || defaultFakeTurn({ participant, turnIndex, options, transcript });
    if (this.name === "fake-tooling" && /WRITE_VIOLATION/.test(options.topic || "")) {
      return {
        message: "Attempted write was detected by fake tooling.",
        control: { status: "blocked" },
        violation: {
          type: "attempted_write",
          detail: "fake-tooling simulated write violation"
        },
        evidence: []
      };
    }
    return response;
  }
}

class LocalCliAdapter {
  constructor(name, env) {
    this.name = name;
    this.env = env;
    // Resolved once per adapter instance so a mid-session edit of
    // local-adapters.json cannot silently switch models between turns.
    this.resolvedModel = undefined;
  }

  preflight({ options, env }) {
    // Shared web is orchestrator-mediated between turns; provider-native web
    // stays disabled (claude denylist, codex sandbox), so local CLIs support it.
    if (testUnavailableAdapters(env).includes(this.name)) {
      return { ok: false, reason: `${this.name} adapter forced unavailable by test preflight` };
    }
    if (!localCliAdaptersEnabled(env)) {
      return {
        ok: false,
        reason: `${this.name} local CLI adapter is not enabled; run \`converge-loop setup\` to verify read-only controls`
      };
    }
    if (env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT === "1") {
      return this.capabilities(options);
    }
    const cliCheck = checkLocalCliAdapter(this.name, env);
    if (!cliCheck.ok) {
      return { ok: false, reason: cliCheck.reason };
    }
    return this.capabilities(options);
  }

  capabilities(options) {
    return {
      ok: true,
      capabilities: {
        adapter: this.name,
        provider: providerFor(this.name),
        class: "local-cli",
        file_scope: ["none", "working-tree", "branch"],
        web_scope: ["off", "shared"],
        control_output: ["json-schema", "nonce-block"],
        read_only_enforcement: this.name === "codex" ? "sandbox-read-only" : "tool-denylist-plan-mode",
        observed_evidence: [],
        timeouts: true
      }
    };
  }

  controlMode() {
    return "json-schema";
  }

  async invoke({ participant, options, prompt, nonce }) {
    if (this.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE === "1") {
      return defaultFakeTurn({ participant, turnIndex: options.__turnIndex || 0, options });
    }
    const command = localCliCommandName(this.name, this.env);
    if (this.resolvedModel === undefined) {
      this.resolvedModel = adapterModel(this.name, options, this.env);
    }
    const model = this.resolvedModel;
    const limits = {
      timeoutMs: options.turnTimeoutSeconds * 1000,
      inactivityMs: (options.turnInactivitySeconds ?? 0) * 1000,
      cwd: options.cwd
    };
    if (this.name === "codex") {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "converge-loop-turn-"));
      const outPath = path.join(outDir, "last-message.json");
      try {
        const stdout = await runWithTimeout(command, [
          "exec",
          ...(model ? ["--model", model] : []),
          "--sandbox", "read-only",
          "--cd", options.cwd,
          "--ignore-user-config",
          "--output-schema", PARTICIPANT_SCHEMA_PATH,
          "--output-last-message", outPath,
          "-"
        ], prompt, limits, this.env);
        const structured = readStructuredFile(outPath);
        if (structured) return structured;
        return parseParticipantOutput(stdout, { nonce, participant });
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }
    // stream-json keeps output flowing during long turns so the inactivity
    // detector can tell a slow model from a hung one; the final stream line is
    // the same result envelope the buffered json format produces.
    const stdout = await runWithTimeout(command, [
      "--safe-mode",
      "--print",
      ...(model ? ["--model", model] : []),
      "--permission-mode",
      "plan",
      "--disallowedTools",
      "Edit,MultiEdit,Write,WebFetch,WebSearch,Bash(git commit *),Bash(git push *),Bash(converge-loop *),Bash(review-loop *)",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--json-schema",
      participantSchemaInline()
    ], prompt, limits, this.env);
    const envelope = claudeResultEnvelope(stdout);
    if (envelope) {
      if (envelope.is_error) {
        throw new Error(`claude reported an error: ${redact(envelope.result || envelope.subtype || "unknown")}`);
      }
      if (envelope.structured_output) {
        return envelope.structured_output;
      }
      return parseParticipantOutput(String(envelope.result || ""), { nonce, participant });
    }
    return parseParticipantOutput(stdout, { nonce, participant });
  }
}

// Accepts both stream-json output (scan for the trailing result event) and a
// plain result envelope — including a pretty-printed multi-line one — so older
// CLI builds and wrapper scripts keep working.
function claudeResultEnvelope(stdout) {
  const text = String(stdout || "");
  const lines = text.split(/\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const parsed = tryParseJson(line);
    if (!parsed || typeof parsed !== "object") continue;
    if (parsed.type === "result" || "is_error" in parsed || "structured_output" in parsed) return parsed;
    if ("result" in parsed && !("type" in parsed)) return parsed;
  }
  const whole = tryParseJson(text.trim());
  if (whole && typeof whole === "object" && ("is_error" in whole || "structured_output" in whole || "result" in whole)) {
    return whole;
  }
  return null;
}

function readStructuredFile(outPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.control) return parsed;
    return null;
  } catch {
    return null;
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function localCliAdaptersEnabled(env) {
  if (env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS === "1") return true;
  const config = readLocalAdapterConfig(env);
  return Boolean(
    config?.schema_version === LOCAL_ADAPTER_CONFIG_SCHEMA &&
    config.enabled === true &&
    config.checks?.codex?.ok === true &&
    config.checks?.codex?.auth?.ok === true &&
    config.checks?.claude?.ok === true &&
    config.checks?.claude?.auth?.ok === true
  );
}

function checkLocalCliAdapter(name, env) {
  const command = localCliCommandName(name, env);
  if (!commandExists(command, env)) {
    return { ok: false, command, reason: `${command} executable not found` };
  }
  const helpArgs = name === "codex" ? ["exec", "--help"] : ["--help"];
  const required = LOCAL_CLI_REQUIRED_FLAGS[name] || [];
  const help = spawnSync(command, helpArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 5000
  });
  const text = `${help.stdout || ""}\n${help.stderr || ""}`;
  if (help.error) {
    return { ok: false, command, reason: `${command} help command failed: ${help.error.message}` };
  }
  if (help.status !== 0) {
    return { ok: false, command, reason: `${command} help command failed`, status: help.status };
  }
  const missing = required.filter((flag) => !text.includes(flag));
  if (missing.length) {
    return { ok: false, command, reason: `${name} missing required read-only flags: ${missing.join(", ")}` };
  }
  return { ok: true, command, required_flags: required };
}

function withAuthCheck(name, cliCheck, env) {
  if (!cliCheck.ok) return { ...cliCheck, auth: { ok: false, reason: "skipped because CLI flag readiness failed" } };
  const auth = name === "codex"
    ? checkCodexAuth(cliCheck.command, env)
    : checkClaudeAuth(cliCheck.command, env);
  return {
    ...cliCheck,
    ok: cliCheck.ok && auth.ok,
    auth,
    reason: auth.ok ? cliCheck.reason : auth.reason
  };
}

function checkCodexAuth(command, env) {
  const result = spawnSync(command, ["login", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 5000
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const firstLine = text.split(/\n/).find(Boolean) || "";
  if (result.error) {
    return { ok: false, method: "codex-login-status", reason: `codex auth status failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, method: "codex-login-status", reason: "codex is not authenticated", status: result.status };
  }
  if (isCodexLoggedInOutput(text)) {
    return { ok: true, method: "codex-login-status", status: "logged-in" };
  }
  return {
    ok: false,
    method: "codex-login-status",
    reason: "codex login status output was not recognized as authenticated",
    output: firstLine
  };
}

function isCodexLoggedInOutput(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  if (/\bnot\s+logged\s+in\b|\blogged\s+out\b|\bunauth/i.test(normalized)) return false;
  return /^logged in\b/i.test(normalized) || /\blogged in using\b/i.test(normalized);
}

function checkClaudeAuth(command, env) {
  const result = spawnSync(command, ["auth", "status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 5000
  });
  const text = `${result.stdout || ""}`.trim();
  if (result.error) {
    return { ok: false, method: "claude-auth-status-json", reason: `claude auth status failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, method: "claude-auth-status-json", reason: "claude is not authenticated", status: result.status };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, method: "claude-auth-status-json", reason: "claude auth status did not return valid JSON" };
  }
  if (parsed?.loggedIn === true) {
    const sanitized = { ok: true, method: "claude-auth-status-json", status: "logged-in" };
    if (parsed.authMethod) sanitized.auth_method = parsed.authMethod;
    if (parsed.apiProvider) sanitized.api_provider = parsed.apiProvider;
    return sanitized;
  }
  return { ok: false, method: "claude-auth-status-json", reason: "claude auth status is not logged in" };
}

function localCliCommandName(name, env) {
  return env[`CONVERGE_LOOP_${name.toUpperCase()}_BIN`] || name;
}

function checkCommand(command, args, { requiredText = null, env = process.env } = {}) {
  if (!commandExists(command, env)) {
    return { ok: false, command, reason: `${command} executable not found` };
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    return { ok: false, command, reason: `${command} ${args.join(" ")} failed`, status: result.status };
  }
  if (requiredText && !requiredText.test(text)) {
    return { ok: false, command, reason: `${command} output did not match readiness expectation` };
  }
  return { ok: true, command, output: text.trim().split(/\n/)[0] || "" };
}

function testUnavailableAdapters(env) {
  return String(env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function defaultFakeTurn({ participant, turnIndex, options }) {
  const topic = options.topic || options.focus || "the requested topic";
  if (turnIndex === 0) {
    return {
      message: `${participant.role} proposes a stronger position on ${topic}.`,
      control: {
        status: "continue",
        confidence: "medium",
        improvements: [`Clarify the proposal for ${topic}`],
        evidence_used: [],
        ready_to_converge: false
      },
      evidence: []
    };
  }
  return {
    message: `${participant.role} has no material pushback and is ready to converge.`,
    control: {
      status: "agreed",
      confidence: "high",
      agreements: [`The conclusion is sufficient for ${topic}`],
      pushbacks: [],
      improvements: [],
      evidence_used: [],
      ready_to_converge: true
    },
    evidence: []
  };
}

function loadFixtureTurn(fixturePath, turnIndex, participant) {
  if (!fixturePath) return null;
  const resolved = path.resolve(fixturePath);
  const fixture = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const turns = Array.isArray(fixture) ? fixture : fixture.turns;
  if (!Array.isArray(turns)) return null;
  const turn = turns[turnIndex];
  if (!turn) return null;
  if (turn.byRole && turn.byRole[participant.role]) {
    return turn.byRole[participant.role];
  }
  return turn;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWithTimeout(command, args, stdin, limits, env = process.env) {
  const { timeoutMs, inactivityMs = 0, cwd = undefined } = limits;
  return new Promise((resolve, reject) => {
    // detached gives the child its own process group so timeout kills reach
    // grandchildren the CLI may have spawned; the recursion sentinel stops
    // participants from starting nested converge-loop runs.
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, CONVERGE_LOOP_PARTICIPANT: "1" },
      cwd,
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let inactivityTimer = null;
    let killed = false;
    const killWith = (message, timeoutKind) => {
      if (killed) return;
      killed = true;
      clearTimers();
      signalProcessTree(child.pid, "SIGTERM");
      const killTimer = setTimeout(() => signalProcessTree(child.pid, "SIGKILL"), 2000);
      killTimer.unref();
      const error = new Error(message);
      error.code = "CONVERGE_LOOP_TIMEOUT";
      error.timeoutKind = timeoutKind;
      reject(error);
    };
    const timer = setTimeout(() => {
      killWith(`${command} timed out after ${timeoutMs}ms (absolute turn cap; increase --turn-timeout-seconds to allow longer turns)`, "absolute");
    }, timeoutMs);
    // The inactivity timer resets on every stdout/stderr chunk, so a slow but
    // streaming turn survives while a genuinely hung CLI dies fast.
    const armInactivity = () => {
      if (killed || !inactivityMs) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        killWith(`${command} produced no output for ${inactivityMs}ms and looks hung (adjust --turn-inactivity-seconds; 0 disables)`, "inactivity");
      }, inactivityMs);
    };
    const clearTimers = () => {
      clearTimeout(timer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
    };
    armInactivity();
    child.stdout.on("data", (chunk) => { stdout += chunk; armInactivity(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; armInactivity(); });
    child.on("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimers();
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed with code ${code}: ${redact(stderr.trim())}`));
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
