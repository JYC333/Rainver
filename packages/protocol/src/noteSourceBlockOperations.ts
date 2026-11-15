import {z} from 'zod';
import {RuntimeSessionConfigSelectionSchema} from './hosts.js';
import {RetrievalSearchRequestSchema,RetrievalBriefRequestSchema} from './knowledgeRetrieval.js';
import {CustomSourceCredentialCreateSchema,CustomSourceCredentialDTOSchema,CustomSourceSpacePolicyUpdateSchema,CustomSourceSpacePolicyDTOSchema,CustomSourceInstanceRunnerSettingsUpdateSchema,CustomSourceInstanceRunnerSettingsDTOSchema} from './sourceCustomSourceHandlers.js';
/**
 * Plan 5 Note/Source block, remaining retained URLs as human-only core
 * commands. Each entry names its owning service and the policy action its
 * retained route already applied. Receipts carry identity and the minimum
 * state the caller acts on; bodies stay behind the authorized readers, and a
 * replay is released only under the caller's current authority.
 */
const id=z.string().trim().min(1).max(64);
const itemTarget={source_item_id:id};
const state=z.string().trim().min(1).max(64);

/* Material processing (items/:itemId/processing/*, items/:itemId/reading-syntax). */
export const SourceMaterialStartInputSchema=z.object({...itemTarget,investigation:z.boolean().optional(),agent_id:id.optional(),runtime_profile_id:id.optional(),session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32).optional()}).strict().refine(v=>!!v.agent_id===!!v.runtime_profile_id,{message:'Select Agent and runtime profile together'});
export const SourceMaterialStartReceiptSchema=z.object({id,space_id:id,status:z.enum(['queued','needs_consent']),processing_id:id.optional(),run_id:id.optional(),source_id:id.optional(),source_name:z.string().max(2000).optional(),can_request_consent:z.boolean().optional()}).strict();
export const SourceMaterialCancelInputSchema=z.object(itemTarget).strict();
export const SourceMaterialCancelReceiptSchema=z.object({id,space_id:id,status:state,processing_id:id.optional(),run_id:id.optional(),cancel_requested:z.boolean().optional()}).strict();
export const SourceMaterialStorageInputSchema=z.object(itemTarget).strict();
export const SourceMaterialStorageReceiptSchema=z.object({id,space_id:id,allowed:z.literal(true).optional(),proposal_id:id.optional(),source_name:z.string().max(2000).optional()}).strict();
export const SourceMaterialSyntaxInputSchema=z.object({...itemTarget,syntax:z.literal('markdown'),artifact_id:id,source_snapshot_id:id.nullable()}).strict();
export const SourceMaterialSyntaxReceiptSchema=z.object({id,space_id:id,artifact_id:id}).strict();

/* Post-processing decisions and one-off runs. Agent work is a Job intent for the existing worker. */
export const SOURCE_DECISION_QUEUE_ACTIONS=['queue_content','extract_evidence'] as const;
export const SOURCE_DECISION_REVIEW_ACTIONS=['select','triage','ignore','dismiss','create_proposal','rerun_item','deep_analysis'] as const;
export const SourceDecisionQueueInputSchema=z.object({decision_id:id,action:z.enum(SOURCE_DECISION_QUEUE_ACTIONS)}).strict();
export const SourceDecisionReviewInputSchema=z.object({decision_id:id,action:z.enum(SOURCE_DECISION_REVIEW_ACTIONS)}).strict();
export const SourceDecisionReceiptSchema=z.object({id,space_id:id,review_status:state,proposal_id:id.optional(),job_ids:z.array(id).max(100).optional()}).strict();
export const SourceRunOnceInputSchema=z.object({source_item_ids:z.array(id).max(100).optional(),evidence_ids:z.array(id).max(100).optional(),actions_json:z.record(z.unknown()).optional(),agent_id:id.optional(),project_id:id.optional(),input_config_json:z.record(z.unknown()).optional(),trigger_config_json:z.record(z.unknown()).optional(),summary_goal:z.string().trim().max(4000).optional()}).strict().refine(v=>!!(v.source_item_ids?.length||v.evidence_ids?.length),{message:'At least one source_item_id or evidence_id is required'});
export const SourceJobReceiptSchema=z.object({id,space_id:id,job_id:id,status:z.literal('pending')}).strict();

/* Source retrieval and provider query preview. Provider work is a single-attempt Job; results are read
 * through GET /sources/retrieval/requests/:jobId under the caller's current access. */
