import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParticipants } from "../scripts/lib/adapters.mjs";
import { runCli } from "../scripts/lib/cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(repoRoot, "scripts/bin/converge-loop.mjs");

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `converge-loop-${name}-`));
}

function io(stateRoot, cwd = repoRoot) {
  const out = [];
  const err = [];
  return {
    cwd,
    env: { ...process.env, CONVERGE_LOOP_STATE_HOME: stateRoot },
    stdout: { write: (chunk) => out.push(String(chunk)) },
    stderr: { write: (chunk) => err.push(String(chunk)) },
    binPath,
    out,
    err
  };
}

async function cli(args, stateRoot = tempRoot("state"), cwd = repoRoot) {
  const harness = io(stateRoot, cwd);
  const code = await runCli(args, harness);
  return {
    code,
    stdout: harness.out.join(""),
    stderr: harness.err.join(""),
    stateRoot
  };
}

function writeFixture(dir, value) {
  const file = path.join(dir, "fixture.json");
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function resultPath(stateRoot, id) {
  return path.join(stateRoot, "sessions", id, "result.json");
}

function readResult(stateRoot, id) {
  return JSON.parse(fs.readFileSync(resultPath(stateRoot, id), "utf8"));
}

test("fake sequence run persists normalized session result", async () => {
  const stateRoot = tempRoot("run");
  const result = await cli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "test plan",
    "--json"
  ], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  assert.equal(parsed.schema_version, "converge-loop.result.v1");
  const sessionDir = path.join(stateRoot, "sessions", findSingleSessionId(stateRoot));
  assert.ok(fs.existsSync(path.join(sessionDir, "session.json")));
  assert.ok(fs.existsSync(path.join(sessionDir, "turns.jsonl")));
  assert.ok(fs.existsSync(path.join(sessionDir, "transcript.md")));
  assert.ok(fs.existsSync(path.join(sessionDir, "evidence-ledger.jsonl")));
  assert.ok(fs.existsSync(path.join(sessionDir, "result.json")));
});

test("run validation rejects branch scope without base", async () => {
  const result = await cli(["run", "--scope", "branch", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--scope branch requires --base/);
});

test("default real adapters fail closed without explicit safe local adapter enablement", async () => {
  const result = await cli(["run", "--topic", "x", "--json"]);
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /run `converge-loop setup`/);
  assert.doesNotMatch(parsed.summary, /CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS/);
});

