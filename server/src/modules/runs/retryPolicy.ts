const RETRYABLE_RUN_ERROR_CODES = new Set([
  "adapter_timeout",
  "cli_adapter_timeout",
  "cli_stall_timeout",
  "adapter_runtime_error",
  "cli_runtime_provider_config_failed",
  "runtime_tool_version_unavailable",
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
