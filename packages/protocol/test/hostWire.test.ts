import { describe, expect, it } from "vitest";
import { HostInstallToolFrameSchema, RuntimeProbeSchema } from "../src/hostWire.js";

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

describe("install_tool transport", () => {
  const frame = {
    type: "install_tool",
    request_id: "install-1",
    runtime_key: "opencode",
    version: "1.18.31",
    distribution: { kind: "binary", platforms: {} },
    login: null,
  };

  it("carries an explicit built-in Host route and refuses unknown modes", () => {
    expect(HostInstallToolFrameSchema.parse({ ...frame, egress_transport: { mode: "system_tun" } }))
      .toMatchObject({ egress_transport: { mode: "system_tun" } });
    expect(HostInstallToolFrameSchema.safeParse({ ...frame, egress_transport: { mode: "unsafe_direct" } }).success)
      .toBe(false);
  });
});
