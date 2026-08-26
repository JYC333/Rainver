import { beforeAll, describe, expect, it } from "vitest";
import { loadActionRegistry } from "../src/modules/policy/actionRegistry.js";
import {
  checkHardInvariants,
  engineCheck,
  hasRoleAtLeast,
  normalizeRole,
} from "../src/modules/policy/decisionCore.js";
import {
  buildAuditEnvelope,
  checkProposalApplyPolicy,
  computeDecision,
  effectiveProposalRisk,
  isDurableAuditRequired,
  resolveFailureMode,
  SUPPORTED_PROPOSAL_TYPES,
  type Registry,
} from "../src/modules/policy/gateway.js";
import { sanitizePolicyMetadata } from "../src/modules/policy/sanitizer.js";

let registry: Registry;
beforeAll(async () => {
  registry = await loadActionRegistry();
});

function req(action: string, extra: Record<string, unknown> = {}) {
  return { action, force_record: false, ...extra } as never;
}

function spawnChildContext(extra: Record<string, unknown> = {}) {
  return {
    action: "run.spawn_child",
    space_id: "s1",
    resource_space_id: "s1",
    group_id: "group-1",
    parent_run_id: "run-parent",
    root_run_id: "run-root",
    requesting_agent_id: "agent-manager",
    target_agent_id: "agent-reader",
    manager_user_id: "user-1",
    group_status: "active",
    requesting_agent_status: "active",
    target_agent_status: "active",
    requesting_member_status: "active",
    target_member_status: "active",
    depth: 1,
    max_depth: 3,
    fanout_count: 1,
    max_fanout: 8,
    concurrency_count: 1,
    max_concurrency: 4,
    ...extra,
  };
}

describe("roles", () => {
  it("normalizes unknown roles to guest", () => {
    expect(normalizeRole("ADMIN")).toBe("admin");
    expect(normalizeRole("superuser")).toBe("guest");
    expect(normalizeRole("")).toBe("guest");
  });
  it("ranks authority", () => {
    expect(hasRoleAtLeast("owner", "admin")).toBe(true);
    expect(hasRoleAtLeast("member", "admin")).toBe(false);
  });
});

describe("information digest automation policy", () => {
  it("allows a member to fire their own personal digest schedule", () => {
    const decision = engineCheck(registry, req("automation.fire", {
      membership_role: "member",
      target_type: "information_digest",
      actor_is_owner: true,
    }));
    expect(decision).toMatchObject({
      decision: "allow",
      policy_rule_id: "automation_information_digest_owner_allow",
      risk_level: "low",
    });
  });

  it("requires Project writer proof for the Project form", () => {
    const denied = engineCheck(registry, req("automation.fire", {
      membership_role: "member",
      target_type: "information_digest",
      actor_is_owner: true,
      project_id: "project-1",
      project_writer: false,
    }));
    const allowed = engineCheck(registry, req("automation.fire", {
      membership_role: "member",
      target_type: "information_digest",
      actor_is_owner: true,
      project_id: "project-1",
      project_writer: true,
    }));
    expect(denied.decision).toBe("deny");
    expect(allowed.policy_rule_id).toBe("automation_information_digest_owner_allow");
  });
});

describe("managed grantable system actions", () => {
  it("denies a requestable action until the exact Run grant exists", () => {
    const denied = engineCheck(registry, req("project.source.bind", {
      surface: "managed_run_system_action_gateway",
      action_id: "project.source.propose_bind",
      has_action_approval_grant: false,
    }));
    expect(denied).toMatchObject({
      decision: "deny",
      policy_rule_id: "managed_system_action_grant_required",
    });

    const allowed = engineCheck(registry, req("project.source.bind", {
      surface: "managed_run_system_action_gateway",
      action_id: "project.source.propose_bind",
      has_action_approval_grant: true,
    }));
    expect(allowed).toMatchObject({
      decision: "allow",
      policy_rule_id: "managed_system_action_granted",
    });
  });
});

