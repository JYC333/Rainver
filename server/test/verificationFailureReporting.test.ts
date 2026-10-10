import { describe, expect, it } from "vitest";
import { semanticRunFailure } from "../src/modules/runs/orchestrationResults.js";
import type { RunAdapterResultEnvelope } from "@rainver/protocol";

/**
 * A verification failure names what the host said. A failing test, a
 * workspace the host could not resolve, and an offline machine need
 * different actions. Do not collapse them into one sentence.
 */
const succeeded = { success: true, output_json: {} } as unknown as RunAdapterResultEnvelope;

describe("what a failed verification tells the person", () => {
  it("carries the check's own summary instead of a generic sentence", () => {
    const failure = semanticRunFailure(succeeded, [{
      status: "error",
      verifier_type: "test",
      summary: "test command could not be run on the execution host. no local path registered",
    }]);

    expect(failure?.error_code).toBe("verification_failed");
    expect(failure?.error_message).toContain("no local path registered");
    expect(failure?.error_message).not.toBe("Run output did not satisfy its deterministic acceptance checks.");
  });

  it("says how many checks did not pass when more than one did not", () => {
    const failure = semanticRunFailure(succeeded, [
      { status: "failed", verifier_type: "test", summary: "test command failed (exit 1). 2 failing" },
      { status: "failed", verifier_type: "lint", summary: "lint command failed (exit 1)." },
    ]);

    expect(failure?.error_message).toContain("2 failing");
    expect(failure?.error_message).toContain("2 checks did not pass");
  });

  it("still names the verifier when a check recorded no summary", () => {
    const failure = semanticRunFailure(succeeded, [{ status: "failed", verifier_type: "test" }]);
    expect(failure?.error_message).toContain("test");
  });

  it("stays silent when every check passed", () => {
    expect(semanticRunFailure(succeeded, [{ status: "passed", verifier_type: "test" }])).toBeNull();
  });
});
