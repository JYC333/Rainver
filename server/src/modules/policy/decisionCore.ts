/**
 * Policy decision core:
 *   - hard invariant guard (non-overridable invariants)
 *   - canonical role ranks
 *   - built-in rules
 *   - rule evaluation + registry-default fallthrough
 *
 * These are deterministic and DB-free. The orchestration (guard → engine,
 * audit-required, failure-mode) lives in `gateway.ts`.
 */

import {
  makeDecision,
  RISK_RANK,
  VALID_RISK_LEVELS,
  pyRepr,
  type Decision,
  type PolicyDecision,
  type RiskLevel,
} from "./decisions.js";
import {
  requireActionDefinition,
  UnknownPolicyActionError,
  type PolicyActionDefinition,
} from "./actionRegistry.js";
import { allowsManagedCredentialUse } from "./managedExecutionPolicy.js";

type Ctx = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// roles.py
// ---------------------------------------------------------------------------

export const CANONICAL_ROLES = [
  "guest",
  "member",
  "reviewer",
  "admin",
  "owner",
] as const;
const ROLE_RANK = new Map<string, number>(
  CANONICAL_ROLES.map((r, i) => [r, i]),
);

export function normalizeRole(raw: string | null | undefined): string {
  if (!raw) return "guest";
  const lower = raw.trim().toLowerCase();
  return ROLE_RANK.has(lower) ? lower : "guest";
}
export function roleRank(role: string | null | undefined): number {
  return ROLE_RANK.get(normalizeRole(role)) ?? 0;
}
export function hasRoleAtLeast(role: string, required: string): boolean {
  return roleRank(role) >= roleRank(required);
}

// ---------------------------------------------------------------------------
// hard_invariants.py
// ---------------------------------------------------------------------------

const PERSISTENCE_ACTIONS = new Set([
  "artifact.persist",
  "memory.create",
  "memory.update",
  "memory.archive",
  "project_folder.write_patch",
  "proposal.create",
  "proposal.apply",
  "policy.change",
  "capability.enable",
  "capability.update",
  "tool_binding.enable",
  "automation.create",
  "automation.fire",
  "automation.update",
  "deployment.propose",
  "deployment.execute",
]);

const APPROVAL_PROOF_FLAGS = [
  "approved_by_user",
  "approved_by_granting_user",
  "approval_status",
  "is_approved",
  "auto_approved",
  "pre_approved",
];

const EGRESS_SENSITIVE_ACTIONS = new Set([
  "artifact.export",
  "artifact.persist",
  "proposal.apply",
  "context.use_personal_grant",
]);

const MEMORY_READ_ACTIONS = new Set([
  "context.inject_memory",
  "context.use_personal_grant",
]);

type Invariant = (ctx: Ctx) => PolicyDecision | null;

const crossSpaceMemoryRead: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (!MEMORY_READ_ACTIONS.has(action) && action !== "context.render_for_runtime")
    return null;
  const spaceId = ctx.space_id;
  const resourceSpaceId = ctx.resource_space_id;
  if (!spaceId || !resourceSpaceId) return null;
  if (spaceId === resourceSpaceId) return null;
  if (ctx.has_personal_memory_grant === true) return null;
  return makeDecision({
    decision: "deny",
    message: `Cross-space memory read denied: requesting_space=${pyRepr(String(spaceId))}, resource_space=${pyRepr(String(resourceSpaceId))}. A PersonalMemoryGrant is required for cross-space personal memory access.`,
    risk_level: "critical",
    reason_code: "hard_invariant_cross_space_memory",
    policy_rule_id: "hard_invariant_cross_space_memory",
    policy_source: "hard_invariant",
    audit_code: "cross_space_memory_denied",
    action,
    space_id: str(spaceId) || null,
    resource_type: (ctx.resource_type as string | undefined) ?? null,
  });
};

