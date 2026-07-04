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

function writeLocalCliPair(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const codex = path.join(dir, "codex");
  const claude = path.join(dir, "claude");
  const codexHelp = overrides.codexHelp || "Usage: codex exec --sandbox --cd --ignore-user-config";
  const claudeHelp = overrides.claudeHelp || "Usage: claude --print --permission-mode --disallowedTools --output-format --safe-mode";
  const codexAuth = overrides.codexAuth ?? "Logged in using ChatGPT\n";
  const claudeAuth = overrides.claudeAuth ?? "{\"loggedIn\":true,\"authMethod\":\"oauth\"}\n";
  const codexAuthExit = overrides.codexAuthExit ?? 0;
  const claudeAuthExit = overrides.claudeAuthExit ?? 0;
  fs.writeFileSync(codex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write(${JSON.stringify(`${codexHelp}\n`)});
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write(${JSON.stringify(codexAuth)});
  process.exit(${codexAuthExit});
}
if (args[0] === "exec") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const nonce = /nonce ([a-f0-9]+)/i.exec(input)?.[1] || "missing";
    process.stdout.write("codex smoke ok\\n<<<CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n" + JSON.stringify({
      status: "agreed",
      confidence: "high",
      agreements: ["codex local cli invoked"],
      ready_to_converge: true
    }) + "\\n<<<END_CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n");
  });
} else {
  process.stdout.write("codex\\n");
}
`);
  fs.writeFileSync(claude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--help") {
  process.stdout.write(${JSON.stringify(`${claudeHelp}\n`)});
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status" && args[2] === "--json") {
  process.stdout.write(${JSON.stringify(claudeAuth)});
  process.exit(${claudeAuthExit});
}
const prompt = args.join(" ");
const nonce = /nonce ([a-f0-9]+)/i.exec(prompt)?.[1] || "missing";
process.stdout.write("claude smoke ok\\n<<<CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n" + JSON.stringify({
  status: "agreed",
  confidence: "high",
  agreements: ["claude local cli invoked"],
  ready_to_converge: true
}) + "\\n<<<END_CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n");
`);
  fs.chmodSync(codex, 0o755);
  fs.chmodSync(claude, 0o755);
  return { codex, claude, binDir: dir };
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
  writeLocalCliPair(binDir);
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
  assert.equal(setup.checks.codex.auth.ok, true);
  assert.equal(setup.checks.claude.auth.ok, true);
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

