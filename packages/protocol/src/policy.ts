/**
 * Policy enforcement wire contracts.
 *
 * Shared policy decision surface: the canonical action registry,
 * decision/request shapes, durable-audit envelope, and the `PolicyGateBlocked`
 * error taxonomy.
 *
 * Schemas only — no enforcement authority lives here. The authority is the
 * server `policy` module.
 * Field names mirror the API JSON (snake_case).
 */

import { z } from "zod";
import { IdSchema, ISODateTimeSchema, SecretResponseGuards } from "./common.js";

// ---------------------------------------------------------------------------
// Core enums (decisions.py / actions.py)
// ---------------------------------------------------------------------------

export const POLICY_DECISION_VALUES = [
  "allow",
  "deny",
  "require_approval",
] as const;
export type PolicyDecisionValue = (typeof POLICY_DECISION_VALUES)[number];
export const PolicyDecisionEnum = z.enum(POLICY_DECISION_VALUES);

export const POLICY_RISK_LEVEL_VALUES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type PolicyRiskLevel = (typeof POLICY_RISK_LEVEL_VALUES)[number];
export const PolicyRiskLevelEnum = z.enum(POLICY_RISK_LEVEL_VALUES);

export const POLICY_ACTION_LIFECYCLE_VALUES = [
  "wired_direct",
  "wired_via_proposal",
  "reserved",
] as const;
export const PolicyActionLifecycleEnum = z.enum(
  POLICY_ACTION_LIFECYCLE_VALUES,
);

export const POLICY_RECORD_FAILURE_MODE_VALUES = [
  "best_effort",
  "fail_closed",
] as const;
export const PolicyRecordFailureModeEnum = z.enum(
  POLICY_RECORD_FAILURE_MODE_VALUES,
);

// ---------------------------------------------------------------------------
// Canonical action registry
//
// This is the durable shared contract: every enforcement point must use the
// same action metadata. The registry is data and is validated by tests.
// ---------------------------------------------------------------------------

export const PolicyActionDefinitionSchema = z
  .object({
    action: z.string().min(1),
    resource_type: z.string().min(1),
    default_risk_level: PolicyRiskLevelEnum,
    default_decision: PolicyDecisionEnum,
    audit_required: z.boolean(),
    approval_capability: z.string().nullable(),
    default_required_approver_role: z.string().nullable(),
    current_enforcement_point: z.string(),
    description: z.string(),
    lifecycle_status: PolicyActionLifecycleEnum,
    record_failure_mode: PolicyRecordFailureModeEnum,
  })
  .strict();
export type PolicyActionDefinition = z.infer<
  typeof PolicyActionDefinitionSchema
>;

/**
 * The canonical registry, in insertion order. `description` is intentionally
 * omitted from the enforcement contract surface (it is human documentation, not
 * a decision input), but carried so audits and docs share the same labels.
 */