export const SOURCE_RETRIEVAL_JOB='source_retrieval_request' as const;
export const SourceRetrievalSearchInputSchema=RetrievalSearchRequestSchema.strict();
export const SourceRetrievalBriefInputSchema=RetrievalBriefRequestSchema.strict();
export const SourceQueryPreviewInputSchema=z.object({provider_key:z.string().trim().min(1).max(128),query:z.record(z.unknown()),source_channel_id:id.optional(),credential_id:id.optional()}).strict();
export const SourceRetrievalReindexInputSchema=z.object({}).strict();
export const SourceRetrievalReindexReceiptSchema=z.object({id,space_id:id,reindexed:z.record(z.number().int().nonnegative()),embedding_backfill_job_id:id.nullable()}).strict();
/** The dedicated reader's envelope: a pending/failed request, or its result filtered by current access. */
export const SourceRetrievalRequestViewSchema=z.object({job_id:id,kind:z.enum(['search','brief','query_preview','recipe_plan','recipe_dry_run','custom_test','custom_repair','goal_preview']),status:z.enum(['pending','running','completed','failed','cancelled']),result:z.record(z.unknown()).nullable(),withheld:z.number().int().nonnegative()}).strict();
export type SourceRetrievalRequestView=z.infer<typeof SourceRetrievalRequestViewSchema>;

/* Backfill start: the human submission of the canonical `source_backfill_start` proposal. */
export const SourceBackfillStartProposeInputSchema=z.object({source_channel_id:id,source_backfill_plan_id:id}).strict();
export const SourceBackfillStartProposeReceiptSchema=z.object({plan_id:id,source_channel_id:id,status:state,proposal_id:id}).strict();

/* Source recipes: planning and dry-run fetch and execute externally, so they are Job intents; activation is DB-only. */
export const SourceRecipePlanInputSchema=z.object({endpoint_url:z.string().trim().min(1).max(4000),name:z.string().trim().min(1).max(500).optional(),source_type:z.string().trim().max(64).optional(),list_selector:z.string().trim().max(2000).optional(),fixture_content:z.string().max(2_000_000).optional(),credential_id:id.nullable().optional(),fetch_frequency:z.string().trim().max(32).optional(),capture_policy:z.string().trim().max(64).optional(),retention_policy:z.string().trim().max(64).optional(),
  // Shared with recipe creation; planning reads none of these.
  next_check_at:z.string().max(64).nullable().optional(),schedule_rule:z.record(z.unknown()).nullable().optional(),config:z.record(z.unknown()).optional()}).strict();
export const SourceRecipeDryRunInputSchema=z.object({source_connection_id:id,recipe_version_id:id,fixture_content:z.string().max(2_000_000).optional()}).strict();
export const SourceRecipeActivateInputSchema=z.object({source_connection_id:id,recipe_version_id:id,next_check_at:z.string().max(64).nullable().optional(),schedule_rule:z.record(z.unknown()).nullable().optional()}).strict();
export const SourceRecipeActivateReceiptSchema=z.object({id,space_id:id,status:z.enum(['active','pending_approval']),recipe_version_id:id,proposal_id:id.nullable(),deltas:z.array(z.string().max(2000)).max(100)}).strict();

/* Custom Sources. Handler test and repair execute handlers externally, so they are Job intents;
 * drafts, generation, activation, rollback, the pipeline bridge, credentials and settings are DB-only. */
