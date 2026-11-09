import {RESEARCH_EXECUTION_SCHEMAS} from './researchExecutionOperations.js';
import {ResearchAdhocInputSchema,ResearchAdhocReceiptSchema} from './researchAdhocOperation.js';
import {PROJECT_SOURCE_PROPOSAL_SCHEMAS} from './projectSourceProposalOperations.js';
import {PROJECT_CORPUS_SCHEMAS} from './projectCorpusOperations.js';
import {INQUIRY_AGENT_OPERATION_SCHEMAS} from './inquiryAgentOperations.js';
import {PROJECT_FOLDER_SCHEMAS} from './projectFolderOperations.js';
import {PROJECT_FOLDER_IO_SCHEMAS} from './projectFolderIoOperations.js';
import {PROJECT_INGRESS_SCHEMAS} from './projectIngressOperations.js';
import {PROJECT_EXECUTION_SCHEMAS} from './projectExecutionOperations.js';
import {PROJECT_MANAGEMENT_SCHEMAS} from './projectManagementOperations.js';
import {INQUIRY_OPERATION_SCHEMAS} from './inquiryOperations.js';
import {RESEARCH_WORKSPACE_SCHEMAS} from './researchWorkspaceOperations.js';
import {KnowledgeExtractionInputSchema,KnowledgeExtractionReceiptSchema} from './knowledgeExtractionOperation.js';
import {WorkspaceVerificationGetInputSchema,WorkspaceVerificationConfigureInputSchema,WorkspaceVerificationViewSchema,WorkspaceChangeStatusSchema,WorkspaceChangeGetInputSchema,WorkspaceChangeCompleteInputSchema,WorkspaceChangeReceiptSchema,WorkspaceIntegrationRetryInputSchema,WorkspaceChangeAbandonInputSchema,WorkspaceRetentionUpdateInputSchema,WorkspaceRetentionReceiptSchema} from "./executionWorkspaces.js";
import {KNOWLEDGE_REVIEW_SCHEMAS} from './knowledgeReviewOperations.js';
import {KNOWLEDGE_OBJECT_SCHEMAS} from './knowledgeObjectOperations.js';
import {NOTE_OBJECT_SCHEMAS} from './noteObjectOperations.js';
import {SourceProcessingCreateSchema,SourceProcessingUpdateSchema,SourceProcessingDispatchSchema,SourceExtractionDispatchSchema,SourceProcessingRuleSchema,SourceDispatchReceiptSchema} from './sourceProcessingOperations.js';
import {SourceChannelCreateInputSchema,SourceChannelCreateOutputSchema} from './sourceChannelCreateOperation.js';
import {NoteControlTargetSchema,NoteRollbackInputSchema,NoteControlReceiptSchema} from './noteControlOperations.js';
import {SourceMonitorTargetSchema,SourceMonitorUpdateSchema,SourceMonitorOutputSchema,SourceMonitorScanOutputSchema} from './sourceMonitorOperations.js';
import {SourceRecipeCreateInputSchema,SourceRecipeCreateOutputSchema} from './sourceRecipeOperations.js';
import {SourceSubscriptionInputSchema,SourceRecommendationInputSchema,SourceSubscriptionOutputSchema} from './sourceSubscriptionOperations.js';
import {ProjectSourceBindInputSchema,ProjectSourceTargetSchema,ProjectSourceUpdateInputSchema,ProjectSourceBackfillOutputSchema,ProjectSourceBindingOutputSchema,ProjectSourceUnbindOutputSchema} from './projectSourceOperations.js';
import {InquiryThreadCreateInputSchema,InquiryThreadCreateReceiptSchema,NoteQuestionInputSchema,NoteQuestionReceiptSchema} from './inquiryCreationOperations.js';
import {TaskReportInputSchema,TaskCompleteInputSchema,TaskReviewInputSchema,TaskHandoffInputSchema,TaskStatusInputSchema,TaskDeleteInputSchema,TaskStatusOutputSchema,TaskReportOutputSchema,TaskCompleteOutputSchema,TaskHandoffOutputSchema,TaskDeleteOutputSchema} from './taskLifecycle.js';
import {BoardConfigurationInputSchema, BoardColumnSelectionSchema, TaskCompletionOverrideSchema, ProjectBoardColumnSchema, TASK_STATUSES} from './projectWork.js';
import { IdSchema } from './common.js';
import { z } from 'zod';
import {TaskSpacePlacementInputSchema,TaskSpacePlacementOutputSchema} from './taskSpacePlacement.js';
import {SourceBackfillPreviewInputSchema,SourceBackfillCreateInputSchema,SourceBackfillControlInputSchema,SourceBackfillPreviewOutputSchema,SourceBackfillReceiptSchema} from './sourceBackfillOperations.js';
export const OperationActorSchema = z.object({
  principal: z.object({
    kind: z.enum(['user', 'agent', 'automation', 'system']),
    id: z.string().min(1)
  }).strict(),
  on_behalf_of_user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  origin: z.enum(['manual', 'scheduled', 'delegated', 'continuation', 'system_event']),
  effective_origin: z.string(),
  root_run_id: z.string().nullable(),
  continuation_hops: z.number().int().nonnegative(),
  surface: z.enum(['web', 'public_api', 'agent_tool', 'external_mcp', 'system_job']),
  space_id: z.string().min(1)
}).strict();
export type OperationActor = z.infer<typeof OperationActorSchema>;
export const OPERATION_ERROR_CODES = ['authentication_required', 'operation_not_found', 'operation_version_unsupported', 'operation_invalid_input', 'idempotency_key_required', 'idempotency_key_reused', 'idempotency_in_progress', 'operation_approval_mapping_unavailable', 'operation_approval_state_inconsistent', 'operation_approval_rejected', 'operation_approval_expired', 'operation_approval_superseded', 'operation_result_unavailable', 'operation_invalid_output', 'operation_audit_unavailable', 'operation_temporarily_unavailable', 'operation_internal_error', 'operation_conflict', 'operation_limit_exceeded'] as const;
export type OperationErrorCode = typeof OPERATION_ERROR_CODES[number];
export const OperationErrorSchema = z.object({
  error: z.object({
    code: z.enum(OPERATION_ERROR_CODES),
    domain: z.string(),
    message: z.string(),
    metadata: z.record(z.unknown()),
    retryable: z.boolean(),
    request_id: z.string()
  }).strict()
}).strict();
export type OperationErrorBody = z.infer<typeof OperationErrorSchema>;
export type OperationOutcome<T = unknown> = {
  status: 'succeeded';
  data: T;
} | {
  status: 'pending_approval';
  proposal_id: string;
} | OperationErrorBody;
export interface OperationResponse<T = unknown> {
  http_status: number;
  request_id: string;
  replayed: boolean;
  policy_decision_record_id: string | null;
  body: OperationOutcome<T>;
}
export const ActionCatalogInputSchema = z.object({}).strict();
export const ActionCatalogOutputSchema = z.object({
  actions: z.array(z.object({
    id: z.string(),
    version: z.number().int().positive(),
    title: z.string(),
    kind: z.enum(['command', 'query'])
  }).strict())
}).strict();
const grantId = z.string().min(1).max(36);
export const ActionGrantCreateInputSchema = z.object({
  agent_id: grantId,
  action_id: z.string().min(1).max(128),
  project_id: grantId.nullable().default(null),
  target_run_id: grantId.nullable().default(null),
  resource_kind: z.string().min(1).max(64).nullable().default(null),
  resource_id: z.string().min(1).max(256).nullable().default(null),
  max_uses: z.number().int().positive().max(2147483647).nullable().default(null),
  expires_at: z.string().datetime({offset: true}).nullable().default(null),
}).strict();
export const ActionGrantRevokeInputSchema = z.object({grant_id: grantId}).strict();
export const ActionGrantOutputSchema = z.object({
  id: grantId,
  space_id: grantId,
  agent_id: grantId,
  action_id: z.string(),
  target_run_id: grantId.nullable(),
  project_id: grantId.nullable(),
  resource_kind: z.string().nullable(),
  resource_id: z.string().nullable(),
  granted_by_user_id: grantId,
  status: z.enum(['active', 'revoked', 'expired']),
  expires_at: z.string().datetime().nullable(),
  max_uses: z.number().int().positive().nullable(),
  use_count: z.number().int().nonnegative(),
  last_used_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
}).strict();
export const BoardConfigureOperationInputSchema = BoardConfigurationInputSchema.extend({
  project_id: IdSchema.max(36).optional(), reason:z.string().trim().min(1).max(2000).nullable().default(null),
}).strict();
export const BoardConfigureOperationOutputSchema = z.object({
  project_id:IdSchema.max(36), columns_revision:z.string().min(1),
  columns:z.array(ProjectBoardColumnSchema.omit({count:true})),
}).strict();
export const TaskMoveOperationInputSchema = BoardColumnSelectionSchema.extend({
  task_id:IdSchema.max(36), project_id:IdSchema.max(36).optional(),
  reason:z.string().trim().min(1).max(2000).nullable().default(null),
  override_completion:TaskCompletionOverrideSchema.nullable().default(null),
}).strict();
export const TaskMoveOperationOutputSchema = z.object({
  task_id:IdSchema.max(36), project_id:IdSchema.max(36),status:z.enum(TASK_STATUSES),column_id:IdSchema.max(36).nullable(),
}).strict();
// Draft labels and references do not confer orchestrator execution authority.
export const ProjectOperationCreateInputSchema = z.object({
  project_id: IdSchema.max(36),
  kind: z.enum(['custom','source_setup','source_backfill']),
  title: z.string().trim().min(1).max(256),
  intent_text: z.string().trim().nullable().default(null),
  initiating_run_id: IdSchema.max(36).nullable().default(null),
  plan_artifact_id: IdSchema.max(36).nullable().default(null),
  steps: z.array(z.object({title:z.string().trim().min(1).max(256), detail:z.record(z.unknown()).default({})}).strict()).default([]),
}).strict();
export const ProjectOperationCancelInputSchema = z.object({
  project_id: IdSchema.max(36), operation_id: IdSchema.max(36),
}).strict();
export const ProjectOperationCommandOutputSchema = z.object({
  id: IdSchema.max(36), project_id: IdSchema.max(36),
  kind: z.enum(['custom','source_setup','source_backfill','research']),
  status: z.enum(['draft','active','waiting_review','completed','failed','cancelled']),
  version: z.number().int().positive(),
}).strict();
const collaborationParticipants = z.array(IdSchema.max(36)).min(1)
  .refine(ids => new Set(ids).size === ids.length, 'Participants must be distinct');
