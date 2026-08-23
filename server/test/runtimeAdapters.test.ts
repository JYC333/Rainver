import { describe, expect, it } from "vitest";
import {
  getLocalCliRuntimeAdapterSpec,
  getRuntimeAdapterSpec,
  isVendorCliAdapter,
  listRuntimeAdapterSpecs,
} from "../src/modules/runtimeAdapters";

describe("runtime adapter catalog", () => {
  it("keeps model-provider credentials separate from local CLI login state", () => {
    const specs = listRuntimeAdapterSpecs();
    const modelProviderSpecs = specs.filter(
      (spec) => spec.credentials.credential_mode === "model_provider_api_key",
    );
    expect(modelProviderSpecs.map((spec) => spec.adapter_type).sort()).toEqual([
      "model_api",
      "ts_agent_host",
    ]);

    for (const spec of specs.filter((item) => item.runtime_kind === "local_cli")) {
      if (spec.adapter_type !== "opencode") expect(spec.model.model_provider_mode).toBe("none");
      expect(["cli_profile", "cli_profile_or_model_provider"]).toContain(spec.credentials.credential_mode);
      expect(spec.credentials.credential_runtime_name).toBe(spec.adapter_type);
    }
  });

  it("exposes only implemented local CLI adapters as executable vendor CLIs", () => {
    expect(isVendorCliAdapter("claude_code")).toBe(true);
    expect(isVendorCliAdapter("codex_cli")).toBe(true);
    expect(isVendorCliAdapter("opencode")).toBe(true);
    expect(isVendorCliAdapter("gemini_cli")).toBe(false);
    expect(getLocalCliRuntimeAdapterSpec("opencode")?.implementation_status).toBe("implemented");
  });

  it("owns adapter execution semantics outside providers", () => {
    expect(getRuntimeAdapterSpec("model_api")?.runtime_kind).toBe("managed_api");
  });

  it("declares the execution and trust capabilities for every catalog entry", () => {
    for (const spec of listRuntimeAdapterSpecs()) {
      expect(spec.executor_family).toBe(spec.runtime_kind);
      expect(spec.subagent_support).toBeDefined();
      expect(spec.subagent_disable_mechanism).toBeDefined();
      expect(spec.delegation_controllability).toBeDefined();
      expect(spec.structured_output).toBeDefined();
      expect(spec.checkpoint_resume).toBeDefined();
      expect(spec.cancellation_reliability).toBeDefined();
      expect(spec.observability_level).toBeDefined();
      expect(spec.side_effect_level).toBeDefined();
      expect(spec.data_exposure).toBeDefined();
      expect(spec.baseline_trust_level).toBeDefined();
    }
    expect(getRuntimeAdapterSpec("claude_code")).toMatchObject({
      executor_family: "local_cli",
      subagent_support: "runtime_internal",
      subagent_disable_mechanism: "runtime_config",
      subagent_disable_config: {
        relative_path: ".claude/settings.json",
        denied_value: "Task",
      },
    });
    expect(getRuntimeAdapterSpec("codex_cli")?.subagent_disable_mechanism).toBe("unknown");
    expect(getRuntimeAdapterSpec("opencode")).toMatchObject({
      implementation_status: "implemented",
      invocation: {
        headless_command_template: ["{executable}", "acp", "--cwd", "{sandbox_cwd}"],
        protocol: "acp",
      },
      subagent_disable_config: {
        relative_path: "opencode.json",
        denied_value: { "*": "deny" },
        required_values: expect.arrayContaining([
          { path: ["default_agent"], value: "agent-space-locked", value_mode: "exact" },
          { path: ["subagent_depth"], value: 0, value_mode: "exact" },
          { path: ["agent", "agent-space-locked", "mode"], value: "primary", value_mode: "exact" },
        ]),
      },
    });
  });
});
