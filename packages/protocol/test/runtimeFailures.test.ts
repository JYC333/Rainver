import { describe, expect, it } from "vitest";
import { RuntimeFailureEvidenceSchema, RuntimeFailureTargetSchema } from "../src/runtimeFailures.js";

describe("runtime diagnostic compatibility", () => {
  const legacy = { rpc_code: -32603, vendor_code: "usageLimitExceeded", category: "quota", message: "Limit reached",
    occurred_at: "2026-11-05T21:00:00Z", resets_at: null };
  it("accepts existing failure evidence while validating new stage observations", () => {
    expect(RuntimeFailureEvidenceSchema.parse(legacy)).toEqual(legacy);
    expect(RuntimeFailureEvidenceSchema.parse({ ...legacy, phase: "session_new", phase_elapsed_ms: 1250 })).toMatchObject({ phase: "session_new" });
    expect(RuntimeFailureEvidenceSchema.safeParse({ ...legacy, phase_elapsed_ms: -1 }).success).toBe(false);
    expect(RuntimeFailureEvidenceSchema.safeParse({ ...legacy, category: "probably-auth" }).success).toBe(false);
  });
  it("keeps navigation identity separate from credentials, paths and vendor sessions", () => {
    const target = { host_id: "host-a", runtime_key: "codex_cli", installation: "own", backend_mode: "runtime_native" };
    expect(RuntimeFailureTargetSchema.parse({ ...target, token: "secret", home: "/private", session_id: "native-session" })).toEqual(target);
    expect(RuntimeFailureTargetSchema.safeParse({ ...target, host_id: "" }).success).toBe(false);
  });
});