const personalContextBlockNotPersisted: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (!PERSISTENCE_ACTIONS.has(action)) return null;
  const metadata = asRecord(ctx.metadata_json) ?? {};
  const context = asRecord(ctx.context) ?? {};
  for (const bag of [metadata, context]) {
    if ("personal_context_block" in bag) {
      return makeDecision({
        decision: "deny",
        message:
          "personal_context_block must never be persisted. It is ephemeral and may only be used for runtime reasoning.",
        risk_level: "critical",
        reason_code: "hard_invariant_personal_context_not_persisted",
        policy_rule_id: "hard_invariant_personal_context_not_persisted",
        policy_source: "hard_invariant",
        audit_code: "personal_context_block_persist_attempt",
        action,
        space_id: (ctx.space_id as string | undefined) ?? null,
      });
    }
  }
  return null;
};

const rawPrivateMemoryBlocksEgress: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (!EGRESS_SENSITIVE_ACTIONS.has(action)) return null;
  const context = asRecord(ctx.context);
  const rawPrivate =
    ctx.raw_private_memory_included === true ||
    (context !== null && context.raw_private_memory_included === true);
  if (rawPrivate) {
    return makeDecision({
      decision: "deny",
      message:
        "raw_private_memory_included=true blocks all egress. Private memory content must never leave the personal space context.",
      risk_level: "critical",
      reason_code: "hard_invariant_raw_private_memory_egress",
      policy_rule_id: "hard_invariant_raw_private_memory_egress",
      policy_source: "hard_invariant",
      audit_code: "raw_private_memory_egress_blocked",
      action,
      space_id: (ctx.space_id as string | undefined) ?? null,
    });
  }
  return null;
};

const publicTargetBlocksGrantDerived: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (!EGRESS_SENSITIVE_ACTIONS.has(action)) return null;
  if (ctx.derived_from_personal_memory_grant !== true) return null;
  const targetVisibility = str(ctx.target_visibility);
  if (targetVisibility.toLowerCase() === "public") {
    return makeDecision({
      decision: "deny",
      message:
        "Grant-derived output cannot be published with public visibility. Personal memory grant output must remain within approved scopes.",
      risk_level: "critical",
      reason_code: "hard_invariant_public_visibility_grant_derived",
      policy_rule_id: "hard_invariant_public_visibility_grant_derived",
      policy_source: "hard_invariant",
      audit_code: "grant_derived_public_visibility_blocked",
      action,
      space_id: (ctx.space_id as string | undefined) ?? null,
    });
  }
  return null;
};

const payloadFlagsNotApprovalProof: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (action !== "proposal.apply" && action !== "policy.change") return null;
  const payload = asRecord(ctx.payload) ?? {};
  const metadata = asRecord(ctx.metadata_json) ?? {};
  const context = asRecord(ctx.context) ?? {};
  for (const bag of [payload, metadata, context]) {
    for (const flag of APPROVAL_PROOF_FLAGS) {
      if (flag in bag) {
        return makeDecision({
          decision: "deny",
          message: `Payload flag ${pyRepr(flag)} cannot serve as approval proof. Approval requires a real ProposalApproval row with verifiable authority.`,
          risk_level: "critical",
          reason_code: "hard_invariant_payload_not_approval_proof",
          policy_rule_id: "hard_invariant_payload_not_approval_proof",
          policy_source: "hard_invariant",
          audit_code: "payload_flag_as_approval_proof",
          action,
          space_id: (ctx.space_id as string | undefined) ?? null,
        });
      }
    }
  }
  return null;
};

const unknownTargetSpaceEgressFailsClosed: Invariant = (ctx) => {
  const action = str(ctx.action);
  if (!EGRESS_SENSITIVE_ACTIONS.has(action)) return null;
  const targetSpaceId = ctx.target_space_id;
  if (targetSpaceId === null || targetSpaceId === undefined) return null;
  if (typeof targetSpaceId !== "string" || targetSpaceId.trim() === "") {
    return makeDecision({
      decision: "deny",
      message:
        "Unknown or empty target_space_id in egress-sensitive action. Cannot resolve target space; failing closed.",
      risk_level: "critical",
      reason_code: "hard_invariant_unknown_target_space",
      policy_rule_id: "hard_invariant_unknown_target_space",
      policy_source: "hard_invariant",
      audit_code: "unknown_target_space_egress",
      action,
      space_id: (ctx.space_id as string | undefined) ?? null,
    });
  }
  return null;
};

const HARD_INVARIANTS: readonly Invariant[] = [
  crossSpaceMemoryRead,
  personalContextBlockNotPersisted,
  rawPrivateMemoryBlocksEgress,
  publicTargetBlocksGrantDerived,
  payloadFlagsNotApprovalProof,
  unknownTargetSpaceEgressFailsClosed,
];

