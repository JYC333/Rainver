import { describe, expect, it } from "vitest";
import { HostServerFrameSchema, HostFolderReadFrameSchema, HostInstallToolFrameSchema, HostUpdateOwnToolFrameSchema, RuntimeProbeSchema } from "../src/hostWire.js";
import { HostSkillFilesSchema, SkillImportPreviewRequestSchema, SkillImportRequestSchema } from "../src/skills.js";

it("discovers global Skills using opaque ids without accepting a caller filesystem path", () => {
  expect(HostServerFrameSchema.parse({ type: "skill_scan", request_id: "scan-1", path: "/private" })).toEqual({ type: "skill_scan", request_id: "scan-1" });
  expect(HostServerFrameSchema.safeParse({ type: "skill_read", request_id: "read-1", skill_id: "../secret" }).success).toBe(false);
  expect(HostServerFrameSchema.parse({ type: "skill_read", request_id: "read-1", skill_id: "a".repeat(64) })).toMatchObject({ skill_id: "a".repeat(64) });
  const source = { source_type: "local_workspace", host_id: "host-1", skill_id: "a".repeat(64) };
  expect(SkillImportPreviewRequestSchema.safeParse(source).success).toBe(true);
  expect(SkillImportRequestSchema.safeParse({ ...source, package_hash: "b".repeat(64) }).success).toBe(true);
  expect(SkillImportPreviewRequestSchema.safeParse({ ...source, path: "/private" }).success).toBe(false);
  expect(HostSkillFilesSchema.safeParse(Array.from({ length: 9 }, (_, index) => ({ path: `file-${index}`, content_base64: "A".repeat(349528) }))).success).toBe(false);
});

it("own CLI update accepts only fixed runtime recipes, never caller commands", () => {
  const frame = { type: "update_own_tool", request_id: "update-1", runtime_key: "codex_cli" };
  expect(HostUpdateOwnToolFrameSchema.parse({ ...frame, command: "arbitrary" })).not.toHaveProperty("command");
  expect(HostUpdateOwnToolFrameSchema.safeParse({ ...frame, runtime_key: "arbitrary" }).success).toBe(false);
});

it("carries directory pagination without dropping the path or offset", () => {
  const frame = { type: "folder_read", request_id: "read-1", workspace_location_id: "location-1", kind: "tree", protected: false, path: ".agent", tree_offset: 500 };
  expect(HostFolderReadFrameSchema.parse(frame)).toMatchObject({ path: ".agent", tree_offset: 500 });
  expect(HostFolderReadFrameSchema.safeParse({ ...frame, tree_offset: -1 }).success).toBe(false);
});

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
  it("preserves fixed login process settings and post-login verification commands", () => {
    const login = { command: ["claude", "/login"], env: { DISABLE_AUTOUPDATER: "1" },
      verification_command: ["claude", "--version"], managed_verification_command: ["{tree}/claude", "--version"],
      home_subdir: ".claude", credential_file: ".credentials.json" };
    expect(RuntimeProbeSchema.parse({ ...probe, login }).login).toEqual(login);
    expect(RuntimeProbeSchema.safeParse({ ...probe, login: { ...login, verification_command: [] } }).success).toBe(false);
  });
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