const connectionTarget={source_connection_id:id};
const schedule={next_check_at:z.string().max(64).nullable().optional(),schedule_rule:z.record(z.unknown()).nullable().optional()};
export const CustomSourceDraftInputSchema=z.object({name:z.string().trim().min(1).max(500),endpoint_url:z.string().trim().min(1).max(4000),credential_id:id.nullable().optional(),project_id:id.nullable().optional(),visibility:z.string().trim().max(32).optional(),fetch_frequency:z.string().trim().max(32).optional(),...schedule,config:z.record(z.unknown()).optional()}).strict();
export const CustomSourceReceiptSchema=z.object({id,space_id:id,source_channel_id:id.optional(),status:state.optional()}).strict();
export const CustomSourceGenerateInputSchema=z.object({...connectionTarget,generation_mode:z.literal('pipeline'),pipeline:z.record(z.unknown()),capture_policy:z.string().trim().max(64).optional(),retention_policy:z.string().trim().max(64).optional()}).strict();
export const CustomSourceVersionReceiptSchema=z.object({id,space_id:id,source_connection_id:id,status:state}).strict();
export const CustomSourceTestInputSchema=z.object({...connectionTarget,handler_version_id:id,fixture_html:z.string().max(2_000_000).optional()}).strict();
export const CustomSourceActivateInputSchema=z.object({...connectionTarget,handler_version_id:id,...schedule}).strict();
export const CustomSourceActivationReceiptSchema=z.object({id,space_id:id,status:z.enum(['active','pending_approval']),handler_version_id:id,proposal_id:id.nullable(),deltas:z.array(z.string().max(2000)).max(100),previous_handler_version_id:id.nullable().optional()}).strict();
export const CustomSourceRepairInputSchema=z.object({...connectionTarget,pipeline:z.record(z.unknown()).optional(),capture_policy:z.string().trim().max(64).optional(),retention_policy:z.string().trim().max(64).optional(),fixture_html:z.string().max(2_000_000).optional()}).strict();
export const CustomSourceRollbackInputSchema=z.object({...connectionTarget,target_version_id:id.optional()}).strict();
export const CustomSourceBridgeInputSchema=z.object({...connectionTarget,handler_version_id:id.optional(),name:z.string().trim().min(1).max(500).optional(),fetch_frequency:z.string().trim().max(32).optional(),...schedule}).strict();
export const CustomSourceBridgeReceiptSchema=z.object({id,space_id:id,source_channel_id:id,recipe_version_id:id,bridged_from_connection_id:id,bridged_from_handler_version_id:id}).strict();
/** The secret is accepted once and never returned; the request fingerprint keys it by an HMAC. */
export const CustomSourceCredentialCreateInputSchema=CustomSourceCredentialCreateSchema;

/* Note trash purge: the existing retention window, batch and per-Note write rule; a replay never deletes again. */
export const NoteTrashPurgeInputSchema=z.object({}).strict();
export const NoteTrashPurgeReceiptSchema=z.object({id,space_id:id,deleted:z.number().int().nonnegative(),retention_days:z.number().int().positive(),
  /** The Projects this batch deleted from: its receipt's authorization scope. */
  project_ids:z.array(id).max(500)}).strict();

type Entry={input:z.ZodTypeAny;output:z.ZodTypeAny;title:string;owner:string;service:string;policy:string;effects:'durable'|'draft'|'proposal'};
const entry=<I extends z.ZodTypeAny,O extends z.ZodTypeAny>(input:I,output:O,title:string,owner:string,service:string,policy:string,effects:Entry['effects']='durable')=>({input,output,title,owner,service,policy,effects});

