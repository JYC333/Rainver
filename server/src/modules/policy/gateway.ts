/**
 * Policy gateway compute logic.
 *
 * This module is DB-free: it composes hard invariants + engine into a decision,
 * resolves the durable-audit requirement and failure mode, and builds the
 * sanitized audit envelope. The durable write itself and the DB lookups (space
 * role, supported proposal types) are injected by the service layer
 * (`service.ts`), preserving the §8 boundary that server runs/policy never read
 * unrelated context tables directly.
 */

import {
  isAllowed,
  makeDecision,
  pyRepr,
  RISK_RANK,
  type Decision,
  type PolicyDecision,
  type RiskLevel,
} from "./decisions";
import {
  getActionDefinition,
  type PolicyActionDefinition,
} from "./actionRegistry";
import { checkHardInvariants, engineCheck } from "./decisionCore";
import { sanitizePolicyMetadata } from "./sanitizer";

import type {
  PolicyAuditEnvelope,
  PolicyCheckRequest,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

export type Registry = ReadonlyMap<string, PolicyActionDefinition>;

// ---------------------------------------------------------------------------
// Context assembly (gateway.py _build_engine_ctx / _guard_ctx)
// ---------------------------------------------------------------------------

function buildEngineCtx(req: PolicyCheckRequest): Record<string, unknown> {
  const ctx: Record<string, unknown> = { action: req.action };
  if (req.space_id) ctx.space_id = req.space_id;
  if (req.resource_space_id) ctx.resource_space_id = req.resource_space_id;
  if (req.actor_id) ctx.actor_id = req.actor_id;
  if (req.actor_ref) ctx.actor_ref = req.actor_ref;
  if (req.resource_type) ctx.resource_type = req.resource_type;
  if (req.resource_id) ctx.resource_id = req.resource_id;
  if (req.proposal_id) ctx.proposal_id = req.proposal_id;
  if (req.context) Object.assign(ctx, req.context);
  return ctx;
}

function buildGuardCtx(req: PolicyCheckRequest): Record<string, unknown> {
  const ctx: Record<string, unknown> = { action: req.action };
  if (req.space_id) ctx.space_id = req.space_id;
  if (req.resource_space_id) ctx.resource_space_id = req.resource_space_id;
  if (req.metadata_json) ctx.metadata_json = req.metadata_json;
  if (req.payload) ctx.payload = req.payload;
  if (req.context) {
    Object.assign(ctx, req.context);
    ctx.context = req.context;
  }
  return ctx;
}

function triggerOrigin(req: PolicyCheckRequest): string {
  const ctx = req.context;
  const v = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>).trigger_origin : undefined;
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Durable-audit requirement + failure mode (gateway.py)
// ---------------------------------------------------------------------------

export function isDurableAuditRequired(
  defn: PolicyActionDefinition | undefined,
  decision: PolicyDecision,
  req: PolicyCheckRequest,
): boolean {
  if (req.force_record) return true;
  if (defn && defn.audit_required) return true;
  if (defn && defn.record_failure_mode === "fail_closed") return true;
  if (decision.decision === "deny" || decision.decision === "require_approval")
    return true;
  if (decision.risk_level === "critical") return true;
  if (triggerOrigin(req) === "automation" || triggerOrigin(req) === "autonomous") return true;
  return false;
}

export type FailureMode = "best_effort" | "fail_closed";

export function resolveFailureMode(
  defn: PolicyActionDefinition | undefined,
  decision: PolicyDecision,
  req: PolicyCheckRequest,
): FailureMode {
  if (req.force_record) return "fail_closed";
  if (defn && defn.record_failure_mode === "fail_closed") return "fail_closed";
  const auditRequired = Boolean(defn && defn.audit_required);
  const origin = triggerOrigin(req);
  if (auditRequired) {
    if (origin === "automation" || origin === "autonomous") return "fail_closed";
    if (decision.risk_level === "critical") return "fail_closed";
  }
  if (decision.decision !== "allow") {
    if (origin === "automation" || origin === "autonomous") return "fail_closed";
    if (decision.risk_level === "critical") return "fail_closed";
  }
  return "best_effort";
}

// ---------------------------------------------------------------------------
// Audit envelope (gateway.py _build_audit_envelope)
// ---------------------------------------------------------------------------

export function buildAuditEnvelope(
  req: PolicyCheckRequest,
  decision: PolicyDecision,
  defn: PolicyActionDefinition | undefined,
  nowIso: string,
): PolicyAuditEnvelope {
  const resourceType =
    req.resource_type ?? defn?.resource_type ?? decision.resource_type ?? null;
  let proposalId = req.proposal_id ?? null;
  if (proposalId === null && resourceType === "proposal") {
    proposalId = req.resource_id ?? decision.resource_id ?? null;
  }
  return {
    space_id: req.space_id ?? decision.space_id ?? null,
    actor_type: req.actor_type ?? decision.actor_type ?? null,
    actor_id: req.actor_id ?? decision.actor_id ?? null,
    actor_ref_json: req.actor_ref ?? decision.actor_ref ?? null,
    action: req.action,
    resource_type: resourceType,
    resource_id: req.resource_id ?? decision.resource_id ?? null,
    decision: decision.decision,
    risk_level: decision.risk_level,
    required_approver_role: decision.required_approver_role ?? null,
    approval_capability: decision.approval_capability ?? null,
    policy_rule_id: decision.policy_rule_id ?? null,
    policy_source: decision.policy_source ?? null,
    policy_id: decision.policy_id ?? null,
    audit_code: decision.audit_code ?? null,
    run_id: req.run_id ?? null,
    proposal_id: proposalId,
    metadata_json: sanitizePolicyMetadata(req.metadata_json),
    created_at: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Decision computation (gateway.py PolicyGateway._compute_decision)
// ---------------------------------------------------------------------------

export interface ComputedDecision {
  defn: PolicyActionDefinition | undefined;
  decision: PolicyDecision;
}

export function computeDecision(
  registry: Registry,
  req: PolicyCheckRequest,
): ComputedDecision {
  const defn = getActionDefinition(registry, req.action);

  if (defn === undefined) {
    const denial = makeDecision({
      decision: "deny",
      message: `Unknown policy action ${pyRepr(req.action)}.`,
      risk_level: "high",
      reason_code: "unknown_policy_action",
      policy_rule_id: "unknown_action_deny",
      policy_source: "builtin",
      audit_code: "unknown_policy_action",
      action: req.action,
      space_id: req.space_id ?? null,
      actor_type: req.actor_type ?? null,
      actor_id: req.actor_id ?? null,
      actor_ref: req.actor_ref ?? null,
      resource_type: req.resource_type ?? null,
      resource_id: req.resource_id ?? null,
    });
    return { defn: undefined, decision: denial };
  }

  if (defn.lifecycle_status === "reserved") {
    const reserved = makeDecision({
      decision: "deny",
      message: `Policy action ${pyRepr(req.action)} is reserved and has no enforcement point. Reserved actions always fail closed until the action is wired to a real enforcement point.`,
      risk_level: defn.default_risk_level as RiskLevel,
      reason_code: "policy_action_not_implemented",
      policy_rule_id: "action_not_implemented",
      policy_source: "registry",
      audit_code: "policy_action_not_implemented",
      action: req.action,
      resource_type: defn.resource_type,
      resource_id: req.resource_id ?? null,
      actor_type: req.actor_type ?? null,
      actor_id: req.actor_id ?? null,
      actor_ref: req.actor_ref ?? null,
      space_id: req.space_id ?? null,
      required_approver_role: defn.default_required_approver_role,
      approval_capability: defn.approval_capability,
    });
    return { defn, decision: reserved };
  }

  if (defn.lifecycle_status === "wired_via_proposal") {
    const viaProposal = makeDecision({
      decision: "deny",
      message: `Policy action ${pyRepr(req.action)} is enforced via the proposal.apply gate and must not be enforced as a standalone action. Use PolicyGateway.enforce_proposal_apply() instead.`,
      risk_level: defn.default_risk_level as RiskLevel,
      reason_code: "policy_action_via_proposal_only",
      policy_rule_id: "action_via_proposal_only",
      policy_source: "registry",
      audit_code: "policy_action_via_proposal_only",
      action: req.action,
      resource_type: defn.resource_type,
      resource_id: req.resource_id ?? null,
      actor_type: req.actor_type ?? null,
      actor_id: req.actor_id ?? null,
      actor_ref: req.actor_ref ?? null,
      space_id: req.space_id ?? null,
      required_approver_role: defn.default_required_approver_role,
      approval_capability: defn.approval_capability,
    });
    return { defn, decision: viaProposal };
  }

  // WIRED_DIRECT: hard invariants, then engine.
  const guardCtx = buildGuardCtx(req);
  const invariantDenial = checkHardInvariants(guardCtx);
  if (invariantDenial !== null) {
    invariantDenial.actor_type = invariantDenial.actor_type ?? req.actor_type ?? null;
    invariantDenial.actor_id = invariantDenial.actor_id ?? req.actor_id ?? null;
    invariantDenial.actor_ref = invariantDenial.actor_ref ?? req.actor_ref ?? null;
    invariantDenial.space_id = invariantDenial.space_id ?? req.space_id ?? null;
    invariantDenial.resource_type =
      invariantDenial.resource_type ?? defn.resource_type ?? req.resource_type ?? null;
    invariantDenial.resource_id = invariantDenial.resource_id ?? req.resource_id ?? null;
    return { defn, decision: invariantDenial };
  }

  const engineCtx = buildEngineCtx(req);
  const decision = engineCheck(registry, engineCtx);
  decision.actor_type = decision.actor_type ?? req.actor_type ?? null;
  decision.actor_id = decision.actor_id ?? req.actor_id ?? null;
  decision.actor_ref = decision.actor_ref ?? req.actor_ref ?? null;
  decision.space_id = decision.space_id ?? req.space_id ?? null;
  decision.resource_id = decision.resource_id ?? req.resource_id ?? null;
  decision.resource_type = decision.resource_type ?? defn.resource_type ?? null;
  return { defn, decision };
}

// ---------------------------------------------------------------------------
// Proposal-apply gate (proposal_apply.py — pure parts)
//
// DB lookups (space role, the live supported-proposal-type set) are injected so
// this stays DB-free and unit-testable. The service layer supplies them.
// ---------------------------------------------------------------------------

const PROPOSAL_TYPE_RISK: Record<string, RiskLevel> = {
  memory_create: "medium",
  memory_update: "medium",
  memory_archive: "medium",
  follow_up_task: "medium",
  plan_review: "medium",
  plan_checkpoint: "medium",
  code_patch: "high",
  policy_change: "high",
  egress_review: "high",
  agent_config_update: "high",
  prompt_update: "medium",
  knowledge_create: "medium",
  knowledge_update: "medium",
  knowledge_archive: "medium",
  claim_create: "medium",
  claim_update: "medium",
  claim_archive: "medium",
  object_relation_create: "medium",
  object_relation_delete: "medium",
  object_kind_create: "high",
  object_kind_update: "high",
  object_kind_deprecate: "high",
  object_kind_archive: "high",
  claim_candidate_packet: "medium",
  memory_maintenance_packet: "medium",
  retrieval_diagnostics_packet: "medium",
  retrieval_maintenance_packet: "medium",
  relation_discovery_packet: "medium",
  skill_import_approve: "medium",
  capability_install: "high",
  capability_update: "high",
  capability_enable: "high",
  capability_disable: "medium",
  runtime_skill_binding_update: "high",
  custom_source_policy_delta: "medium",
  custom_source_credentialed_source: "high",
  custom_source_repair_activation: "medium",
  source_recipe_activation: "medium",
  evolution_bundle_rollback: "high",
};

export const SUPPORTED_PROPOSAL_TYPES: ReadonlySet<string> = new Set(
  Object.keys(PROPOSAL_TYPE_RISK),
);

const ADMIN_MAX_RISK: RiskLevel = "high";
const REVIEWER_MAX_RISK: RiskLevel = "medium";

export class ProposalRiskLevelError extends Error {
  readonly riskValue: string;
  constructor(riskValue: string) {
    super(
      `Invalid proposal risk_level ${pyRepr(riskValue)}. Must be one of: low, medium, high, critical.`,
    );
    this.riskValue = riskValue;
    this.name = "ProposalRiskLevelError";
  }
}

function parseProposalRisk(riskStr: string | null | undefined): RiskLevel | null {
  if (!riskStr) return null;
  if (riskStr === "low" || riskStr === "medium" || riskStr === "high" || riskStr === "critical")
    return riskStr;
  throw new ProposalRiskLevelError(riskStr);
}

export function effectiveProposalRisk(
  proposalType: string,
  declaredRiskStr: string | null | undefined,
): RiskLevel {
  const typeDefault = PROPOSAL_TYPE_RISK[proposalType] ?? "high";
  const declared = parseProposalRisk(declaredRiskStr);
  if (declared === null) return typeDefault;
  return RISK_RANK[declared] > RISK_RANK[typeDefault] ? declared : typeDefault;
}

export interface ProposalApplyInput {
  user_id: string;
  space_id: string;
  proposal_id: string;
  proposal_type: string;
  declared_risk: string | null | undefined;
  required_approver_role?: string | null | undefined;
  proposal_payload: Record<string, unknown> | null | undefined;
  metadata_json?: Record<string, unknown> | null | undefined;
}

/**
 * Pure proposal.apply gate. `role` is the actor's raw active membership role
 * (or null if not a member), and `supportedTypes` is the live set
 * (registered applier ∩ risk table) — both resolved by the service from DB.
 */
export function checkProposalApplyPolicy(
  input: ProposalApplyInput,
  role: string | null,
  supportedTypes: ReadonlySet<string>,
): PolicyDecision {
  const resourceType = "proposal";
  const approvalCapability = "approve_proposal";

  if (!supportedTypes.has(input.proposal_type)) {
    return makeDecision({
      decision: "deny",
      message: `Proposal type ${pyRepr(input.proposal_type)} has no supported apply handler`,
      risk_level: "high",
      reason_code: "unsupported_proposal_type",
      policy_rule_id: "proposal_type_not_supported",
      action: "proposal.apply",
      resource_type: resourceType,
      resource_id: input.proposal_id,
      proposal_type: input.proposal_type,
      approval_capability: approvalCapability,
      audit_code: "unsupported_proposal_type",
      space_id: input.space_id,
      actor_id: input.user_id,
      actor_type: "user",
      metadata_json: {
        proposal_type: input.proposal_type,
        supported_apply_type: false,
      },
    });
  }

  const risk = effectiveProposalRisk(input.proposal_type, input.declared_risk);
  const requiredApproverRole = normalizeRequiredApproverRole(input.required_approver_role);

  const meta = (membershipRole: string | null): Record<string, unknown> => ({
    proposal_type: input.proposal_type,
    membership_role: membershipRole,
    effective_risk: risk,
    proposal_declared_risk: input.declared_risk ?? null,
    proposal_required_approver_role: input.required_approver_role ?? null,
    default_type_risk: PROPOSAL_TYPE_RISK[input.proposal_type] ?? "high",
    supported_apply_type: true,
  });

  if (role === null) {
    return makeDecision({
      decision: "require_approval",
      message: "User is not a member of this space",
      risk_level: risk,
      reason_code: "no_membership",
      policy_rule_id: "proposal_apply_no_membership",
      action: "proposal.apply",
      resource_type: resourceType,
      resource_id: input.proposal_id,
      proposal_type: input.proposal_type,
      approval_capability: approvalCapability,
      audit_code: "no_membership",
      required_approver_role: requiredApproverRole,
      space_id: input.space_id,
      actor_id: input.user_id,
      actor_type: "user",
      metadata_json: meta(null),
    });
  }

  if (requiredApproverRole && !roleSatisfiesRequiredApprover(role, requiredApproverRole)) {
    return makeDecision({
      decision: "require_approval",
      message: `User has ${pyRepr(role)} role; proposal requires ${requiredApproverRole} approval`,
      risk_level: risk,
      reason_code: "insufficient_required_approver_role",
      policy_rule_id: "proposal_apply_required_role",
      action: "proposal.apply",
      resource_type: resourceType,
      resource_id: input.proposal_id,
      proposal_type: input.proposal_type,
      required_approver_role: requiredApproverRole,
      approval_capability: approvalCapability,
      audit_code: "insufficient_required_approver_role",
      space_id: input.space_id,
      actor_id: input.user_id,
      actor_type: "user",
      metadata_json: meta(role),
    });
  }

  if (role === "owner") {
    return approveProposal(input, risk, "owner", "approved_owner", "proposal_apply_owner_allow", meta, requiredApproverRole);
  }
  if (role === "admin" && RISK_RANK[risk] <= RISK_RANK[ADMIN_MAX_RISK]) {
    return approveProposal(input, risk, "admin", "approved_admin", "proposal_apply_admin_allow", meta, requiredApproverRole);
  }
  if (role === "reviewer" && RISK_RANK[risk] <= RISK_RANK[REVIEWER_MAX_RISK]) {
    return approveProposal(input, risk, "reviewer", "approved_reviewer", "proposal_apply_reviewer_allow", meta, requiredApproverRole);
  }

  return makeDecision({
    decision: "require_approval",
    message: `User has ${pyRepr(role)} role; insufficient authority for ${risk}-risk proposal`,
    risk_level: risk,
    reason_code: "insufficient_role",
    policy_rule_id: "proposal_apply_insufficient_role",
    action: "proposal.apply",
    resource_type: resourceType,
    resource_id: input.proposal_id,
    proposal_type: input.proposal_type,
    required_approver_role: requiredApproverRole,
    approval_capability: approvalCapability,
    audit_code: "insufficient_role",
    space_id: input.space_id,
    actor_id: input.user_id,
    actor_type: "user",
    metadata_json: meta(role),
  });
}

function approveProposal(
  input: ProposalApplyInput,
  risk: RiskLevel,
  role: string,
  auditCode: string,
  ruleId: string,
  meta: (r: string | null) => Record<string, unknown>,
  requiredApproverRole: string | null,
): PolicyDecision {
  return makeDecision({
    decision: "allow",
    message: `User has ${role} role; approved for ${risk}-risk proposal`,
    risk_level: risk,
    reason_code: auditCode,
    policy_rule_id: ruleId,
    action: "proposal.apply",
    resource_type: "proposal",
    resource_id: input.proposal_id,
    proposal_type: input.proposal_type,
    required_approver_role: requiredApproverRole,
    approval_capability: "approve_proposal",
    audit_code: auditCode,
    space_id: input.space_id,
    actor_id: input.user_id,
    actor_type: "user",
    metadata_json: meta(role),
  });
}

function normalizeRequiredApproverRole(role: string | null | undefined): "owner" | "admin" | "reviewer" | null {
  if (!role) return null;
  if (role === "owner" || role === "admin" || role === "reviewer") return role;
  return "owner";
}

function roleSatisfiesRequiredApprover(
  actorRole: string,
  requiredRole: "owner" | "admin" | "reviewer",
): boolean {
  return roleRank(actorRole) >= roleRank(requiredRole);
}

function roleRank(role: string): number {
  if (role === "owner") return 3;
  if (role === "admin") return 2;
  if (role === "reviewer") return 1;
  return 0;
}

export { isAllowed };
export type { Decision };
