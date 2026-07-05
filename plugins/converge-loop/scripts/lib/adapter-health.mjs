import path from "node:path";
import { defaultStateRoot, nowIso, readJson, writeJson } from "./util.mjs";

const HEALTH_SCHEMA = "converge-loop.adapter-health.v1";
export const DEFAULT_KNOWN_BAD_TTL_MS = 15 * 60 * 1000;

// Failure classes. Deterministic failures fail the same way every run, so
// retrying and swapping is pure waste and a swap that "succeeds" hides the
// real problem — these get remembered. Transient failures (timeouts, dropped
// connections) are worth retrying and are never cached.
const CLASSIFIERS = [
  {
    category: "timeout",
    class: "transient",
    test: (error, message) => error?.code === "CONVERGE_LOOP_TIMEOUT" || /timed out/i.test(message)
  },
  {
    category: "network",
    class: "transient",
    test: (_error, message) => /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed/i.test(message)
  },
  {
    category: "auth",
    class: "deterministic",
    hint: "re-authenticate the local CLI (`codex login` or `claude auth login`), then rerun `converge-loop setup`.",
    test: (_error, message) => /token_invalidated|refresh_token_invalidated|not logged in|logged out|unauthor|\b401\b|auth error/i.test(message)
  },
  {
    category: "schema",
    class: "deterministic",
    hint: "the provider rejected the output schema; update the local CLI and run `converge-loop setup --smoke` to re-verify.",
    test: (_error, message) => /invalid_json_schema|invalid_request_error|unsupported schema|\b400\b/i.test(message)
  },
  {
    category: "cli",
    class: "deterministic",
    hint: "the local CLI is missing a required flag or rejected an argument; update it and rerun `converge-loop setup`.",
    test: (_error, message) => /missing required read-only flags|unexpected argument|unrecognized|unknown option|unsupported adapter/i.test(message)
  }
];

// Classify a mid-turn adapter failure. Unknown failures default to transient
// so a recoverable adapter is never locked out by an unrecognized error.
export function classifyAdapterFailure(error) {
  const message = String(error?.message || error || "");
  for (const classifier of CLASSIFIERS) {
    if (classifier.test(error, message)) {
      return { category: classifier.category, class: classifier.class, hint: classifier.hint || null };
    }
  }
  return { category: "unknown", class: "transient", hint: null };
}

export function isDeterministicFailure(error) {
  return classifyAdapterFailure(error).class === "deterministic";
}

export function adapterHealthPath(env = process.env) {
  return path.join(defaultStateRoot(env), "config", "adapter-health.json");
}

export function readAdapterHealth(env = process.env) {
  try {
    const parsed = readJson(adapterHealthPath(env));
    if (parsed?.schema_version === HEALTH_SCHEMA && parsed.adapters && typeof parsed.adapters === "object") {
      return parsed;
    }
  } catch {}
  return { schema_version: HEALTH_SCHEMA, adapters: {} };
}

function writeAdapterHealth(env, health) {
  writeJson(adapterHealthPath(env), { ...health, schema_version: HEALTH_SCHEMA, updated_at: nowIso() });
}

// Record a deterministic verdict so later runs fail fast with the diagnosis
// instead of rediscovering it. Transient failures are ignored (not cached).
export function recordAdapterFailure(env, adapter, { category, reason, hint, ttlMs = DEFAULT_KNOWN_BAD_TTL_MS } = {}) {
  const health = readAdapterHealth(env);
  health.adapters[adapter] = {
    category: category || "unknown",
    reason: reason || "adapter failed",
    hint: hint || null,
    recorded_at: nowIso(),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  };
  writeAdapterHealth(env, health);
}

// Clear an adapter's verdict after it succeeds again (a good turn or setup).
export function clearAdapterHealth(env, adapter) {
  const health = readAdapterHealth(env);
  if (!health.adapters[adapter]) return;
  delete health.adapters[adapter];
  writeAdapterHealth(env, health);
}

// Non-expired deterministic verdict for an adapter, or null. An env escape
// hatch lets an operator retry a known-bad adapter without waiting for the TTL.
export function knownBadVerdict(env, adapter) {
  if (env.CONVERGE_LOOP_IGNORE_ADAPTER_HEALTH === "1") return null;
  const entry = readAdapterHealth(env).adapters[adapter];
  if (!entry) return null;
  const expires = Date.parse(entry.expires_at || 0);
  if (Number.isFinite(expires) && expires < Date.now()) return null;
  return entry;
}