/** Run all hard invariants in order; return the first denial or null. */
export function checkHardInvariants(ctx: Ctx): PolicyDecision | null {
  for (const guard of HARD_INVARIANTS) {
    const result = guard(ctx);
    if (result !== null) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// rules.py
// ---------------------------------------------------------------------------

type Rule = (ctx: Ctx) => PolicyDecision | null;

const ruleSpaceBoundary: Rule = (ctx) => {
  const requesting = ctx.space_id;
  const resource = ctx.resource_space_id;
  if (resource && requesting && requesting !== resource) {
    return makeDecision({
      decision: "deny",
      message: `Cross-space access denied: requesting=${requesting}, resource=${resource}`,
      risk_level: "critical",
      reason_code: "space_boundary",
      policy_rule_id: "space_boundary",
      audit_code: "cross_space_access_denied",
    });
  }
  return null;
};

const ruleAgentStatus: Rule = (ctx) => {
  const action = str(ctx.action);
  const agentStatus = ctx.agent_status;
  if (agentStatus && agentStatus !== "active") {
    if (action.startsWith("memory.") || action === "runtime.execute") {
      return makeDecision({
        decision: "deny",
        message: `Agent is not active (status=${agentStatus})`,
        risk_level: "high",
        reason_code: "agent_status",
        policy_rule_id: "agent_status",
        audit_code: "agent_not_active",
      });
    }
  }
  return null;
};

const PROTECTED_MEMORY_SCOPES = new Set(["user", "project_folder", "space", "system"]);

const ruleMemoryScope: Rule = (ctx) => {
  const action = str(ctx.action);
  if (
    action !== "memory.create" &&
    action !== "memory.update" &&
    action !== "memory.archive"
  )
    return null;
  const scope = str(ctx.resource_id);
  if (PROTECTED_MEMORY_SCOPES.has(scope)) {
    return makeDecision({
      decision: "require_approval",
      message: `Writing to scope '${scope}' requires user approval`,
      risk_level: "medium",
      reason_code: "memory_scope_requires_approval",
      required_approver_role: "owner",
      policy_rule_id: "memory_scope",
      audit_code: "memory_scope_requires_approval",
    });
  }
  return null;
};

const ruleUseCredential: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "runtime.use_credential") return null;

  const spaceId = ctx.space_id;
  const resourceSpaceId = ctx.resource_space_id;
  const triggerOrigin = str(ctx.trigger_origin) || "manual";

  if (resourceSpaceId && spaceId && resourceSpaceId !== spaceId) {
    return makeDecision({
      decision: "deny",
      message: `Cross-space credential use denied: run space=${pyRepr(String(spaceId))} credential space=${pyRepr(String(resourceSpaceId))}`,
      risk_level: "critical",
      reason_code: "credential_cross_space",
      policy_rule_id: "credential_cross_space_deny",
      audit_code: "credential_cross_space",
    });
  }

  if (allowsManagedCredentialUse(triggerOrigin, ctx)) {
    return makeDecision({
      decision: "allow",
      message: "Managed source/research execution is covered by the user's setup authorization.",
      risk_level: "high",
      reason_code: "credential_managed_preauthorized",
      policy_rule_id: "credential_managed_preauthorized_allow",
      audit_code: "credential_managed_preauthorized",
    });
  }

  if (triggerOrigin === "automation" || triggerOrigin === "autonomous") {
    if (ctx.automation_pre_authorized === true) {
      return makeDecision({
        decision: "allow",
        message:
          "Automation-authorized credential use allowed by standing pre-authorization.",
        risk_level: "high",
        reason_code: "credential_automation_preauthorized",
        policy_rule_id: "credential_automation_preauthorized_allow",
        audit_code: "credential_automation_preauthorized",
      });
    }
    return makeDecision({
      decision: "require_approval",
      message: "Automation-authorized credential use requires explicit approval.",
      risk_level: "high",
      reason_code: "credential_automation_origin",
      required_approver_role: "owner",
      policy_rule_id: "credential_automation_require_approval",
      audit_code: "credential_automation_origin",
    });
  }

  if (
    triggerOrigin === "manual" ||
    triggerOrigin === "user" ||
    triggerOrigin === "api" ||
    triggerOrigin === "delegation" ||
    !triggerOrigin
  ) {
    return makeDecision({
      decision: "allow",
      message: "Same-space user-mediated credential use allowed.",
      risk_level: "high",
      reason_code: "credential_same_space_manual",
      policy_rule_id: "credential_same_space_manual_allow",
      audit_code: "credential_same_space_manual",
    });
  }

  return null;
};

