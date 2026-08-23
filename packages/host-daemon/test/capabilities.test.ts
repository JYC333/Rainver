import { describe, expect, it } from "vitest";
import { detectCapabilities } from "../src/capabilities.js";

describe("capability discovery", () => {
  it("detects git, which every environment running this test suite has installed", async () => {
    const capabilities = await detectCapabilities();
    expect(capabilities.runtimes).toContain("git");
    expect(capabilities.versions.git).toMatch(/git version/i);
  });

  it("never throws for a binary that is not on PATH — it is simply absent from the result", async () => {
    const capabilities = await detectCapabilities();
    // claude/codex/opencode are not guaranteed to be installed in a CI
    // environment; the contract under test is "absent, not thrown".
    for (const bin of ["claude", "codex", "opencode"] as const) {
      if (!capabilities.runtimes.includes(bin)) {
        expect(capabilities.versions[bin]).toBeUndefined();
      }
    }
  });
});
