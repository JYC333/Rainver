import {z} from 'zod';
import {IdSchema} from './common.js';
import {
 PromptEvaluationRequestSchema,PromptPromotionRequestSchema,PromptRenderPreviewRequestSchema,PromptRenderPreviewResultSchema,
 PromptResolveRequestSchema,PromptResolveResultSchema,PromptRollbackRequestSchema,PromptVersionCreateRequestSchema,PromptAssetScopeTypeSchema,
} from './prompts.js';
import {MethodTargetSchema,ReadingMethodDraftSchema,ReadingMethodGenerationSchema,ReadingMethodJudgeSchema,ReadingMethodSampleSchema,ReadingMethodTrialSchema} from './readingMethod.js';
import {EvolutionProposalReceiptSchema} from './evolutionAssetOperations.js';

/**
 * Prompt facade and Reading Method commands, plus render preview and runtime
 * resolution as queries. The asset key is the URL target; bodies are the
 * existing request contracts. Generations and comparisons commit their Run
 * and Job intent; provider or Agent work runs in that Job. Receipts carry ids
 * only; versions, deployment refs, generations, comparisons and samples are
 * reread through their authorized GET readers.
 */
const key=z.string().trim().min(1).max(128);
const ref=IdSchema.max(128);
const withKey=<T extends z.ZodRawShape>(shape:T)=>({asset_key:key,...shape});
export const PromptVersionReceiptSchema=z.object({space_id:IdSchema,asset_key:key,version_id:IdSchema}).strict();
export const PromptDeploymentReceiptSchema=z.object({space_id:IdSchema,asset_key:key,deployment_id:IdSchema}).strict();
export const PromptEvaluationReceiptSchema=z.object({space_id:IdSchema,asset_key:key,evaluation_run_id:IdSchema}).strict();
export const ReadingMethodInitializeReceiptSchema=z.object({space_id:IdSchema,initialized:z.literal(true)}).strict();
export const ReadingMethodVersionReceiptSchema=z.object({space_id:IdSchema,version_id:IdSchema}).strict();
export const ReadingMethodSampleReceiptSchema=z.object({space_id:IdSchema,case_id:IdSchema}).strict();
export const ReadingMethodGenerationReceiptSchema=z.object({space_id:IdSchema,generation_id:IdSchema}).strict();
export const ReadingMethodTrialReceiptSchema=z.object({space_id:IdSchema,trial_id:IdSchema}).strict();
export const ReadingMethodPromotionReceiptSchema=z.object({space_id:IdSchema,proposal_id:IdSchema}).strict();

export const PROMPT_OPERATION_SCHEMAS={
 'prompt.version.create':{input:PromptVersionCreateRequestSchema.extend(withKey({})).strict(),output:PromptVersionReceiptSchema},
 /** Staging or another label; production needs the named accepted promotion Proposal. */
 'prompt.deployment.set':{input:z.object(withKey({label:z.string().trim().min(1).max(64),version_id:ref,scope_type:PromptAssetScopeTypeSchema.optional(),scope_id:ref.nullish(),promoted_from_proposal_id:ref.nullish()})).strict(),output:PromptDeploymentReceiptSchema},
 'prompt.deployment.rollback':{input:PromptRollbackRequestSchema.extend(withKey({})).strict(),output:PromptDeploymentReceiptSchema},
 'prompt.evaluation.record':{input:PromptEvaluationRequestSchema.extend(withKey({})).strict(),output:PromptEvaluationReceiptSchema},
 'prompt.promotion.propose':{input:PromptPromotionRequestSchema.extend(withKey({})).strict(),output:EvolutionProposalReceiptSchema},
 'prompt.render_preview':{input:PromptRenderPreviewRequestSchema.extend(withKey({})).strict(),output:PromptRenderPreviewResultSchema},
 'prompt.resolve':{input:PromptResolveRequestSchema.extend(withKey({})).strict(),output:PromptResolveResultSchema},
 /** Synchronizes the code-owned Reading and revision method built-ins for a Space manager. */
 'reading_method.initialize':{input:z.object({}).strict(),output:ReadingMethodInitializeReceiptSchema},
 'reading_method.draft.save':{input:ReadingMethodDraftSchema,output:ReadingMethodVersionReceiptSchema},
 'reading_method.sample.save':{input:z.object({item_id:ref,project_id:ref.nullable().optional(),target_key:MethodTargetSchema.optional(),sample:ReadingMethodSampleSchema}).strict(),output:ReadingMethodSampleReceiptSchema},
 'reading_method.generation.start':{input:ReadingMethodGenerationSchema,output:ReadingMethodGenerationReceiptSchema},
 /** Records the stop: a provider task ends here; an Agent Run's process stops after commit. */
 'reading_method.generation.cancel':{input:z.object({generation_id:ref}).strict(),output:ReadingMethodGenerationReceiptSchema},
 'reading_method.trial.start':{input:ReadingMethodTrialSchema,output:ReadingMethodTrialReceiptSchema},
 'reading_method.trial.cancel':{input:z.object({trial_id:ref}).strict(),output:ReadingMethodTrialReceiptSchema},
 'reading_method.trial.judge':{input:ReadingMethodJudgeSchema.extend({trial_id:ref}).strict(),output:ReadingMethodTrialReceiptSchema},
 /** The same promotion Proposal and applier as every prompt; a retry reuses its pending Proposal. */
 'reading_method.promotion.propose':{input:z.object({version_id:ref,evaluation_id:ref,project_id:ref.nullable().optional()}).strict(),output:ReadingMethodPromotionReceiptSchema},
 'reading_method.rollback':{input:z.object({item_id:ref.nullable().optional(),project_id:ref.nullable().optional(),expected_version_id:ref,target_key:MethodTargetSchema.optional()}).strict(),output:PromptDeploymentReceiptSchema},
} as const;
export type PromptOperationId=keyof typeof PROMPT_OPERATION_SCHEMAS;
export type PromptOperationInput<Id extends PromptOperationId>=z.output<(typeof PROMPT_OPERATION_SCHEMAS)[Id]['input']>;
export const PROMPT_QUERY_IDS=['prompt.render_preview','prompt.resolve'] as const satisfies readonly PromptOperationId[];
export const PROMPT_OPERATION_TITLES:Record<PromptOperationId,string>={
 'prompt.version.create':'Create a prompt version','prompt.deployment.set':'Deploy a prompt version to a label',
 'prompt.deployment.rollback':'Roll back a prompt deployment','prompt.evaluation.record':'Record a prompt evaluation',
 'prompt.promotion.propose':'Propose a prompt production promotion','prompt.render_preview':'Preview a rendered prompt',
 'prompt.resolve':'Resolve the effective prompt','reading_method.initialize':'Initialize the Reading methods',
 'reading_method.draft.save':'Save a Reading method draft','reading_method.sample.save':'Save a Reading method sample',
 'reading_method.generation.start':'Generate a Reading method revision','reading_method.generation.cancel':'Cancel a Reading method generation',
 'reading_method.trial.start':'Compare a Reading method','reading_method.trial.cancel':'Cancel a Reading method comparison',
 'reading_method.trial.judge':'Judge a Reading method comparison','reading_method.promotion.propose':'Propose a Reading method promotion',
 'reading_method.rollback':'Roll back the Reading method',
};
