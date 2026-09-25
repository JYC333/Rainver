import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

const RETRYABLE_RUN_ERROR_CODES = new Set([
  "adapter_timeout",
  // `cli_adapter_timeout`, `cli_stall_timeout` and
  // `cli_runtime_provider_config_failed` were the server-side CLI line's
  // codes and went with it (ADR 0016); these two are what a host daemon
  // actually reports.
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
 * retried: another attempt meets the same refusal until the window resets,
 * and each one spends a turn of the Run's budget to learn nothing. A
 * discussion stops at it as at a cap (`rooms/discussionService.ts`).
 */
export const SUBSCRIPTION_QUOTA_EXHAUSTED = "subscription_quota_exhausted";

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
  const patterns = getRuntimeAdapterSpec(runtimeKey)?.usage.quota_exhausted_patterns ?? [];
  return patterns.some((pattern) => new RegExp(pattern, "i").test(errorText))
    ? SUBSCRIPTION_QUOTA_EXHAUSTED
    : null;
}
