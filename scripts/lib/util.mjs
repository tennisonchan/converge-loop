import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function createSessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `cl-${stamp}-${randomBytes(4).toString("hex")}`;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

export function appendFile(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text);
}

export function fileExists(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function runGit(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function isGitWorktree(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0;
}

export function gitRoot(cwd) {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function hasWorkingTreeMaterial(cwd) {
  const result = runGit(cwd, ["status", "--porcelain"]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function pathInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveReadablePath(cwd, input, name) {
  const resolved = path.resolve(cwd, input);
  if (!path.isAbsolute(input) && !pathInside(cwd, resolved)) {
    throw new Error(`${name} must resolve inside the current working directory unless an absolute path is supplied`);
  }
  if (!fileExists(resolved)) {
    throw new Error(`${name} does not exist or is not readable: ${input}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`${name} must be a readable file: ${input}`);
  }
  return resolved;
}

export function defaultStateRoot(env = process.env, platform = process.platform) {
  if (env.CONVERGE_LOOP_STATE_HOME) {
    return path.resolve(env.CONVERGE_LOOP_STATE_HOME);
  }
  if (env.XDG_STATE_HOME) {
    return path.join(env.XDG_STATE_HOME, "converge-loop");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "converge-loop");
  }
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "converge-loop");
  }
  return path.join(os.homedir(), ".local", "state", "converge-loop");
}

export function commandExists(command) {
  const result = spawnSync("command", ["-v", command], {
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0;
}

export function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function copyDir(src, dest) {
  ensureDir(dest);
  fs.cpSync(src, dest, { recursive: true });
}
