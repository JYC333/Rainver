import { describe, expect, it } from "vitest";
import { isRetryableRunErrorCode } from "../src/modules/runs/retryPolicy";

describe("run retry policy", () => {
  it("keeps transient provider failures retryable without retrying permanent errors", () => {
    expect(isRetryableRunErrorCode("provider_network_error")).toBe(true);
    // A stream torn off after the provider answered 200 is transport, not a
    // verdict: the Supervisor's bounded retry has to be allowed to try again.
    expect(isRetryableRunErrorCode("provider_stream_terminated")).toBe(true);
    expect(isRetryableRunErrorCode("provider_rate_limit")).toBe(true);
    expect(isRetryableRunErrorCode("invalid_request")).toBe(false);
  });

  it("treats a remote run's timeout and stall the same as the server host's", () => {
    // These two are the remote path's twins of cli_adapter_timeout and
    // cli_stall_timeout. Only the local pair was listed, so an identical
    // failure was retried automatically on the server host and sent straight
    // to human review on a paired one.
    expect(isRetryableRunErrorCode("cli_adapter_timeout")).toBe(true);
    expect(isRetryableRunErrorCode("cli_stall_timeout")).toBe(true);
    expect(isRetryableRunErrorCode("runtime_timeout")).toBe(true);
    expect(isRetryableRunErrorCode("runtime_stall_timeout")).toBe(true);
    // A runtime that ran and exited non-zero reached a verdict; retrying it
    // repeats the same work for the same answer.
    expect(isRetryableRunErrorCode("runtime_nonzero_exit")).toBe(false);
  });
});