const ruleToolPermission: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "runtime.execute") return null;
  const toolName = ctx.tool_name;
  const allowedTools = ctx.agent_tool_permissions;
  if (
    toolName &&
    Array.isArray(allowedTools) &&
    !allowedTools.includes(toolName)
  ) {
    return makeDecision({
      decision: "deny",
      message: `Tool '${toolName}' is not in agent's tool_permissions_json`,
      risk_level: "high",
      reason_code: "tool_not_permitted",
      policy_rule_id: "tool_permission",
      audit_code: "tool_not_permitted",
    });
  }
  return null;
};

const ruleProjectFolderWritePatch: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "project_folder.write_patch") return null;
  if (
    ctx.proposal_id &&
    ctx.proposal_type === "code_patch" &&
    ctx.proposal_apply_allowed === true
  ) {
    return makeDecision({
      decision: "allow",
      message: "project_folder.write_patch via accepted code_patch proposal",
      risk_level: "high",
      reason_code: "project_folder_write_patch_via_proposal",
      policy_rule_id: "project_folder_write_patch_via_proposal",
      audit_code: "project_folder_write_via_proposal",
    });
  }
  return null;
};

const AUTOMATION_ACTIONS = new Set([
  "automation.create",
  "automation.update",
  "automation.fire",
]);

const ruleAutomation: Rule = (ctx) => {
  const action = str(ctx.action);
  if (!AUTOMATION_ACTIONS.has(action)) return null;
  const role = str(ctx.membership_role) || "guest";
  if (hasRoleAtLeast(role, "admin")) {
    return makeDecision({
      decision: "allow",
      message: `${action} allowed for role=${role}`,
      risk_level: "high",
      reason_code: "automation_admin_allow",
      policy_rule_id: "automation_admin_allow",
      audit_code: "automation_allowed",
    });
  }
  if (ctx.target_type === "agent_run" && ctx.project_writer === true && str(ctx.project_id)) {
    return makeDecision({
      decision: "allow",
      message: `${action} allowed for project writer`,
      risk_level: "high",
      reason_code: "automation_project_writer_allow",
      policy_rule_id: "automation_project_writer_allow",
      audit_code: "automation_project_writer_allowed",
    });
  }
  // autonomous_tick is a per-user self-service control-plane target: any
  // active member may enable, reconfigure, or (un)fire their own tick, scoped
  // to their own identity and whatever Agent they can already reach. It is
  // never a "manage this Space's automations" authority — actor_is_owner
  // requires the caller to be the automation's own owner_user_id, so this
  // carve-out cannot reach another member's tick, unlike the admin branch.
  if (ctx.target_type === "autonomous_tick" && ctx.actor_is_owner === true && hasRoleAtLeast(role, "member")) {
    return makeDecision({
      decision: "allow",
      message: `${action} allowed for the tick's own owner (role=${role})`,
      risk_level: "high",
      reason_code: "automation_autonomy_self_service_allow",
      policy_rule_id: "automation_autonomy_self_service_allow",
      audit_code: "automation_autonomy_self_service_allowed",
    });
  }
  // The digest target is provisioned by the system, not through the generic
  // Automation editor. It performs deterministic reads and writes only its
  // own delivery snapshot, so the schedule's owner may fire the personal
  // form; the Project form additionally proves Project writer authority.
  if (
    ctx.target_type === "information_digest"
    && ctx.actor_is_owner === true
    && hasRoleAtLeast(role, "member")
    && (!str(ctx.project_id) || ctx.project_writer === true)
  ) {
    return makeDecision({
      decision: "allow",
      message: `${action} allowed for the digest schedule owner (role=${role})`,
      risk_level: "low",
      reason_code: "automation_information_digest_owner_allow",
      policy_rule_id: "automation_information_digest_owner_allow",
      audit_code: "automation_information_digest_allowed",
    });
  }
  return makeDecision({
    decision: "deny",
    message: `${action} requires admin or owner authority; role=${role}`,
    risk_level: "high",
    reason_code: "automation_insufficient_role",
    policy_rule_id: "automation_insufficient_role",
    audit_code: "automation_denied",
  });
};

