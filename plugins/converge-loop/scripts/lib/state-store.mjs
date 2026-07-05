import fs from "node:fs";
import path from "node:path";
import { EVIDENCE_SCHEMA, JOB_SCHEMA, OPERATOR_INPUT_SCHEMA, SESSION_SCHEMA, TURN_SCHEMA, WEB_MATERIAL_SCHEMA } from "./constants.mjs";
import { validateResult } from "./result.mjs";
import {
  appendFile,
  appendJsonl,
  createSessionId,
  defaultStateRoot,
  ensureDir,
  nowIso,
  readJson,
  writeJson
} from "./util.mjs";

export class StateStore {
  constructor({ root }) {
    this.root = root;
    this.sessionsRoot = path.join(root, "sessions");
    this.jobsRoot = path.join(root, "jobs");
    ensureDir(this.sessionsRoot);
    ensureDir(this.jobsRoot);
  }

  static fromEnv(env) {
    return new StateStore({ root: defaultStateRoot(env) });
  }

  createSession({ sessionId = createSessionId(), cwd, options, participants }) {
    const sessionPath = this.sessionPath(sessionId);
    ensureDir(sessionPath);
    const session = {
      schema_version: SESSION_SCHEMA,
      id: sessionId,
      cwd,
      created_at: nowIso(),
      updated_at: nowIso(),
      options,
      participants,
      state: "running",
      current_turn_index: 0,
      session_path: sessionPath
    };
    this.writeSession(session);
    this.writeTranscript(sessionId, `# converge-loop ${sessionId}\n\n`);
    for (const file of ["turns.jsonl", "evidence-ledger.jsonl"]) {
      const fullPath = this.sessionFile(sessionId, file);
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, "");
      }
    }
    return session;
  }

  sessionPath(sessionId) {
    return path.join(this.sessionsRoot, sessionId);
  }

  sessionFile(sessionId, name) {
    return path.join(this.sessionPath(sessionId), name);
  }

  loadSession(sessionId) {
    return readJson(this.sessionFile(sessionId, "session.json"));
  }

  writeSession(session) {
    session.updated_at = nowIso();
    writeJson(this.sessionFile(session.id, "session.json"), session);
  }

  writeTranscript(sessionId, text) {
    appendFile(this.sessionFile(sessionId, "transcript.md"), text);
  }

  appendTurn(sessionId, turn) {
    appendJsonl(this.sessionFile(sessionId, "turns.jsonl"), {
      schema_version: TURN_SCHEMA,
      ...turn
    });
  }

  appendEvidence(sessionId, evidence) {
    appendJsonl(this.sessionFile(sessionId, "evidence-ledger.jsonl"), {
      schema_version: EVIDENCE_SCHEMA,
      ...evidence
    });
  }

  appendOperatorInput(sessionId, input) {
    appendJsonl(this.sessionFile(sessionId, "operator-inputs.jsonl"), {
      schema_version: OPERATOR_INPUT_SCHEMA,
      ...input
    });
  }

  readOperatorInputs(sessionId) {
    const file = this.sessionFile(sessionId, "operator-inputs.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  appendWebMaterial(sessionId, material) {
    appendJsonl(this.sessionFile(sessionId, "web-materials.jsonl"), {
      schema_version: WEB_MATERIAL_SCHEMA,
      ...material
    });
  }

  readWebMaterials(sessionId) {
    const file = this.sessionFile(sessionId, "web-materials.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  writeConclusion(sessionId, text) {
    fs.writeFileSync(this.sessionFile(sessionId, "conclusion.md"), text);
  }

  writeResult(sessionId, result) {
    writeJson(this.sessionFile(sessionId, "result.json"), validateResult(result));
  }

  loadResult(sessionId) {
    return readJson(this.sessionFile(sessionId, "result.json"));
  }

  resultExists(sessionId) {
    return fs.existsSync(this.sessionFile(sessionId, "result.json"));
  }

  // Drop a torn trailing record left by a crash mid-append so later appends
  // and reads see a clean file. Returns true when a repair happened.
  repairTurnsTail(sessionId) {
    const file = this.sessionFile(sessionId, "turns.jsonl");
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean);
    if (!lines.length) return false;
    try {
      JSON.parse(lines[lines.length - 1]);
      return false;
    } catch {
      const tmp = `${file}.tmp-${process.pid}`;
      const kept = lines.slice(0, -1);
      fs.writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "");
      fs.renameSync(tmp, file);
      return true;
    }
  }

  readTurns(sessionId) {
    const file = this.sessionFile(sessionId, "turns.jsonl");
    if (!fs.existsSync(file)) return [];
    // Tolerate a torn trailing line from a crash mid-append; corruption
    // anywhere else would silently shift turn alternation, so fail loudly.
    const lines = fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean);
    const turns = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        turns.push(JSON.parse(lines[index]));
      } catch {
        if (index === lines.length - 1) break;
        throw new Error(`corrupt turn record at line ${index + 1} of ${file}`);
      }
    }
    return turns;
  }

  listSessions() {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    return fs.readdirSync(this.sessionsRoot).flatMap((entry) => {
      try {
        const session = readJson(path.join(this.sessionsRoot, entry, "session.json"));
        const resultPath = path.join(this.sessionsRoot, entry, "result.json");
        const result = fs.existsSync(resultPath) ? readJson(resultPath) : null;
        return [{ session, result }];
      } catch {
        return [];
      }
    }).sort((a, b) => String(b.session.updated_at).localeCompare(String(a.session.updated_at)));
  }

  // Advisory lock (design plan jobs/lock): serializes job-state writes so a
  // cancel cannot race a heartbeat read-modify-write. mkdir is atomic; a lock
  // older than 5s is treated as abandoned and broken.
  withJobsLock(fn) {
    const lockDir = path.join(this.jobsRoot, "lock");
    const deadline = Date.now() + 2000;
    let acquired = false;
    while (!acquired) {
      try {
        fs.mkdirSync(lockDir);
        acquired = true;
        break;
      } catch {
        try {
          const age = Date.now() - fs.statSync(lockDir).mtimeMs;
          if (age > 5000) {
            fs.rmdirSync(lockDir);
            continue;
          }
        } catch {}
        if (Date.now() > deadline) break; // proceed unlocked rather than deadlock
        // Sleep without pegging a core; job writes are rare and tiny.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          fs.rmdirSync(lockDir);
        } catch {}
      }
    }
  }

  writeJob(sessionId, job) {
    writeJson(path.join(this.jobsRoot, `${sessionId}.json`), {
      schema_version: JOB_SCHEMA,
      ...job,
      updated_at: nowIso()
    });
  }

  loadJob(sessionId) {
    const file = path.join(this.jobsRoot, `${sessionId}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
  }

  listJobs() {
    if (!fs.existsSync(this.jobsRoot)) return [];
    return fs.readdirSync(this.jobsRoot)
      .filter((entry) => entry.endsWith(".json"))
      .flatMap((entry) => {
        try {
          return [readJson(path.join(this.jobsRoot, entry))];
        } catch {
          return [];
        }
      });
  }
}