describe("hard invariants", () => {
  it("denies cross-space memory read without grant", () => {
    const d = checkHardInvariants({
      action: "context.inject_memory",
      space_id: "s1",
      resource_space_id: "s2",
    });
    expect(d?.decision).toBe("deny");
    expect(d?.reason_code).toBe("hard_invariant_cross_space_memory");
    expect(d?.risk_level).toBe("critical");
  });
  it("allows same-space memory read", () => {
    expect(
      checkHardInvariants({
        action: "context.inject_memory",
        space_id: "s1",
        resource_space_id: "s1",
      }),
    ).toBeNull();
  });
  it("permits cross-space read with grant", () => {
    expect(
      checkHardInvariants({
        action: "context.inject_memory",
        space_id: "s1",
        resource_space_id: "s2",
        has_personal_memory_grant: true,
      }),
    ).toBeNull();
  });
  it("blocks raw private memory egress", () => {
    const d = checkHardInvariants({
      action: "artifact.persist",
      raw_private_memory_included: true,
    });
    expect(d?.audit_code).toBe("raw_private_memory_egress_blocked");
  });
  it("rejects approval-proof flags on proposal.apply", () => {
    const d = checkHardInvariants({
      action: "proposal.apply",
      payload: { is_approved: true },
    });
    expect(d?.reason_code).toBe("hard_invariant_payload_not_approval_proof");
  });
  it("rejects personal_context_block persistence", () => {
    const d = checkHardInvariants({
      action: "memory.create",
      metadata_json: { personal_context_block: "x" },
    });
    expect(d?.audit_code).toBe("personal_context_block_persist_attempt");
  });
  it("fails closed on empty target_space_id in egress", () => {
    const d = checkHardInvariants({
      action: "artifact.persist",
      target_space_id: "  ",
    });
    expect(d?.reason_code).toBe("hard_invariant_unknown_target_space");
  });
});

