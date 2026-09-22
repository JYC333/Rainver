import { describe, expect, it } from "vitest";
import { candidateForPersistedDecision, DeterministicRouteSelector, mergeRouteHints } from "../src/modules/routing/router.js";
import { runtimeRequiredCapabilities } from "../src/modules/routing/repository.js";
import type { RouteCandidate } from "../src/modules/routing/types.js";

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    runtime_profile_id: "profile-1",
    profile_name: "Primary",
    runtime_key: "opencode",
    backend_mode: "model_provider",
    model_provider_id: "provider-1",
    model_name: "model-1",
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
  it("does not revive a persisted Profile that failed current hard filters", () => {
    const selector = new DeterministicRouteSelector();
    const decision = selector.select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
    }, [
      candidate({ runtime_profile_id: "legacy-model-api", enabled: false }),
      candidate({ runtime_profile_id: "current-acp", runtime_key: "opencode" }),
    ]);

    expect(candidateForPersistedDecision(decision, "legacy-model-api")).toBeNull();
    expect(candidateForPersistedDecision(decision, "current-acp")?.runtime_key).toBe("opencode");
  });

  it("does not treat server-owned Room actions as runtime capabilities", async () => {
    await expect(runtimeRequiredCapabilities([
      "inquiry.record_conclusion",
      "inquiry.promote_knowledge",
      "agent.delegate",
      "runtime.custom_capability",
    ])).resolves.toEqual(["runtime.custom_capability"]);
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

  it("filters critical local CLI candidates by Docker capability with OpenCode as the initial runtime", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "critical",
      workspace_available: true,
    }, [
      candidate({
        runtime_profile_id: "local-unsafe",
        runtime_key: "codex_cli", requires_file_access: true,
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        supports_one_shot_docker: false,
        baseline_trust_level: "high",
        effective_trust_level: "high",
      }),
      candidate({
        runtime_profile_id: "opencode-safe",
        runtime_key: "opencode",
        supports_one_shot_docker: true,
      }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("opencode-safe");
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
      hints: mergeRouteHints([{ source: "task_contract", value: { preferred_runtime_keys: ["claude_code"] } }]),
    }, [
      candidate({ runtime_profile_id: "opencode", profile_name: "OpenCode", runtime_key: "opencode", minimum_sandbox_level: "worktree", supports_workspace: true, is_default: true }),
      candidate({ runtime_profile_id: "claude", profile_name: "Claude", runtime_key: "claude_code", requires_file_access: true, minimum_sandbox_level: "worktree", supports_workspace: true, is_default: false, historical_verification_pass_rate: 0.8 }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("claude");
    expect(result.fallback_chain).toEqual(["claude", "opencode"]);
  });

  it("uses the selected default Profile for conversational and structured generation", () => {
    for (const executionShape of ["conversational", "structured_generation"] as const) {
      const result = new DeterministicRouteSelector().select({
        required_sandbox_level: "none",
        execution_mode: "live",
        risk_level: "low",
        workspace_available: false,
        hints: mergeRouteHints([{ source: "contract", value: { execution_shape: executionShape } }]),
      }, [
        candidate({ runtime_profile_id: "alternate", runtime_key: "claude_code", is_default: false }),
        candidate({
          runtime_profile_id: "open",
          runtime_key: "opencode", requires_file_access: true,
          is_default: true,
          minimum_sandbox_level: "worktree",
          supports_workspace: true,
          effective_trust_level: "low",
        }),
      ]);
      expect(result.selected?.candidate.runtime_profile_id).toBe("open");
    }
  });

  it("lets an explicitly preferred Profile outrank the default on conversational work", () => {
    // Scoring terms are named for what they measure (B61). A shape-named term
    // that was really a ten-fold copy of `default_profile` could outscore the
    // Profile the caller asked for; the default's own weight must not.
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: false,
      hints: mergeRouteHints([{
        source: "contract",
        value: { execution_shape: "conversational", preferred_runtime_profile_id: "preferred" },
      }]),
    }, [
      candidate({ runtime_profile_id: "preferred", is_default: false }),
      candidate({ runtime_profile_id: "space-default", is_default: true }),
    ]);

    expect(result.selected?.candidate.runtime_profile_id).toBe("preferred");
    expect(result.selected?.score_trace).not.toHaveProperty("execution_shape_default");
    expect(result.selected?.score_trace.profile_preference).toBe(25);
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
        candidate({ runtime_profile_id: "opencode", runtime_key: "opencode" }),
        candidate({
          runtime_profile_id: "open",
          runtime_key: "opencode", requires_file_access: true,
          is_default: false,
          minimum_sandbox_level: "worktree",
          supports_workspace: true,
          effective_trust_level: "low",
        }),
      ]);
      expect(result.selected?.candidate.runtime_profile_id).toBe("open");
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runtime_profile_id: "opencode",
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
        runtime_key: "some_future_cli",
        requires_file_access: true,
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
      }),
    ]);
    expect(result.selected?.candidate.runtime_profile_id).toBe("future");
    expect(result.rejected).toEqual([]);
  });

  it("rejects registered runtimes without file access from file work", () => {
    for (const runtimeKey of ["opencode", "claude_code", "codex_cli"]) {
      const result = new DeterministicRouteSelector().select({
        required_sandbox_level: "none",
        execution_mode: "live",
        risk_level: "low",
        workspace_available: true,
        hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "code_execution" } }]),
      }, [candidate({ runtime_profile_id: "no-files", runtime_key: runtimeKey })]);
      expect(result.selected).toBeNull();
      expect(result.rejected).toEqual(expect.arrayContaining([
        expect.objectContaining({ reasons: expect.arrayContaining(["execution_shape_incompatible"]) }),
      ]));
    }
  });

  it("rejects a tool-free, file-less adapter from file work, and now admits the CLI", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: true,
      required_tools: ["shell"],
      hints: mergeRouteHints([{ source: "contract", value: { execution_shape: "agentic_files" } }]),
    }, [
      candidate({ runtime_profile_id: "opencode", runtime_key: "opencode", tools: [] }),
      candidate({
        runtime_profile_id: "open",
        runtime_key: "opencode", requires_file_access: true,
        tools: ["shell"],
        minimum_sandbox_level: "worktree",
        supports_workspace: true,
        effective_trust_level: "low",
      }),
    ]);
    // The CLI is selected now. It used to be rejected for having no passing
    // conformance suite, which was the gate removed on 2026-09-09: a one-shot
    // behaviour probe, cached against a version key and blind to the model,
    // was not evidence to refuse work on.
    expect(result.selected?.candidate.runtime_profile_id).toBe("open");
    expect(result.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime_profile_id: "opencode",
        reasons: expect.arrayContaining(["required_tool_missing", "execution_shape_incompatible"]),
      }),
    ]));
  });

  it("merges task, workflow, and evolution hints with source trace", () => {
    const hints = mergeRouteHints([
      { source: "task_contract", value: { required_capabilities: ["research"], cost_budget_usd: 2 } },
      { source: "workflow_node", value: { required_tools: ["browser"], preferred_runtime_keys: ["opencode"] } },
      { source: "evolution_strategy", value: { minimum_trust_level: "high", latency_budget_ms: 1000 } },
    ]);
    expect(hints).toMatchObject({
      required_capabilities: ["research"],
      required_tools: ["browser"],
      preferred_runtime_keys: ["opencode"],
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

  it("allows a low/medium-risk file-access CLI without a persistent workspace", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "low",
      workspace_available: false,
    }, [candidate({
      runtime_key: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      requires_workspace_for_execution: false,
      supports_workspace: true,
      effective_trust_level: "low",
    })]);
    expect(result.selected?.candidate.runtime_key).toBe("opencode");
  });

  it("requires a persistent workspace for high-risk file-access CLI work", () => {
    const result = new DeterministicRouteSelector().select({
      required_sandbox_level: "none",
      execution_mode: "live",
      risk_level: "high",
      workspace_available: false,
    }, [candidate({
      runtime_key: "opencode", requires_file_access: true,
      minimum_sandbox_level: "worktree",
      requires_workspace_for_execution: false,
      supports_workspace: true,
      baseline_trust_level: "high",
      effective_trust_level: "high",
    })]);
    expect(result.selected).toBeNull();
    expect(result.rejected[0]?.reasons).toContain("workspace_or_file_access_unavailable");
  });
});
