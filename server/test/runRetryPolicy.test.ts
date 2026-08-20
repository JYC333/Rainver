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
});