const ruleRuntimeExecuteRiskLevel: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "runtime.execute") return null;
  const raw = ctx.risk_level;
  if (typeof raw !== "string" || !VALID_RISK_LEVELS.has(raw)) return null;
  return makeDecision({
    decision: "allow",
    message: `runtime.execute allowed with effective risk_level=${raw}`,
    risk_level: raw as RiskLevel,
    reason_code: "runtime_execute_risk_level",
    policy_rule_id: "runtime_execute_risk_level",
    audit_code: "runtime_execute_risk_level",
  });
};

const RUN_SPAWN_CHILD_REQUIRED_CONTEXT = [
  "space_id",
  "resource_space_id",
  "group_id",
  "parent_run_id",
  "root_run_id",
  "requesting_agent_id",
  "target_agent_id",
  "manager_user_id",
  "group_status",
  "requesting_agent_status",
  "target_agent_status",
  "requesting_member_status",
  "target_member_status",
] as const;

const RUN_SPAWN_CHILD_REQUIRED_NUMERIC_CONTEXT = [
  "depth",
  "max_depth",
  "fanout_count",
  "max_fanout",
  "concurrency_count",
  "max_concurrency",
] as const;

const ruleRunSpawnChild: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "run.spawn_child") return null;

  for (const field of RUN_SPAWN_CHILD_REQUIRED_CONTEXT) {
    if (!str(ctx[field])) {
      return makeDecision({
        decision: "deny",
        message: `run.spawn_child missing required context '${field}'`,
        risk_level: "high",
        reason_code: "run_spawn_child_missing_context",
        policy_rule_id: "run_spawn_child_missing_context",
        audit_code: "run_spawn_child_missing_context",
      });
    }
  }
  for (const field of RUN_SPAWN_CHILD_REQUIRED_NUMERIC_CONTEXT) {
    if (num(ctx[field]) === null) {
      return makeDecision({
        decision: "deny",
        message: `run.spawn_child missing required numeric context '${field}'`,
        risk_level: "high",
        reason_code: "run_spawn_child_missing_context",
        policy_rule_id: "run_spawn_child_missing_context",
        audit_code: "run_spawn_child_missing_context",
      });
    }
  }

  if (str(ctx.requesting_agent_id) === str(ctx.target_agent_id)) {
    return makeDecision({
      decision: "deny",
      message: "run.spawn_child requires a distinct target agent.",
      risk_level: "medium",
      reason_code: "run_spawn_child_self_target",
      policy_rule_id: "run_spawn_child_self_target",
      audit_code: "run_spawn_child_self_target",
    });
  }

  const statusChecks: Array<[string, string]> = [
    ["group_status", "Agent group is not active."],
    ["requesting_agent_status", "Requesting agent is not active."],
    ["target_agent_status", "Target agent is not active."],
    ["requesting_member_status", "Requesting agent is not an active group member."],
    ["target_member_status", "Target agent is not an active group member."],
  ];
  for (const [field, message] of statusChecks) {
    const value = str(ctx[field]);
    if (value && value !== "active") {
      return makeDecision({
        decision: "deny",
        message,
        risk_level: "high",
        reason_code: "run_spawn_child_inactive_context",
        policy_rule_id: "run_spawn_child_inactive_context",
        audit_code: "run_spawn_child_inactive_context",
      });
    }
  }

  if (
    ctx.context_widens_authority === true ||
    ctx.credential_scope_widens === true ||
    ctx.workspace_scope_widens === true ||
    ctx.project_scope_widens === true ||
    ctx.memory_scope_widens === true ||
    ctx.durable_write_scope_widens === true
  ) {
    return makeDecision({
      decision: "deny",
      message: "run.spawn_child cannot widen the parent/root authority envelope.",
      risk_level: "critical",
      reason_code: "run_spawn_child_authority_widening",
      policy_rule_id: "run_spawn_child_authority_widening",
      audit_code: "run_spawn_child_authority_widening",
    });
  }

  const depth = num(ctx.depth);
  const maxDepth = num(ctx.max_depth);
  if (
    ctx.depth_limit_exceeded === true ||
    (depth !== null && maxDepth !== null && depth > maxDepth)
  ) {
    return makeDecision({
      decision: "deny",
      message: "run.spawn_child depth limit exceeded.",
      risk_level: "high",
      reason_code: "run_spawn_child_depth_limit",
      policy_rule_id: "run_spawn_child_depth_limit",
      audit_code: "run_spawn_child_depth_limit",
    });
  }

  const fanout = num(ctx.fanout_count);
  const maxFanout = num(ctx.max_fanout);
  const concurrency = num(ctx.concurrency_count);
  const maxConcurrency = num(ctx.max_concurrency);
  if (
    ctx.fanout_limit_exceeded === true ||
    ctx.concurrency_limit_exceeded === true ||
    (fanout !== null && maxFanout !== null && fanout > maxFanout) ||
    (concurrency !== null &&
      maxConcurrency !== null &&
      concurrency > maxConcurrency)
  ) {
    return makeDecision({
      decision: "deny",
      message: "run.spawn_child fanout or concurrency limit exceeded.",
      risk_level: "high",
      reason_code: "run_spawn_child_capacity_limit",
      policy_rule_id: "run_spawn_child_capacity_limit",
      audit_code: "run_spawn_child_capacity_limit",
    });
  }

  return makeDecision({
    decision: "allow",
    message: "run.spawn_child allowed for active same-space group delegation.",
    risk_level: "medium",
    reason_code: "run_spawn_child_allowed",
    policy_rule_id: "run_spawn_child_allowed",
    audit_code: "run_spawn_child_allowed",
  });
};