test("setup verifies local cli readiness and enables real adapters without env flag", async () => {
  const stateRoot = tempRoot("setup");
  const binDir = path.join(stateRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const codex = path.join(binDir, "codex");
  const claude = path.join(binDir, "claude");
  fs.writeFileSync(codex, "#!/bin/sh\nif [ \"$1\" = \"exec\" ]; then echo 'Usage: codex exec --sandbox --cd'; exit 0; fi\necho 'codex';\n");
  fs.writeFileSync(claude, "#!/bin/sh\necho 'Usage: claude --print --permission-mode --disallowedTools --output-format';\n");
  fs.chmodSync(codex, 0o755);
  fs.chmodSync(claude, 0o755);
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  delete harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  const setupCode = await runCli(["setup", "--json"], harness);
  assert.equal(setupCode, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, true);
  assert.equal(setup.enabled, true);
  assert.equal(setup.checks.codex.ok, true);
  assert.equal(setup.checks.claude.ok, true);
  assert.ok(fs.existsSync(setup.config_path));

  const runHarness = io(stateRoot);
  runHarness.env.PATH = harness.env.PATH;
  delete runHarness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const runCode = await runCli(["run", "--topic", "configured local adapters", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "agreed");
  assert.deepEqual(parsed.participants.map((participant) => participant.adapter), ["codex", "claude"]);
});

test("setup reports unavailable local cli controls without enabling adapters", async () => {
  const stateRoot = tempRoot("setup-unavailable");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_CODEX_BIN = path.join(stateRoot, "missing-codex");
  harness.env.CONVERGE_LOOP_CLAUDE_BIN = path.join(stateRoot, "missing-claude");
  const code = await runCli(["setup", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.enabled, false);
  assert.match(parsed.next_step, /Install and authenticate/);
});

test("host aliases select the expected default opposite-agent order", () => {
  const options = { agents: null, roles: null };
  for (const host of [undefined, "", "akx", "codex", "openai"]) {
    assert.deepEqual(
      buildParticipants(options, { CONVERGE_LOOP_HOST: host }).map((participant) => participant.adapter),
      ["codex", "claude"]
    );
  }
  for (const host of ["akc", "claude", "claude-code", "anthropic"]) {
    assert.deepEqual(
      buildParticipants(options, { CONVERGE_LOOP_HOST: host }).map((participant) => participant.adapter),
      ["claude", "codex"]
    );
  }
  assert.throws(
    () => buildParticipants(options, { CONVERGE_LOOP_HOST: "gemini" }),
    /unsupported CONVERGE_LOOP_HOST: gemini/
  );
});

test("plugin root environment infers host when explicit host is unset", () => {
  const options = { agents: null, roles: null };
  assert.deepEqual(
    buildParticipants(options, { CLAUDE_PLUGIN_ROOT: repoRoot }).map((participant) => participant.adapter),
    ["claude", "codex"]
  );
  assert.deepEqual(
    buildParticipants(options, { PLUGIN_ROOT: repoRoot }).map((participant) => participant.adapter),
    ["codex", "claude"]
  );
  assert.deepEqual(
    buildParticipants(options, { CLAUDE_PLUGIN_ROOT: repoRoot, PLUGIN_ROOT: repoRoot }).map((participant) => participant.adapter),
    ["claude", "codex"]
  );
  assert.deepEqual(
    buildParticipants(options, { CONVERGE_LOOP_HOST: "akx", CLAUDE_PLUGIN_ROOT: repoRoot }).map((participant) => participant.adapter),
    ["codex", "claude"]
  );
});

test("run fails fast for unsupported explicit host", async () => {
  const stateRoot = tempRoot("bad-host");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_HOST = "gemini";
  const code = await runCli(["run", "--topic", "x", "--json"], harness);
  assert.equal(code, 1);
  assert.deepEqual(
    harness.out,
    []
  );
  assert.match(harness.err.join(""), /unsupported CONVERGE_LOOP_HOST: gemini/);
});

test("host aliases are recorded as normalized host_agent values", async () => {
  const stateRoot = tempRoot("host-record");
  const harness = io(stateRoot);
  harness.env.CLAUDE_PLUGIN_ROOT = repoRoot;
  const code = await runCli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "host record",
    "--json"
  ], harness);
  assert.equal(code, 0, harness.err.join(""));
  assert.equal(JSON.parse(harness.out.join("")).host_agent, "claude");
});

test("background job records host and cancel-before-init preserves it", async () => {
  const stateRoot = tempRoot("cancel-host");
  const harness = io(stateRoot);
  harness.env.CLAUDE_PLUGIN_ROOT = repoRoot;
  const runCode = await runCli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "cancel before init",
    "--turn-delay-ms",
    "500",
    "--background"
  ], harness);
  assert.equal(runCode, 0, harness.err.join(""));
  const sessionId = harness.out.join("").trim();
  const job = JSON.parse(fs.readFileSync(path.join(stateRoot, "jobs", `${sessionId}.json`), "utf8"));
  assert.equal(job.host_agent, "claude");
  fs.rmSync(path.join(stateRoot, "sessions", sessionId), { recursive: true, force: true });
  const cancelHarness = io(stateRoot);
  cancelHarness.env.CLAUDE_PLUGIN_ROOT = repoRoot;
  const cancelCode = await runCli(["cancel", sessionId], cancelHarness);
  assert.equal(cancelCode, 0, cancelHarness.err.join(""));
  assert.equal(readResult(stateRoot, sessionId).host_agent, "claude");
});

test("claude command surface is discoverable as a single command", () => {
  const manifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");
  const commandDir = path.join(repoRoot, "commands");
  const commandPath = path.join(commandDir, "converge-loop.md");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "converge-loop");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(typeof manifest.description, "string");
  assert.equal(manifest.author?.name, "Tennison Chan");
  assert.deepEqual(fs.readdirSync(commandDir), ["converge-loop.md"]);
  const command = fs.readFileSync(commandPath, "utf8");
  assert.match(command, /CLAUDE_PLUGIN_ROOT/);
  assert.match(command, /setup \[--json\]/);
  assert.doesNotMatch(command, /CONVERGE_LOOP_HOST/);
});

