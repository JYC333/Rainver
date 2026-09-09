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
