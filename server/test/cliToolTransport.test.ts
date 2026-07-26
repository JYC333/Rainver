import { describe, expect, it } from "vitest";
import {
  CliRunToolIdentityRegistry,
} from "../src/modules/runs/cliToolTransport";

describe("CLI Run tool identity", () => {
  it("is short-lived, Run-scoped, cross-space opaque, and revocable", () => {
    const registry = new CliRunToolIdentityRegistry();
    const token = registry.issue({ id: "run-1", space_id: "space-1" }, 60_000);
    expect(registry.resolve(token, "run-1")).toMatchObject({
      run_id: "run-1",
      space_id: "space-1",
    });
    expect(registry.resolve(token, "run-2")).toBeNull();
    expect(registry.resolve(token, "run-1")).toMatchObject({ run_id: "run-1" });

    const revoked = registry.issue({ id: "run-1", space_id: "space-1" }, 60_000);
    registry.revoke(revoked);
    expect(registry.resolve(revoked, "run-1")).toBeNull();
  });

  it("rejects expired identities", () => {
    const registry = new CliRunToolIdentityRegistry();
    const token = registry.issue({ id: "run-1", space_id: "space-1" }, 1);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(registry.resolve(token, "run-1")).toBeNull();
        resolve();
      }, 5);
    });
  });
});