test("help presents host-aware run example before fake adapter smoke paths", async () => {
  const result = await cli(["help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /converge-loop setup/);
  assert.match(result.stdout, /converge-loop run --topic/);
  assert.doesNotMatch(result.stdout, /CONVERGE_LOOP_HOST=akx/);
  assert.doesNotMatch(result.stdout, /fake-sequence,fake-sequence/);
});

test("codex skill owns codex host identity without exposing old akx setup", () => {
  const skill = fs.readFileSync(path.join(repoRoot, "skills/converge-loop/SKILL.md"), "utf8");
  const setupSkill = fs.readFileSync(path.join(repoRoot, "skills/converge-loop-setup/SKILL.md"), "utf8");
  assert.match(skill, /CONVERGE_LOOP_HOST=codex converge-loop run/);
  assert.match(skill, /CONVERGE_LOOP_HOST=codex converge-loop setup/);
  assert.match(skill, /CONVERGE_LOOP_HOST=codex node scripts\/bin\/converge-loop\.mjs run/);
  assert.match(skill, /CLAUDE_PLUGIN_ROOT/);
  assert.match(skill, /converge-loop setup/);
  assert.match(setupSkill, /converge-loop\.mjs" setup/);
  assert.doesNotMatch(setupSkill, /CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS/);
  assert.doesNotMatch(skill, /CONVERGE_LOOP_HOST=akx/);
  assert.doesNotMatch(skill, /CONVERGE_LOOP_HOST=akc/);
});

test("fixture coverage includes terminal statuses", async () => {
  const cases = [
    ["needs_evidence", { status: "needs_evidence", evidence_requests: ["logs"] }],
    ["operator_intervention", { status: "operator_intervention", operator_intervention_points: ["choose"] }],
    ["clear_disagreement", { status: "clear_disagreement", pushbacks: ["risk"] }]
  ];
  for (const [expected, control] of cases) {
    const stateRoot = tempRoot(expected);
    const fixture = writeFixture(stateRoot, { turns: [{ message: expected, control }] });
    const result = await cli([
      "run",
      "--agents",
      "fake-replay,fake-replay",
      "--topic",
      expected,
      "--fixture",
      fixture,
      "--json"
    ], stateRoot);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, expected);
  }
});

test("max turns and read-only violations produce terminal results", async () => {
  const maxTurns = await cli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "turn cap",
    "--max-turns",
    "1",
    "--json"
  ]);
  assert.equal(JSON.parse(maxTurns.stdout).status, "max_turns");

  const blocked = await cli([
    "run",
    "--agents",
    "fake-tooling,fake-tooling",
    "--topic",
    "WRITE_VIOLATION",
    "--json"
  ]);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
});

test("result export requires explicit versioned export when destination is tracked-visible", async () => {
  const stateRoot = tempRoot("export");
  const run = await cli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "export",
    "--json"
  ], stateRoot);
  const actualId = findSingleSessionId(stateRoot);
  const blocked = await cli(["result", actualId, "--export", ".converge-loop/test-export"], stateRoot);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /not ignored/);
  const allowed = await cli(["result", actualId, "--export", ".converge-loop/test-export", "--allow-versioned-export"], stateRoot);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.ok(fs.existsSync(path.join(repoRoot, ".converge-loop/test-export/result.json")));
  fs.rmSync(path.join(repoRoot, ".converge-loop"), { recursive: true, force: true });
});

test("resume continues from an allowed terminal state", async () => {
  const stateRoot = tempRoot("resume");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "need logs", control: { status: "needs_evidence", evidence_requests: ["logs"] } },
      { message: "resolved", control: { status: "agreed", agreements: ["done"], ready_to_converge: true } }
    ]
  });
  const run = await cli([
    "run",
    "--agents",
    "fake-replay,fake-replay",
    "--topic",
    "resume",
    "--fixture",
    fixture,
    "--json"
  ], stateRoot);
  const sessionId = findSingleSessionId(stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "needs_evidence");
  const resumed = await cli(["resume", sessionId, "--fixture", fixture, "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
  const session = JSON.parse(fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "session.json"), "utf8"));
  assert.equal(session.options.scope, "working-tree");
  assert.equal(session.options.maxTurns, 8);
});