export const POLICY_ACTION_REGISTRY = [
  {
    action: "authorization.request.create",
    resource_type: "authorization_request",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/policy/authorizationRequestService.ts",
    description: "Create a bounded request from a requestable denied policy decision.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  // ---- WIRED_DIRECT ----
  {
    action: "runtime.execute",
    resource_type: "run",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/runs/orchestrationService.ts",
    description: "Execute a runtime adapter for an agent run.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "run.spawn_child",
    resource_type: "run",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/agentGroups/service.ts",
    description:
      "Create a policy-gated child run requested by one agent for another agent inside an active agent group run.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "runtime.use_credential",
    resource_type: "credential",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_credential_use",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/runs/orchestrationService.ts",
    description: "Allow a runtime adapter to use a space credential.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "runtime_context_policy.change",
    resource_type: "runtime_context_policy",
    default_risk_level: "high",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/policy/runtimeContextPolicyRepository.ts",
    description: "Create and activate an immutable Runtime Context Policy version after scope-authority checks.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "work_context_setup.change",
    resource_type: "work_context_setup",
    default_risk_level: "medium",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/runtimeContext/workContextService.ts",
    description: "Create an immutable Work Context Setup version after scope-authority and governing-policy checks.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "context.inject_memory",
    resource_type: "memory",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/runtimeContext/productionAcquisition.ts",
    description: "Authorize memory acquisition for Runtime Context planning.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "context.render_for_runtime",
    resource_type: "context",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/runtimeContext/invocationSnapshotService.ts",
    description:
      "Authorize Runtime Context Delivery persistence for a runtime adapter.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "project_folder.write_patch",
    resource_type: "project_folder",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_code_patch",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/projectFolders/codePatch.ts",
    description: "Apply a code patch to Project Folder files.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "artifact.persist",
    resource_type: "artifact",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/runs/materializationService.ts",
    description: "Persist an artifact produced by a run.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "proposal.create",
    resource_type: "proposal",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/memory/proposalRepository.ts, server/src/modules/runs/materializationService.ts, server/src/modules/projectFolders/codePatch.ts",
    description:
      "Create a proposal for a pending durable change. Covers user-created memory proposals (memory_create, memory_update, etc.) and system-created code_patch proposals from CLI runs.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "proposal.apply",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts",
    description:
      "Accept and apply a pending proposal through ProposalApplyService. The actor must have approval authority for the proposal type and risk level.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "agent.config_update",
    resource_type: "agent",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: "approve_agent_config_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/agents/routes.ts",
    description:
      "Create an agent_config_update proposal for post-create execution configuration changes. The durable mutation is still protected by proposal.apply.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  // ---- WIRED_VIA_PROPOSAL ----
  {
    action: "memory.create",
    resource_type: "memory",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_memory_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create a new memory entry. Protected via proposal.apply gate and ProposalApplyService. Must not be called directly through PolicyGateway.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "memory.update",
    resource_type: "memory",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_memory_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update a memory entry. Protected via proposal.apply gate and ProposalApplyService. Must not be called directly through PolicyGateway.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "memory.archive",
    resource_type: "memory",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_memory_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Archive a memory entry. Protected via proposal.apply gate and ProposalApplyService. Must not be called directly through PolicyGateway.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "policy.change",
    resource_type: "policy",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_policy_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create or supersede a policy version. Protected via proposal.apply gate and ProposalApplyService. Must not be called directly through PolicyGateway.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "knowledge.create",
    resource_type: "knowledge",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create an active KnowledgeItem after an accepted knowledge_create proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "knowledge.update",
    resource_type: "knowledge",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create a new version of an existing KnowledgeItem after an accepted knowledge_update proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "knowledge.archive",
    resource_type: "knowledge",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Archive a KnowledgeItem after an accepted knowledge_archive proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "claim.create",
    resource_type: "claim",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create a global Claim atom after an accepted claim_create proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "claim.update",
    resource_type: "claim",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update a global Claim atom after an accepted claim_update proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "claim.archive",
    resource_type: "claim",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Archive a global Claim atom after an accepted claim_archive proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_relation.create",
    resource_type: "object_relation",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create an FK-backed ObjectRelation after an accepted object_relation_create proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_relation.delete",
    resource_type: "object_relation",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Archive an ObjectRelation after an accepted object_relation_delete proposal. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_profile.create",
    resource_type: "object_schema",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "admin",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Create a governed per-space object_profile definition after an accepted object_profile_create proposal. Does not create canonical domain rows or retrieval object types.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_profile.update",
    resource_type: "object_schema",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "admin",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update label/config fields or activate a draft governed object_profile definition after an accepted object_profile_update proposal. Key and base object type remain fixed.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_profile.deprecate",
    resource_type: "object_schema",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "admin",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Deprecate a governed object_profile definition after an accepted object_profile_deprecate proposal. Existing object rows remain valid.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "object_profile.archive",
    resource_type: "object_schema",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_knowledge_change",
    default_required_approver_role: "admin",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Archive a governed object_profile definition after an accepted object_profile_archive proposal. Existing object rows remain valid because object_profile remains optional.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "claim_candidate_packet",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Review a Claim Candidate Packet. Accepting creates child pending claim/object-relation proposals for supported candidates and does not directly write canonical Claims.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "retrieval_maintenance_packet",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Review a retrieval maintenance packet. Private packets remain creator-only; explicit space_shared space_ops packets require the Context Ops review setting to allow the reviewer. Accepting may create child pending Knowledge relation proposals but does not directly write canonical Knowledge.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "memory_maintenance_packet",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Acknowledge a Memory maintenance packet. Private packets remain creator-only; explicit space_shared space_ops packets require the Context Ops review setting to allow the reviewer. Accepting records review acknowledgement only and performs no canonical Memory writes.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "retrieval_diagnostics_packet",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Acknowledge a retrieval diagnostics packet. Private packets remain creator-only; explicit space_shared space_ops packets require the Context Ops review setting to allow the reviewer. Accepting records review acknowledgement only and performs no canonical Knowledge or Memory writes.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "relation_discovery_packet",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Review a candidate-relation discovery packet. Private packets remain creator-only; explicit space_shared space_ops packets require the Context Ops review setting to allow the reviewer. Accepting creates child pending object_relation_create / knowledge_create proposals for supported candidates and does not directly write canonical Knowledge.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "best_effort",
  },
  {
    action: "skill.import",
    resource_type: "skill_package",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Approve an imported Open Skill package as reviewed source material. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "skill.convert",
    resource_type: "skill_package",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Convert a reviewed Open Skill package into a disabled draft capability. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "capability.enable",
    resource_type: "capability",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Enable a registered capability for agent runs in this space. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "capability.disable",
    resource_type: "capability",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Disable a registered capability for agent runs in this space. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "capability.update",
    resource_type: "capability",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update the manifest or configuration of a registered capability. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "runtime_skill.binding_update",
    resource_type: "runtime_skill_binding",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update a runtime skill binding for a capability version. Protected via proposal.apply gate and ProposalApplyService.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  // ---- RESERVED + remaining WIRED_DIRECT (insertion order) ----
  {
    action: "context.use_personal_grant",
    resource_type: "personal_memory_grant",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "not_implemented",
    description:
      "Authorize use of a PersonalMemoryGrant to include cross-space personal memory in a run context.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "project_folder.read",
    resource_type: "project_folder",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/projectFolders/repository.ts",
    description: "Read files or metadata from a Project Folder.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "project_folder.apply_patch",
    resource_type: "project_folder",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_code_patch",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Apply a patch to Project Folder files via a mechanism other than project_folder.write_patch (e.g. a direct apply path bypassing the proposal).",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "artifact.export",
    resource_type: "artifact",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Export an artifact to a destination outside the originating space.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "proposal.approve",
    resource_type: "proposal",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_proposal",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Record an explicit ProposalApproval row for a pending proposal, separate from the proposal.apply gate.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "memory.read_private",
    resource_type: "memory",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Read a private memory entry outside the owning user's personal space run context.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "memory.promote_shared",
    resource_type: "memory",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_memory_change",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Change a memory entry's visibility from private to space-shared.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "runtime_skill.render",
    resource_type: "runtime_skill_binding",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point: "server/src/modules/runtimeContext/productionAcquisition.ts",
    description:
      "Render a runtime-bound Open Skill for an adapter execution context.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "runtime_skill.execute",
    resource_type: "runtime_skill_binding",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Execute a runtime-bound Open Skill through an adapter-native skill mechanism.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "tool_binding.enable",
    resource_type: "tool_binding",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_tool_binding_change",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description: "Enable a tool binding for agent use in this space.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "evidence.export",
    resource_type: "evidence",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description: "Export extracted evidence outside the originating space.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  // ---- Automation WIRED_DIRECT ----
  {
    action: "automation.create",
    resource_type: "automation",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_automation_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/automations/service.ts",
    description:
      "Create an automation rule that can trigger agent runs or managed operational scans on a schedule or event.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "automation.fire",
    resource_type: "automation",
    default_risk_level: "medium",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/automations/service.ts",
    description: "Manually trigger an automation rule to queue an agent run or execute a managed operational scan.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "automation.update",
    resource_type: "automation",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_automation_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/automations/service.ts",
    description:
      "Update an existing automation rule's trigger condition or configuration.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.connection.manage",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description: "Create or update source connections.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.item_create",
    resource_type: "source_item",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Create raw source items or extraction jobs without mutating durable memory or knowledge.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.item_update",
    resource_type: "source_item",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Update source item triage or read status without changing durable memory or knowledge.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "evidence.create",
    resource_type: "evidence",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Create extracted evidence derived from source, activity, artifacts, or run records.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "evidence.update",
    resource_type: "evidence",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Update extracted evidence review status, confidence, or metadata.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "evidence.link",
    resource_type: "evidence",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Link evidence to space, project_folder, project, user, agent, run, proposal, artifact, memory, knowledge, or task targets.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.create",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description: "Create a draft Custom Source connection shell.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.generate",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description: "Generate a new handler version (source code + policy envelope) for a Custom Source.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.test",
    resource_type: "source_connection",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description: "Run a Custom Source handler version in sandboxed fixture-test mode without materializing Source output.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.activate",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Activate a tested Custom Source handler version; policy-delta activations create custom_source_* proposals and mark the version pending_approval until accepted.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.repair",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSourceRoutes.ts",
    description:
      "Regenerate a Custom Source handler version from its active version's manifest plus overrides, test it, and either auto-activate (unchanged envelope, Space policy allows) or create a review proposal.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.rollback",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSourceRoutes.ts",
    description:
      "Activate a previously active (superseded) Custom Source handler version in place of the current active one, without a proposal — it can only reduce to an already-approved prior state, never broaden permissions.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.credential_create",
    resource_type: "custom_source_credential",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSourceRoutes.ts",
    description:
      "Create a Custom Source fetch credential (encrypted at rest, space-scoped); requires space admin. The plaintext secret is never returned by any API response.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.recipe.create",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceRecipeRoutes.ts",
    description:
      "Plan or create a Level 2 recipe Source: deterministic source planning plus a paused source connection with a draft recipe version.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.recipe.activate",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceRecipeRoutes.ts",
    description:
      "Activate a dry-run-tested Source recipe version; policy-envelope deltas create a source_recipe_activation proposal and mark the version pending_approval until accepted.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.recipe.dry_run",
    resource_type: "source_connection",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceRecipeRoutes.ts",
    description:
      "Run a bounded, side-effect-free dry-run of a draft Source recipe version; produces a sample preview and step traces without materializing Source output.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "source.custom.settings_update",
    resource_type: "custom_source_settings",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/routes.ts",
    description:
      "Update Space Settings product policy for Source Custom Source creation, defaults, allowed domains, credentialed-source allowance, and same-envelope repair auto-apply.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    action: "project.source.bind",
    resource_type: "project_source",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projects/routes.ts",
    description:
      "Create or update a Project-owned Source binding (project consumption configuration over a Sources-owned connection).",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  // NE registered these two so its Note actions would have a policy action to
  // name. Both are `reserved`, not `wired_direct`, and the distinction is the
  // honest one: no code path evaluates either, so nothing is gated by them and
  // no audit record carries their name.
  //
  // They were first written as `wired_direct` on the grounds that they made
  // the action auditable. They do not: the enforcement is the route's own
  // Project ACL, and who did it is already on the domain row
  // (`space_objects.created_by_user_id` for a Thread,
  // `note_links.created_by_user_id` for a link), so a policy audit record
  // would restate what the canonical row already says. Wiring them is a
  // decision to make, not a description of today — which is what `reserved`
  // means here and for the nine other actions that carry it.
  {
    // NE: raising a passage of a note as a Question. Direct-write, matching
    // the Thread create route it calls — P2 confirmed Thread structure stays
    // direct rather than moving behind a proposal.
    action: "inquiry.thread.create",
    // The Project, not the Thread: there is no Thread yet to authorize
    // against, and writing into a Project is the authority being checked —
    // the same shape `task.create` uses.
    resource_type: "project",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/systemActions/systemActionDispatcher.ts",
    description:
      "Open an Inquiry Thread in a Project the actor can write to. Allowed when a person asked for it in the turn; an autonomous origin requires approval, because a question nobody asked for is a commitment made on the Project's behalf. Bounded per turn, and every Thread an Agent opens is archivable from the Project's updates.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    // NE: linking a note to evidence. A note_link is navigational and carries
    // no graph authority (N4), so this would be low risk and allowed by
    // default if it were ever wired.
    action: "note.link.create",
    resource_type: "note",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "not_implemented",
    description:
      "Create a navigational link from a Note to another ontology object. Not a semantic graph edge (B12A/N4). Reserved: the note read gate on both endpoints is what enforces this today.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "project.operation.manage",
    resource_type: "project_operation",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projects/routes.ts",
    description:
      "Create or cancel a Project operation progress record. Project operations are a grouping/read model over runs, jobs, proposals, and plans; they carry no execution authority of their own.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {
    // Direct execution, no proposal gate (room-advancement-reliability-plan
    // Phase 4): the Inquiry Thread was already human-accepted at creation,
    // so starting acquisition on it is execution, not the agent-drafted
    // structure/content write ADR 0003 gates. The human confirmation gate is
    // replaced by hard idempotency guards in the acquisition service itself.
    action: "research.acquisition.start",
    resource_type: "inquiry_thread",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projectResearch/pipeline/researchAcquisitionService.ts",
    description:
      "Start a tracked background research-acquisition pipeline (question assessment, query planning, strategy activation, initial intake) for an accepted Inquiry Thread.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    // The stop lever for what `research.acquisition.start` began. Low risk and
    // allowed by default in both directions: stopping work the user or their
    // Agent no longer wants is not a destructive act on durable content — no
    // Artifact, Report, or Knowledge already written is touched — and a stop
    // that needed approval would be no stop at all while a Run keeps spending.
    action: "research.acquisition.cancel",
    resource_type: "project_operation",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projectResearch/routes.ts + system-action policy gate",
    description:
      "Cancel a running research Operation: the Operation stops accepting new passes and its in-flight Runs, screening batches, and pass Execution are terminated.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "retrieval.search",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the managed-run Knowledge retrieval search tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "retrieval.brief",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the managed-run Knowledge Context Brief tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "memory.retrieval.search",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Memory retrieval search tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "memory.retrieval.brief",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Memory Context Brief tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project.summary.search",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Project public-summary search tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project.summary.brief",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Project public-summary Context Brief tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.retrieval.search",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Source retrieval search tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.retrieval.brief",
    resource_type: "retrieval_tool",
    default_risk_level: "low",
    default_decision: "deny",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/retrieval/tool/service.ts, server/src/modules/runs/managedRetrievalTools.ts",
    description:
      "Invoke the explicitly opted-in managed-run Source Context Brief tool under the instructing user's read access.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "deployment.propose",
    resource_type: "deployment",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_deployment",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Create a deployment proposal for a configuration or infrastructure change.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "deployment.execute",
    resource_type: "deployment",
    default_risk_level: "critical",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_deployment",
    default_required_approver_role: "owner",
    current_enforcement_point: "not_implemented",
    description:
      "Execute a deployment to apply a proposed configuration or infrastructure change.",
    lifecycle_status: "reserved",
    record_failure_mode: "best_effort",
  },
  {
    action: "policy.action_grant.create",
    resource_type: "action_approval_grant",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: "manage_action_grants",
    default_required_approver_role: "owner",
    current_enforcement_point: "server/src/modules/policy/actionApprovalGrantService.ts",
    description: "Create a bounded pre-authorization grant for one agent and system action.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.connection.activate",
    resource_type: "source_connection",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_source_connection",
    default_required_approver_role: "owner",
    current_enforcement_point: "server/src/modules/proposals/applyService.ts via source_connection_create",
    description: "Activate a reviewed Source connection draft; direct activation requires approval unless an owning flow proves an approved envelope.",
    lifecycle_status: "wired_via_proposal",
    record_failure_mode: "fail_closed",
  },
  {
    action: "policy.action_grant.revoke",
    resource_type: "action_approval_grant",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: "manage_action_grants",
    default_required_approver_role: "owner",
    current_enforcement_point: "server/src/modules/policy/actionApprovalGrantService.ts",
    description: "Revoke an active action pre-authorization grant.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  { action:"source.backfill.plan",resource_type:"source_backfill_plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/sources/sourceBackfillService.ts",description:"Preview or create a bounded Source history import plan.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"source.backfill.start",resource_type:"source_backfill_plan",default_risk_level:"high",default_decision:"require_approval",audit_required:true,approval_capability:"approve_source_backfill",default_required_approver_role:"owner",current_enforcement_point:"server/src/modules/sources/sourceBackfillProposalApplier.ts",description:"Start an approved quota-controlled Source history import.",lifecycle_status:"wired_via_proposal",record_failure_mode:"fail_closed" },
  { action:"source.backfill.manage",resource_type:"source_backfill_plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/sources/routes.ts",description:"Pause or resume a Source history import plan.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.plan.propose",resource_type:"plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Submit an Agent-generated execution Plan for a source Task.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"project.brief.propose",resource_type:"project_brief_version",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Propose a formal Project goal or core problem for owner review.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's Tasks (ids, titles, status) so an Agent can address one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"proposal.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read a conversation's pending Proposals (ids and titles) so an Agent can decide one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"research.operation.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's research Operations (ids and status) so an Agent can cancel one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"memory.write",resource_type:"memory_entry",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"An Agent's own bounded memory write: private, normal-sensitivity, about the acting person, always a new version with provenance. Allowed from a person's turn; an unattended origin requires approval, and any write that widens reach becomes a proposal whatever the origin.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.advice.adopt",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Adopt the system's recorded next step for an Inquiry Thread, on the user's instruction — the same write the Area's Adopt button makes.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.thread.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's active Inquiry Threads (ids and statements) so an Agent can address one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },

  { action:"inquiry.iteration.record",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Record an Inquiry Thread conclusion. Allowed when a person asked for it in the turn; an autonomous origin requires approval. Every Iteration keeps the position it replaced, so the Project's updates can revert it.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.knowledge.promote",resource_type:"knowledge_promotion_candidate",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Propose promoting a concluded Inquiry round to a Knowledge Item.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.create",resource_type:"project",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Create a Project Task. Allowed when a person asked for it in the turn; an autonomous origin requires approval, because a Task nobody asked for is a commitment made on the Project's behalf.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"proposal.decide",resource_type:"proposal",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Accept or reject, on the instructing person's word in their own turn, a proposal a Run of the same conversation created. Refused on any other origin: an Agent never decides for itself, it carries the decision.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.report",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Append a readable account of what was done and concluded. Append-only, and the only way an Agent advancing work outside a conversation can say anything at all.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.handoff",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Transfer responsibility for a Task, or release it. Self-limiting: it can only give work away.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.stage.advance",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Move a Task's Loop stage. An autonomous origin requires approval: skipping or reversing a stage is a claim about the work that a person should see.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.request_review",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Stop work and ask a person to decide. Self-limiting: it can only halt, never proceed.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
] as const satisfies readonly PolicyActionDefinition[];

export type PolicyActionId = (typeof POLICY_ACTION_REGISTRY)[number]["action"];

// ---------------------------------------------------------------------------
// Enforcement request (PolicyCheckRequest, gateway.py)
//
// `context` carries bounded decision inputs (flattened into the guard ctx);
// `metadata_json` is audit-only; `payload` is only scanned by hard invariants.
// None of these may carry secrets — the broker/runtime channels own those.
// ---------------------------------------------------------------------------

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const PolicyCheckRequestSchema = z
  .object({
    action: z.string().min(1),
    actor_type: z.string().nullish(),
    actor_id: IdSchema.nullish(),
    actor_ref: JsonRecordSchema.nullish(),
    space_id: IdSchema.nullish(),
    resource_type: z.string().nullish(),
    resource_id: z.string().nullish(),
    resource_space_id: IdSchema.nullish(),
    run_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    context: JsonRecordSchema.nullish(),
    payload: JsonRecordSchema.nullish(),
    metadata_json: JsonRecordSchema.nullish(),
    force_record: z.boolean().default(false),
  })
  .strict();
export type PolicyCheckRequest = z.infer<typeof PolicyCheckRequestSchema>;

// ---------------------------------------------------------------------------
// Proposal-apply gate request (PolicyPort.enforce_proposal_apply)
// ---------------------------------------------------------------------------

export const PolicyProposalApplyRequestSchema = z
  .object({
    user_id: IdSchema,
    space_id: IdSchema,
    proposal_id: IdSchema,
    proposal_type: z.string().min(1),
    risk_level: PolicyRiskLevelEnum.nullish(),
    required_approver_role: z.string().nullish(),
    membership_role: z.string().nullish(),
    supported_proposal_types: z.array(z.string().min(1)),
    // The proposal payload is scanned only for approval-proof flags by the hard
    // invariant guard; it is never a decision input otherwise and must be
    // secret-free.
    payload: JsonRecordSchema.nullish(),
    metadata_json: JsonRecordSchema.nullish(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Decision result (PolicyDecision, decisions.py)
// ---------------------------------------------------------------------------

export const PolicyDecisionSchema = z
  .object({
    decision: PolicyDecisionEnum,
    message: z.string(),
    risk_level: PolicyRiskLevelEnum.default("low"),
    reason_code: z.string().nullish(),
    required_approver_role: z.string().nullish(),
    policy_rule_id: z.string().nullish(),
    policy_source: z.string().default("builtin"),
    policy_id: z.string().nullish(),
    actor_type: z.string().nullish(),
    actor_id: IdSchema.nullish(),
    actor_ref: JsonRecordSchema.nullish(),
    space_id: IdSchema.nullish(),
    action: z.string().nullish(),
    resource_type: z.string().nullish(),
    resource_id: z.string().nullish(),
    audit_code: z.string().nullish(),
    approval_capability: z.string().nullish(),
    proposal_type: z.string().nullish(),
    metadata_json: JsonRecordSchema.nullish(),
    created_at: ISODateTimeSchema.nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// ---------------------------------------------------------------------------
// Durable audit envelope (audit.py PolicyAuditEnvelope → PolicyDecisionRecord)
//
// This is the sanitized, audit-only record the gateway persists. metadata_json
// is post-sanitization (no credentials/raw memory/patch bodies/stdout-stderr).
// ---------------------------------------------------------------------------

export const PolicyAuditEnvelopeSchema = z
  .object({
    space_id: IdSchema.nullish(),
    actor_type: z.string().nullish(),
    actor_id: IdSchema.nullish(),
    actor_ref_json: JsonRecordSchema.nullish(),
    action: z.string(),
    resource_type: z.string().nullish(),
    resource_id: z.string().nullish(),
    decision: PolicyDecisionEnum,
    risk_level: PolicyRiskLevelEnum,
    required_approver_role: z.string().nullish(),
    approval_capability: z.string().nullish(),
    policy_rule_id: z.string().nullish(),
    policy_source: z.string().nullish(),
    policy_id: z.string().nullish(),
    audit_code: z.string().nullish(),
    run_id: IdSchema.nullish(),
    proposal_id: IdSchema.nullish(),
    metadata_json: JsonRecordSchema.nullish(),
    created_at: ISODateTimeSchema,
    ...SecretResponseGuards,
  })
  .passthrough();
export type PolicyAuditEnvelope = z.infer<typeof PolicyAuditEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Error taxonomy (exceptions.py — PolicyGateBlocked / PolicyAuditPersistError)
//
// `enforce` returns a PolicyDecision on ALLOW and raises a gate-block on
// DENY / REQUIRE_APPROVAL; an independent fail-closed audit write failure is a
// distinct error so a sensitive action does not proceed without durable audit.
// ---------------------------------------------------------------------------

export const POLICY_ENFORCE_ERROR_CODES = [
  "policy_denied",
  "policy_requires_approval",
  "policy_audit_persist_failed",
  "unknown_policy_action",
  "policy_action_not_implemented",
  "unauthorized_internal_port",
  "policy_invalid_request",
] as const;
export const PolicyEnforceErrorCodeEnum = z.enum(POLICY_ENFORCE_ERROR_CODES);

export const PolicyEnforceResultSchema = z
  .object({
    status: z.enum(["allow", "blocked", "error"]),
    decision: PolicyDecisionSchema.nullish(),
    policy_decision_record_id: IdSchema.nullish(),
    error_code: PolicyEnforceErrorCodeEnum.nullish(),
    message: z.string().nullish(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type PolicyEnforceResult = z.infer<typeof PolicyEnforceResultSchema>;
