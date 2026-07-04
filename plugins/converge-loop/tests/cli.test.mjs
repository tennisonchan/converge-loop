import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildParticipants } from "../scripts/lib/adapters.mjs";
import { runCli } from "../scripts/lib/cli.mjs";
import { hasNewProgress, parseParticipantOutput } from "../scripts/lib/control.mjs";
import { buildTurnPrompt, loadMaterials } from "../scripts/lib/orchestrator.mjs";

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

// Deterministic participant pairs use the test-restricted --fake-adapters
// flag; the public run surface only exposes the host primary plus --counterpart.
// Run-specific: pass run options only, without the "run" subcommand.
function cliFakes(pair, args, stateRoot, cwd) {
  return cli(["run", "--fake-adapters", pair, ...args], stateRoot, cwd);
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
  const codexHelp = overrides.codexHelp || "Usage: codex exec --sandbox --cd --ignore-user-config --output-schema --output-last-message --model";
  const claudeHelp = overrides.claudeHelp || "Usage: claude --print --permission-mode --disallowedTools --output-format --safe-mode --json-schema --model --verbose --include-partial-messages";
  const codexAuth = overrides.codexAuth ?? "Logged in using ChatGPT\n";
  const claudeAuth = overrides.claudeAuth ?? "{\"loggedIn\":true,\"authMethod\":\"oauth\"}\n";
  const codexAuthExit = overrides.codexAuthExit ?? 0;
  const claudeAuthExit = overrides.claudeAuthExit ?? 0;
  fs.writeFileSync(codex, `#!/usr/bin/env node
const fs = require("node:fs");
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
  ${overrides.codexExecFail ? 'process.stderr.write("codex stub forced invoke failure token=abc123secretvalue\\n"); process.exit(1);' : ""}
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const modelIndex = args.indexOf("--model");
    const model = modelIndex === -1 ? "default" : args[modelIndex + 1];
    const structured = {
      message: "codex smoke ok model=" + model,
      control: {
        status: "agreed",
        confidence: "high",
        agreements: ["codex local cli invoked"],
        ready_to_converge: true
      }
    };
    const outIndex = args.indexOf("--output-last-message");
    if (outIndex !== -1 && args[outIndex + 1]) {
      fs.writeFileSync(args[outIndex + 1], JSON.stringify(structured));
      process.stdout.write("codex smoke ok\\n");
      return;
    }
    const nonce = /<<<CONVERGE_LOOP_CONTROL ([a-f0-9]+)>>>/i.exec(input)?.[1] || "missing";
    process.stdout.write("codex smoke ok\\n<<<CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n" + JSON.stringify(structured.control) + "\\n<<<END_CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n");
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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const modelIndex = args.indexOf("--model");
  const model = modelIndex === -1 ? "default" : args[modelIndex + 1];
  const structured = {
    message: "claude smoke ok model=" + model,
    control: {
      status: "agreed",
      confidence: "high",
      agreements: ["claude local cli invoked"],
      ready_to_converge: true
    }
  };
  if (args.includes("--json-schema")) {
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: "claude smoke ok",
      structured_output: structured
    });
    if (args.includes("stream-json")) {
      // Mirror real stream-json output: event lines first, result envelope last.
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta" } }) + "\\n");
      process.stdout.write(envelope + "\\n");
      return;
    }
    process.stdout.write(envelope + "\\n");
    return;
  }
  const nonce = /<<<CONVERGE_LOOP_CONTROL ([a-f0-9]+)>>>/i.exec(input)?.[1] || "missing";
  process.stdout.write("claude smoke ok\\n<<<CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n" + JSON.stringify(structured.control) + "\\n<<<END_CONVERGE_LOOP_CONTROL " + nonce + ">>>\\n");
});
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

function readTurns(stateRoot, id) {
  const file = path.join(stateRoot, "sessions", id, "turns.jsonl");
  return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
}

test("fake sequence run persists normalized session result", async () => {
  const stateRoot = tempRoot("run");
  const result = await cliFakes("fake-sequence,fake-sequence", [
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

test("--agents is no longer a public run option", async () => {
  const result = await cli(["run", "--agents", "codex,claude", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown run option: --agents/);
});

test("--counterpart accepts only codex or claude", async () => {
  const result = await cli(["run", "--counterpart", "fake-sequence", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--counterpart must be one of codex, claude/);
});

test("--counterpart pairs the host primary with the selected agent", async () => {
  const stateRoot = tempRoot("secondary-pair");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_HOST = "codex";
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const code = await runCli(["run", "--counterpart", "codex", "--topic", "same provider", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "agreed");
  assert.deepEqual(parsed.participants.map((participant) => participant.adapter), ["codex", "codex"]);
  assert.equal(parsed.independent_provider_coverage, false);
  assert.deepEqual(parsed.fallbacks_used, []);
});

test("--counterpart from a claude host keeps the host primary first", async () => {
  const stateRoot = tempRoot("counterpart-claude-host");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_HOST = "claude";
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE = "1";
  const code = await runCli(["run", "--counterpart", "codex", "--topic", "claude host order", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.deepEqual(parsed.participants.map((participant) => participant.adapter), ["claude", "codex"]);
});

test("--counterpart explicit selection does not fall back when unavailable", async () => {
  const stateRoot = tempRoot("secondary-no-fallback");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_HOST = "codex";
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  const code = await runCli(["run", "--counterpart", "claude", "--topic", "explicit secondary", "--json"], harness);
  assert.equal(code, 0, harness.err.join(""));
  const parsed = JSON.parse(harness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /claude adapter forced unavailable/);
  assert.deepEqual(parsed.fallbacks_used, []);
});

test("--counterpart cannot be combined with --fake-adapters", async () => {
  const result = await cli(["run", "--counterpart", "claude", "--fake-adapters", "fake-sequence,fake-sequence", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--counterpart cannot be combined with --fake-adapters/);
});

test("--fake-adapters must name exactly two participants", async () => {
  const result = await cli(["run", "--fake-adapters", "fake-sequence", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exactly two participants/);
});

test("--fake-adapters refuses real adapters", async () => {
  const result = await cli(["run", "--fake-adapters", "codex,claude", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /only accepts fake-sequence, fake-replay, fake-tooling; got: codex, claude/);
});

test("--fake-adapters rejects unknown fake adapter names at parse time", async () => {
  const result = await cli(["run", "--fake-adapters", "fake-seqence,fake-sequence", "--topic", "x"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /got: fake-seqence/);
});

test("--roles rejects more stances than participants", async () => {
  const result = await cli(["run", "--topic", "x", "--roles", "a,b,c"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--roles requires one or two entries/);
});

test("--roles rejects an empty stance list instead of silently dropping defaults", async () => {
  const result = await cli(["run", "--topic", "x", "--roles", ""]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--roles requires one or two entries/);
});

test("--roles with a single stance keeps the second participant's default role", async () => {
  const stateRoot = tempRoot("single-role");
  const result = await cliFakes("fake-sequence,fake-sequence", ["--roles", "proposer", "--topic", "single role", "--json"], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  assert.deepEqual(parsed.participants.map((participant) => participant.role), ["proposer", "participant-2"]);
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
    "--fake-adapters",
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
    "--fake-adapters",
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

test("participant output schema satisfies OpenAI strict structured-output rules", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "participant-output.schema.json"), "utf8"));
  const checkStrict = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object" && node.properties) {
      assert.equal(node.additionalProperties, false, `${at} must set additionalProperties false`);
      const keys = Object.keys(node.properties).sort();
      const required = [...(node.required || [])].sort();
      assert.deepEqual(required, keys, `${at} required must list every property`);
      for (const [key, child] of Object.entries(node.properties)) checkStrict(child, `${at}.${key}`);
    }
    if (node.items) checkStrict(node.items, `${at}[]`);
  };
  checkStrict(schema, "schema");
});

test("manifest and marketplace versions stay in lockstep", () => {
  const rootDir = path.join(repoRoot, "..", "..");
  const versions = {
    "package.json": JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version,
    ".codex-plugin/plugin.json": JSON.parse(fs.readFileSync(path.join(repoRoot, ".codex-plugin", "plugin.json"), "utf8")).version,
    ".claude-plugin/plugin.json": JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")).version,
    "marketplace metadata": JSON.parse(fs.readFileSync(path.join(rootDir, ".claude-plugin", "marketplace.json"), "utf8")).metadata.version,
    "marketplace plugin": JSON.parse(fs.readFileSync(path.join(rootDir, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].version
  };
  const distinct = [...new Set(Object.values(versions))];
  assert.equal(distinct.length, 1, `version drift: ${JSON.stringify(versions)}`);
});

test("claude marketplace exposes the plugin from the repository root", () => {
  const marketplacePath = path.join(repoRoot, "..", "..", ".claude-plugin", "marketplace.json");
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  assert.equal(marketplace.name, "converge-loop");
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "converge-loop");
  assert.equal(marketplace.plugins[0].source, "./plugins/converge-loop");
  const codexMarketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, "..", "..", ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(codexMarketplace.plugins[0].source.path, "./plugins/converge-loop");
});

test("claude command surface is discoverable as a single command", () => {
  const manifestPath = path.join(repoRoot, ".claude-plugin", "plugin.json");
  const commandDir = path.join(repoRoot, "commands");
  const commandPath = path.join(commandDir, "converge-loop.md");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.name, "converge-loop");
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version);
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
    const result = await cliFakes("fake-replay,fake-replay", [
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

test("control parser accepts nonce-matching fenced json fallback", () => {
  const parsed = parseParticipantOutput(`Smoke turn complete.

\`\`\`json
{
  "nonce": "abc123",
  "role": "critic",
  "topic": "converge-loop setup smoke",
  "status": "agreed",
  "ready_to_converge": true,
  "objections": [],
  "follow_up_evidence_requested": false
}
\`\`\`
`, { nonce: "abc123" });
  assert.equal(parsed.control.status, "agreed");
  assert.equal(parsed.control.ready_to_converge, true);
  assert.equal(parsed.control.nonce, undefined);
  assert.equal(parsed.message.trim(), "Smoke turn complete.");
});

