import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseParticipantOutput } from "./control.mjs";
import { commandExists, nowIso } from "./util.mjs";

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
      tier: adapter.startsWith("fake-") ? "fake" : "external",
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
  return { ok: true, checked };
}

function checkParticipants(participants, options, env) {
  return participants.map((participant) => {
    const adapter = getAdapter(participant.adapter, env);
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
    fallback_for: failed.participant.adapter
  };
  const fallbackParticipants = participants.slice();
  fallbackParticipants[failedIndex] = participant;
  return { adapter: fallbackAdapter, participants: fallbackParticipants };
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
  if (name === "fake-sequence" || name === "fake-replay" || name === "fake-tooling") {
    return new FakeAdapter(name);
  }
  if (name === "codex") return new LocalCliAdapter("codex", env);
  if (name === "claude") return new LocalCliAdapter("claude", env);
  return new UnsupportedAdapter(name);
}

function providerFor(adapter) {
  if (adapter === "codex") return "openai";
  if (adapter === "claude") return "anthropic";
  if (adapter.startsWith("fake-")) return "local-fake";
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
    if (options.turnDelayMs) {
      await delay(options.turnDelayMs);
    }
    const scripted = loadFixtureTurn(options.fixture, turnIndex, participant);
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
  }

  preflight({ options, env }) {
    if (testUnavailableAdapters(env).includes(this.name)) {
      return { ok: false, reason: `${this.name} adapter forced unavailable by test preflight` };
    }
    if (env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS !== "1") {
      return {
        ok: false,
        reason: `${this.name} adapter is fail-closed; set CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS=1 only after verifying local read-only controls`
      };
    }
    if (env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT === "1") {
      return this.capabilities(options);
    }
    if (!commandExists(this.name)) {
      return { ok: false, reason: `${this.name} executable not found` };
    }
    const help = spawnSync(this.name, [this.name === "codex" ? "exec" : "--help", "--help"].filter(Boolean), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const text = `${help.stdout || ""}\n${help.stderr || ""}`;
    if (this.name === "codex" && !text.includes("--sandbox")) {
      return { ok: false, reason: "codex read-only sandbox flag was not detected" };
    }
    if (this.name === "claude" && !text.includes("--disallowedTools")) {
      return { ok: false, reason: "claude tool-denylist flag was not detected" };
    }
    if (options.web === "shared") {
      return { ok: false, reason: `${this.name} shared web adapter execution is not implemented yet; fake adapters cover deterministic web-scope tests` };
    }
    return this.capabilities(options);
  }

  capabilities(options) {
    if (options.web === "shared") {
      return { ok: false, reason: `${this.name} shared web adapter execution is not implemented yet; fake adapters cover deterministic web-scope tests` };
    }
    return {
      ok: true,
      capabilities: {
        adapter: this.name,
        provider: providerFor(this.name),
        class: "local-cli",
        file_scope: ["none", "working-tree", "branch"],
        web_scope: ["off"],
        control_output: ["nonce-block"],
        read_only_enforcement: this.name === "codex" ? "sandbox-read-only" : "tool-denylist-plan-mode",
        observed_evidence: [],
        timeouts: true
      }
    };
  }

  async invoke({ participant, options, prompt, nonce }) {
    if (this.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE === "1") {
      return defaultFakeTurn({ participant, turnIndex: options.__turnIndex || 0, options });
    }
    const command = this.name;
    const args = this.name === "codex"
      ? ["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "--cd", options.cwd, "-"]
      : [
          "--print",
          "--permission-mode",
          "plan",
          "--disallowedTools",
          "Edit,MultiEdit,Write,Bash(git commit *),Bash(git push *),Bash(converge-loop *),Bash(review-loop *)",
          "--output-format",
          "text",
          prompt
        ];
    const output = await runWithTimeout(command, args, this.name === "codex" ? prompt : null, options.turnTimeoutSeconds * 1000);
    return parseParticipantOutput(output, { nonce, participant });
  }
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
      message: `${participant.role} proposes a stronger plan for ${topic}.`,
      control: {
        status: "continue",
        confidence: "medium",
        improvements: [`Clarify the plan for ${topic}`],
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
      agreements: [`The plan is sufficient for ${topic}`],
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

function runWithTimeout(command, args, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} failed with code ${code}: ${stderr.trim()}`));
    });
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