const ruleRuntimeSkillRenderEnabled: Rule = (ctx) => {
  const action = str(ctx.action);
  if (action !== "runtime_skill.render") return null;
  if (ctx.enabled_binding !== true) return null;
  const capabilityEnablementId = str(ctx.capability_enablement_id);
  if (!capabilityEnablementId) return null;
  const raw = ctx.risk_level;
  const riskLevel: RiskLevel =
    typeof raw === "string" && VALID_RISK_LEVELS.has(raw) ? (raw as RiskLevel) : "medium";
  // A binding only reaches render from the context prepare path after the
  // runtime provider proves an enabled capability_enablement row selected it.
  // Enablement is the review gate where the owner decides whether a high or
  // critical capability runs; direct calls without that proof fall through to
  // the action registry default.
  return makeDecision({
    decision: "allow",
    message: `runtime_skill.render allowed for enabled binding (reviewed at capability enablement, risk_level=${riskLevel})`,
    risk_level: riskLevel,
    reason_code: "runtime_skill_render_enabled_binding",
    policy_rule_id: "runtime_skill_render_enabled_binding",
    audit_code: "runtime_skill_render_enabled_binding",
  });
};

const RETRIEVAL_TOOL_ACTIONS = new Set([
  "retrieval.search",
  "retrieval.brief",
  "memory.retrieval.search",
  "memory.retrieval.brief",
  "project.summary.search",
  "project.summary.brief",
  "source.retrieval.search",
  "source.retrieval.brief",
]);