export const CollaborationParticipantsInputSchema = z.object({
  group_id: IdSchema.max(36),
  expected_participant_agent_ids: collaborationParticipants,
  participant_agent_ids: collaborationParticipants,
  reason: z.string().trim().min(1).max(2000),
}).strict();
export const CollaborationParticipantsOutputSchema = z.object({
  group_id: IdSchema.max(36), task_id: IdSchema.max(36), participant_agent_ids: collaborationParticipants,
  max_delegations: z.number().int().positive(),
}).strict();
export const OPERATION_SCHEMA_TABLE = {
  'knowledge.candidate.extract':{input:KnowledgeExtractionInputSchema,output:KnowledgeExtractionReceiptSchema},
  "workspace.integration.verification.get":{input:WorkspaceVerificationGetInputSchema,output:WorkspaceVerificationViewSchema},
  "workspace.integration.verification.configure":{input:WorkspaceVerificationConfigureInputSchema,output:WorkspaceVerificationViewSchema},
  "workspace.integration.retry":{input:WorkspaceIntegrationRetryInputSchema,output:WorkspaceChangeReceiptSchema},
  "workspace.change.abandon":{input:WorkspaceChangeAbandonInputSchema,output:WorkspaceChangeReceiptSchema},
  "workspace.retention.update":{input:WorkspaceRetentionUpdateInputSchema,output:WorkspaceRetentionReceiptSchema},
  "workspace.change.get":{input:WorkspaceChangeGetInputSchema,output:WorkspaceChangeStatusSchema},
  "workspace.change.complete":{input:WorkspaceChangeCompleteInputSchema,output:WorkspaceChangeReceiptSchema},

  'source.processing.rule.create':{input:SourceProcessingCreateSchema,output:SourceProcessingRuleSchema},
  'source.processing.rule.update':{input:SourceProcessingUpdateSchema,output:SourceProcessingRuleSchema},
  'source.processing.rule.dispatch':{input:SourceProcessingDispatchSchema,output:SourceDispatchReceiptSchema},
  'source.extraction.dispatch':{input:SourceExtractionDispatchSchema,output:SourceDispatchReceiptSchema},
  'source.channel.create':{input:SourceChannelCreateInputSchema,output:SourceChannelCreateOutputSchema},
  ...NOTE_OBJECT_SCHEMAS,
  ...KNOWLEDGE_OBJECT_SCHEMAS,
  ...KNOWLEDGE_REVIEW_SCHEMAS,
  ...RESEARCH_WORKSPACE_SCHEMAS,
  ...RESEARCH_EXECUTION_SCHEMAS,
  'research.ask_ai':{input:ResearchAdhocInputSchema,output:ResearchAdhocReceiptSchema},
  ...PROJECT_SOURCE_PROPOSAL_SCHEMAS,
  ...PROJECT_CORPUS_SCHEMAS,
  ...PROJECT_FOLDER_SCHEMAS,
  ...PROJECT_FOLDER_IO_SCHEMAS,
  ...PROJECT_INGRESS_SCHEMAS,
  ...PROJECT_EXECUTION_SCHEMAS,
  ...PROJECT_MANAGEMENT_SCHEMAS,
  ...INQUIRY_OPERATION_SCHEMAS,
  ...INQUIRY_AGENT_OPERATION_SCHEMAS,
  'knowledge.note.rollback':{input:NoteRollbackInputSchema,output:NoteControlReceiptSchema},
  'knowledge.note.delete':{input:NoteControlTargetSchema,output:NoteControlReceiptSchema},
  'source.channel.update':{input:SourceMonitorUpdateSchema,output:SourceMonitorOutputSchema},
  'source.channel.scan':{input:SourceMonitorTargetSchema,output:SourceMonitorScanOutputSchema},
  'source.recipe.create':{input:SourceRecipeCreateInputSchema,output:SourceRecipeCreateOutputSchema},
  'source.channel.set_subscription':{input:SourceSubscriptionInputSchema,output:SourceSubscriptionOutputSchema},
  'source.recommendation.decide':{input:SourceRecommendationInputSchema,output:SourceSubscriptionOutputSchema},
  'project.source.bind':{input:ProjectSourceBindInputSchema,output:ProjectSourceBindingOutputSchema},
  'project.source.update':{input:ProjectSourceUpdateInputSchema,output:ProjectSourceBindingOutputSchema},
  'project.source.unbind':{input:ProjectSourceTargetSchema,output:ProjectSourceUnbindOutputSchema},
  'project.source.backfill':{input:ProjectSourceTargetSchema,output:ProjectSourceBackfillOutputSchema},
  'inquiry.thread.create':{input:InquiryThreadCreateInputSchema,output:InquiryThreadCreateReceiptSchema},
  'note.raise_as_question':{input:NoteQuestionInputSchema,output:NoteQuestionReceiptSchema},
  'task.report':{input:TaskReportInputSchema,output:TaskReportOutputSchema},
  'task.complete':{input:TaskCompleteInputSchema,output:TaskCompleteOutputSchema},
  'task.request_review':{input:TaskReviewInputSchema,output:TaskStatusOutputSchema},
  'task.handoff':{input:TaskHandoffInputSchema,output:TaskHandoffOutputSchema},
  'task.set_status':{input:TaskStatusInputSchema,output:TaskStatusOutputSchema},
  'task.delete':{input:TaskDeleteInputSchema,output:TaskDeleteOutputSchema},
  'board.configure':{input:BoardConfigureOperationInputSchema,output:BoardConfigureOperationOutputSchema},
  'task.move_to_column':{input:TaskMoveOperationInputSchema,output:TaskMoveOperationOutputSchema},
  'task.place_in_space_board':{input:TaskSpacePlacementInputSchema,output:TaskSpacePlacementOutputSchema},
  'source.backfill.preview':{input:SourceBackfillPreviewInputSchema,output:SourceBackfillPreviewOutputSchema},
  'source.backfill.create_plan':{input:SourceBackfillCreateInputSchema,output:SourceBackfillReceiptSchema},
  'source.backfill.pause':{input:SourceBackfillControlInputSchema,output:SourceBackfillReceiptSchema},
  'source.backfill.resume':{input:SourceBackfillControlInputSchema,output:SourceBackfillReceiptSchema},
  'project.operation.create': {input:ProjectOperationCreateInputSchema, output:ProjectOperationCommandOutputSchema},
  'project.operation.cancel': {input:ProjectOperationCancelInputSchema, output:ProjectOperationCommandOutputSchema},
  'room.collaboration.update_participants': {input: CollaborationParticipantsInputSchema, output: CollaborationParticipantsOutputSchema},
  'policy.action_grant.create':{input:ActionGrantCreateInputSchema,output:ActionGrantOutputSchema},
  'policy.action_grant.revoke':{input:ActionGrantRevokeInputSchema,output:ActionGrantOutputSchema},
  'system.actions.list': {
    input: ActionCatalogInputSchema,
    output: ActionCatalogOutputSchema
  }
} as const;
export type OperationId = keyof typeof OPERATION_SCHEMA_TABLE;
export type OperationInput<Id extends OperationId> = z.input<(typeof OPERATION_SCHEMA_TABLE)[Id]['input']>;
export type OperationOutput<Id extends OperationId> = z.output<(typeof OPERATION_SCHEMA_TABLE)[Id]['output']>;