test("agreed on the first participant turn still waits for the second participant", async () => {
  const stateRoot = tempRoot("minturn");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "premature", control: { status: "agreed", agreements: ["early"], ready_to_converge: true } },
      { message: "confirmed", control: { status: "agreed", agreements: ["confirmed"], ready_to_converge: true } }
    ]
  });
  const result = await cli([
    "run",
    "--agents",
    "fake-replay,fake-replay",
    "--topic",
    "min turn",
    "--fixture",
    fixture,
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  assert.equal(parsed.turn_count, 2);
});

test("local cli adapter preflight can be exercised without enabling unsafe execution", async () => {
  const stateRoot = tempRoot("local-preflight");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  const result = await runCli(["run", "--agents", "codex,claude", "--topic", "preflight", "--web", "shared", "--json"], harness);
  assert.equal(result, 0);
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /shared web adapter execution is not implemented/);
});

test("default opposite-agent preflight can fall back to degraded host participant", async () => {
  const stateRoot = tempRoot("fallback");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_HOST = "codex";
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  harness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const code = await runCli(["run", "--topic", "fallback", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "agreed");
  assert.equal(parsed.independent_provider_coverage, false);
  assert.match(parsed.summary, /degraded fallback/i);
  assert.deepEqual(parsed.participants.map((participant) => participant.adapter), ["codex", "codex"]);
  assert.equal(parsed.participants[1].tier, "fallback");
  assert.equal(parsed.participants[1].fallback_for, "claude");
  assert.equal(parsed.fallbacks_used.length, 1);
  const sessionId = findSingleSessionId(stateRoot);
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.match(transcript, /degraded fallback/i);
});

test("explicit agents do not use degraded fallback implicitly", async () => {
  const stateRoot = tempRoot("explicit-no-fallback");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  const code = await runCli(["run", "--agents", "codex,claude", "--topic", "explicit", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /claude adapter forced unavailable/);
  assert.equal(parsed.fallbacks_used.length, 0);
});

test("shared web remains fail-closed under current local adapter capabilities", async () => {
  const stateRoot = tempRoot("shared-web-block");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  const code = await runCli(["run", "--topic", "shared web", "--web", "shared", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /shared web adapter execution is not implemented/);
});

test("status reports a starting job before session files exist", async () => {
  const stateRoot = tempRoot("starting");
  const storeRoot = path.join(stateRoot, "jobs");
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.writeFileSync(path.join(storeRoot, "pending.json"), JSON.stringify({
    schema_version: "converge-loop.job.v1",
    id: "pending",
    pid: process.pid,
    command: [],
    cwd: repoRoot,
    created_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    status: "starting",
    session_path: path.join(stateRoot, "sessions", "pending"),
    turn_timeout_seconds: 180
  }));
  const result = await cli(["status", "pending"], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /pending starting job=starting/);
});

test("background run creates a job and terminal status", async () => {
  const stateRoot = tempRoot("background");
  const run = await cli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "background",
    "--background"
  ], stateRoot);
  assert.equal(run.code, 0, run.stderr);
  const sessionId = run.stdout.trim();
  await waitFor(() => fs.existsSync(resultPath(stateRoot, sessionId)));
  const status = await cli(["status", sessionId], stateRoot);
  assert.match(status.stdout, new RegExp(`${sessionId} agreed`));
});

test("cancel marks a running background job canceled", async () => {
  const stateRoot = tempRoot("cancel");
  const run = await cli([
    "run",
    "--agents",
    "fake-sequence,fake-sequence",
    "--topic",
    "cancel",
    "--turn-delay-ms",
    "500",
    "--background"
  ], stateRoot);
  assert.equal(run.code, 0, run.stderr);
  const sessionId = run.stdout.trim();
  const cancel = await cli(["cancel", sessionId], stateRoot);
  assert.equal(cancel.code, 0, cancel.stderr);
  await waitFor(() => fs.existsSync(resultPath(stateRoot, sessionId)));
  assert.equal(readResult(stateRoot, sessionId).status, "canceled");
});

function findSingleSessionId(stateRoot) {
  const sessions = fs.readdirSync(path.join(stateRoot, "sessions"));
  assert.equal(sessions.length, 1);
  return sessions[0];
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("timed out waiting for predicate");
}