const ruleRetrievalToolCall: Rule = (ctx) => {
  const action = str(ctx.action);
  if (!RETRIEVAL_TOOL_ACTIONS.has(action)) return null;

  const toolName = str(ctx.tool_name) || action;
  const domain = str(ctx.domain) || "unknown";
  if (ctx.domain_enabled !== true) {
    return makeDecision({
      decision: "deny",
      message: `Retrieval tool ${pyRepr(toolName)} is not enabled for domain ${pyRepr(domain)} in this run.`,
      risk_level: "low",
      reason_code: "retrieval_tool_domain_not_enabled",
      policy_rule_id: "retrieval_tool_domain_enabled",
      audit_code: "retrieval_tool_domain_not_enabled",
      action,
      resource_type: "retrieval_tool",
      resource_id: toolName,
    });
  }

  if (!str(ctx.instructed_by_user_id)) {
    return makeDecision({
      decision: "deny",
      message: `Retrieval tool ${pyRepr(toolName)} requires an instructed user viewer.`,
      risk_level: "low",
      reason_code: "retrieval_tool_missing_viewer",
      policy_rule_id: "retrieval_tool_viewer_required",
      audit_code: "retrieval_tool_missing_viewer",
      action,
      resource_type: "retrieval_tool",
      resource_id: toolName,
    });
  }

  if (ctx.source_policy_denied === true) {
    return makeDecision({
      decision: "deny",
      message: `Retrieval tool ${pyRepr(toolName)} denied by source policy.`,
      risk_level: "medium",
      reason_code: "retrieval_tool_source_policy_denied",
      policy_rule_id: "retrieval_tool_source_policy",
      audit_code: "retrieval_tool_source_policy_denied",
      action,
      resource_type: "retrieval_tool",
      resource_id: toolName,
    });
  }

  if (ctx.egress_policy_denied === true) {
    return makeDecision({
      decision: "deny",
      message: `Retrieval tool ${pyRepr(toolName)} denied by egress policy.`,
      risk_level: "medium",
      reason_code: "retrieval_tool_egress_policy_denied",
      policy_rule_id: "retrieval_tool_egress_policy",
      audit_code: "retrieval_tool_egress_policy_denied",
      action,
      resource_type: "retrieval_tool",
      resource_id: toolName,
    });
  }

  return makeDecision({
    decision: "allow",
    message: `Retrieval tool ${pyRepr(toolName)} allowed for domain ${pyRepr(domain)}.`,
    risk_level: "low",
    reason_code: "retrieval_tool_call_allowed",
    policy_rule_id: "retrieval_tool_call_allowed",
    audit_code: "retrieval_tool_call_allowed",
    action,
    resource_type: "retrieval_tool",
    resource_id: toolName,
  });
};

const REQUESTABLE_SYSTEM_ACTIONS = new Set([
  "source.channel.propose_activation",
  "project.source.propose_bind",
  "source.backfill.propose_start",
]);

const ruleManagedSystemActionGrant: Rule = (ctx) => {
  if (ctx.surface !== "managed_run_system_action_gateway") return null;
  const actionId = str(ctx.action_id);
  if (!REQUESTABLE_SYSTEM_ACTIONS.has(actionId)) return null;
  if (ctx.has_action_approval_grant === true) {
    return makeDecision({
      decision: "allow",
      message: `Managed system action ${pyRepr(actionId)} is authorized by a bounded Run grant.`,
      risk_level: "medium",
      reason_code: "managed_system_action_granted",
      policy_rule_id: "managed_system_action_granted",
      audit_code: "managed_system_action_granted",
    });
  }
  return makeDecision({
    decision: "deny",
    message: `Managed system action ${pyRepr(actionId)} requires owner authorization for this Run.`,
    risk_level: "medium",
    reason_code: "managed_system_action_grant_required",
    policy_rule_id: "managed_system_action_grant_required",
    audit_code: "managed_system_action_grant_required",
  });
};

/**
 * Project writes an Agent makes on its own initiative.
 *
 * The same action definition serves both origins, because the write is the
 * same write — what differs is who wanted it. A person saying "split this into
 * three tasks" in the turn *is* the authorization for the Tasks that follow;
 * the identical call from an autonomous wake-up is a commitment made on the
 * Project's behalf that nobody asked for, and a Loop stage skipped or reversed
 * without a person seeing it is a claim about the work.
 *
 * Reporting, handing off, and asking for review stay ungated at any origin:
 * they are append-only or self-limiting — they can record, give work away, or
 * stop, never take ground.
 *
 * ADR 0017 §2 widened this from Tasks to every Project-internal write that
 * stopped being a proposal: opening a question, recording a conclusion,
 * adopting a recorded next step, starting a bounded acquisition. The gate they
 * lost was on authorship; this one is on whether anybody asked, which is the
 * question that was worth asking all along.
 */