describe("engine + registry default", () => {
  it("unknown action fails closed", () => {
    const d = engineCheck(registry, { action: "made.up" });
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("unknown_policy_action");
  });
  it("runtime.execute defaults to allow", () => {
    const d = engineCheck(registry, { action: "runtime.execute" });
    expect(d.decision).toBe("allow");
  });
  it("runtime_skill.render requires enablement proof before allowing render", () => {
    const d = engineCheck(registry, {
      action: "runtime_skill.render",
      risk_level: "medium",
    });
    expect(d.decision).toBe("require_approval");
    expect(d.policy_rule_id).toBe("registry_default");
  });
  it("runtime_skill.render allows enabled bindings (review happens at enablement)", () => {
    const d = engineCheck(registry, {
      action: "runtime_skill.render",
      risk_level: "medium",
      enabled_binding: true,
      capability_enablement_id: "enable-1",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("runtime_skill_render_enabled_binding");
  });
  it("runtime_skill.render allows enabled bindings even without a context risk_level", () => {
    const d = engineCheck(registry, {
      action: "runtime_skill.render",
      enabled_binding: true,
      capability_enablement_id: "enable-1",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("runtime_skill_render_enabled_binding");
  });
  it("runtime_skill.render allows enabled high-risk bindings (enablement was the review gate)", () => {
    const d = engineCheck(registry, {
      action: "runtime_skill.render",
      risk_level: "high",
      enabled_binding: true,
      capability_enablement_id: "enable-1",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("runtime_skill_render_enabled_binding");
    expect(d.risk_level).toBe("high");
  });
  it("retrieval tool policy allows enabled domains with an instructed viewer", () => {
    const { decision } = computeDecision(
      registry,
      req("memory.retrieval.search", {
        space_id: "s1",
        context: {
          domain: "memory",
          domain_enabled: true,
          instructed_by_user_id: "u1",
        },
      }),
    );
    expect(decision.decision).toBe("allow");
    expect(decision.policy_rule_id).toBe("retrieval_tool_call_allowed");
    expect(decision.resource_type).toBe("retrieval_tool");
  });
  it("retrieval tool policy denies disabled domains", () => {
    const { decision } = computeDecision(
      registry,
      req("memory.retrieval.search", {
        space_id: "s1",
        context: {
          domain: "memory",
          domain_enabled: false,
          instructed_by_user_id: "u1",
        },
      }),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.audit_code).toBe("retrieval_tool_domain_not_enabled");
  });
  it("retrieval tool policy requires an instructed viewer", () => {
    const { decision } = computeDecision(
      registry,
      req("retrieval.search", {
        space_id: "s1",
        context: {
          domain: "knowledge",
          domain_enabled: true,
        },
      }),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.audit_code).toBe("retrieval_tool_missing_viewer");
  });
  it("retrieval tool policy reserves source and egress denial hooks", () => {
    const sourceDenied = computeDecision(
      registry,
      req("retrieval.brief", {
        space_id: "s1",
        context: {
          domain: "knowledge",
          domain_enabled: true,
          instructed_by_user_id: "u1",
          source_policy_denied: true,
        },
      }),
    ).decision;
    const egressDenied = computeDecision(
      registry,
      req("project.summary.brief", {
        space_id: "s1",
        context: {
          domain: "project_public_summary",
          domain_enabled: true,
          instructed_by_user_id: "u1",
          egress_policy_denied: true,
        },
      }),
    ).decision;
    expect(sourceDenied.decision).toBe("deny");
    expect(sourceDenied.audit_code).toBe("retrieval_tool_source_policy_denied");
    expect(egressDenied.decision).toBe("deny");
    expect(egressDenied.audit_code).toBe("retrieval_tool_egress_policy_denied");
  });
  it("runtime.use_credential same-space manual allows", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "manual",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("credential_same_space_manual_allow");
  });
  it("runtime.use_credential same-space delegation allows", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "delegation",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("credential_same_space_manual_allow");
  });
  it("runtime.use_credential automation requires approval", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "automation",
    });
    expect(d.decision).toBe("require_approval");
  });
  it("runtime.use_credential autonomous uses Automation standing authorization", () => {
    const denied = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "autonomous",
    });
    const allowed = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "autonomous",
      automation_pre_authorized: true,
    });
    expect(denied.decision).toBe("require_approval");
    expect(allowed.decision).toBe("allow");
    expect(allowed.policy_rule_id).toBe("credential_automation_preauthorized_allow");
  });
  it("runtime.use_credential allows a user-configured source post-processing job", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "job",
      managed_execution: "source_post_processing",
      credential_pre_authorized: true,
      failure_policy: "fail_fast",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("credential_managed_preauthorized_allow");
  });
  it("runtime.use_credential allows the post-screening project research run", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "system",
      managed_execution: "project_research",
      credential_pre_authorized: true,
      failure_policy: "fail_fast",
    });
    expect(d.decision).toBe("allow");
    expect(d.policy_rule_id).toBe("credential_managed_preauthorized_allow");
  });
  it("managed pre-authorization does not bypass an Automation-origin run", () => {
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s1",
      trigger_origin: "automation",
      managed_execution: "source_post_processing",
      credential_pre_authorized: true,
      failure_policy: "fail_fast",
    });
    expect(d.decision).toBe("require_approval");
  });
  it("runtime.use_credential cross-space denies via space_boundary (runs before the credential rule)", () => {
    // rule_space_boundary precedes rule_use_credential, so a cross-space
    // credential request denies as space_boundary, not credential_cross_space.
    const d = engineCheck(registry, {
      action: "runtime.use_credential",
      space_id: "s1",
      resource_space_id: "s2",
    });
    expect(d.decision).toBe("deny");
    expect(d.reason_code).toBe("space_boundary");
  });
  it("tool not in permission list denies runtime.execute", () => {
    const d = engineCheck(registry, {
      action: "runtime.execute",
      tool_name: "codex_cli",
      agent_tool_permissions: ["claude_code"],
    });
    expect(d.decision).toBe("deny");
    expect(d.reason_code).toBe("tool_not_permitted");
  });
  it("run.spawn_child requires delegation context and fails closed when missing", () => {
    const d = engineCheck(registry, {
      action: "run.spawn_child",
      space_id: "s1",
      resource_space_id: "s1",
    });
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("run_spawn_child_missing_context");
  });
  it("run.spawn_child requires explicit active-state proofs", () => {
    const d = engineCheck(registry, {
      action: "run.spawn_child",
      space_id: "s1",
      resource_space_id: "s1",
      group_id: "group-1",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      requesting_agent_id: "agent-manager",
      target_agent_id: "agent-reader",
      manager_user_id: "user-1",
    });
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("run_spawn_child_missing_context");
  });
  it("run.spawn_child requires explicit budget and capacity proofs", () => {
    const d = engineCheck(registry, {
      action: "run.spawn_child",
      space_id: "s1",
      resource_space_id: "s1",
      group_id: "group-1",
      parent_run_id: "run-parent",
      root_run_id: "run-root",
      requesting_agent_id: "agent-manager",
      target_agent_id: "agent-reader",
      manager_user_id: "user-1",
      group_status: "active",
      requesting_agent_status: "active",
      target_agent_status: "active",
      requesting_member_status: "active",
      target_member_status: "active",
    });
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("run_spawn_child_missing_context");
    expect(d.message).toContain("numeric context");
  });
  it("run.spawn_child allows active same-space group delegation", () => {
    const d = engineCheck(registry, spawnChildContext({ max_depth: 2, max_fanout: 4 }));
    expect(d.decision).toBe("allow");
    expect(d.audit_code).toBe("run_spawn_child_allowed");
  });
  it("run.spawn_child denies inactive group, agent, or member proofs", () => {
    for (const field of ["group_status", "target_agent_status", "target_member_status"]) {
      const d = engineCheck(registry, spawnChildContext({ [field]: "paused" }));
      expect(d.decision).toBe("deny");
      expect(d.audit_code).toBe("run_spawn_child_inactive_context");
    }
  });
  it("run.spawn_child denies authority widening", () => {
    const d = engineCheck(registry, spawnChildContext({ context_widens_authority: true }));
    expect(d.decision).toBe("deny");
    expect(d.risk_level).toBe("critical");
    expect(d.audit_code).toBe("run_spawn_child_authority_widening");
  });
  it("run.spawn_child denies Memory or Knowledge direct-write authority widening", () => {
    const d = engineCheck(registry, spawnChildContext({ durable_write_scope_widens: true }));
    expect(d.decision).toBe("deny");
    expect(d.risk_level).toBe("critical");
    expect(d.audit_code).toBe("run_spawn_child_authority_widening");
  });
  it("run.spawn_child applies depth budgets as hard ceilings", () => {
    const atLimit = engineCheck(registry, spawnChildContext({ depth: 2, max_depth: 2 }));
    const overLimit = engineCheck(registry, spawnChildContext({ depth: 3, max_depth: 2 }));
    expect(atLimit.decision).toBe("allow");
    expect(overLimit.decision).toBe("deny");
    expect(overLimit.audit_code).toBe("run_spawn_child_depth_limit");
  });
  it("run.spawn_child applies fanout and concurrency budgets as inclusive current counts", () => {
    const fanoutAtLimit = engineCheck(registry, spawnChildContext({
      fanout_count: 2,
      max_fanout: 2,
    }));
    const fanoutOverLimit = engineCheck(registry, spawnChildContext({
      fanout_count: 3,
      max_fanout: 2,
    }));
    const concurrencyAtLimit = engineCheck(registry, spawnChildContext({
      concurrency_count: 4,
      max_concurrency: 4,
    }));
    const concurrencyOverLimit = engineCheck(registry, spawnChildContext({
      concurrency_count: 5,
      max_concurrency: 4,
    }));
    expect(fanoutAtLimit.decision).toBe("allow");
    expect(concurrencyAtLimit.decision).toBe("allow");
    expect(fanoutOverLimit.decision).toBe("deny");
    expect(concurrencyOverLimit.decision).toBe("deny");
    expect(fanoutOverLimit.audit_code).toBe("run_spawn_child_capacity_limit");
    expect(concurrencyOverLimit.audit_code).toBe("run_spawn_child_capacity_limit");
  });
  it("unknown delegation-like actions fail closed", () => {
    const d = engineCheck(registry, { action: "agent.delegate" });
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("unknown_policy_action");
  });
  it("run.spawn_child production gate is wired and fail-closed audited", () => {
    const r = req("run.spawn_child", {
      space_id: "s1",
      resource_space_id: "s1",
      context: {
        group_id: "group-1",
        parent_run_id: "run-parent",
        root_run_id: "run-root",
        requesting_agent_id: "agent-manager",
        target_agent_id: "agent-reader",
        manager_user_id: "user-1",
        group_status: "active",
        requesting_agent_status: "active",
        target_agent_status: "active",
        requesting_member_status: "active",
        target_member_status: "active",
        depth: 1,
        max_depth: 3,
        fanout_count: 1,
        max_fanout: 8,
        concurrency_count: 1,
        max_concurrency: 4,
      },
    });
    const { defn, decision } = computeDecision(registry, r);
    expect(decision.decision).toBe("allow");
    expect(decision.audit_code).toBe("run_spawn_child_allowed");
    expect(isDurableAuditRequired(defn, decision, r)).toBe(true);
    expect(resolveFailureMode(defn, decision, r)).toBe("fail_closed");
  });
});

