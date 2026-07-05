import { TERMINAL_STATUSES } from "./constants.mjs";

export function defaultControl(overrides = {}) {
  return {
    status: "continue",
    confidence: "medium",
    agreements: [],
    pushbacks: [],
    minor_reservations: [],
    improvements: [],
    open_questions: [],
    evidence_used: [],
    evidence_requests: [],
    web_fetch_requests: [],
    concessions: [],
    ready_to_converge: false,
    operator_intervention_points: [],
    next_prompt_suggestion: "",
    ...overrides
  };
}

export function normalizeControl(control = {}) {
  const normalized = defaultControl(control);
  for (const key of [
    "agreements",
    "pushbacks",
    "minor_reservations",
    "improvements",
    "open_questions",
    "evidence_used",
    "evidence_requests",
    "web_fetch_requests",
    "concessions",
    "operator_intervention_points"
  ]) {
    normalized[key] = Array.isArray(normalized[key]) ? normalized[key] : [];
  }
  if (!TERMINAL_STATUSES.has(normalized.status) && normalized.status !== "continue") {
    normalized.status = "continue";
  }
  normalized.ready_to_converge = Boolean(normalized.ready_to_converge);
  if (normalized.status === "agreed") {
    normalized.ready_to_converge = true;
  }
  return normalized;
}

// Participant-level convergence on the core issue: ready with no core
// pushbacks or pending evidence. Minor reservations do not block.
export function isConverged(control) {
  const c = normalizeControl(control);
  return Boolean(
    c.ready_to_converge &&
    !c.pushbacks.length &&
    !c.evidence_requests.length &&
    !c.operator_intervention_points.length
  );
}

export function parseParticipantOutput(output, { nonce } = {}) {
  if (output && typeof output === "object" && !Buffer.isBuffer(output)) {
    const control = output.control || (output.status || typeof output.ready_to_converge === "boolean" ? output : null);
    return {
      message: String(output.message || output.notes || ""),
      control: normalizeControl(stripNonControlFields(control || {})),
      control_found: Boolean(control),
      evidence: Array.isArray(output.evidence) ? output.evidence : []
    };
  }
  const text = String(output || "");
  const parsed = tryJson(text);
  if (parsed) {
    return parseParticipantOutput(parsed, { nonce });
  }
  if (nonce) {
    const pattern = new RegExp(`<<<CONVERGE_LOOP_CONTROL ${escapeRegex(nonce)}>>>([\\s\\S]*?)<<<END_CONVERGE_LOOP_CONTROL ${escapeRegex(nonce)}>>>`, "g");
    let match;
    let last = null;
    while ((match = pattern.exec(text)) !== null) {
      last = match[1].trim();
    }
    if (last) {
      const control = tryJson(last);
      if (control) {
        return {
          message: text.replace(pattern, "").trim(),
          control: normalizeControl(control),
          control_found: true,
          evidence: []
        };
      }
    }
    const nonceJson = parseNonceJsonFallback(text, nonce);
    if (nonceJson) return nonceJson;
  }
  return {
    message: text.trim(),
    control: normalizeControl(),
    control_found: false,
    evidence: []
  };
}

function parseNonceJsonFallback(text, nonce) {
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  let last = null;
  while ((match = fencePattern.exec(text)) !== null) {
    const parsed = tryJson(match[1].trim());
    if (parsed && parsed.nonce === nonce && (parsed.status || typeof parsed.ready_to_converge === "boolean")) {
      last = { full: match[0], parsed };
    }
  }
  if (!last) return null;
  return {
    message: text.replace(last.full, "").trim(),
    control: normalizeControl(stripNonControlFields(last.parsed)),
    control_found: true,
    evidence: []
  };
}

function stripNonControlFields(value = {}) {
  const { nonce, message, notes, evidence, role, topic, ...control } = value;
  return control;
}

export function hasProgress(control) {
  const c = normalizeControl(control);
  return Boolean(
    c.status !== "continue" ||
    c.ready_to_converge ||
    c.agreements.length ||
    c.pushbacks.length ||
    c.minor_reservations.length ||
    c.improvements.length ||
    c.open_questions.length ||
    c.evidence_used.length ||
    c.evidence_requests.length ||
    c.concessions.length ||
    c.operator_intervention_points.length
  );
}

const PROGRESS_LIST_KEYS = [
  "agreements",
  "pushbacks",
  "minor_reservations",
  "improvements",
  "open_questions",
  "evidence_used",
  "evidence_requests",
  "web_fetch_requests",
  "concessions",
  "operator_intervention_points"
];

// Withdrawing one of these without adding anything is still movement
// toward (or away from) convergence.
const DEESCALATION_KEYS = ["pushbacks", "evidence_requests", "operator_intervention_points"];

// A turn makes progress only relative to the same participant's previous
// control: restating the same positions verbatim is not movement.
export function hasNewProgress(control, previousControl = null) {
  const c = normalizeControl(control);
  if (!previousControl) return hasProgress(c);
  const previous = normalizeControl(previousControl);
  if (c.status !== previous.status) return true;
  if (c.ready_to_converge !== previous.ready_to_converge) return true;
  if (PROGRESS_LIST_KEYS.some((key) => {
    const seen = new Set(previous[key]);
    return c[key].some((item) => !seen.has(item));
  })) return true;
  return DEESCALATION_KEYS.some((key) => {
    const kept = new Set(c[key]);
    return previous[key].some((item) => !kept.has(item));
  });
}

export function hasMaterialPushback(control) {
  const c = normalizeControl(control);
  return Boolean(
    c.pushbacks.length ||
    c.improvements.length ||
    c.evidence_requests.length ||
    c.open_questions.length ||
    c.operator_intervention_points.length
  );
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