test("setup --check-only reports readiness without writing config", async () => {
  const stateRoot = tempRoot("setup-check-only");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  const code = await runCli(["setup", "--check-only", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, true);
  assert.equal(setup.mode, "check-only");
  assert.equal(setup.config_changed, false);
  assert.deepEqual(setup.actions, []);
  assert.equal(fs.existsSync(setup.config_path), false);
});

test("setup --check-only fails closed without writing config when readiness fails", async () => {
  const stateRoot = tempRoot("setup-check-only-fail");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_CODEX_BIN = path.join(stateRoot, "missing-codex");
  harness.env.CONVERGE_LOOP_CLAUDE_BIN = path.join(stateRoot, "missing-claude");
  const code = await runCli(["setup", "--check-only", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, false);
  assert.equal(setup.enabled, false);
  assert.equal(setup.mode, "check-only");
  assert.equal(setup.config_changed, false);
  assert.deepEqual(setup.actions, []);
  assert.equal(fs.existsSync(setup.config_path), false);
});

test("setup --disable writes disabled config and runtime stays blocked", async () => {
  const stateRoot = tempRoot("setup-disable");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  const code = await runCli(["setup", "--disable", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, true);
  assert.equal(setup.enabled, false);
  assert.equal(setup.mode, "disable");
  assert.match(setup.warnings.join("\n"), /overrides setup config/);
  const config = JSON.parse(fs.readFileSync(setup.config_path, "utf8"));
  assert.equal(config.enabled, false);
  assert.match(config.disabled_at, /\d{4}-\d{2}-\d{2}T/);

  const runHarness = io(stateRoot);
  runHarness.env.PATH = `${binDir}${path.delimiter}${runHarness.env.PATH || ""}`;
  runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  delete runHarness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  const runCode = await runCli(["run", "--topic", "disabled", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /run `converge-loop setup`/);
});

test("setup rejects incompatible control flags", async () => {
  for (const args of [
    ["setup", "--disable", "--check-only"],
    ["setup", "--disable", "--smoke"],
    ["setup", "--check-only", "--smoke"]
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot be combined/);
  }
});

test("setup auth checks fail closed on unauthenticated or ambiguous output", async () => {
  const cases = [
    ["codex-not-logged-in", { codexAuth: "Not logged in\n" }, /not recognized as authenticated/],
    ["codex-ambiguous", { codexAuth: "Ready\n" }, /not recognized as authenticated/],
    ["claude-malformed", { claudeAuth: "not-json\n" }, /valid JSON/],
    ["claude-logged-out", { claudeAuth: "{\"loggedIn\":false}\n" }, /not logged in/]
  ];
  for (const [name, overrides, reason] of cases) {
    const stateRoot = tempRoot(name);
    const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"), overrides);
    const harness = io(stateRoot);
    harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
    const code = await runCli(["setup", "--json"], harness);
    assert.equal(code, 0, harness.err.join(""));
    const setup = JSON.parse(harness.out.join(""));
    assert.equal(setup.ok, false);
    assert.equal(setup.enabled, false);
    assert.match(JSON.stringify(setup.checks), reason);
    const config = JSON.parse(fs.readFileSync(setup.config_path, "utf8"));
    assert.equal(config.enabled, false);
  }
});

test("run remains blocked after auth-failed setup writes disabled config", async () => {
  const stateRoot = tempRoot("auth-failed-run-blocked");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"), { codexAuth: "Not logged in\n" });
  const setupHarness = io(stateRoot);
  setupHarness.env.PATH = `${binDir}${path.delimiter}${setupHarness.env.PATH || ""}`;
  const setupCode = await runCli(["setup", "--json"], setupHarness);
  assert.equal(setupCode, 0, setupHarness.err.join(""));
  const setup = JSON.parse(setupHarness.out.join(""));
  assert.equal(setup.ok, false);
  assert.equal(setup.enabled, false);

  const runHarness = io(stateRoot);
  runHarness.env.PATH = `${binDir}${path.delimiter}${runHarness.env.PATH || ""}`;
  runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const runCode = await runCli(["run", "--topic", "auth failed", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /run `converge-loop setup`/);
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

test("runtime preflight rechecks the same required flags as setup", async () => {
  const stateRoot = tempRoot("runtime-preflight-flags");
  const binDir = path.join(stateRoot, "bin");
  const firstPair = writeLocalCliPair(binDir);
  const setupHarness = io(stateRoot);
  setupHarness.env.PATH = `${binDir}${path.delimiter}${setupHarness.env.PATH || ""}`;
  setupHarness.env.CONVERGE_LOOP_CODEX_BIN = firstPair.codex;
  setupHarness.env.CONVERGE_LOOP_CLAUDE_BIN = firstPair.claude;
  const setupCode = await runCli(["setup", "--json"], setupHarness);
  assert.equal(setupCode, 0, setupHarness.err.join(""));
  assert.equal(JSON.parse(setupHarness.out.join("")).enabled, true);

  const secondPair = writeLocalCliPair(binDir, { codexHelp: "Usage: codex exec --sandbox" });
  const runHarness = io(stateRoot);
  runHarness.env.PATH = `${binDir}${path.delimiter}${runHarness.env.PATH || ""}`;
  runHarness.env.CONVERGE_LOOP_CODEX_BIN = secondPair.codex;
  runHarness.env.CONVERGE_LOOP_CLAUDE_BIN = secondPair.claude;
  runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const runCode = await runCli(["run", "--topic", "runtime flags", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /missing required read-only flags: --cd/);
});

test("setup --smoke uses explicit codex and claude adapters without fallback", async () => {
  const stateRoot = tempRoot("setup-smoke");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  const code = await runCli(["setup", "--smoke", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, true);
  assert.equal(setup.enabled, true);
  assert.equal(setup.smoke.ok, true);
  assert.deepEqual(setup.smoke.participants, ["codex", "claude"]);
  assert.equal(setup.smoke.independent_provider_coverage, true);
  assert.deepEqual(setup.smoke.fallbacks_used, []);
  assert.equal(setup.smoke.diagnostic_path, null);
  assert.ok(fs.existsSync(setup.config_path));
});

test("setup --smoke fails closed instead of falling back when secondary adapter is unavailable", async () => {
  const stateRoot = tempRoot("setup-smoke-no-fallback");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  const code = await runCli(["setup", "--smoke", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, false);
  assert.equal(setup.enabled, false);
  assert.equal(setup.smoke.ok, false);
  assert.match(setup.smoke.reason, /independent provider coverage/);
  assert.ok(setup.smoke.diagnostic_path);
  const config = JSON.parse(fs.readFileSync(setup.config_path, "utf8"));
  assert.equal(config.enabled, false);
});

test("setup --smoke refuses fake local cli turn shortcut", async () => {
  const stateRoot = tempRoot("setup-smoke-fake-refused");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  harness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const code = await runCli(["setup", "--smoke", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const setup = JSON.parse(harness.out.join(""));
  assert.equal(setup.ok, false);
  assert.equal(setup.enabled, false);
  assert.match(setup.smoke.reason, /cannot run with CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE/);
  assert.match(setup.warnings.join("\n"), /deterministic tests only/);
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
