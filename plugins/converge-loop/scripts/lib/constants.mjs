export const SESSION_SCHEMA = "converge-loop.session.v1";
export const TURN_SCHEMA = "converge-loop.turn.v1";
export const EVIDENCE_SCHEMA = "converge-loop.evidence.v1";
export const JOB_SCHEMA = "converge-loop.job.v1";
export const RESULT_SCHEMA = "converge-loop.result.v1";

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
  maxTurns: 8,
  maxMinutes: 15,
  turnTimeoutSeconds: 180,
  maxToolCallsPerTurn: 20,
  maxControlRetries: 1,
  agents: null,
  roles: null,
  background: false,
  json: false,
  intervene: false
});
