export const DECISION_CODES = Object.freeze({
  policy_denied: "policy_deny",
  plan_check_denied: "policy_deny",
  intent_plan_missing: "missing_plan",
  intent_drift: "out_of_scope",
  intent_parameter_mismatch: "out_of_scope",
  intent_plan_empty: "out_of_scope",
  intent_token_expired: "token_expired",
  intent_token_not_issued: "plan_request_failed",
  crypto_policy_mismatch: "integrity",
  csrg_proof_invalid: "integrity",
  csrg_proof_missing: "integrity",
  remote_verify_denied: "integrity",
  remote_verify_failed: "internal_error",
  require_approval: "approval_required",
  backend_unreachable: "outage",
  invalid_payload: "internal_error",
  missing_tool_name: "internal_error",
  internal_error: "internal_error"
});

export function decisionOutcome(code, reason) {
  if (!Object.hasOwn(DECISION_CODES, code)) throw new Error("Unknown audit producer code");
  const decisionCode = DECISION_CODES[code];
  return {
    status: decisionCode === "approval_required" ? "held" : "blocked",
    decision_code: decisionCode,
    error_message: `${code}: ${reason}`,
    output: null
  };
}
