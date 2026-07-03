import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.match(parsed.summary, /fail-closed/);
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
