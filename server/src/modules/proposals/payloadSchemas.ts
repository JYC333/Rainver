import { z } from "zod";
import {
  SOURCE_CAPTURE_POLICIES,
  SOURCE_RETENTION_POLICIES,
} from "../sources/capturePolicy";

// Base for every proposal payload: at minimum a literal proposal_type.
// All schemas use .passthrough() so unknown optional fields from agents are tolerated.

const memoryCreate = z
  .object({ proposal_type: z.literal("memory_create") })
  .passthrough();

const memoryUpdate = z
  .object({
    proposal_type: z.literal("memory_update"),
    target_memory_id: z.string().min(1),
  })
  .passthrough();

const memoryArchive = z
  .object({
    proposal_type: z.literal("memory_archive"),
    target_memory_id: z.string().min(1),
  })
  .passthrough();

const policyChange = z
  .object({ proposal_type: z.literal("policy_change") })
  .passthrough();

const skillImportApprove = z
  .object({ proposal_type: z.literal("skill_import_approve") })
  .passthrough();

const capabilityInstall = z
  .object({ proposal_type: z.literal("capability_install") })
  .passthrough();

const capabilityUpdate = z
  .object({ proposal_type: z.literal("capability_update") })
  .passthrough();

const capabilityEnable = z
  .object({ proposal_type: z.literal("capability_enable") })
  .passthrough();

const capabilityDisable = z
  .object({ proposal_type: z.literal("capability_disable") })
  .passthrough();

const runtimeSkillBindingUpdate = z
  .object({ proposal_type: z.literal("runtime_skill_binding_update") })
  .passthrough();

const knowledgeCreate = z
  .object({
    proposal_type: z.literal("knowledge_create"),
    knowledge_kind: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
  })
  .passthrough();

const knowledgeUpdate = z
  .object({
    proposal_type: z.literal("knowledge_update"),
    target_item_id: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
  })
  .passthrough();

const knowledgeArchive = z
  .object({
    proposal_type: z.literal("knowledge_archive"),
    target_item_id: z.string().min(1),
  })
  .passthrough();

const claimCreate = z
  .object({
    proposal_type: z.literal("claim_create"),
    claim_kind: z.string().min(1),
    claim_text: z.string().min(1),
  })
  .passthrough();

const claimUpdate = z
  .object({
    proposal_type: z.literal("claim_update"),
    target_claim_id: z.string().min(1),
  })
  .passthrough();

const claimArchive = z
  .object({
    proposal_type: z.literal("claim_archive"),
    target_claim_id: z.string().min(1),
  })
  .passthrough();

const objectRelationCreate = z
  .object({
    proposal_type: z.literal("object_relation_create"),
    from_object_id: z.string().min(1),
    to_object_id: z.string().min(1),
    link_type: z.string().min(1),
  })
  .passthrough();

const objectRelationDelete = z
  .object({
    proposal_type: z.literal("object_relation_delete"),
    relation_id: z.string().min(1),
  })
  .passthrough();

const objectProfileCreate = z
  .object({
    proposal_type: z.literal("object_profile_create"),
    key: z.string().min(1),
    label: z.string().min(1),
    base_object_type: z.string().min(1),
  })
  .passthrough();

const objectProfileUpdate = z
  .object({
    proposal_type: z.literal("object_profile_update"),
    target_profile_id: z.string().min(1),
  })
  .passthrough();

const objectProfileDeprecate = z
  .object({
    proposal_type: z.literal("object_profile_deprecate"),
    target_profile_id: z.string().min(1),
  })
  .passthrough();

const objectProfileArchive = z
  .object({
    proposal_type: z.literal("object_profile_archive"),
    target_profile_id: z.string().min(1),
  })
  .passthrough();

const followUpTask = z
  .object({ proposal_type: z.literal("follow_up_task") })
  .passthrough();

const planReview = z
  .object({
    proposal_type: z.literal("plan_review"),
    plan_id: z.string().min(1),
    plan_version_id: z.string().min(1),
  })
  .passthrough();

const planCheckpoint = z
  .object({
    proposal_type: z.literal("plan_checkpoint"),
    plan_id: z.string().min(1),
    plan_version_id: z.string().min(1),
    node_id: z.string().min(1),
  })
  .passthrough();

const workflowExecutionCheckpoint = z
  .object({
    proposal_type: z.literal("workflow_execution_checkpoint"),
    workflow_execution_id: z.string().min(1),
    node_id: z.string().min(1),
    automation_id: z.string().min(1).optional(),
  })
  .passthrough();

const codePatch = z
  .object({ proposal_type: z.literal("code_patch") })
  .passthrough();