test("control parser accepts root-level json control", () => {
  const parsed = parseParticipantOutput(JSON.stringify({
    nonce: "abc123",
    status: "agreed",
    ready_to_converge: true,
    notes: "Local CLI invocation and control block verified working."
  }), { nonce: "abc123" });
  assert.equal(parsed.control.status, "agreed");
  assert.equal(parsed.control.ready_to_converge, true);
  assert.equal(parsed.control.nonce, undefined);
  assert.equal(parsed.message, "Local CLI invocation and control block verified working.");
});

test("max turns and read-only violations produce terminal results", async () => {
  const maxTurns = await cliFakes("fake-sequence,fake-sequence", [
    "--topic",
    "turn cap",
    "--max-turns",
    "1",
    "--json"
  ]);
  assert.equal(JSON.parse(maxTurns.stdout).status, "max_turns");

  const blocked = await cliFakes("fake-tooling,fake-tooling", [
    "--topic",
    "WRITE_VIOLATION",
    "--json"
  ]);
  assert.equal(JSON.parse(blocked.stdout).status, "blocked");
});

test("stalled adapter turn records adapter failure instead of remaining running", async () => {
  const stateRoot = tempRoot("adapter-timeout");
  const fixture = writeFixture(stateRoot, {
    turns: [
      {
        message: "proposer completed",
        control: { status: "continue", improvements: ["first turn persisted"], ready_to_converge: false }
      },
      {
        attempts: [
          "critic first attempt has no control block",
          {
            // Longer than the extended (2x) retry window too, so the turn
            // exhausts both the primary and the retry attempt.
            delay_ms: 2500,
            message: "critic repair would eventually respond",
            control: { status: "agreed", agreements: ["too late"], ready_to_converge: true }
          }
        ]
      }
    ]
  });
  const result = await cliFakes("fake-sequence,fake-sequence", [
    "--topic",
    "adapter timeout",
    "--fixture",
    fixture,
    "--turn-timeout-seconds",
    "1",
    "--json"
  ], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /^Adapter failure: fake-sequence participant turn timed out after 2000ms/);

  const sessionId = findSingleSessionId(stateRoot);
  const session = JSON.parse(fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "session.json"), "utf8"));
  const turns = readTurns(stateRoot, sessionId);
  assert.equal(session.state, "blocked");
  assert.equal(session.current_turn_index, 2);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].message, "proposer completed");
  assert.equal(turns[0].violation, null);
  assert.equal(turns[1].violation.type, "adapter_failure");
  assert.match(turns[1].message, /Adapter failed: fake-sequence participant turn timed out after 2000ms/);
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.match(transcript, /retrying once with extended limits \(timeout 2s/);
});

