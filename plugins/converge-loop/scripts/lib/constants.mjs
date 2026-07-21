export const SESSION_SCHEMA = "converge-loop.session.v1";
export const TURN_SCHEMA = "converge-loop.turn.v1";
export const EVIDENCE_SCHEMA = "converge-loop.evidence.v1";
export const JOB_SCHEMA = "converge-loop.job.v1";
export const RESULT_SCHEMA = "converge-loop.result.v1";
export const DOCTOR_SCHEMA = "converge-loop.doctor.v1";
export const OPERATOR_INPUT_SCHEMA = "converge-loop.operator-input.v1";
export const WEB_MATERIAL_SCHEMA = "converge-loop.web-material.v1";

export const TERMINAL_STATUSES = new Set([
  "agreed",
  "clear_disagreement",
  "needs_evidence",
  "operator_intervention",
  "blocked",
  "max_turns",
  "timeout",
  "canceled"
]);

export const RESUMABLE_STATUSES = new Set([
  "operator_intervention",
  "timeout",
  "needs_evidence",
  "canceled"
]);

export const DEFAULT_RUN_OPTIONS = Object.freeze({
  scope: "working-tree",
  web: "off",
  output: "compact",
  minTurns: 4,
  maxTurns: 8,
  maxMinutes: 30,
  // Absolute per-turn cap. Deliberation turns on large models routinely run
  // past 3 minutes of pure generation, so this is a hang bound rather than an
  // expected turn length; turnInactivitySeconds catches hung adapters fast.
  turnTimeoutSeconds: 420,
  // Kill a local CLI turn that streams no output at all for this long; 0
  // disables. Generous because a legitimate read-only tool call (a slow grep
  // or search) emits nothing until it returns; the window doubles alongside
  // the absolute cap on the extended timeout retry.
  turnInactivitySeconds: 120,
  maxToolCallsPerTurn: 20,
  maxControlRetries: 1,
  claudeModel: null,
  codexModel: null,
  agents: null,
  roles: null,
  background: false,
  json: false,
  intervene: false,
  requireIndependent: false
});