// `proposal.decide` is the sharpest of these: a decision is a person's, and
// the only origin on which the Agent can be carrying one is the person's own
// turn.
const ORIGIN_GATED_PROJECT_WRITES = new Set([
  "task.create",
  "task.stage.advance",
  "proposal.decide",
  "inquiry.thread.create",
  "inquiry.iteration.record",
  "inquiry.advice.adopt",
  "research.acquisition.start",
  // `memory.write` is here and not in `ruleMemoryScope`: what the older rule
  // gates — scope and operation — ADR 0003 §1 now settles in the applier,
  // and what remains for policy is the origin.
  "memory.write",
]);
/**
 * Every origin that is not a person in a conversation. Listed as an allowlist
 * of the attended ones rather than a denylist, so a new origin is gated until
 * someone decides it should not be — the safe direction for a write nobody
 * asked for.
 */
/**
 * Origins that mean a person asked for this in a conversation. Exported so
 * everything that turns on "did someone ask" reads the same set — a second
 * copy is how one surface starts treating a scheduled wake-up as attended.
 */
export const ATTENDED_TRIGGER_ORIGINS = new Set(["manual"]);

const ruleUnattendedProjectWrite: Rule = (ctx) => {
  const action = str(ctx.action);
  if (!ORIGIN_GATED_PROJECT_WRITES.has(action)) return null;
  // Absent rather than defaulted: a caller that does not say who wanted the
  // write cannot be assumed to have had a person behind it.
  const triggerOrigin = str(ctx.trigger_origin);
  if (triggerOrigin && ATTENDED_TRIGGER_ORIGINS.has(triggerOrigin)) return null;
  return makeDecision({
    decision: "require_approval",
    message: `${action} from an unattended '${triggerOrigin}' run requires approval: nobody asked for this write in a conversation.`,
    risk_level: "medium",
    reason_code: "unattended_project_write",
    policy_rule_id: "unattended_project_write_require_approval",
    audit_code: "unattended_project_write",
  });
};

const BUILTIN_RULES: readonly Rule[] = [
  ruleSpaceBoundary,
  ruleAgentStatus,
  ruleMemoryScope,
  ruleUseCredential,
  ruleToolPermission,
  ruleProjectFolderWritePatch,
  ruleAutomation,
  ruleRuntimeExecuteRiskLevel,
  ruleRunSpawnChild,
  ruleRuntimeSkillRenderEnabled,
  ruleRetrievalToolCall,
  ruleManagedSystemActionGrant,
  ruleUnattendedProjectWrite,
];

// ---------------------------------------------------------------------------
// engine.py
// ---------------------------------------------------------------------------

/**
 * Evaluate built-in rules in order; first non-null wins. Unknown actions fail
 * closed with DENY; known actions with no matching rule use the registry
 * default decision (never a permissive ALLOW fallback).
 */
export function engineCheck(
  registry: ReadonlyMap<string, PolicyActionDefinition>,
  ctx: Ctx,
): PolicyDecision {
  const action = ctx.action;
  let defn: PolicyActionDefinition;
  try {
    defn = requireActionDefinition(registry, str(action));
  } catch (err) {
    if (err instanceof UnknownPolicyActionError) {
      return makeDecision({
        decision: "deny",
        message: `Unknown policy action ${pyRepr(String(action))}. All sensitive actions must be registered in the canonical action registry.`,
        risk_level: "high",
        reason_code: "unknown_policy_action",
        policy_rule_id: "unknown_action_deny",
        policy_source: "builtin",
        audit_code: "unknown_policy_action",
        action: (action as string | undefined) ?? null,
        space_id: (ctx.space_id as string | undefined) ?? null,
      });
    }
    throw err;
  }

  for (const rule of BUILTIN_RULES) {
    const result = rule(ctx);
    if (result !== null) return result;
  }

  return makeDecision({
    decision: defn.default_decision as Decision,
    message: `No rule matched; registry default for ${pyRepr(String(action))} is ${defn.default_decision}`,
    risk_level: defn.default_risk_level as RiskLevel,
    reason_code: "registry_default",
    required_approver_role: defn.default_required_approver_role,
    approval_capability: defn.approval_capability,
    policy_rule_id: "registry_default",
    policy_source: "registry",
    resource_type: defn.resource_type,
    action: str(action),
    actor_id: (ctx.actor_id as string | undefined) ?? null,
    actor_ref: asRecord(ctx.actor_ref),
    space_id: (ctx.space_id as string | undefined) ?? null,
  });
}

export { RISK_RANK };
