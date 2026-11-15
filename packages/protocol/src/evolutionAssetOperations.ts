import {z} from 'zod';
import {IdSchema,JsonObjectSchema} from './common.js';

/**
 * Evolvable-asset, evaluation, workflow-from-Run, bundle-creation and
 * Evolution-Run commands, plus the two read-shaped POSTs as queries. Inputs
 * mirror the retained REST bodies; the owners keep every scope, lifecycle and
 * evaluation rule. Receipts carry identities and states only: assets,
 * versions, pins, cases, evaluation runs and bundles are reread through their
 * authorized GET readers.
 */
const text=(max:number)=>z.string().trim().max(max).nullable().optional();
const ref=IdSchema.max(128);
export const EvolvableAssetTypeSchema=z.enum(['prompt_template','workflow_template','agent_config','source_post_processing_rule']);
export const EvolvableAssetScopeTypeSchema=z.enum(['system','space','project','user','agent']);
export const EvolvableAssetPinScopeTypeSchema=z.enum(['space','project','user','agent']);
export const EvolvableAssetVersionStatusSchema=z.enum(['draft','candidate','testing','approved','deprecated','archived']);
export const EvolvableAssetVersionSourceSchema=z.enum(['built_in','user_authored','evolved','imported','generated']);
export const EvolvableAssetEvaluationStatusSchema=z.enum(['queued','running','passed','failed','blocked','cancelled']);
const evaluationFields={
 eval_suite_ref:JsonObjectSchema,evaluator_version:z.string().trim().min(1).max(128),
 status:EvolvableAssetEvaluationStatusSchema.optional(),baseline_version_id:ref.nullish(),run_id:ref.nullish(),
 model_provider_ref:JsonObjectSchema.nullish(),metrics:JsonObjectSchema.optional(),blockers:z.array(z.unknown()).max(200).optional(),
 output_artifact_id:ref.nullish(),report_artifact_id:ref.nullish(),
};
const caseFields={
 asset_id:ref,name:z.string().trim().min(1).max(256),description:text(4000),
 input_json:JsonObjectSchema.optional(),expectation_json:JsonObjectSchema.optional(),
 verification_recipe_json:JsonObjectSchema,baseline_version_id:ref,
};
const workflowFields={run_id:ref,asset_key:text(128),display_name:text(256),description:text(4000),input_schema_json:JsonObjectSchema.nullish()};

export const EvolvableAssetReceiptSchema=z.object({space_id:IdSchema,asset_id:IdSchema}).strict();
export const EvolvableAssetVersionReceiptSchema=z.object({space_id:IdSchema,asset_id:IdSchema,version_id:IdSchema}).strict();
export const EvolvableAssetPinReceiptSchema=z.object({space_id:IdSchema,asset_id:IdSchema,scope_type:EvolvableAssetPinScopeTypeSchema,scope_id:IdSchema,pin_id:IdSchema.nullable()}).strict();
export const EvaluationCaseReceiptSchema=z.object({space_id:IdSchema,asset_id:IdSchema,case_id:IdSchema}).strict();
export const EvaluationRunReceiptSchema=z.object({space_id:IdSchema,asset_id:IdSchema,evaluation_run_id:IdSchema}).strict();
export const EvaluationExecutionReceiptSchema=EvaluationRunReceiptSchema.extend({job_id:IdSchema,connector_mode:z.literal('mock_read_only')}).strict();
/** A pointer to the pending Proposal; review and apply stay with the canonical Proposal applier. */
export const EvolutionProposalReceiptSchema=z.object({space_id:IdSchema,proposal_id:IdSchema,status:z.string().min(1).max(32),proposal_type:z.string().min(1).max(64)}).strict();
export const WorkflowSaveReceiptSchema=z.discriminatedUnion('status',[
 z.object({space_id:IdSchema,status:z.literal('proposal_required'),proposal_id:IdSchema,proposal_type:z.literal('workflow_save'),risk_level:z.string().min(1).max(16)}).strict(),
 z.object({space_id:IdSchema,status:z.literal('draft_saved'),asset_id:IdSchema,version_id:IdSchema,version_status:z.literal('draft'),risk_level:z.string().min(1).max(16)}).strict(),
]);
export const EvolutionBundleReceiptSchema=z.object({space_id:IdSchema,bundle_id:IdSchema}).strict();
/** The queued Run and its agent_run Job intent; execution happens in the Job, never in the request. */
export const EvolutionRunStartReceiptSchema=z.discriminatedUnion('status',[
 z.object({space_id:IdSchema,status:z.literal('queued'),target_id:IdSchema,run_id:IdSchema,job_id:IdSchema,selector_decision_id:IdSchema,selected_strategy_key:z.string().min(1).max(256)}).strict(),
 /** No active strategy matched: the recorded selector decision explains why; no Run was created. */
 z.object({space_id:IdSchema,status:z.literal('not_selected'),target_id:IdSchema,selector_decision_id:IdSchema,reason:z.string().min(1).max(2000)}).strict(),
]);
/** Resolution owner output: the effective version, its content and trace, under the caller's asset read authority. */
export const EvolvableAssetResolutionSchema=z.record(z.unknown());
/** Workflow extraction preview (definition, risk, source kind); computed from the caller's own visible Run. */
export const WorkflowFromRunPreviewSchema=z.record(z.unknown());

