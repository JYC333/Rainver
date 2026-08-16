import { describe, expect, it } from "vitest";
import { DeterministicRouteSelector, mergeRouteHints } from "../src/modules/routing/router";
import type { RouteCandidate } from "../src/modules/routing/types";
import { SERVER_MODULES } from "../src/gateway/routeRegistry";

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    runtime_profile_id: "profile-1",
    profile_name: "Primary",
    adapter_type: "model_api",
    model_provider_id: "provider-1",
    model_name: "model-1",
    credential_profile_id: null,
    runtime_config_json: {},
    runtime_policy_json: {},
    enabled: true,
    is_default: true,
    credential_available: true,
    capabilities: ["research"],
    tools: ["browser"],
    minimum_sandbox_level: "none",
    requires_file_access: false,
    requires_workspace_for_execution: false,
    supports_workspace: false,
    supports_one_shot_docker: false,
    supports_live: true,
    supports_dry_run: true,
    baseline_trust_level: "high",
    effective_trust_level: "high",
    subagent_disable_mechanism: "not_applicable",
    estimated_cost_usd: 1,
    estimated_latency_ms: 500,
    historical_verification_pass_rate: 0.9,
    ...overrides,
  };
}

describe("deterministic route selector", () => {
  it("registers the durable run route-decision read surface", () => {
    expect(SERVER_MODULES.find((module) => module.name === "routing")).toBeDefined();
  });

  it("hard-filters credentials, capabilities, sandbox, and trust before scoring", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "worktree",
      execution_mode: "live",
      risk_level: "high",
      workspace_available: true,
      required_capabilities: ["code"],
      required_tools: ["shell"],
    }, [candidate({ credential_available: false, baseline_trust_level: "low", effective_trust_level: "low" })]);
    expect(result.selected).toBeNull();
    expect(result.rejected[0]?.reasons).toEqual(expect.arrayContaining([
      "credential_unavailable",
      "required_capability_missing",
      "required_tool_missing",
      "trust_level_too_low",
    ]));
  });

  it("rejects a weaker sandbox instead of confusing it with a stronger candidate", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "one_shot_docker",
      execution_mode: "live",
      risk_level: "critical",
      workspace_available: true,
    }, [
      candidate({ minimum_sandbox_level: "worktree" }),
      candidate({ runtime_profile_id: "docker", minimum_sandbox_level: "one_shot_docker", supports_one_shot_docker: true }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("docker");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_profile_id: "profile-1", reasons: expect.arrayContaining(["sandbox_requirement_not_supported"]) }),
    ]));
  });

  it("filters critical local CLI candidates by Docker capability even when the initial adapter is managed API", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "critical",
      workspace_available: true,
    }, [
      candidate({
        runtime_profile_id: "local-unsafe",
        adapter_type: "codex_cli", requires_file_access: true,
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        supports_one_shot_docker: false,
        baseline_trust_level: "high",
        effective_trust_level: "high",
      }),
      candidate({ runtime_profile_id: "managed-safe", adapter_type: "model_api" }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("managed-safe");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_profile_id: "local-unsafe",
        reasons: expect.arrayContaining(["sandbox_requirement_not_supported"]),
      }),
    ]));
  });

  it("selects the highest deterministic score and keeps the rest as fallback chain", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "worktree",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
      hints: { ...mergeRouteHints([{ source: "task_contract", value: { preferred_adapters: ["claude_code"] } }]) },
    }, [
      candidate({ runtime_profile_id: "model", profile_name: "Model", adapter_type: "model_api", minimum_sandbox_level: "worktree", supports_workspace: true, is_default: true }),
      candidate({ runtime_profile_id: "claude", profile_name: "Claude", adapter_type: "claude_code", requires_file_access: true, minimum_sandbox_level: "worktree", supports_workspace: true, is_default: false, historical_verification_pass_rate: 0.8 }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("claude");
    expect(result.fallback_chain).toEqual(["claude", "model"]);
  });

  it("defaults conversational and structured generation to Managed API", () => {
    for (const executionShape of ["conversational", "structured_generation"] as const) {
      const result = new DeterministicRouteSelector().select({
        required_sandbox_level: "none",
        execution_mode: "live",
        risk_level: "low",
        workspace_available: false,
        hints: mergeRouteHints([{ source: "contract", value: { execution_shape: executionShape } }]),
      }, [
        candidate({ runtime_profile_id: "managed", adapter_type: "model_api", is_default: false }),
        candidate({
          runtime_profile_id: "open",
          adapter_type: "opencode", requires_file_access: true,
          is_default: true,
          minimum_sandbox_level: "worktree",
          supports_workspace: true,
          effective_trust_level: "low",
          conformance_status: "passed",
        }),
      ]);
      expect(result.selected?.candidate.runtime_profile_id).toBe("managed");
    }
  });

  it("defaults file and code shapes to conformant OpenCode", () => {
    for (const executionShape of ["agentic_files", "code_execution"] as const) {
      const result = new DeterministicRouteSelector().select({
        required_sandbox_level: "none",
        execution_mode: "live",
        risk_level: "low",
        workspace_available: true,
        hints: mergeRouteHints([{ source: "contract", value: { execution_shape: executionShape } }]),
      }, [
        candidate({ runtime_profile_id: "managed", adapter_type: "model_api" }),
        candidate({
          runtime_profile_id: "open",
          adapter_type: "opencode", requires_file_access: true,
          is_default: false,
          minimum_sandbox_level: "worktree",
          supports_workspace: true,
          effective_trust_level: "low",
          conformance_status: "passed",
        }),
      ]);
      expect(result.selected?.candidate.runtime_profile_id).toBe("open");
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runtime_profile_id: "managed",
          reasons: expect.arrayContaining(["execution_shape_incompatible"]),
        }),
      ]));
    }
  });

  it("admits file work on a declared file-access adapter the router has never heard of", () => {
    // Gate for judging by declaration rather than by name: this adapter type
    // appears in no branch of hardFilterReasons, so if it is admitted, the
    // judgement came from requires_file_access alone.
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
      hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "agentic_files" } }]),
    }, [
      candidate({
        runtime_profile_id: "future",
        adapter_type: "some_future_cli",
        requires_file_access: true,
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        conformance_status: "passed",
      }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("future");
    expect(result.rejected).toEqual([]);
  });

  it("requires conformance evidence from any file-access CLI on file work, not only OpenCode", () => {
    // The name-based form asked this of OpenCode alone, so a Claude Code or
    // Codex profile could take low-risk file work with no C3 evidence at all
    // (the risk-based conformance filter above only covers non-low risk).
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
      hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "agentic_files" } }]),
    }, [
      candidate({
        runtime_profile_id: "claude",
        adapter_type: "claude_code", requires_file_access: true,
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        effective_trust_level: "low",
        conformance_status: null,
      }),
    ]);
    expect(result.selected).toBeNull();
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_profile_id: "claude",
        reasons: expect.arrayContaining(["runtime_conformance_required_for_execution_shape"]),
      }),
    ]));
  });

  it("rejects every no-file-access adapter from file work, not only Managed API", () => {
    // ts_agent_host and capability declare the same noFiles sandbox as
    // model_api. The name-based form rejected only model_api.
    for (const adapterType of ["model_api", "ts_agent_host", "capability"]) {
      const result = new DeterministicRouteSelector().select({
        required_sandbox_level: "none",
        execution_mode: "live",
        risk_level: "low",
        workspace_available: true,
        hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "code_execution" } }]),
      }, [candidate({ runtime_profile_id: "no-files", adapter_type: adapterType })]);
      expect(result.selected).toBeNull();
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ reasons: expect.arrayContaining(["execution_shape_incompatible"]) }),
      ]));
    }
  });

  it("rejects nonconformant OpenCode and tool-free fallback for file work", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
      required_tools: ["shell"],
      hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "agentic_files" } }]),
    }, [
      candidate({ runtime_profile_id: "managed", adapter_type: "model_api", tools: [] }),
      candidate({
        runtime_profile_id: "open",
        adapter_type: "opencode", requires_file_access: true,
        tools: ["shell"],
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        effective_trust_level: "low",
        conformance_status: "partial",
      }),
    ]);
    expect(result.selected).toBeNull();
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_profile_id: "managed",
        reasons: expect.arrayContaining(["required_tool_missing", "execution_shape_incompatible"]),
      }),
      expect.objectContaining({
        runtime_profile_id: "open",
        reasons: expect.arrayContaining(["runtime_conformance_required_for_execution_shape"]),
      }),
    ]));
  });

  it("merges task, workflow, and evolution hints with source trace", () => {
    const hints = mergeRouteHints([
      { source: "task_contract", value: { required_capabilities: ["research"], cost_budget_usd: 2 } },
      { source: "workflow_node", value: { required_tools: ["browser"], preferred_adapter_types: ["model_api"] } },
      { source: "evolution_strategy", value: { minimum_trust_level: "high", latency_budget_ms: 1000 } },
    ]);
    expect(hints).toMatchObject({
      required_capabilities: ["research"],
      required_tools: ["browser"],
      preferred_adapter_types: ["model_api"],
      minimum_trust_level: "high",
      cost_budget_usd: 2,
      latency_budget_ms: 1000,
    });
    expect(hints.sources).toEqual(["task_contract", "workflow_node", "evolution_strategy"]);
  });

  it("never lets a route hint lower risk-derived sandbox or trust requirements", () => {
    const hints = mergeRouteHints([{
      source: "workflow_node",
      value: { required_sandbox_level: "none", minimum_trust_level: "low" },
    }]);
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "worktree",
      execution_mode: "live",
      risk_level: "high",
      workspace_available: true,
      hints,
    }, [candidate({ minimum_sandbox_level: "none", baseline_trust_level: "low", effective_trust_level: "medium" })]);
    expect(result.selected).toBeNull();
    expect(result.rejected[0]?.reasons).toEqual(expect.arrayContaining([
      "trust_level_too_low",
    ]));
  });

  it("treats a manually selected runtime profile as a hard constraint", () => {
    const result = new DeterministicRouteSelector().select({
      runtime_profile_id: "profile-1",
      runtime_profile_is_explicit: true,
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: false,
    }, [
      candidate({ runtime_profile_id: "profile-1", historical_verification_pass_rate: 0.1 }),
      candidate({ runtime_profile_id: "profile-2", historical_verification_pass_rate: 1, is_default: false }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("profile-1");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_profile_id: "profile-2", reasons: ["explicit_profile_not_selected"] }),
    ]));
  });

  it("selects the next eligible profile when a retry excludes the prior route", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: false,
      excluded_runtime_profile_ids: ["profile-1"],
      fallback_runtime_profile_ids: ["profile-1", "profile-2"],
    }, [
      candidate({ runtime_profile_id: "profile-1" }),
      candidate({ runtime_profile_id: "profile-2", is_default: false }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("profile-2");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_profile_id: "profile-1",
        reasons: expect.arrayContaining(["runtime_profile_excluded_for_retry"]),
      }),
    ]));
  });

  it("requires conformance evidence before any local CLI can serve non-low-risk work", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "worktree",
      execution_mode: "live",
      risk_level: "medium",
      workspace_available: true,
    }, [candidate({
      adapter_type: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      supports_workspace: true,
      baseline_trust_level: "low",
      effective_trust_level: "low",
      subagent_disable_mechanism: "runtime_config",
      conformance_status: null,
    })]);
    expect(result.selected).toBeNull();
    expect(result.rejected[0]?.reasons).toContain("runtime_conformance_required");

    const passed = new DeterministicRouteSelector().select({
      required_sandbox_level: "worktree",
      execution_mode: "live",
      risk_level: "medium",
      workspace_available: true,
    }, [candidate({
      adapter_type: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      supports_workspace: true,
      baseline_trust_level: "low",
      effective_trust_level: "medium",
      subagent_disable_mechanism: "runtime_config",
      conformance_status: "passed",
    })]);
    expect(passed.selected?.candidate.adapter_type).toBe("opencode");
  });

  it("allows a low/medium-risk file-access CLI without a persistent workspace", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: false,
    }, [candidate({
      adapter_type: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      requires_workspace_for_execution: false,
      supports_workspace: true,
      effective_trust_level: "low",
    })]);
    expect(result.selected?.candidate.adapter_type).toBe("opencode");
  });

  it("requires a persistent workspace for high-risk file-access CLI work", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "high",
      workspace_available: false,
    }, [candidate({
      adapter_type: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      requires_workspace_for_execution: false,
      supports_workspace: true,
      baseline_trust_level: "high",
      effective_trust_level: "high",
      conformance_status: "passed",
    })]);
    expect(result.selected).toBeNull();
    expect(result.rejected[0]?.reasons).toContain("workspace_or_file_access_unavailable");
  });
});
