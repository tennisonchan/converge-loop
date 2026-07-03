import fs from "node:fs";
import path from "node:path";
import { EVIDENCE_SCHEMA, JOB_SCHEMA, SESSION_SCHEMA, TURN_SCHEMA } from "./constants.mjs";
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

  writeConclusion(sessionId, text) {
    fs.writeFileSync(this.sessionFile(sessionId, "conclusion.md"), text);
  }

  writeResult(sessionId, result) {
    writeJson(this.sessionFile(sessionId, "result.json"), result);
  }

  loadResult(sessionId) {
    return readJson(this.sessionFile(sessionId, "result.json"));
  }

  resultExists(sessionId) {
    return fs.existsSync(this.sessionFile(sessionId, "result.json"));
  }

  readTurns(sessionId) {
    const file = this.sessionFile(sessionId, "turns.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
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