export const EVOLUTION_ASSET_OPERATION_SCHEMAS={
 'evolution.asset.create':{input:z.object({asset_type:EvolvableAssetTypeSchema,asset_key:z.string().trim().min(1).max(128),display_name:z.string().trim().min(1).max(256),description:text(4000),owner_scope_type:EvolvableAssetScopeTypeSchema.optional(),owner_scope_id:ref.nullish(),default_eval_suite_ref:JsonObjectSchema.nullish(),metadata_json:JsonObjectSchema.optional()}).strict(),output:EvolvableAssetReceiptSchema},
 /** A new draft; a server-owned Reading generation provenance is never accepted from input. */
 'evolution.asset.version.create':{input:z.object({asset_id:ref,scope_type:EvolvableAssetScopeTypeSchema.optional(),scope_id:ref.nullish(),parent_version_id:ref.nullish(),source:EvolvableAssetVersionSourceSchema.optional(),content_ref:text(2048),content_hash:z.string().max(128).nullish(),content_json:JsonObjectSchema.nullish()}).strict(),output:EvolvableAssetVersionReceiptSchema},
 /** Drafts only; the content hash is always recomputed by the owner. */
 'evolution.asset.version.update':{input:z.object({asset_id:ref,version_id:ref,content_json:JsonObjectSchema.nullish(),content_ref:text(2048),content_hash:z.string().max(128).nullish()}).strict(),output:EvolvableAssetVersionReceiptSchema},
 /** Forward-only direct moves; approved/deprecated stay reachable only through the promotion Proposal. */
 'evolution.asset.version.transition':{input:z.object({asset_id:ref,version_id:ref,status:EvolvableAssetVersionStatusSchema}).strict(),output:EvolvableAssetVersionReceiptSchema},
 'evolution.asset.pin.set':{input:z.object({asset_id:ref,scope_type:EvolvableAssetPinScopeTypeSchema,scope_id:ref,version_id:ref,reason:text(2000)}).strict(),output:EvolvableAssetPinReceiptSchema},
 'evolution.asset.pin.archive':{input:z.object({asset_id:ref,scope_type:EvolvableAssetPinScopeTypeSchema,scope_id:ref}).strict(),output:EvolvableAssetPinReceiptSchema},
 'evolution.asset.resolve':{input:z.object({asset_id:ref,project_id:ref.nullish(),agent_id:ref.nullish(),explicit_version_id:ref.nullish(),allow_user_pin:z.boolean().optional()}).strict(),output:EvolvableAssetResolutionSchema},
 'evolution.asset.evaluation_case.create':{input:z.object({...caseFields,baseline_output_json:z.unknown()}).strict(),output:EvaluationCaseReceiptSchema},
 /** The baseline fixture is the visible source Run's output with a passed post-run evaluation. */
 'evolution.asset.evaluation_case.create_from_run':{input:z.object({...caseFields,source_run_id:ref}).strict(),output:EvaluationCaseReceiptSchema},
 /** Externally reported evidence; an Evaluation Engine pass is writable only by its Job. */
 'evolution.asset.evaluation.record':{input:z.object({asset_id:ref,version_id:ref,...evaluationFields}).strict(),output:EvaluationRunReceiptSchema},
 /** Records the queued evaluation run and its Job intent together; the verification runs in that Job. */
 'evolution.asset.evaluation.execute':{input:z.object({asset_id:ref,version_id:ref,case_id:ref,candidate_run_id:ref}).strict(),output:EvaluationExecutionReceiptSchema},
 'evolution.asset.promotion.propose':{input:z.object({asset_id:ref,version_id:ref,target_scope_type:z.enum(['project','space','user','agent','system']),target_scope_id:ref.nullish(),pin_after_approval:z.boolean().optional(),deprecate_previous:z.boolean().optional(),evaluation_run_ids:z.array(ref).max(50).optional(),reason:text(2000),hard_gate:z.boolean().optional(),evaluation_hard_gate:z.boolean().optional()}).strict(),output:EvolutionProposalReceiptSchema},
 'evolution.workflow.preview':{input:z.object(workflowFields).strict(),output:WorkflowFromRunPreviewSchema},
 /** Saves a draft within its risk bounds; otherwise files a `workflow_save` Proposal. */
 'evolution.workflow.save':{input:z.object(workflowFields).strict(),output:WorkflowSaveReceiptSchema},
 /** Groups pending, visible Proposals for one review; deciding the bundle is the Proposal decision path. */
 'evolution.bundle.create':{input:z.object({title:z.string().trim().min(1).max(256),description:text(4000),proposal_ids:z.array(ref).min(1).max(50)}).strict(),output:EvolutionBundleReceiptSchema},
 'evolution.target.run':{input:z.object({target_id:ref,agent_id:ref.nullish(),mode:z.enum(['dry_run','live']).optional(),runtime_profile_id:ref.nullish(),project_id:ref.nullish(),project_folder_id:ref.nullish()}).strict(),output:EvolutionRunStartReceiptSchema},
} as const;
export type EvolutionAssetOperationId=keyof typeof EVOLUTION_ASSET_OPERATION_SCHEMAS;
export type EvolutionAssetOperationInput<Id extends EvolutionAssetOperationId>=z.output<(typeof EVOLUTION_ASSET_OPERATION_SCHEMAS)[Id]['input']>;
export const EVOLUTION_ASSET_QUERY_IDS=['evolution.asset.resolve','evolution.workflow.preview'] as const satisfies readonly EvolutionAssetOperationId[];
export const EVOLUTION_ASSET_OPERATION_TITLES:Record<EvolutionAssetOperationId,string>={
 'evolution.asset.create':'Create an evolvable asset','evolution.asset.version.create':'Create an asset version',
 'evolution.asset.version.update':'Edit a draft asset version','evolution.asset.version.transition':'Move an asset version forward',
 'evolution.asset.pin.set':'Pin an approved asset version','evolution.asset.pin.archive':'Remove an asset pin',
 'evolution.asset.resolve':'Resolve the effective asset version','evolution.asset.evaluation_case.create':'Create an evaluation case',
 'evolution.asset.evaluation_case.create_from_run':'Create an evaluation case from a Run','evolution.asset.evaluation.record':'Record an asset evaluation',
 'evolution.asset.evaluation.execute':'Run an evaluation case','evolution.asset.promotion.propose':'Propose an asset version promotion',
 'evolution.workflow.preview':'Preview a workflow from a Run','evolution.workflow.save':'Save a workflow from a Run',
 'evolution.bundle.create':'Create an Evolution review bundle','evolution.target.run':'Start an Evolution Run',
};
