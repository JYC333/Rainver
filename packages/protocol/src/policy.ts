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
// Core enums
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

/**
 * Shared role ceilings, sourced from server policy/decisions.ts. These values
 * support UI eligibility; the server still authorizes each approval.
 */
export const POLICY_APPROVER_MAX_RISK: Readonly<Record<string, PolicyRiskLevel>> = {
  owner: "critical",
  admin: "high",
  reviewer: "medium",
};

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
  {"action":"workspace.integration.verification.get","resource_type":"project","default_risk_level":"low","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceVerificationOperations.ts","description":"Read verification configuration for an authorized isolated integration without changing or publishing it.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.integration.verification.configure","resource_type":"project","default_risk_level":"medium","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceVerificationOperations.ts","description":"Configure bounded Folder verification commands for an isolated integration; unattended writes require approval.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.integration.retry","resource_type":"project","default_risk_level":"medium","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceOperations.ts","description":"Control a revision-fenced isolated change using current Project and Run authority.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.change.abandon","resource_type":"project","default_risk_level":"medium","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceOperations.ts","description":"Control a revision-fenced isolated change using current Project and Run authority.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.retention.update","resource_type":"project","default_risk_level":"medium","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceRetentionOperations.ts","description":"Recover existing obligations or manage retention using current Project, Host and Run authority; Agents may recover or retry existing cleanup, never grant a new discard.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.change.list","resource_type":"project","default_risk_level":"low","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceChangeList.ts","description":"List visible isolated change sets with Project, Run body, contributor and Host visibility; manually instructed conversation writers may inspect the same person's other conversations for reviewed cleanup.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.branch.align","resource_type":"project","default_risk_level":"high","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceBranchAlign.ts","description":"Person-only alignment of a local Folder branch to another with frozen expected tips, worktree/lease guards and a recovery ref; never pushes.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},

  {"action":"workspace.change.get","resource_type":"project","default_risk_level":"low","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceOperations.ts","description":"Read authorized workspace progress, including same-Project cross-conversation cleanup targets; inspection grants no publication or integration retry authority.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {"action":"workspace.change.complete","resource_type":"project","default_risk_level":"medium","default_decision":"allow","audit_required":true,"approval_capability":null,"default_required_approver_role":null,"current_enforcement_point":"server/src/modules/projectFolders/workspaceOperations.ts","description":"Mark an authorized isolated change set ready for checkpointed, verified integration; never publishes directly.","lifecycle_status":"wired_direct","record_failure_mode":"fail_closed"},
  {action:"system.actions.list",resource_type:"space",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/operations/executor.ts",description:"Discover enabled public operation metadata under current Space membership.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed"},
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
    action: "room.collaboration.manage",
    resource_type: "agent_run_group",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/agentGroups/collaborationParticipantsOperation.ts",
    description: "Authenticated human coordinator changes participants without changing Task, coordinator, usage or history.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "room.collaboration.read",
    resource_type: "agent_run_group",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: false,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/agentGroups/collaborationReadOperation.ts",
    description: "Authenticated human manager reads the task collaboration of one Room conversation.",
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
  {action:'proposal.accept',resource_type:'proposal',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/proposals/operations.ts',description:'Accept through the canonical typed Proposal owner and its proposal.apply authority gate.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'proposal.rollback',resource_type:'proposal',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/proposals/operations.ts',description:'Queue rollback through the canonical typed Proposal owner and its proposal.apply authority gate.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'proposal.reject',resource_type:'proposal',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/proposals/operations.ts',description:'Decline a currently readable pending Proposal through its canonical reviewer and complete dependency closure.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'proposal.egress.approve',resource_type:'proposal',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/proposals/operations.ts',description:'Record consent by the currently authorized taint owner or personal-memory granting person; does not accept the Proposal.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
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
      "Registered policy action. Owner routes append an immutable AgentVersion directly and do not call this action or create an agent_config_update proposal.",
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
    action: "runtime_skill.binding_update",
    resource_type: "skill_binding",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_capability_change",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/proposals/applyService.ts via proposal.apply",
    description:
      "Update a scoped binding to an immutable reviewed Skill package. Protected via proposal.apply gate and ProposalApplyService.",
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
    action: "input_resource.read",
    resource_type: "conversation_input_resource",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/sessions/conversationInputResourceService.ts",
    description: "Read bounded lines from an immutable conversation resource.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "input_resource.search",
    resource_type: "conversation_input_resource",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/sessions/conversationInputResourceService.ts",
    description: "Search bounded text in an immutable conversation resource.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "conversation.history.read",
    resource_type: "session",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point:
      "server/src/modules/sessions/conversationHistorySystemActionExecutors.ts",
    description: "Read or search the recorded history of the conversation a Run belongs to.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project_folder.apply_patch",
    resource_type: "project_folder",
    default_risk_level: "high",
    default_decision: "require_approval",
    audit_required: true,
    approval_capability: "approve_code_patch",
    default_required_approver_role: "owner",
    current_enforcement_point:
      "server/src/modules/projectFolders/repository.ts",
    description:
      "Save a user-authored recovery draft to a Project Folder after exact optimistic concurrency checks; history restoration remains draft-only.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
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
  {action:'relation.write',resource_type:'space_object',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/relations/operations.ts',description:'Write owned Relations records under live Project and source-reference authority.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {
    action: "source.goal.manage",
    resource_type: "source_goal",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/goals/operations.ts",
    description: "Manage bounded collection goals; each bound Source still requires its own live policy and content authorization.",
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
    action: "source.gmail.connection.manage",
    resource_type: "gmail_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailOperations.ts",
    description: "Disconnect or forget the caller's own private Gmail connection; owner only, human API only, never an Agent tool.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.selection.manage",
    resource_type: "gmail_thread_selection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailOperations.ts",
    description: "Remove an existing legacy Gmail thread reference; owner-private even in a shared Project, human API only, never an Agent tool. New selections cannot be added.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.monitor.manage",
    resource_type: "gmail_monitor",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailOperations.ts",
    description: "Pause, resume or delete the caller's own private Gmail monitor; owner only, human API only, never an Agent tool.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.mail.read",
    resource_type: "gmail_connection",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailAgentReadOperation.ts",
    description: "An Agent reads the mailbox owner's recent mail or a Gmail search (at most 5 messages, plain-text bodies) through the server's Gmail broker, in an ordinary conversation of a Project on its own runtime (ADR 0033 §6): the owner's opt-in and own turn, their standing consent for that Project and mailbox (confirmed once in place), an audience inside that Project, release gate, taint and owner-only audit.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },


  {
    action: "source.gmail.digest.propose",
    resource_type: "gmail_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailDigestProposal.ts",
    description: "An Agent drafts the mailbox owner's scheduled Gmail digest as a confirmation only the owner can accept, in the owner's own turn of a Project conversation (their private one, a Room or the mainline, while every reader reads the Project), delivered only into that conversation. The Agent reads no mail.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.digest.read",
    resource_type: "gmail_digest",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailDigestReadOperation.ts",
    description: "A scheduled digest Run reads the mail of the window the server froze for its delivery (ADR 0033 phase B): the owner's digest consent, the delivery conversation's own runtime (an owner-only turn of their private conversation, or one scheduled Room or mainline turn whose readers all read the Project), release gate, taint and the owner's audit.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.digest.manage",
    resource_type: "gmail_digest",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailOperations.ts",
    description: "Pause, resume or end the caller's own scheduled Gmail digest; owner only, human API only, never an Agent tool.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.summary.share",
    resource_type: "room",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailSummaryShare.ts",
    description: "The person shares their edited excerpt from their own Gmail reply to an accessible conversation in the same Project, under their own name.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.gmail.monitor.propose",
    resource_type: "gmail_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/gmail/gmailMonitorProposal.ts",
    description: "An Agent drafts a private Gmail monitor as a proposal only the mailbox owner can accept; only in the owner's own turn with an owner-only audience. The Agent never reads mail.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
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
    current_enforcement_point: "server/src/modules/sources/sourceObjectOperations.ts",
    description:
      "Create extracted evidence derived from source, activity, artifacts, or run records.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "evidence.update",
    resource_type: "evidence",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceObjectOperations.ts",
    description:
      "Update extracted evidence review status, confidence, or metadata.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "evidence.link",
    resource_type: "evidence",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceObjectOperations.ts",
    description:
      "Link evidence to space, project_folder, project, user, agent, run, proposal, artifact, memory, knowledge, or task targets.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.create",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description: "Create a draft Custom Source connection shell.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.generate",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description: "Generate a new handler version (source code + policy envelope) for a Custom Source.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.test",
    resource_type: "source_connection",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description: "Run a Custom Source handler version in sandboxed fixture-test mode without materializing Source output.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.activate",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description:
      "Activate a tested Custom Source handler version; policy-delta activations create custom_source_* proposals and mark the version pending_approval until accepted.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.repair",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description:
      "Regenerate a Custom Source handler version from its active version's manifest plus overrides, test it, and either auto-activate (unchanged envelope, Space policy allows) or create a review proposal.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.rollback",
    resource_type: "source_connection",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description:
      "Activate a previously active (superseded) Custom Source handler version in place of the current active one, without a proposal — it can only reduce to an already-approved prior state, never broaden permissions.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.credential_create",
    resource_type: "custom_source_credential",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description:
      "Create a Custom Source fetch credential (encrypted at rest, space-scoped); requires space admin. The plaintext secret is never returned by any API response.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
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
    current_enforcement_point: "server/src/modules/sources/sourceRecipeOperations.ts",
    description:
      "Activate a dry-run-tested Source recipe version; policy-envelope deltas create a source_recipe_activation proposal and mark the version pending_approval until accepted.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.recipe.dry_run",
    resource_type: "source_connection",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/sourceRecipeOperations.ts",
    description:
      "Run a bounded, side-effect-free dry-run of a draft Source recipe version; produces a sample preview and step traces without materializing Source output.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "source.custom.settings_update",
    resource_type: "custom_source_settings",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/sources/customSources/operations.ts",
    description:
      "Update Space Settings product policy for Source Custom Source creation, defaults, allowed domains, credentialed-source allowance, and same-envelope repair auto-apply.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project.source.bind",
    resource_type: "project_source",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projects/projectSourceOperations.ts; server/src/modules/projects/routes.ts for proposal-first setup",
    description:
      "Create or update a Project-owned Source binding (project consumption configuration over a Sources-owned connection).",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  // Thread creation and human Note history/trash use their canonical direct
  // writers. Navigational note links below remain reserved/default-denied;
  // migrating independent Note controls does not relax their separate policy.
  {
    // Raising a passage of a note as a Question. Direct-write, matching
    // the Thread create route it calls. Thread structure stays a direct write.
    // Do not move it behind a proposal.
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
    current_enforcement_point: "server/src/modules/inquiry/threadCreationOperations.ts; server/src/modules/systemActions/systemActionDispatcher.ts for Agent create_thread",
    description:
      "Open an Inquiry Thread in a Project the actor can write to. Allowed when a person asked for it in the turn; an autonomous origin requires approval, because a question nobody asked for is a commitment made on the Project's behalf. Bounded per turn, and every Thread an Agent opens is archivable from the Project's updates.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "note.edit",
    resource_type: "note",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/knowledge/noteObjectOperations.ts; noteControlOperations.ts",
    description: "Human Note draft/edit, collection/placement and history/trash controls with canonical read/write and Project authority. No new Agent, Memory/Wiki promotion, Note linking or hard-delete permission.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    // Human navigational links use the ordinary object access gates.
    // They carry no canonical graph authority and grant no Agent capability.
    action: "note.link.create",
    resource_type: "note",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/knowledge/noteLinkOperations.ts",
    description:
      "Human navigational Note links under current Note/Project write and typed endpoint read access; no canonical graph or Agent authority (B12A/N4).",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project.monitoring.configure",
    resource_type: "project",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projects/monitoring/routes.ts",
    description: "Propose or explicitly operate bounded manual Project monitoring; Project writer and Sources owner gates remain mandatory.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  {
    action: "project.operation.manage",
    resource_type: "project_operation",
    default_risk_level: "low",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projects/projectOperationOperations.ts; server/src/modules/systemActions/systemActionDispatcher.ts for monitoring read",
    description:
      "Create or cancel a Project operation progress record. Project operations are a grouping/read model over runs, jobs, proposals, and plans; they carry no execution authority of their own.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "best_effort",
  },
  {action:"project.reading.read",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read existing Project Reading materials and analyses under live audience and Source egress gates.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort"},
  {action:'inquiry.workspace.update',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/inquiry/operations.ts',description:'Human Inquiry commands retain Thread, content, Project and canonical domain mutation gates.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'agent.definition.manage',resource_type:'agent',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/agents/operations.ts',description:'Human Agent definition, configuration version, template, Runtime Profile, Space runtime default and managed Assistant preference commands retain owner, configurer and Host/Location authority; no credential or deployment field.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'agent.run.start',resource_type:'agent',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/agents/operations.ts, server/src/modules/agents/chatOperations.ts',description:'A person queues an Agent Run or direct conversation turn under Agent visibility, Project placement and budget admission; execution, Host and provider work stay in workers.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'agent.conversation.write',resource_type:'agent',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/agents/operations.ts',description:'Reset a person\'s direct Agent context or save their conversation runtime session configuration under conversation, Room writer and Host-owner authority.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'room.roster.manage',resource_type:'room',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/rooms/operations.ts',description:'Human Room creation, Agent and person roster, invitation, ownership and Agent-context commands retain Project writer, Room membership, private-Agent sharing and Host-owner authority; Host archive/restore happens after commit.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'room.conversation.write',resource_type:'room',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/rooms/operations.ts',description:'A Room member sends, queues, retries or continues turns, copies references and steers discussions under Room audience, disclosure and Conversation execution authority; Runs and Jobs commit with the turn and workers alone contact Hosts and providers.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'agent_group.manage',resource_type:'agent_run_group',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/agentGroups/operations.ts',description:'A person creates, edits, messages and pauses/resumes/cancels an Agent group run they manage; dispatched Runs and Jobs commit with the change and parked Runs are re-evaluated after commit.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'run.control',resource_type:'run',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/runs/operations.ts',description:'A person stops, abandons, resumes, queues, finalizes, steers or sets quota recovery for a Run under the existing Run command standing and approval authority; process, Host and provider work run after commit or in the Run Job, never in the transaction.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'session.write',resource_type:'session',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sessions/operations.ts',description:'A person opens, writes to or deletes their own direct conversation, previews or initializes a conversation execution context and changes Folder attachments under Project writer, Room and Host authority; Host workspace archive happens after commit.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'provider.manage',resource_type:'model_provider',default_risk_level:'high',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/providers/operations.ts',description:"A person creates, updates, deletes, grants or tests a model Provider they own or may manage, maintains its encrypted API-key pool, reads its plan usage or (instance admin) its managed subscription quota, or disconnects that subscription. Keys enter only the encrypted credential channel; no response, receipt, audit or Job carries one. Vendor IO is a durable system command performed after commit.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'provider.space_policy.manage',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/providers/operations.ts',description:"A Space owner or admin sets or removes an auxiliary task Provider chain or the Space's subscription quota lines; an embedding chain change resets and re-queues that Space's retrieval embeddings in the same transaction.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'network_profile.manage',resource_type:'network_profile',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/networkProfiles/operations.ts',description:"A Space owner or admin creates, updates or deletes a network profile (direct or credential-free HTTP proxy) used for Provider and managed CLI egress.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'instance.settings.manage',resource_type:'instance',default_risk_level:'high',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/system/settingsOperations.ts',description:"The instance administrator changes instance-wide configuration: operating settings, the ACP registry agents enabled here, the instance Source catalog, or requests a manual backup (a durable system command).",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'official_plugin.manage',resource_type:'plugin',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/plugins/settingsOperations.ts',description:"Install (instance admin; plugin migrations run in the worker's own transaction), enable, disable or configure an official plugin at its declared scope: a Space plugin by a Space owner or admin, a user plugin by that user only.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'deployment.job.manage',resource_type:'deployment',default_risk_level:'critical',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/deployment/operations.ts',description:"The instance administrator creates an argument-free update or check_update deployment job, or cancels a queued one. The deployer pulls the job; this request is the per-instance human approval (B43, ADR 0017).",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'notification.webhook.dispatch',resource_type:'notification_webhook',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/notifications/operations.ts',description:"Send a supported notification event to an allowlisted webhook target. The send is a durable system command performed after commit; an unconfirmed send is needs_attention, never repeated.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'host.manage',resource_type:'host',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/hosts/operations.ts',description:'Host owner (paired Host) or instance admin (built-in Host) installs, updates, rolls back or removes Runtime copies and ordinary tools, probes quota, retries provisioning, sets the provider proxy address or revokes a paired Host. Host effects are durable command intents performed after commit.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'host.workspace.register',resource_type:'project',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/hosts/operations.ts',description:'The paired Host owner with Project write access registers a directory on that Host as a Project Location through a durable Host command.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'host.account.manage',resource_type:'host',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/hosts/operations.ts',description:'A person logs out of their own ordinary CLI account on a Host they may use; the account key is derived from that person only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'agent.host_state.reset',resource_type:'agent',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/hosts/operations.ts',description:"The Agent owner (or anyone for an ownerless Agent) who owns the Host retires the Agent's vendor sessions there and archives its runtime profiles through a journaled Host command; launches on that Host wait for it.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'host.import.manage',resource_type:'workspace_location',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/importedSessions/operations.ts',description:"The paired Host owner with Project write access sets a Location's history import consent, dismisses its offer and imports history; an imported session is changed or deleted by its importer, or, while its Location exists, by that Location's Host owner with Project write.",lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'project.management.write',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projects/managementOperations.ts',description:'Human Project workspace commands retain owner, membership, version review, Decision, focus, work-report and private Notebook authority.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'experiment.command',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/experiments/operations.ts',description:'Human Experiment commands preserve Definition, version, Run, Thread and evidence permissions; managed execution commits its existing Run and Job intent.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'project.folder.command',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projectFolders/operations.ts, server/src/modules/projectFolders/ioOperations.ts',description:'Human Folder metadata, location, execution configuration and durable IO intents retain Project and Host authority. No file or Host IO executes in the core transaction.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'project.corpus.update',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projects/corpusOperations.ts',description:'Human Corpus reference and triage commands preserve current Project writer and Source/Object/Evidence permissions, provenance and domain materialization.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'research.workspace.update',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projectResearch/workspaceOperations.ts, server/src/modules/projectResearch/controlOperations.ts',description:'Maintain Research notebook/checklist, Claim links, screening, limits, checkpoints, operation repair, standing advice, integrity and Corpus rebuild under the current Project writer and referenced content permissions; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'project.summary.brief.request',resource_type:'project_public_summary',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projects/summaryBriefOperation.ts',description:'Queue a Context Brief over published public summaries the person can currently read, with optional private artifact; provider work runs in its Job; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'space.create',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/spaces/operations.ts',description:'An active person creates a household or team Space and becomes its owner; personal Spaces are created only at registration. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'space.membership.manage',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/spaces/operations.ts',description:'A non-personal Space owner or admin invites by email at no higher role than their own, held against concurrent role change; the invited active account claims membership with the hashed secret. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'space.settings.update',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/spaces/operations.ts',description:'A Space owner or admin changes snapshot defaults, member copy-out or retrieval settings under the locked membership; an embedding dimension change queues its backfill Job in the same transaction. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'runtime_context.policy.write',resource_type:'runtime_context_policy',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/policy/runtimeContextOperations.ts',description:'Activate the next immutable Runtime Context Policy version under the existing scope authority (Space owner/admin, Project/Agent owner, or the person for their own preferences), stale-base, no-widening and preference rules; the version keeps its runtime_context_policy.change decision record. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'runtime_context.work_context.update',resource_type:'work_context_setup',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/runtimeContext/operations.ts',description:'Save the next Work Context Setup version, switch a conversation\u2019s knowledge retrieval, or correct its active semantic checkpoint from the person\u2019s own canonical message, under the existing scope, reference and governing-policy checks; Setups keep their work_context_setup.change record. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.target.manage',resource_type:'evolution_target',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/operations.ts',description:'An active Space member creates or edits a Space-owned Evolution target with a supported type; system targets stay read-only and starting an Evolution Run is separate. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.signal.manage',resource_type:'evolution_signal',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/operations.ts',description:'An active Space member records an explicit signal on a target the Space can read, or triages a Space signal; triage never changes autonomous review consumption. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.asset.manage',resource_type:'evolvable_asset',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/assetOperations.ts',description:'Create an evolvable asset, create or edit a draft version, move a version forward, pin an approved version or remove a pin, under the asset owner-scope write authority and the canonical asset lock; approved and deprecated stay reachable only through the promotion Proposal. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.asset.evaluate',resource_type:'evolvable_asset',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/assetOperations.ts',description:'Create an evaluation case or record evaluation evidence for a candidate version, or queue an evaluation case run as a Job; an Evaluation Engine pass is written only by its Job. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.asset.read',resource_type:'evolvable_asset',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/assetOperations.ts',description:'Resolve an asset or prompt to its effective version, render a prompt preview, or preview a workflow extracted from the caller\u2019s own visible Run, as read-only queries. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.bundle.create',resource_type:'evolution_bundle',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/assetOperations.ts',description:'Group pending Proposals the person can see into one Evolution review bundle; deciding or rolling back the bundle stays on the canonical Proposal decision path. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'evolution.run.start',resource_type:'evolution_target',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/evolution/assetOperations.ts',description:'Select a strategy for a runnable target and queue its dry-run Evolution Run with the agent_run Job intent in one transaction; the Run executes in that Job. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'prompt.deployment.manage',resource_type:'evolvable_asset',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/prompts/operations.ts',description:'Point a prompt label at a version, or roll a deployment back, under the asset lock; production needs an accepted promotion Proposal or a version with a passed evaluation. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading_method.manage',resource_type:'evolvable_asset',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/prompts/reading/operations.ts',description:'Initialize the Reading methods, save a method draft or a Source-authorized sample, or judge a completed comparison, under the method asset lock and Project audience. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading_method.execute',resource_type:'evolvable_asset',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/prompts/reading/operations.ts',description:'Start or cancel a bounded Reading method generation or comparison; the Run and Job intent commit together, provider or Agent work runs in the Job, and an Agent process stops after commit. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'runtime_context.policy.read',resource_type:'runtime_context_policy',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/policy/runtimeContextOperations.ts',description:'Resolve the effective Runtime Context Policy over scopes the person can read, as a read-only query. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'runtime_context.preview.request',resource_type:'work_context_setup',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/runtimeContext/previewRequests.ts',description:'Queue a turn Runtime Context preview over a readable Work Context; acquisition and its read audit run in a single-attempt Job and the owning reader releases the envelope under current access. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'content.access.manage',resource_type:'content',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/contentAccess/operations.ts',description:'The content owner, or a Space owner or admin, changes visibility and grants; narrowing needs the owner\u2019s current exposure disclosure, Memory changes go through the canonical applier and tainted widening needs owner review. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.composition.retry',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/composition/operations.ts',description:'A current Project writer retries only failed composition of the existing complete analysis cohort, queuing canonical composition Jobs atomically; no new analysis or model Run. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.annotation.retry',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sourceAnnotation/operations.ts',description:'Reopen the caller’s eligible Source annotation failure episodes under current Source access and recovery conditions, with mandatory existing annotation Job in the same transaction. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.deep_read.start',resource_type:'source_item',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sources/deepReading/operations.ts',description:'Start a private investigation using the caller’s owned execution and current Project, Source, original and Following-purpose authority. Canonical queued Run and Job intent; no external IO in command transaction. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.deep_read.cancel',resource_type:'run',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sources/deepReading/operations.ts',description:'Cancel the caller’s exact private deep-reading Run, including after input or Project access is withdrawn; canonical Host acknowledgement and settlement remain required. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'briefing.project.request',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/briefing/operations.ts',description:'Preserve the historical Project generation refusal after current Project read and writer authorization. No new Run or Job.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  ...(['daily_capture.run','capture.relocate','activity.summary.request','activity.upload','activity.create','capture.create','activity.review','activity.archive','activity.consolidate','daily_capture.settings.patch','daily_capture.settings.set'] as const).map(action=>({action,resource_type:'space' as const,default_risk_level:'low' as const,default_decision:'allow' as const,audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:action==='daily_capture.run'?'server/src/modules/dailyReports/runOperation.ts':action==='capture.relocate'?'server/src/modules/capture/relocationOperation.ts':action==='activity.summary.request'?'server/src/modules/activity/summaryOperation.ts':action==='capture.create'?'server/src/modules/capture/createOperation.ts':action==='activity.upload'?'server/src/modules/activity/uploadOperation.ts':action==='activity.create'?'server/src/modules/activity/createOperation.ts':action.startsWith('activity.')?'server/src/modules/activity/operations.ts':'server/src/modules/dailyReports/operations.ts',description:'Update the currently authorized Activity status or the requesting person’s daily capture report settings through its canonical owner.',lifecycle_status:'wired_direct' as const,record_failure_mode:'fail_closed' as const})),
  ...(['briefing.personal.follow_up','briefing.project.follow_up','briefing.personal.adoption.preview','briefing.project.adoption.preview','briefing.personal.adoption.confirm','briefing.project.adoption.confirm'] as const).map(action=>({action,resource_type:'space' as const,default_risk_level:'low' as const,default_decision:'allow' as const,audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/briefing/highlightOperations.ts',description:'Preview or adopt a currently authorized briefing highlight through its canonical scope and Task owners.',lifecycle_status:'wired_direct' as const,record_failure_mode:'fail_closed' as const})),
  ...(['digest.personal.backfill','digest.project.backfill'] as const).map(action=>({action,resource_type:'space' as const,default_risk_level:'low' as const,default_decision:'allow' as const,audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/backfillOperations.ts',description:'Queue one deterministic digest backfill under current scope and Source authority.',lifecycle_status:'wired_direct' as const,record_failure_mode:'fail_closed' as const})),
  {action:'briefing.personal.request',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/briefing/requestOperation.ts',description:'Request an owner-private briefing through the canonical Run and Job owner.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  ...(['briefing.personal.cancel','briefing.project.cancel'] as const).map(action=>({action,resource_type:'run' as const,default_risk_level:'low' as const,default_decision:'allow' as const,audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/briefing/operations.ts',description:'Record cancellation of the exact current briefing attempt under current scope writer authority. Host acknowledgement and canonical settlement remain required.',lifecycle_status:'wired_direct' as const,record_failure_mode:'fail_closed' as const})),
  ...(['briefing.personal.settings.set','briefing.project.settings.set'] as const).map(action=>({action,resource_type:'space' as const,default_risk_level:'low' as const,default_decision:'allow' as const,audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/briefing/settingsOperations.ts',description:'Change the caller daily briefing configuration under canonical scope authority.',lifecycle_status:'wired_direct' as const,record_failure_mode:'fail_closed' as const})),
  {action:'digest.serendipity.feedback',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/feedbackOperations.ts',description:'Owner-private serendipity cooldown and blocklist feedback; never writes interest facts or Memory.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'focus_area.write',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/focusAreas/operations.ts',description:'Human classification commands under current Space and canonical object owner/read authority; classification grants no reach.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'learning.write',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/learning/operations.ts',description:'Create learning material under current Project writer and Knowledge read authority, or record caller-private mastery under Project read authority.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'graph.view_state.write',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/graph/operations.ts',description:'Save caller-private graph navigation state in the current Space. No graph content, Project or Memory writes.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'interest.profile.write',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/interestProfile/operations.ts',description:'Explicit owner-only profile settings and topic decisions. Human API only; no Agent activation or Memory writes.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.preference.write',resource_type:'project',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/readingOperations.ts',description:'Set the caller’s private Project Reading opt-in under current Project read authority; no shared content, generation or spending. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reading.item_state.write',resource_type:'source_item',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/informationDigest/readingOperations.ts',description:'Set the caller’s private Reading favorite or item/topic-change state under current Project and Source authority; no shared content, generation or spending. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'reader.write',resource_type:'reader_document',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/reader/operations.ts',description:'Personal Reader annotation, comment, reading position, appearance and document-note commands retain live document and provenance authority. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'knowledge.retrieval.request',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/contentRequests.ts',description:'Queue a knowledge search or Context Brief over content the person can read; provider embedding, rewrite, rerank and synthesis run in its single-attempt Job, and results are released only by the owning result reader under current access; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'memory.retrieval.request',resource_type:'space',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/contentRequests.ts',description:'Queue a memory search or Context Brief over content the person can read; provider embedding, rewrite, rerank and synthesis run in its single-attempt Job, and results are released only by the owning result reader under current access; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'source.retrieval.request',resource_type:'source_item',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sources/retrievalOperations.ts',description:'Queue a Source search or Context Brief over Source items and evidence the person can read; provider embedding, rewrite, rerank and synthesis run in its single-attempt Job, and results are released only by the Source result reader under current access; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'source.retrieval.reindex',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/sources/retrievalOperations.ts',description:'Rebuild the Space Source retrieval projection and queue its embedding backfill Job in one transaction; Space owner or admin only; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'knowledge.retrieval.feedback',resource_type:'knowledge_item',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/feedbackReindexOperations.ts',description:'Record private retrieval feedback on a Knowledge search result the person can currently read; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'knowledge.retrieval.reindex',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/feedbackReindexOperations.ts',description:'Rebuild the Space Knowledge retrieval projection and queue its embedding backfill Job in one transaction; Space owner or admin only; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'memory.own.status',resource_type:'memory_entry',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/memory/humanOperations.ts',description:'Archive, restore or undo a revision of a memory entry the person owns, through the canonical Memory applier as a new version (ADR 0003 \u00a73); anyone else\u2019s entry is a proposal. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'memory.proposal.revise',resource_type:'proposal',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/memory/humanOperations.ts',description:'Write the revision a pending maintenance memory update asked for, by the person who decides that entry; accepting stays a separate proposal decision. Human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'memory.retrieval.feedback',resource_type:'memory_entry',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/feedbackReindexOperations.ts',description:'Record private retrieval feedback on a Memory search result the person can currently read, with its owner-only read statistics; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'memory.retrieval.reindex',resource_type:'space',default_risk_level:'medium',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/retrieval/feedbackReindexOperations.ts',description:'Rebuild the Space Memory retrieval projection and queue its embedding backfill Job in one transaction; Space owner or admin only; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:'project.summary.feedback',resource_type:'project_public_summary',default_risk_level:'low',default_decision:'allow',audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:'server/src/modules/projects/ingressOperations.ts',description:'Record private retrieval feedback on a public summary the person can currently read; human API only.',lifecycle_status:'wired_direct',record_failure_mode:'fail_closed'},
  {action:"research.result.read",resource_type:"project_operation",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read a bound research result with Thread, Run, Source and Artifact permissions.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort"},
  {action:"research.result.adopt",resource_type:"project_operation",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectResearch/agentResearchOperations.ts, server/src/modules/projectResearch/controlOperations.ts",description:"Explicitly assess research result applicability in current Inquiry Verify; unattended origin requires approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed"},
  {
    // Direct execution, no proposal gate: the Inquiry Thread was already
    // human-accepted at creation, so starting acquisition on it is execution,
    // not the agent-drafted structure/content write ADR 0003 gates. Idempotency
    // guards in the acquisition service are the confirmation.
    action: "research.acquisition.start",
    resource_type: "inquiry_thread",
    default_risk_level: "medium",
    default_decision: "allow",
    audit_required: true,
    approval_capability: null,
    default_required_approver_role: null,
    current_enforcement_point: "server/src/modules/projectResearch/agentResearchOperations.ts, server/src/modules/projectResearch/controlOperations.ts, server/src/modules/projectResearch/pipeline/researchAcquisitionService.ts",
    description:
      "Start a bound background research invocation for an accepted Inquiry Thread: optional Frame assessment, bounded query planning, strategy activation and initial intake.",
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
    action:'personal.retrieval.manage',resource_type:'personal_retrieval',
    default_risk_level:'high',default_decision:'allow',audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:'server/src/modules/crossSpaceRetrieval/operations.ts',
    description:'Personal retrieval under each current source authority and explicit disclosure.',
    lifecycle_status:'wired_direct',record_failure_mode:'fail_closed',
  },
  {
    action:"attention.read_state.manage",resource_type:"attention",
    default_risk_level:"low",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/agentAttention/operations.ts",
    description:"Record only the active person's own attention decisions under current source authority.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action:"plugin_data_grant.manage",resource_type:"plugin_data_grant",
    default_risk_level:"high",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/plugins/dataGrantOperations.ts",
    description:"The data owner (sensitive) or Space owner (personal) grants or revokes bounded Agent plugin data consent; never a requester or administrator substitute.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action:"official_plugin.project_binding.manage",resource_type:"project",
    default_risk_level:"medium",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/plugins/projectBindingOperations.ts",
    description:"A Project owner-level person binds a Project plugin enabled for them to an active Project, or unbinds it (also while archived or disabled); unbinding keeps the plugin's data and stops every entry for that Project.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action:"official_plugin.project_binding.view",resource_type:"project",
    default_risk_level:"low",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/plugins/projectBindingOperations.ts",
    description:"A Project reader lists which Project plugins are bound to it and whether each is effective for them.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action:"agent_data_read.view",resource_type:"agent_data_read",
    default_risk_level:"low",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/plugins/dataGrantOperations.ts",
    description:"The owner reads the content-free record of Agent reads made on their behalf.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action:"artifact.plugin_create",resource_type:"project",
    default_risk_level:"medium",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/plugins/corePorts.ts",
    description:"A plugin command creates a private inline Artifact in a Project the person writes, through the canonical Artifact writer; an Agent only in its Run's Project from a person's own turn, never after a sensitive plugin read.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action: "personal_memory_grant.manage",resource_type:"personal_memory_grant",
    default_risk_level:"high",default_decision:"allow",audit_required:true,
    approval_capability:null,default_required_approver_role:null,
    current_enforcement_point:"server/src/modules/personalMemoryGrants/operations.ts",
    description:"Human owner manages a bounded summary-only personal grant; target authority checked independently.",
    lifecycle_status:"wired_direct",record_failure_mode:"fail_closed",
  },
  {
    action: "policy.action_grant.create",
    resource_type: "action_approval_grant",
    default_risk_level: "high",
    default_decision: "allow",
    audit_required: true,
    approval_capability: "manage_action_grants",
    default_required_approver_role: "owner",
    current_enforcement_point: "server/src/modules/policy/actionGrantOperations.ts; server/src/modules/policy/authorizationRequestService.ts",
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
    current_enforcement_point: "server/src/modules/proposals/applyService.ts via source_channel_activation",
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
    current_enforcement_point: "server/src/modules/policy/actionGrantOperations.ts",
    description: "Revoke an active action pre-authorization grant.",
    lifecycle_status: "wired_direct",
    record_failure_mode: "fail_closed",
  },
  { action:"source.subscription.manage",resource_type:"source_channel",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/sources/sourceSubscriptionOperations.ts",description:"Authenticated people decide their own existing Source recommendations or subscription preferences; no Source configuration, content-access grant or Agent authority is conferred.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"source.backfill.plan",resource_type:"source_backfill_plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/sources/sourceBackfillOperations.ts",description:"Preview or create a bounded Source history import plan.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"source.backfill.start",resource_type:"source_backfill_plan",default_risk_level:"high",default_decision:"require_approval",audit_required:true,approval_capability:"approve_source_backfill",default_required_approver_role:"owner",current_enforcement_point:"server/src/modules/sources/sourceBackfillProposalApplier.ts",description:"Start an approved quota-controlled Source history import.",lifecycle_status:"wired_via_proposal",record_failure_mode:"fail_closed" },
  { action:"source.backfill.manage",resource_type:"source_backfill_plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/sources/sourceBackfillOperations.ts",description:"Pause or resume a Source history import plan.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.plan.propose",resource_type:"plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Submit an Agent-generated execution Plan for a source Task.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"project.brief.propose",resource_type:"project_brief_version",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Propose a formal Project goal or core problem for owner review.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's Tasks (ids, titles, status) so an Agent can address one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"proposal.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read a conversation's pending Proposals (ids and titles) so an Agent can decide one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"research.operation.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's research Operations (ids and status) so an Agent can cancel one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"memory.write",resource_type:"memory_entry",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"An Agent's own bounded memory write: private, normal-sensitivity, about the acting person, always a new version with provenance. Allowed from a person's turn; an unattended origin requires approval, and any write that widens reach becomes a proposal whatever the origin.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.thread.list",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read the Project's active Inquiry Threads (ids and statements) so an Agent can address one exactly.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },

  { action:"inquiry.problem.read",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read a bounded page of authorized problem work and close-out history.",lifecycle_status:"wired_direct",record_failure_mode:"best_effort" },
  { action:"inquiry.work.record",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Record versioned problem work. Manual origin under bounds; unattended origin requires approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.round.close",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Close a problem round with Updates and compensating undo. Manual origin under bounds; unattended origin requires approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.iteration.record",resource_type:"inquiry_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Record an Inquiry Thread conclusion. Allowed when a person asked for it in the turn; an autonomous origin requires approval. Every Iteration keeps the position it replaced, so the Project's updates can revert it.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"inquiry.knowledge.promote",resource_type:"knowledge_promotion_candidate",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Propose promoting a concluded Inquiry round to a Knowledge Item.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.create",resource_type:"project",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/tasks/operations.ts",description:"Create a Project Task. Allowed when a person asked for it in the turn; an autonomous origin requires approval, because a Task nobody asked for is a commitment made on the Project's behalf.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"proposal.decide",resource_type:"proposal",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Accept or reject, on the instructing person's word in their own turn, a proposal a Run of the same conversation created. Refused on any other origin: an Agent never decides for itself, it carries the decision.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.report",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Append a readable account of what was done and concluded. Append-only, and the only way an Agent advancing work outside a conversation can say anything at all.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.handoff",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Transfer responsibility for a Task, or release it. Self-limiting: it can only give work away.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.evaluation.record",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/tasks/operations.ts",description:"A person records a Task evaluation; the newest evaluation decides the close gate, so it requires Project write access and readable linked evidence.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.run.start",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/tasks/operations.ts",description:"A person queues a Task execution or planning Run through the Run owner, under Project write access, Task budgets and the Location/Host owner gate.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"board.manage",resource_type:"board",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/tasks/operations.ts",description:"A person creates or edits a Board in their Personal Space or a Project they write; changes that can select another active Project Board carry the current columns revision.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"plan.execute",resource_type:"plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/plans/operations.ts",description:"A Project writer who can read the source Task starts an approved Plan: coordinator and node Runs, Job intents and checkpoint Proposals commit together.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"plan.reconcile",resource_type:"plan",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/plans/operations.ts",description:"A Space owner or admin with Project write access reconciles a running Plan through the same domain function as recovery.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"job.cancel",resource_type:"job",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/jobs/operations.ts",description:"The requesting person cancels their own pending or claimed Job; a Run-backed Job ends its Run in the same transaction.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"board.read",resource_type:"project",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Read Project columns and their lifecycle meanings.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"board.configure",resource_type:"project",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/boardOperations.ts",description:"Configure Project columns; unattended changes require approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.column.move",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/boardOperations.ts",description:"Move a Task to a column; unattended moves require approval and completion gates remain.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.delete",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Delete a Task on the instructing person’s behalf, retaining execution and audit evidence. Unattended deletion requires approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.content.update",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/tasks/operations.ts",description:"Edit an existing Task or subtask (task.update). A person edits the contract under full Task access and the writer role of its current and destination Project; an Agent edits only title and description in its Run's Project. Status, placement and deletion keep their named commands. Unattended edits require approval.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.status.set",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Change a Task's board status. Unattended status changes require approval; completion and review retain their existing gates.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"artifact.declare",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Declare that a file this Run leaves behind is a Task's output, evidence, or draft. Append-only: it records what a file is, never its content, and cannot take ground — which is why it is ungated at any origin, like task.report.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.complete",resource_type:"task",default_risk_level:"medium",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Say a Task's work is finished. An autonomous origin requires approval: closing is a commitment about the work, not a report of it. It passes the same completion contract a manual close does and cannot override one.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"handoff.write",resource_type:"host_thread",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/systemActions/systemActionDispatcher.ts",description:"Write the handoff an Agent's next vendor session starts from, before Rainver rotates a session that has filled most of its context window. Self-limiting: it writes one Artifact on the Agent's own Conversation thread and touches nothing else, which is why it is ungated at any origin.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
  { action:"task.request_review",resource_type:"task",default_risk_level:"low",default_decision:"allow",audit_required:true,approval_capability:null,default_required_approver_role:null,current_enforcement_point:"server/src/modules/projectWork/taskLifecycleOperations.ts",description:"Stop work and ask a person to decide. Self-limiting: it can only halt, never proceed.",lifecycle_status:"wired_direct",record_failure_mode:"fail_closed" },
] as const satisfies readonly PolicyActionDefinition[];

export type PolicyActionId = (typeof POLICY_ACTION_REGISTRY)[number]["action"];

// ---------------------------------------------------------------------------
// Enforcement request (PolicyCheckRequest)
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
// Decision result (PolicyDecision)
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
// Durable audit envelope (PolicyAuditEnvelope)
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
// Error taxonomy (PolicyGateBlocked / PolicyAuditPersistError)
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