export const NOTE_SOURCE_BLOCK_OPERATIONS={
  'source.material.start':entry(SourceMaterialStartInputSchema,SourceMaterialStartReceiptSchema,'Read and prepare a saved material','sources','MaterialItemProcessingService.startIn','source.item_update'),
  'source.material.cancel':entry(SourceMaterialCancelInputSchema,SourceMaterialCancelReceiptSchema,'Cancel material preparation','sources','MaterialItemProcessingService.cancelIn','source.item_update'),
  'source.material.request_storage':entry(SourceMaterialStorageInputSchema,SourceMaterialStorageReceiptSchema,'Request saved-text permission for a Source','sources','proposeMaterialStorage','source.item_update'),
  'source.material.show_markdown':entry(SourceMaterialSyntaxInputSchema,SourceMaterialSyntaxReceiptSchema,'Show Agent text as Markdown','sources','showAgentTextAsMarkdown','source.item_update'),
  'source.processing.decision.queue':entry(SourceDecisionQueueInputSchema,SourceDecisionReceiptSchema,'Queue content or evidence from a processing decision','sources','SourcePostProcessingService.decisionAction','source.item_create'),
  'source.processing.decision.review':entry(SourceDecisionReviewInputSchema,SourceDecisionReceiptSchema,'Review a processing decision','sources','SourcePostProcessingService.decisionAction','source.item_update'),
  'source.processing.run_once':entry(SourceRunOnceInputSchema,SourceJobReceiptSchema,'Queue a one-off Source processing run','sources','SourcePostProcessingService.admitOneOff','source.item_update'),
  'source.retrieval.search.request':entry(SourceRetrievalSearchInputSchema,SourceJobReceiptSchema,'Queue a Source search','sources','RetrievalSearchService.search (Job)','source.retrieval.request'),
  'source.retrieval.brief.request':entry(SourceRetrievalBriefInputSchema,SourceJobReceiptSchema,'Queue a Source Context Brief','sources','RetrievalSearchService.buildBrief (Job)','source.retrieval.request'),
  'source.retrieval.reindex':entry(SourceRetrievalReindexInputSchema,SourceRetrievalReindexReceiptSchema,'Rebuild the Source retrieval projection','sources','RetrievalProjectionService.reindexAll','source.retrieval.reindex'),
  'source.query.preview':entry(SourceQueryPreviewInputSchema,SourceJobReceiptSchema,'Queue a provider query preview','sources','SourceQueryPreviewService (Job)','source.connection.manage'),
  'source.backfill.start.propose':entry(SourceBackfillStartProposeInputSchema,SourceBackfillStartProposeReceiptSchema,'Propose a Source history import','sources','SourceBackfillPlanningService.proposeStart','source.backfill.plan'),
  'source.recipe.plan.request':entry(SourceRecipePlanInputSchema,SourceJobReceiptSchema,'Queue Source recipe planning','sources','SourceRecipeCreateService.planSource (Job)','source.recipe.create'),
  'source.recipe.dry_run.request':entry(SourceRecipeDryRunInputSchema,SourceJobReceiptSchema,'Queue a Source recipe dry-run','sources','SourceRecipeDryRunService.dryRunRecipeVersion (Job)','source.recipe.dry_run'),
  'source.recipe.activate':entry(SourceRecipeActivateInputSchema,SourceRecipeActivateReceiptSchema,'Activate a Source recipe version','sources','SourceRecipeCreateService.activateRecipe','source.recipe.activate'),
  'source.custom.draft.create':entry(CustomSourceDraftInputSchema,CustomSourceReceiptSchema,'Create a Custom Source draft','sources','CustomSourceCreateFlowService.createDraft','source.custom.create'),
  'source.custom.handler.generate':entry(CustomSourceGenerateInputSchema,CustomSourceVersionReceiptSchema,'Write a Custom Source pipeline version','sources','CustomSourceCreateFlowService.generateHandler','source.custom.generate'),
  'source.custom.handler.test.request':entry(CustomSourceTestInputSchema,SourceJobReceiptSchema,'Queue a Custom Source handler test','sources','CustomSourceCreateFlowService.testHandler (Job)','source.custom.test'),
  'source.custom.handler.activate':entry(CustomSourceActivateInputSchema,CustomSourceActivationReceiptSchema,'Activate a Custom Source handler version','sources','CustomSourceCreateFlowService.activateHandler','source.custom.activate'),
  'source.custom.repair.request':entry(CustomSourceRepairInputSchema,SourceJobReceiptSchema,'Queue a Custom Source repair','sources','CustomSourceRepairService.repairHandler (Job)','source.custom.repair'),
  'source.custom.rollback':entry(CustomSourceRollbackInputSchema,CustomSourceActivationReceiptSchema,'Roll back a Custom Source handler','sources','CustomSourceRepairService.rollbackHandler','source.custom.rollback'),
  'source.custom.pipeline_bridge':entry(CustomSourceBridgeInputSchema,CustomSourceBridgeReceiptSchema,'Bridge a Custom Source pipeline into a recipe Source','sources','SourceRecipePipelineBridgeService.bridgePipelineHandler','source.recipe.create'),
  'source.custom.credential.create':entry(CustomSourceCredentialCreateInputSchema,CustomSourceCredentialDTOSchema,'Store a Custom Source credential','sources','CustomSourceCredentialService.create','source.custom.credential_create'),
  'source.custom.settings.space.update':entry(CustomSourceSpacePolicyUpdateSchema,CustomSourceSpacePolicyDTOSchema,'Update Space Custom Source policy','sources','PgCustomSourceHandlerRepository.updateSpacePolicy','source.custom.settings_update'),
  'source.custom.settings.instance.update':entry(CustomSourceInstanceRunnerSettingsUpdateSchema,CustomSourceInstanceRunnerSettingsDTOSchema,'Update instance Custom Source runner settings','sources','PgCustomSourceHandlerRepository.updateInstanceRunnerSettings','source.custom.settings_update'),
  'knowledge.note.trash.purge':entry(NoteTrashPurgeInputSchema,NoteTrashPurgeReceiptSchema,'Permanently delete expired trashed Notes','knowledge','PgKnowledgeRepository.purgeDeletedNotes','note.edit'),
} as const;
export type NoteSourceBlockOperationId=keyof typeof NOTE_SOURCE_BLOCK_OPERATIONS;
export const NOTE_SOURCE_BLOCK_SCHEMAS=Object.fromEntries(Object.entries(NOTE_SOURCE_BLOCK_OPERATIONS).map(([k,v])=>[k,{input:v.input,output:v.output}])) as {[K in NoteSourceBlockOperationId]:{input:(typeof NOTE_SOURCE_BLOCK_OPERATIONS)[K]['input'];output:(typeof NOTE_SOURCE_BLOCK_OPERATIONS)[K]['output']}};
