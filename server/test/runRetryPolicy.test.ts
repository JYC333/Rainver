import { describe, expect, it } from "vitest";
import { isRetryableRunErrorCode } from "../src/modules/runs/retryPolicy";

describe("run retry policy", () => {
  it("keeps transient provider failures retryable without retrying permanent errors", () => {
    expect(isRetryableRunErrorCode("provider_network_error")).toBe(true);
    expect(isRetryableRunErrorCode("provider_rate_limit")).toBe(true);
    expect(isRetryableRunErrorCode("invalid_request")).toBe(false);
  });
});
