import { describe, expect, it } from "vitest";
import {
  AgentRuntimeBackendModeSchema,
  AgentRuntimeProfileCreateBodySchema,
  AgentRuntimeProfileUpdateBodySchema,
  RuntimeProfileConfigJsonSchema,
  RuntimeProfileOptionsJsonSchema,
  RuntimeProfilePolicyJsonSchema,
  RunExecutionKindSchema,
  RuntimeKeySchema,
  SpaceAgentRuntimeDefaultOutSchema,
  SpaceAgentRuntimeDefaultWriteSchema,
} from "../src/index.js";

describe("runtime authority contracts", () => {
  it("accepts stable runtime keys and the two explicit backend modes", () => {
    expect(RuntimeKeySchema.parse("opencode")).toBe("opencode");
    expect(AgentRuntimeBackendModeSchema.options).toEqual(["runtime_native", "model_provider"]);
    expect(RunExecutionKindSchema.options).toEqual(["agent", "provider_task"]);
  });

  // Every `runtime_key` column is varchar(64). A key admitted above that width
  // would be stamped on the Profile and then fail with 22001 in mid-dispatch,
  // on whichever downstream table recorded it first.
  it("bounds a runtime key at the one database column width", () => {
    const longest = `acp_${"a".repeat(60)}`;
    expect(longest).toHaveLength(64);
    expect(RuntimeKeySchema.parse(longest)).toBe(longest);
    expect(RuntimeKeySchema.safeParse(`${longest}a`).success).toBe(false);
    expect(RuntimeKeySchema.safeParse("").success).toBe(false);
    expect(RuntimeKeySchema.safeParse("Opencode").success).toBe(false);
  });

  it("rejects invalid provisioning shapes", () => {
    expect(SpaceAgentRuntimeDefaultWriteSchema.safeParse({
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      model_provider_id: "provider-1",
      model_name: null,
    }).success).toBe(false);
    expect(SpaceAgentRuntimeDefaultWriteSchema.safeParse({
      runtime_key: "opencode",
      backend_mode: "model_provider",
      model_provider_id: null,
      model_name: "gpt-5",
    }).success).toBe(false);
    expect(SpaceAgentRuntimeDefaultWriteSchema.safeParse({
      runtime_key: "opencode",
      backend_mode: "runtime_native",
      model_provider_id: null,
      model_name: null,
    }).success).toBe(true);
  });

  it("keeps runtime options from shadowing identity or Agent-owned constraints at any depth", () => {
    expect(RuntimeProfileOptionsJsonSchema.safeParse({
      permission: { mode: "ask" },
      environment: { label: "isolated" },
    }).success).toBe(true);
    for (const invalid of [
      { nested: { runtime_key: "claude_code" } },
      { options: [{ default_runtime_key: "opencode" }] },
      { policy: { risk_level: "critical" } },
      { execution_constraints: { max_run_time_seconds: 3600 } },
    ]) {
      expect(RuntimeProfileOptionsJsonSchema.safeParse(invalid).success).toBe(false);
    }
  });

  // The Profile body schemas are the API boundary for runtime identity, and
  // nothing in this package parsed them: the server's route tests covered the
  // alias rejection, so a widened body shape would have been caught only
  // there — one package away from the contract it changes.
  it("requires a runtime key and a name on a created Runtime Profile", () => {
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default", runtime_key: "opencode",
    }).success).toBe(true);
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({ name: "Default" }).success).toBe(false);
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({ runtime_key: "opencode" }).success).toBe(false);
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "  ", runtime_key: "opencode",
    }).success).toBe(false);
    // The one width authority applies at the boundary too, not only inside.
    expect(AgentRuntimeProfileCreateBodySchema.safeParse({
      name: "Default", runtime_key: `acp_${"a".repeat(61)}`,
    }).success).toBe(false);
  });

  it("retires every deployment alias through .strict() on both Profile bodies", () => {
    for (const retired of ["adapter_type", "default_adapter_type", "allowed_adapter_types", "credential_profile_id"]) {
      expect(AgentRuntimeProfileCreateBodySchema.safeParse({
        name: "Default", runtime_key: "opencode", [retired]: "opencode",
      }).success, retired).toBe(false);
      expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ [retired]: "opencode" }).success, retired).toBe(false);
    }
  });

  it("lets a Profile update carry any subset of the create fields", () => {
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({}).success).toBe(true);
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ enabled: false }).success).toBe(true);
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ backend_mode: "model_provider" }).success).toBe(true);
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ runtime_key: "claude_code" }).success).toBe(true);
    // Partial widens which fields may be absent, never what a present one may be.
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ runtime_key: "Claude_Code" }).success).toBe(false);
    expect(AgentRuntimeProfileUpdateBodySchema.safeParse({ backend_mode: "native" }).success).toBe(false);
  });

  it("gives every live Profile option key exactly one authoring bag", () => {
    // `tools` is read off runtime_config_json by the routing filter and
    // `allow_permission_bypass` off runtime_policy_json by the CLI renderer.
    // Admission refuses the other bag so the silent `a ?? b` precedence the
    // readers used to carry can never be reached.
    expect(RuntimeProfileConfigJsonSchema.safeParse({ tools: ["fs.read"] }).success).toBe(true);
    expect(RuntimeProfileConfigJsonSchema.safeParse({ allow_permission_bypass: true }).success).toBe(false);
    expect(RuntimeProfilePolicyJsonSchema.safeParse({ allow_permission_bypass: true }).success).toBe(true);
    for (const owned of ["tools", "tool_ids", "supports_live", "supports_dry_run"]) {
      expect(RuntimeProfilePolicyJsonSchema.safeParse({ [owned]: true }).success, owned).toBe(false);
    }
    // A runtime's own nested options are not Rainver-owned keys.
    expect(RuntimeProfilePolicyJsonSchema.safeParse({ opencode: { tools: ["fs.read"] } }).success).toBe(true);
    // Both bags keep the one identity/constraint rule.
    expect(RuntimeProfileConfigJsonSchema.safeParse({ nested: { runtime_key: "opencode" } }).success).toBe(false);
    expect(RuntimeProfilePolicyJsonSchema.safeParse({ nested: { risk_level: "critical" } }).success).toBe(false);
  });

  it("carries the Space provisioning template's repair state on the wire", () => {
    const base = {
      space_id: "space-1",
      runtime_key: "opencode",
      backend_mode: "model_provider" as const,
      model_provider_id: "provider-1",
      model_name: "gpt-5",
      runtime_config_json: {},
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:00:00.000Z",
    };
    expect(SpaceAgentRuntimeDefaultOutSchema.safeParse({
      ...base, state: "needs_repair", state_reason: "provider disabled",
    }).success).toBe(true);
    expect(SpaceAgentRuntimeDefaultOutSchema.safeParse({ ...base, state: "ready", state_reason: null }).success).toBe(true);
    expect(SpaceAgentRuntimeDefaultOutSchema.safeParse(base).success).toBe(false);
  });
});
