import { describe, expect, it } from "vitest";
import { RuntimeProbeSchema } from "../src/hostWire.js";

const probe = {
  runtime_key: "opencode",
  runtime: "opencode",
  argv: ["opencode", "acp"],
  distribution: null,
  version: null,
  login: null,
  remote_host_only: false,
};

describe("Host runtime probe identity", () => {
  it("names a runtime only by runtime_key", () => {
    expect(RuntimeProbeSchema.parse(probe)).toMatchObject({ runtime_key: "opencode" });
    expect(RuntimeProbeSchema.safeParse({ ...probe, runtime_key: "" }).success).toBe(false);
    const { runtime_key: _omitted, ...withoutKey } = probe;
    expect(RuntimeProbeSchema.safeParse(withoutKey).success).toBe(false);
  });

  it("drops a second identity field rather than carrying it as an alias", () => {
    const parsed = RuntimeProbeSchema.parse({ ...probe, adapter_type: "claude_code" });
    expect(parsed).not.toHaveProperty("adapter_type");
    expect(parsed.runtime_key).toBe("opencode");
  });
});