describe("computeDecision lifecycle gating", () => {
  it("reserved action denies before engine", () => {
    const { decision } = computeDecision(registry, req("artifact.export"));
    expect(decision.decision).toBe("deny");
    expect(decision.audit_code).toBe("policy_action_not_implemented");
  });
  it("wired_via_proposal action denies standalone", () => {
    const { decision } = computeDecision(registry, req("memory.create"));
    expect(decision.decision).toBe("deny");
    expect(decision.audit_code).toBe("policy_action_via_proposal_only");
  });
  it("wired_direct runtime.execute allows and back-fills actor", () => {
    const { decision } = computeDecision(
      registry,
      req("runtime.execute", { actor_id: "u1", space_id: "s1" }),
    );
    expect(decision.decision).toBe("allow");
    expect(decision.actor_id).toBe("u1");
    expect(decision.space_id).toBe("s1");
  });
});

describe("durable audit + failure mode", () => {
  it("use_credential allow is audit-required and fail-closed", () => {
    const r = req("runtime.use_credential", {
      space_id: "s1",
      resource_space_id: "s1",
      context: { trigger_origin: "manual" },
    });
    const { defn, decision } = computeDecision(registry, r);
    expect(isDurableAuditRequired(defn, decision, r)).toBe(true);
    expect(resolveFailureMode(defn, decision, r)).toBe("fail_closed");
  });
  it("context.inject_memory allow is best-effort, not required", () => {
    const r = req("context.inject_memory", { space_id: "s1" });
    const { defn, decision } = computeDecision(registry, r);
    expect(isDurableAuditRequired(defn, decision, r)).toBe(false);
    expect(resolveFailureMode(defn, decision, r)).toBe("best_effort");
  });
  it("automation-origin escalates to fail-closed", () => {
    const r = req("runtime.execute", {
      space_id: "s1",
      context: { trigger_origin: "automation" },
    });
    const { defn, decision } = computeDecision(registry, r);
    expect(resolveFailureMode(defn, decision, r)).toBe("fail_closed");
  });
  it("audit envelope sanitizes metadata and is secret-free", () => {
    const r = req("runtime.use_credential", {
      space_id: "s1",
      resource_space_id: "s1",
      metadata_json: { api_key: "sk-123", note: "ok" },
      context: { trigger_origin: "manual" },
    });
    const { defn, decision } = computeDecision(registry, r);
    const env = buildAuditEnvelope(r, decision, defn, "2026-06-14T00:00:00Z");
    expect(env.metadata_json).toEqual({ api_key: "[REDACTED]", note: "ok" });
  });
});

