import { RESULT_SCHEMA, TERMINAL_STATUSES } from "./constants.mjs";

const RESULT_ARRAY_FIELDS = [
  "participants",
  "fallbacks_used",
  "agreements",
  "pushbacks_resolved",
  "remaining_disagreements",
  "minor_reservations",
  "improvements",
  "operator_intervention_points",
  "recommended_next_actions"
];

// Fail loud before persisting a result that violates the contract, so a bug
// upstream cannot silently write a self-contradictory result.json.
export function validateResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("result must be an object");
  }
  if (result.schema_version !== RESULT_SCHEMA) {
    throw new Error(`result schema_version must be ${RESULT_SCHEMA}`);
  }
  if (!TERMINAL_STATUSES.has(result.status)) {
    throw new Error(`result status must be one of: ${[...TERMINAL_STATUSES].join(", ")}`);
  }
  if (typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error("result summary must be a non-empty string");
  }
  for (const field of RESULT_ARRAY_FIELDS) {
    if (!Array.isArray(result[field])) {
      throw new Error(`result ${field} must be an array`);
    }
  }
  if (result.status === "agreed" && result.remaining_disagreements.length) {
    throw new Error("agreed result must not carry remaining_disagreements");
  }
  if (result.blocked_reason != null && result.status !== "blocked") {
    throw new Error("blocked_reason is only valid on blocked results");
  }
  return result;
}
