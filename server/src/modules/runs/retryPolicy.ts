import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

// Emitted only after the old, exact Host launch has confirmed its exit.
export const EXECUTION_CONTROLLER_LOST = "execution_controller_lost";
export const TASK_DRY_RUN_UNSUPPORTED = "task_dry_run_unsupported";
/**
 * The Host launch refused to hand the CLI the vendor session this Run was frozen to resume (`remoteHostCliAdapter`'s
 * resume check, ADR 0036 §11–§15): retired by a reset, excluded, archived, from a launch before a reset, or not proven to
 * be in this launch's directory or isolation. Every later attempt of the same Run carries the same session and meets the
 * same refusal, so the Supervisor leaves the failure terminal rather than parking it for a review whose resume would
 * only repeat it; a new turn or Task Run starts a new session.
 */
export const RESUME_SESSION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "resume_session_unconfirmed",
  "isolated_session_resume_refused",
  "sensitive_resume_unconfirmed",
]);

const RETRYABLE_RUN_ERROR_CODES = new Set([
  EXECUTION_CONTROLLER_LOST,
  "adapter_timeout",
  // A host daemon reports these two. Do not also list
  // `cli_adapter_timeout`, `cli_stall_timeout`, or
  // `cli_runtime_provider_config_failed`: a daemon does not emit them
  // (ADR 0016).
  "runtime_timeout",
  "runtime_stall_timeout",
  "adapter_runtime_error",
  "runtime_session_invalid",
  "provider_network_error",
  // A response the provider committed to and then failed to deliver. The
  // Supervisor's bounded, cost-capped retry is the right answer to it for the
  // same reason it is to a network error: nothing about the request was
  // rejected, so the next attempt has a real chance of landing.
  "provider_stream_terminated",
  "provider_rate_limit",
  "orphaned",
  "semantic_rejection",
  "verification_failed",
  "validation_failed",
  "run_exchange_output_validation_failed",
]);

export function isRetryableRunErrorCode(errorCode: string): boolean {
  return RETRYABLE_RUN_ERROR_CODES.has(errorCode);
}

/**
 * A vendor CLI refused because the subscription's window is used up. Never
 * immediately retried: another attempt meets the same refusal until the window resets.
 * The Supervisor can park a bounded successor attempt at the quota gate.
 */
export const SUBSCRIPTION_QUOTA_EXHAUSTED = "subscription_quota_exhausted";

export function retryTaskInstruction(reasonCode: string): string {
  if (reasonCode === EXECUTION_CONTROLLER_LOST) {
    return "Continue the task interrupted by a worker restart. First inspect the current workspace and completed actions; preserve prior progress. Do not replay completed side effects. If an action's outcome cannot be established, ask the person before repeating it. Follow current instructions and authorization; do not change model, funding or collaboration bounds.";
  }
  return reasonCode === SUBSCRIPTION_QUOTA_EXHAUSTED
    ? "Continue the task interrupted by quota exhaustion. First inspect current workspace and completed actions; preserve prior progress. Do not replay completed side effects. If an action's outcome cannot be established, ask the person before repeating it. Follow current instructions and authorization; do not change model, funding or collaboration bounds."
    : "Re-attempt the original task and correct that failure; do not merely repeat the prior response.";
}

/**
 * The code a failed CLI Run gets from what the runtime said, when its text
 * is one the runtime's adapter spec declares as a quota refusal
 * (`usage.quota_exhausted_patterns`); null otherwise, and the caller keeps its
 * own code. Only a Run on the CLI's own login can exhaust a subscription: a
 * Run bound to a ModelProvider is priced and its refusals are the
 * provider's.
 */
export function classifyRuntimeFailure(
  runtimeKey: string | null | undefined,
  errorText: string | null | undefined,
  options: { providerBound: boolean },
): typeof SUBSCRIPTION_QUOTA_EXHAUSTED | null {
  if (options.providerBound || !errorText) return null;
  const spec = getRuntimeAdapterSpec(runtimeKey);
  // Explicit model-capacity refusals have the same meaning across ACP CLIs.
  // A generic HTTP 429 or "rate limit" still does not prove subscription exhaustion.
  if (spec && /\b(?:exhausted (?:your |the )?(?:capacity|quota) (?:on|for) (?:this|the selected) model|model quota (?:is |has been )?(?:exhausted|exceeded))\b/i.test(errorText)) {
    return SUBSCRIPTION_QUOTA_EXHAUSTED;
  }
  const patterns = spec?.usage.quota_exhausted_patterns ?? [];
  return patterns.some((pattern) => new RegExp(pattern, "i").test(errorText))
    ? SUBSCRIPTION_QUOTA_EXHAUSTED
    : null;
}