describe("sanitizer", () => {
  it("redacts nested dangerous keys and truncates", () => {
    const out = sanitizePolicyMetadata({
      ctx: { password: "x", ok: "y" },
      long: "a".repeat(600),
    }) as Record<string, Record<string, string> | string>;
    expect((out.ctx as Record<string, string>).password).toBe("[REDACTED]");
    expect((out.ctx as Record<string, string>).ok).toBe("y");
    expect((out.long as string).length).toBe(512);
  });
  it("returns null for null", () => {
    expect(sanitizePolicyMetadata(null)).toBeNull();
  });
});

describe("proposal.apply gate", () => {
  const base = {
    user_id: "u1",
    space_id: "s1",
    proposal_id: "p1",
    proposal_type: "memory_create",
    declared_risk: null,
    proposal_payload: {},
  };

  it("unsupported type denies", () => {
    const d = checkProposalApplyPolicy(
      { ...base, proposal_type: "weird_type" },
      "owner",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(d.decision).toBe("deny");
    expect(d.audit_code).toBe("unsupported_proposal_type");
  });
  it("owner approves", () => {
    const d = checkProposalApplyPolicy(base, "owner", SUPPORTED_PROPOSAL_TYPES);
    expect(d.decision).toBe("allow");
    expect(d.audit_code).toBe("approved_owner");
  });
  it("honors proposal required_approver_role before risk-based approval", () => {
    const reviewer = checkProposalApplyPolicy(
      { ...base, required_approver_role: "owner" },
      "reviewer",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(reviewer.decision).toBe("require_approval");
    expect(reviewer.audit_code).toBe("insufficient_required_approver_role");

    const admin = checkProposalApplyPolicy(
      { ...base, required_approver_role: "owner" },
      "admin",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(admin.decision).toBe("require_approval");
    expect(admin.audit_code).toBe("insufficient_required_approver_role");

    const owner = checkProposalApplyPolicy(
      { ...base, required_approver_role: "owner" },
      "owner",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(owner.decision).toBe("allow");
    expect(owner.required_approver_role).toBe("owner");
  });
  it("claim and object relation proposal types are supported", () => {
    expect(SUPPORTED_PROPOSAL_TYPES.has("claim_create")).toBe(true);
    expect(SUPPORTED_PROPOSAL_TYPES.has("object_relation_create")).toBe(true);
    expect(SUPPORTED_PROPOSAL_TYPES.has("object_profile_create")).toBe(true);
    expect(SUPPORTED_PROPOSAL_TYPES.has("object_profile_update")).toBe(true);
    expect(SUPPORTED_PROPOSAL_TYPES.has("memory_maintenance_packet")).toBe(true);
    expect(effectiveProposalRisk("claim_create", null)).toBe("medium");
    expect(effectiveProposalRisk("object_relation_create", "low")).toBe("medium");
    expect(effectiveProposalRisk("object_profile_create", "low")).toBe("high");
    expect(effectiveProposalRisk("memory_maintenance_packet", null)).toBe("medium");
  });
  it("reviewer cannot approve high-risk code_patch", () => {
    const d = checkProposalApplyPolicy(
      { ...base, proposal_type: "code_patch" },
      "reviewer",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(d.decision).toBe("require_approval");
    expect(d.audit_code).toBe("insufficient_role");
  });
  it("admin approves high-risk but not critical", () => {
    const high = checkProposalApplyPolicy(
      { ...base, proposal_type: "code_patch" },
      "admin",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(high.decision).toBe("allow");
    const crit = checkProposalApplyPolicy(
      { ...base, proposal_type: "code_patch", declared_risk: "critical" },
      "admin",
      SUPPORTED_PROPOSAL_TYPES,
    );
    expect(crit.decision).toBe("require_approval");
  });
  it("non-member requires approval", () => {
    const d = checkProposalApplyPolicy(base, null, SUPPORTED_PROPOSAL_TYPES);
    expect(d.decision).toBe("require_approval");
    expect(d.audit_code).toBe("no_membership");
  });
  it("effective risk is max(type_default, declared)", () => {
    expect(effectiveProposalRisk("memory_create", null)).toBe("medium");
    expect(effectiveProposalRisk("memory_create", "high")).toBe("high");
    expect(effectiveProposalRisk("code_patch", "low")).toBe("high");
  });
  it("invalid declared risk throws", () => {
    expect(() => effectiveProposalRisk("memory_create", "bogus")).toThrow();
  });
});