const claimCandidatePacket = z
  .object({ proposal_type: z.literal("claim_candidate_packet") })
  .passthrough();

const relationDiscoveryPacket = z
  .object({ proposal_type: z.literal("relation_discovery_packet") })
  .passthrough();

const retrievalDiagnosticsPacket = z
  .object({ proposal_type: z.literal("retrieval_diagnostics_packet") })
  .passthrough();

const retrievalMaintenancePacket = z
  .object({ proposal_type: z.literal("retrieval_maintenance_packet") })
  .passthrough();

const memoryMaintenancePacket = z
  .object({ proposal_type: z.literal("memory_maintenance_packet") })
  .passthrough();

const customSourcePolicyEnvelope = z
  .object({
    allowed_network_origins: z.array(z.string()),
    capture_policy: z.enum(SOURCE_CAPTURE_POLICIES),
    retention_policy: z.enum(SOURCE_RETENTION_POLICIES),
    credential_ref: z.string().nullish(),
    language: z.enum(["typescript_node", "declarative_pipeline_v1"]),
    browser_automation_enabled: z.boolean().default(false),
    shell_enabled: z.boolean().default(false),
    dependency_installation_enabled: z.boolean().default(false),
    log_redaction_enabled: z.boolean().default(true),
    limits: z
      .object({
        timeout_ms: z.number().int().positive(),
        max_download_bytes: z.number().int().positive(),
        max_output_bytes: z.number().int().positive(),
        max_files: z.number().int().positive(),
        max_items: z.number().int().positive(),
        max_evidence_items: z.number().int().positive(),
        log_max_bytes: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough();

const customSourcePolicyDelta = z
  .object({
    proposal_type: z.literal("custom_source_policy_delta"),
    source_connection_id: z.string().min(1),
    handler_version_id: z.string().min(1),
    current_handler_version_id: z.string().min(1).nullable(),
    current_policy_envelope_json: customSourcePolicyEnvelope.nullable(),
    proposed_policy_envelope_json: customSourcePolicyEnvelope,
    envelope_diff_json: z.record(z.unknown()),
  })
  .passthrough();

const customSourceCredentialedSource = z
  .object({
    proposal_type: z.literal("custom_source_credentialed_source"),
    source_connection_id: z.string().min(1),
    handler_version_id: z.string().min(1),
    current_handler_version_id: z.string().min(1).nullable(),
    current_policy_envelope_json: customSourcePolicyEnvelope.nullable(),
    proposed_policy_envelope_json: customSourcePolicyEnvelope,
    credential_scope_json: z.record(z.unknown()),
    requested_by_user_id: z.string().min(1),
  })
  .passthrough();

// Shared Level 2 recipe envelope (SourcePolicyEnvelopeSchema subset): no
// language/browser/shell/dependency fields — those are structurally
// impossible for the in-process recipe interpreter.
const sourceRecipePolicyEnvelope = z
  .object({
    allowed_network_origins: z.array(z.string()),
    capture_policy: z.enum(SOURCE_CAPTURE_POLICIES),
    retention_policy: z.enum(SOURCE_RETENTION_POLICIES),
    credential_ref: z.string().nullish(),
    log_redaction_enabled: z.boolean().default(true),
    limits: z
      .object({
        timeout_ms: z.number().int().positive(),
        max_download_bytes: z.number().int().positive(),
        max_output_bytes: z.number().int().positive(),
        max_files: z.number().int().positive(),
        max_items: z.number().int().positive(),
        max_evidence_items: z.number().int().positive(),
        log_max_bytes: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough();

const sourceRecipeActivation = z
  .object({
    proposal_type: z.literal("source_recipe_activation"),
    source_connection_id: z.string().min(1),
    recipe_version_id: z.string().min(1),
    current_recipe_version_id: z.string().min(1).nullable(),
    current_policy_envelope_json: sourceRecipePolicyEnvelope.nullable(),
    proposed_policy_envelope_json: sourceRecipePolicyEnvelope,
    envelope_diff_json: z.record(z.unknown()),
    requested_by_user_id: z.string().min(1),
  })
  .passthrough();

const customSourceRepairActivation = z
  .object({
    proposal_type: z.literal("custom_source_repair_activation"),
    source_connection_id: z.string().min(1),
    previous_handler_version_id: z.string().min(1),
    new_handler_version_id: z.string().min(1),
    envelope_unchanged: z.boolean(),
    fixture_comparison_json: z.record(z.unknown()),
  })
  .passthrough();

const sourceChannelActivation = z.object({
  proposal_type: z.literal("source_channel_activation"),
  source_channel_id: z.string().min(1),
  draft_updated_at: z.string().min(1),
  action_id: z.literal("source.channel.propose_activation"),
}).passthrough();

const projectSourceBind = z.object({
  proposal_type: z.literal("project_source_bind"),
  project_id: z.string().min(1),
  source_channel_id: z.string().min(1),
  action_id: z.literal("project.source.propose_bind"),
}).passthrough();
const sourceBackfillStart = z.object({ proposal_type:z.literal("source_backfill_start"),action_id:z.literal("source.backfill.propose_start"),source_channel_id:z.string().min(1),source_backfill_plan_id:z.string().min(1),strategy_json:z.record(z.unknown()),quota_policy_json:z.record(z.unknown()) }).passthrough();

const researchQueryStrategyActivation = z.object({
  proposal_type: z.literal("research_query_strategy_activation"),
  project_id: z.string().uuid(),
  source_strategy_id: z.string().uuid(),
  candidate_strategy_id: z.string().uuid(),
  direction: z.enum(["broaden", "narrow"]),
  observation_count: z.number().int().min(3),
  metrics: z.record(z.unknown()),
}).passthrough();

const evolvableAssetVersionPromote = z
  .object({
    proposal_type: z.literal("evolvable_asset_version_promote"),
    asset_id: z.string().min(1),
    candidate_version_id: z.string().min(1),
    target_scope_type: z.enum(["project", "space", "system", "user", "agent"]),
    target_scope_id: z.string().min(1).nullable().optional(),
    pin_after_approval: z.boolean().optional(),
    deprecate_previous: z.boolean().optional(),
    evaluation_run_ids: z.array(z.string().min(1)).optional(),
    reason: z.string().nullable().optional(),
    deployment_label: z.string().min(1).nullable().optional(),
  })
  .passthrough();

const workflowSave = z
  .object({
    proposal_type: z.literal("workflow_save"),
    asset_key: z.string().min(1).max(160),
    display_name: z.string().min(1).max(512),
    description: z.string().max(2048),
    content_json: z.record(z.unknown()),
    content_hash: z.string().min(1).max(128),
  })
  .passthrough();

const evolutionBundleRollback = z
  .object({
    proposal_type: z.literal("evolution_bundle_rollback"),
    bundle_id: z.string().min(1),
  })
  .passthrough();

const egressReview = z.object({
  proposal_type: z.literal("egress_review"),
  target_resource_type: z.string().min(1),
  target_resource_id: z.string().min(1),
  requested_visibility: z.literal("space_shared"),
  requested_access_level: z.enum(["full", "summary"]),
  requested_project_id: z.string().min(1).nullable(),
  requested_grants: z.array(z.object({
    user_id: z.string().min(1),
    access_level: z.enum(["full", "summary"]),
  })),
  required_egress_approver_user_ids: z.array(z.string().min(1)).min(1),
}).passthrough();

export const ProposalPayloadSchema = z.discriminatedUnion("proposal_type", [
  memoryCreate,
  memoryUpdate,
  memoryArchive,
  policyChange,
  skillImportApprove,
  capabilityInstall,
  capabilityUpdate,
  capabilityEnable,
  capabilityDisable,
  runtimeSkillBindingUpdate,
  knowledgeCreate,
  knowledgeUpdate,
  knowledgeArchive,
  claimCreate,
  claimUpdate,
  claimArchive,
  objectRelationCreate,
  objectRelationDelete,
  objectProfileCreate,
  objectProfileUpdate,
  objectProfileDeprecate,
  objectProfileArchive,
  followUpTask,
  planReview,
  planCheckpoint,
  workflowExecutionCheckpoint,
  codePatch,
  claimCandidatePacket,
  relationDiscoveryPacket,
  retrievalDiagnosticsPacket,
  retrievalMaintenancePacket,
  memoryMaintenancePacket,
  customSourcePolicyDelta,
  customSourceCredentialedSource,
  customSourceRepairActivation,
  sourceChannelActivation,
  projectSourceBind,
  sourceBackfillStart,
  researchQueryStrategyActivation,
  sourceRecipeActivation,
  evolvableAssetVersionPromote,
  workflowSave,
  evolutionBundleRollback,
  egressReview,
]);

export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export class ProposalPayloadValidationError extends Error {
  readonly statusCode = 422;
  constructor(
    readonly proposalType: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `proposal payload validation failed for type ${JSON.stringify(proposalType)}: ` +
        issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    this.name = "ProposalPayloadValidationError";
  }
}

export function validateProposalPayload(
  proposalType: string,
  payload: Record<string, unknown> | null,
): void {
  const raw = { ...(payload ?? {}), proposal_type: proposalType };
  const result = ProposalPayloadSchema.safeParse(raw);
  if (!result.success) {
    throw new ProposalPayloadValidationError(proposalType, result.error.issues);
  }
}