test("a timed-out turn is retried once with an extended window and can succeed", async () => {
  const stateRoot = tempRoot("timeout-retry");
  const fixture = writeFixture(stateRoot, {
    turns: [
      {
        // Slower than the 1s primary window, faster than the 2s retry window.
        delay_ms: 1500,
        message: "slow but real proposer turn",
        control: { status: "agreed", agreements: ["slow start"], ready_to_converge: true }
      },
      { message: "confirmed", control: { status: "agreed", agreements: ["confirmed"], ready_to_converge: true } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "timeout retry",
    "--fixture", fixture,
    "--turn-timeout-seconds", "1",
    "--json"
  ], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  const sessionId = findSingleSessionId(stateRoot);
  const turns = readTurns(stateRoot, sessionId);
  assert.equal(turns[0].message, "slow but real proposer turn");
  assert.equal(turns[0].violation, null);
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.match(transcript, /timed out after 1000ms.*retrying once with extended limits \(timeout 2s/);
});

test("per-adapter models flow from run flags and local-adapters config to the CLIs", async () => {
  const stateRoot = tempRoot("adapter-models");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const setupHarness = io(stateRoot);
  setupHarness.env.PATH = `${binDir}${path.delimiter}${setupHarness.env.PATH || ""}`;
  delete setupHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  const setupCode = await runCli(["setup", "--json"], setupHarness);
  assert.equal(setupCode, 0, setupHarness.err.join(""));
  const configPath = JSON.parse(setupHarness.out.join("")).config_path;
  // Operator-maintained persistent model default for claude.
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.adapters = { claude: { model: "sonnet-config" } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const runHarness = io(stateRoot);
  runHarness.env.PATH = setupHarness.env.PATH;
  delete runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  delete runHarness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  runHarness.env.CONVERGE_LOOP_HOST = "codex";
  const runCode = await runCli([
    "run",
    "--topic", "model plumbing",
    "--scope", "none",
    "--codex-model", "gpt-flag",
    "--json"
  ], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "agreed");
  const sessionId = findSingleSessionId(stateRoot);
  const turns = readTurns(stateRoot, sessionId);
  const byAdapter = Object.fromEntries(turns.map((turn) => [turn.adapter, turn.message]));
  assert.equal(byAdapter.codex, "codex smoke ok model=gpt-flag");
  assert.equal(byAdapter.claude, "claude smoke ok model=sonnet-config");
});

test("setup reruns preserve the operator-maintained adapters config block", async () => {
  const stateRoot = tempRoot("setup-preserve-adapters");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"));
  const harness = io(stateRoot);
  harness.env.PATH = `${binDir}${path.delimiter}${harness.env.PATH || ""}`;
  delete harness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  const firstCode = await runCli(["setup", "--json"], harness);
  assert.equal(firstCode, 0, harness.err.join(""));
  const configPath = JSON.parse(harness.out.join("")).config_path;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.adapters = { claude: { model: "sonnet-config" }, codex: { model: "gpt-config" } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const rerunHarness = io(stateRoot);
  rerunHarness.env.PATH = harness.env.PATH;
  delete rerunHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  const rerunCode = await runCli(["setup", "--json"], rerunHarness);
  assert.equal(rerunCode, 0, rerunHarness.err.join(""));
  const rewritten = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(rewritten.adapters, { claude: { model: "sonnet-config" }, codex: { model: "gpt-config" } });

  const disableHarness = io(stateRoot);
  disableHarness.env.PATH = harness.env.PATH;
  const disableCode = await runCli(["setup", "--disable", "--json"], disableHarness);
  assert.equal(disableCode, 0, disableHarness.err.join(""));
  const disabled = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.adapters, { claude: { model: "sonnet-config" }, codex: { model: "gpt-config" } });
});

test("result export requires explicit versioned export when destination is tracked-visible", async () => {
  const stateRoot = tempRoot("export");
  const run = await cliFakes("fake-sequence,fake-sequence", [
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
  const run = await cliFakes("fake-replay,fake-replay", [
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
  const result = await cliFakes("fake-replay,fake-replay", [
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
  harness.env.CONVERGE_LOOP_HOST = "codex";
  const result = await runCli(["run", "--counterpart", "claude", "--topic", "preflight", "--web", "shared", "--json"], harness);
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

test("explicit participant selection does not use degraded fallback implicitly", async () => {
  const stateRoot = tempRoot("explicit-no-fallback");
  const harness = io(stateRoot);
  harness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS = "1";
  harness.env.CONVERGE_LOOP_ASSUME_LOCAL_CLI_PREFLIGHT = "1";
  harness.env.CONVERGE_LOOP_TEST_UNAVAILABLE_ADAPTERS = "claude";
  harness.env.CONVERGE_LOOP_HOST = "codex";
  const code = await runCli(["run", "--counterpart", "claude", "--topic", "explicit", "--json"], harness);
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
  const run = await cliFakes("fake-sequence,fake-sequence", [
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
  const run = await cliFakes("fake-sequence,fake-sequence", [
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

test("turn prompt carries safety preamble, materials, transcript, and convergence contract", () => {
  const dir = tempRoot("prompt");
  const artifact = path.join(dir, "plan.md");
  fs.writeFileSync(artifact, "PLAN BODY CONTENT");
  const participants = [
    { id: "p1", adapter: "codex", role: "proposer" },
    { id: "p2", adapter: "claude", role: "critic" }
  ];
  const transcript = [{
    turn_index: 0,
    participant_role: "proposer",
    adapter: "codex",
    message: "proposal detail",
    control: { status: "continue", improvements: ["improve X"], ready_to_converge: true }
  }];
  const prompt = buildTurnPrompt({
    options: { topic: "storage design", focus: "converge", scope: "working-tree", cwd: "/repo", artifact, context: null },
    participant: participants[1],
    participants,
    transcript,
    nonce: "abc123",
    controlMode: "nonce-block",
    materials: loadMaterials({ artifact, context: null }),
    latestControls: new Map([["p1", { status: "continue", ready_to_converge: true }]])
  });
  assert.match(prompt, /read-only deliberation/i);
  assert.match(prompt, /Focus: converge/);
  assert.match(prompt, /Do not perform host-agent task management/);
  assert.match(prompt, /PLAN BODY CONTENT/);
  assert.match(prompt, /proposal detail/);
  assert.match(prompt, /improvements: improve X/);
  assert.match(prompt, /minor_reservations/);
  assert.match(prompt, /counterpart is ready to converge/i);
  assert.match(prompt, /<<<CONVERGE_LOOP_CONTROL abc123>>>/);

  const schemaPrompt = buildTurnPrompt({
    options: { topic: "storage design", scope: "none", cwd: "/repo" },
    participant: participants[0],
    participants,
    transcript: [],
    nonce: "abc123",
    controlMode: "json-schema"
  });
  assert.match(schemaPrompt, /satisfy the provided output schema/);
  assert.doesNotMatch(schemaPrompt, /<<<CONVERGE_LOOP_CONTROL/);
});

test("one participant declaring agreed with core pushbacks does not end the session agreed", async () => {
  const stateRoot = tempRoot("core-pushback");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "ready", control: { status: "agreed", agreements: ["direction"], ready_to_converge: true } },
      { message: "agree but blocked", control: { status: "agreed", ready_to_converge: true, pushbacks: ["storage model is wrong"] } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "core pushback",
    "--fixture", fixture,
    "--max-turns", "2",
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "max_turns");
  assert.deepEqual(parsed.remaining_disagreements, ["storage model is wrong"]);
});

test("minor reservations do not block convergence and are disclosed", async () => {
  const stateRoot = tempRoot("minor");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "proposal", control: { status: "continue", improvements: ["tighten scope"], ready_to_converge: false } },
      { message: "core pushback", control: { status: "continue", pushbacks: ["storage model is wrong"], ready_to_converge: false } },
      { message: "concede storage", control: { status: "continue", concessions: ["adopt suggested storage model"], ready_to_converge: true } },
      { message: "core agreed", control: { status: "agreed", ready_to_converge: true, minor_reservations: ["naming could be better"] } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "minor reservations",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  assert.equal(parsed.turn_count, 4);
  assert.deepEqual(parsed.remaining_disagreements, []);
  assert.deepEqual(parsed.minor_reservations, ["naming could be better"]);
  assert.deepEqual(parsed.pushbacks_resolved, ["storage model is wrong"]);
  assert.match(parsed.summary, /minor reservations remain/i);
});

test("repeated identical positions end as clear disagreement instead of running to max turns", async () => {
  const stateRoot = tempRoot("repeat");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "position A", control: { status: "continue", pushbacks: ["A"], ready_to_converge: false } },
      { message: "position B", control: { status: "continue", pushbacks: ["B"], ready_to_converge: false } },
      { message: "position A again", control: { status: "continue", pushbacks: ["A"], ready_to_converge: false } },
      { message: "position B again", control: { status: "continue", pushbacks: ["B"], ready_to_converge: false } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "repetition",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "clear_disagreement");
  assert.equal(parsed.turn_count, 4);
  assert.deepEqual(parsed.remaining_disagreements.sort(), ["A", "B"]);
});

test("missing control block triggers a repair retry before counting as no progress", async () => {
  const stateRoot = tempRoot("repair");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { attempts: ["free text with no control block", { message: "repaired", control: { status: "continue", improvements: ["x"], ready_to_converge: false } }] },
      { message: "agreed", control: { status: "agreed", agreements: ["fine"], ready_to_converge: true } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "repair",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  const sessionId = findSingleSessionId(stateRoot);
  const turns = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "turns.jsonl"), "utf8")
    .trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.equal(turns[0].message, "repaired");
  assert.deepEqual(turns[0].control.improvements, ["x"]);
});

test("top-level fixture delay applies to string and structured attempts", async () => {
  const stateRoot = tempRoot("attempt-delay");
  const fixture = writeFixture(stateRoot, {
    turns: [
      {
        delay_ms: 50,
        attempts: [
          "free text with no control block",
          { message: "repaired", control: { status: "continue", improvements: ["delayed repair"], ready_to_converge: false } }
        ]
      },
      { message: "agreed", control: { status: "agreed", agreements: ["done"], ready_to_converge: true } }
    ]
  });
  const started = Date.now();
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "attempt delay",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  const elapsedMs = Date.now() - started;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(elapsedMs >= 90, `expected both attempts to use top-level delay, elapsed ${elapsedMs}ms`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "agreed");
  const sessionId = findSingleSessionId(stateRoot);
  const turns = readTurns(stateRoot, sessionId);
  assert.equal(turns[0].message, "repaired");
  assert.deepEqual(turns[0].control.improvements, ["delayed repair"]);
});

test("resume seeds latest controls and result aggregates from pre-resume turns", async () => {
  const stateRoot = tempRoot("resume-seed");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "opening", control: { status: "needs_evidence", agreements: ["A0"], pushbacks: ["P0"], evidence_requests: ["logs"] } },
      { message: "evidence in hand", control: { status: "continue", concessions: ["logs reviewed"], ready_to_converge: true } },
      { message: "withdraw pushback", control: { status: "agreed", agreements: ["A2"], ready_to_converge: true } },
      { message: "confirm", control: { status: "agreed", ready_to_converge: true } }
    ]
  });
  const first = await cliFakes("fake-replay,fake-replay", [
    "--topic", "resume seeding",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(first.stdout).status, "needs_evidence");
  const sessionId = findSingleSessionId(stateRoot);
  const resumed = await cli(["resume", sessionId, "--fixture", fixture, "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  const result = readResult(stateRoot, sessionId);
  assert.equal(result.status, "agreed");
  assert.ok(result.agreements.includes("A0"), "pre-resume agreements survive resume");
  assert.ok(result.agreements.includes("A2"));
  assert.deepEqual(result.pushbacks_resolved, ["P0"]);
  assert.deepEqual(result.remaining_disagreements, []);
});

test("withdrawing a pushback without adding items still counts as progress", () => {
  assert.equal(hasNewProgress(
    { status: "continue", pushbacks: [], ready_to_converge: false },
    { status: "continue", pushbacks: ["A"], ready_to_converge: false }
  ), true);
  assert.equal(hasNewProgress(
    { status: "continue", pushbacks: ["A"], ready_to_converge: false },
    { status: "continue", pushbacks: ["A"], ready_to_converge: false }
  ), false);
});

test("--max-control-retries 0 disables repair retries", async () => {
  const stateRoot = tempRoot("no-retries");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { attempts: ["first attempt has no control", { message: "would repair", control: { status: "continue", improvements: ["x"] } }] },
      { message: "agreed", control: { status: "agreed", ready_to_converge: true } }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "no retries",
    "--fixture", fixture,
    "--max-control-retries", "0",
    "--json"
  ], stateRoot);
  assert.equal(result.code, 0, result.stderr);
  const sessionId = findSingleSessionId(stateRoot);
  const turns = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "turns.jsonl"), "utf8")
    .trim().split(/\n+/).map((line) => JSON.parse(line));
  assert.equal(turns[0].message, "first attempt has no control");
});

test("exhausted control repairs record the raw reply and end without progress", async () => {
  const stateRoot = tempRoot("repair-exhausted");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { attempts: ["still no control block", "still no control block either"] },
      { attempts: ["nothing parseable", "nothing parseable again"] }
    ]
  });
  const result = await cliFakes("fake-replay,fake-replay", [
    "--topic", "repair exhausted",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "blocked");
  assert.match(parsed.summary, /No progress was detected/);
});

test("invoke-time adapter failure swaps to the opposite adapter with degraded disclosure", async () => {
  const stateRoot = tempRoot("invoke-fallback");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"), { codexExecFail: true });
  const setupHarness = io(stateRoot);
  setupHarness.env.PATH = `${binDir}${path.delimiter}${setupHarness.env.PATH || ""}`;
  delete setupHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  const setupCode = await runCli(["setup", "--json"], setupHarness);
  assert.equal(setupCode, 0, setupHarness.err.join(""));
  assert.equal(JSON.parse(setupHarness.out.join("")).enabled, true);

  const runHarness = io(stateRoot);
  runHarness.env.PATH = setupHarness.env.PATH;
  delete runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  delete runHarness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  const runCode = await runCli(["run", "--topic", "invoke fallback", "--scope", "none", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "agreed");
  assert.equal(parsed.participants[0].adapter, "claude");
  assert.equal(parsed.participants[0].tier, "fallback");
  assert.equal(parsed.participants[0].fallback_for, "codex");
  assert.equal(parsed.independent_provider_coverage, false);
  assert.match(parsed.summary, /degraded fallback/i);
  assert.equal(parsed.fake_coverage, false);
});

test("per-attempt timeout blocks with adapter_failure reason and the session is resumable", async () => {
  const stateRoot = tempRoot("attempt-timeout");
  const blocked = await cliFakes("fake-sequence,fake-sequence", [
    "--topic", "attempt timeout",
    // Exceeds both the 1s primary window and the 2s extended retry window.
    "--turn-delay-ms", "2500",
    "--turn-timeout-seconds", "1",
    "--json"
  ], stateRoot);
  const parsed = JSON.parse(blocked.stdout);
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.blocked_reason, "adapter_failure");
  assert.match(parsed.summary, /timed out/);
  const sessionId = findSingleSessionId(stateRoot);
  const resumed = await cli(["resume", sessionId, "--turn-timeout-seconds", "10", "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
});

test("participant recursion sentinel refuses nested run and resume", async () => {
  for (const args of [["run", "--topic", "nested"], ["resume", "whatever"]]) {
    const harness = io(tempRoot("sentinel"));
    harness.env.CONVERGE_LOOP_PARTICIPANT = "1";
    const code = await runCli(args, harness);
    assert.equal(code, 1);
    assert.match(harness.err.join(""), /cannot be invoked from inside a converge-loop participant turn/);
  }
});

test("interrupted foreground sessions stuck in running state can be resumed", async () => {
  const stateRoot = tempRoot("stuck-running");
  const run = await cliFakes("fake-sequence,fake-sequence", [
    "--topic", "stuck running",
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "agreed");
  const sessionId = findSingleSessionId(stateRoot);
  const sessionPath = path.join(stateRoot, "sessions", sessionId, "session.json");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  session.state = "running";
  delete session.completed_at;
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  fs.rmSync(path.join(stateRoot, "sessions", sessionId, "result.json"));
  const resumed = await cli(["resume", sessionId, "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
});

test("resume refuses a heartbeat-stale session whose process is still alive", async () => {
  const stateRoot = tempRoot("stale-alive-refuse");
  const fixture = writeFixture(stateRoot, {
    turns: [{ message: "need logs", control: { status: "needs_evidence", evidence_requests: ["logs"] } }]
  });
  const run = await cliFakes("fake-replay,fake-replay", [
    "--topic", "stale alive",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "needs_evidence");
  const sessionId = findSingleSessionId(stateRoot);
  const jobPath = path.join(stateRoot, "jobs", `${sessionId}.json`);
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.status = "running";
  job.pid = process.pid;
  job.turn_timeout_seconds = 1;
  job.last_heartbeat_at = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  const resumed = await cli(["resume", sessionId, "--fixture", fixture, "--json"], stateRoot);
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /stale by heartbeat but its process .* is still running/);
});

test("resume is refused while a foreground session is genuinely live", async () => {
  const stateRoot = tempRoot("live-refuse");
  const run = await cliFakes("fake-sequence,fake-sequence", [
    "--topic", "live refuse",
    "--json"
  ], stateRoot);
  assert.equal(run.code, 0, run.stderr);
  const sessionId = findSingleSessionId(stateRoot);
  const sessionPath = path.join(stateRoot, "sessions", sessionId, "session.json");
  const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  session.state = "running";
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  fs.rmSync(path.join(stateRoot, "sessions", sessionId, "result.json"));
  const jobPath = path.join(stateRoot, "jobs", `${sessionId}.json`);
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  job.status = "running";
  job.pid = process.pid;
  job.last_heartbeat_at = new Date().toISOString();
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  const resumed = await cli(["resume", sessionId, "--json"], stateRoot);
  assert.equal(resumed.code, 1);
  assert.match(resumed.stderr, /cannot be resumed from status running/);
});

test("explicit participant selection never swaps to a fallback on invoke failure", async () => {
  const stateRoot = tempRoot("explicit-no-swap");
  const { binDir } = writeLocalCliPair(path.join(stateRoot, "bin"), { codexExecFail: true });
  const setupHarness = io(stateRoot);
  setupHarness.env.PATH = `${binDir}${path.delimiter}${setupHarness.env.PATH || ""}`;
  delete setupHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  await runCli(["setup", "--json"], setupHarness);

  const runHarness = io(stateRoot);
  runHarness.env.PATH = setupHarness.env.PATH;
  delete runHarness.env.CONVERGE_LOOP_TEST_LOCAL_CLI_FAKE;
  delete runHarness.env.CONVERGE_LOOP_ENABLE_LOCAL_CLI_ADAPTERS;
  runHarness.env.CONVERGE_LOOP_HOST = "codex";
  const runCode = await runCli(["run", "--counterpart", "claude", "--topic", "explicit no swap", "--scope", "none", "--json"], runHarness);
  assert.equal(runCode, 0, runHarness.err.join(""));
  const parsed = JSON.parse(runHarness.out.join(""));
  assert.equal(parsed.status, "blocked");
  assert.equal(parsed.blocked_reason, "adapter_failure");
  assert.equal(parsed.participants[0].adapter, "codex");
  assert.deepEqual(parsed.fallbacks_used, []);
});

test("cancel signals the whole process group when the leader is gone", async () => {
  const { spawn } = await import("node:child_process");
  const stateRoot = tempRoot("cancel-tree");
  // Leader spawns a 60s grandchild in its group, then exits: group-first
  // probing must still see the session as alive and cancel must kill the group.
  const leader = spawn(process.execPath, ["-e",
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' }).unref();"
  ], { detached: true, stdio: "ignore" });
  const leaderPid = leader.pid;
  await new Promise((resolve) => leader.on("exit", resolve));
  leader.unref();
  fs.mkdirSync(path.join(stateRoot, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "jobs", "treecancel.json"), JSON.stringify({
    schema_version: "converge-loop.job.v1",
    id: "treecancel",
    pid: leaderPid,
    command: [],
    cwd: repoRoot,
    created_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    status: "running",
    session_path: path.join(stateRoot, "sessions", "treecancel"),
    turn_timeout_seconds: 180
  }));
  const cancel = await cli(["cancel", "treecancel"], stateRoot);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.match(cancel.stdout, /canceling/);
  await waitFor(() => {
    try {
      process.kill(-leaderPid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("status tolerates a torn trailing line in turns.jsonl", async () => {
  const stateRoot = tempRoot("torn");
  await cliFakes("fake-sequence,fake-sequence", [
    "--topic", "torn jsonl",
    "--json"
  ], stateRoot);
  const sessionId = findSingleSessionId(stateRoot);
  fs.appendFileSync(path.join(stateRoot, "sessions", sessionId, "turns.jsonl"), '{"schema_version":"converge-loop.turn.v1","turn_ind');
  const status = await cli(["status", sessionId], stateRoot);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /agreed/);
});

test("resume supplies requested evidence via context override and discloses it", async () => {
  const stateRoot = tempRoot("resume-evidence");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "need usage data", control: { status: "needs_evidence", evidence_requests: ["usage data"], ready_to_converge: true } },
      { message: "evidence reviewed", control: { status: "continue", concessions: ["usage data supports the default"], ready_to_converge: true } },
      { message: "agreed", control: { status: "agreed", agreements: ["default confirmed"], ready_to_converge: true } }
    ]
  });
  const run = await cliFakes("fake-replay,fake-replay", [
    "--topic", "resume evidence",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "needs_evidence");
  const sessionId = findSingleSessionId(stateRoot);
  const evidencePath = path.join(stateRoot, "usage-data.md");
  fs.writeFileSync(evidencePath, "REQUESTED USAGE DATA CONTENT");
  const resumed = await cli([
    "resume", sessionId,
    "--context", evidencePath,
    "--focus", "Requested usage data attached",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
  const session = JSON.parse(fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "session.json"), "utf8"));
  assert.equal(session.options.context, evidencePath);
  assert.equal(session.options.focus, "Requested usage data attached");
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.match(transcript, /New context supplied on resume: .*usage-data\.md/);
});

test("resume artifact override is disclosed while carried-over context is not", async () => {
  const stateRoot = tempRoot("resume-artifact");
  const originalContext = path.join(stateRoot, "original-context.md");
  fs.writeFileSync(originalContext, "ORIGINAL CONTEXT");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "need the spec", control: { status: "needs_evidence", evidence_requests: ["spec"], ready_to_converge: true } },
      { message: "spec reviewed", control: { status: "agreed", agreements: ["spec settles it"], ready_to_converge: true } },
      { message: "confirmed", control: { status: "agreed", ready_to_converge: true } }
    ]
  });
  const run = await cliFakes("fake-replay,fake-replay", [
    "--topic", "artifact resume",
    "--context", originalContext,
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "needs_evidence");
  const sessionId = findSingleSessionId(stateRoot);
  const specPath = path.join(stateRoot, "spec.md");
  fs.writeFileSync(specPath, "REQUESTED SPEC");
  const resumed = await cli(["resume", sessionId, "--artifact", specPath, "--fixture", fixture, "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.match(transcript, /New artifact supplied on resume: .*spec\.md/);
  assert.doesNotMatch(transcript, /context supplied on resume/, "carried-over context must not be re-disclosed");
});

test("resume repairs a torn trailing turn record before appending new turns", async () => {
  const stateRoot = tempRoot("torn-resume");
  const fixture = writeFixture(stateRoot, {
    turns: [
      { message: "need logs", control: { status: "needs_evidence", evidence_requests: ["logs"] } },
      { message: "resolved", control: { status: "agreed", agreements: ["done"], ready_to_converge: true } }
    ]
  });
  const run = await cliFakes("fake-replay,fake-replay", [
    "--topic", "torn resume",
    "--fixture", fixture,
    "--json"
  ], stateRoot);
  assert.equal(JSON.parse(run.stdout).status, "needs_evidence");
  const sessionId = findSingleSessionId(stateRoot);
  const turnsPath = path.join(stateRoot, "sessions", sessionId, "turns.jsonl");
  fs.appendFileSync(turnsPath, '{"schema_version":"converge-loop.turn.v1","turn_ind');
  const resumed = await cli(["resume", sessionId, "--fixture", fixture, "--json"], stateRoot);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(readResult(stateRoot, sessionId).status, "agreed");
  const lines = fs.readFileSync(turnsPath, "utf8").split(/\n/).filter(Boolean);
  for (const line of lines) JSON.parse(line);
  assert.equal(lines.length, 3);
  const transcript = fs.readFileSync(path.join(stateRoot, "sessions", sessionId, "transcript.md"), "utf8");
  assert.doesNotMatch(transcript, /supplied on resume/, "plain resume must not fabricate evidence disclosures");
});

test("redact strips common secret shapes from error text", async () => {
  const { redact } = await import("../scripts/lib/util.mjs");
  const input = "auth sk-abcdefghijklmnopqrstuv failed; token=abc123secret; key ghp_0123456789abcdef01 AKIAABCDEFGHIJKLMNOP";
  const out = redact(input);
  assert.doesNotMatch(out, /sk-abcdefghijklmnopqrstuv/);
  assert.doesNotMatch(out, /abc123secret/);
  assert.doesNotMatch(out, /ghp_0123456789abcdef01/);
  assert.doesNotMatch(out, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(out, /sk-REDACTED/);
});

test("result validation rejects self-contradictory results", async () => {
  const { validateResult } = await import("../scripts/lib/result.mjs");
  const base = {
    schema_version: "converge-loop.result.v1",
    status: "agreed",
    summary: "ok",
    participants: [],
    fallbacks_used: [],
    agreements: [],
    pushbacks_resolved: [],
    remaining_disagreements: [],
    minor_reservations: [],
    improvements: [],
    operator_intervention_points: [],
    recommended_next_actions: []
  };
  assert.equal(validateResult(base), base);
  assert.throws(() => validateResult({ ...base, remaining_disagreements: ["core"] }), /agreed result must not carry/);
  assert.throws(() => validateResult({ ...base, status: "bogus" }), /status must be one of/);
  assert.throws(() => validateResult({ ...base, blocked_reason: "adapter_failure" }), /only valid on blocked/);
});

test("fake adapter results disclose fake coverage", async () => {
  const result = await cliFakes("fake-sequence,fake-sequence", [
    "--topic", "fake disclosure",
    "--json"
  ]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.fake_coverage, true);
  assert.match(parsed.summary, /Fake-adapter coverage: deterministic test participants/);
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
