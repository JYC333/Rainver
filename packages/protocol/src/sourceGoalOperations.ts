import {z} from 'zod';
import {IdSchema} from './common.js';
import {ProjectThemeAnalysisSelectionSchema,ProjectThemeRetrySchema} from './projectReading.js';
import {SourceGoalBeginRequestSchema,SourceGoalBindingConfirmRequestSchema,SourceGoalCheckRequestSchema,SourceGoalCompatibilityRollbackSchema,SourceGoalCreateSchema,SourceGoalEditSchema,SourceGoalFeedbackRequestSchema,SourceGoalFollowRequestSchema,SourceGoalLegacyRequestSchema,SourceGoalMessageRequestSchema,SourceGoalSaveSampleSchema} from './sourceGoals.js';
/**
 * Plan 5 Note/Source block, Goals family: the 21 retained goal-setup / goal
 * control URLs as human-only core commands over SourceGoalService and its
 * owning helpers. Inputs are the existing request schemas plus the URL targets;
 * receipts carry identity and the state the caller acts on. Plans, previews,
 * messages, theme results and Source content stay behind the authorized GET
 * readers, and a replay is released only under the caller's current authority.
 * Agent goal actions (source.goal.read/write_version/...) are unchanged.
 */
const id=IdSchema;
const goal={goal_id:id};
const state=z.string().trim().min(1).max(64);
const base={id,space_id:id};

const [excludeOrigin,excludeTerm,notRelevant,slowDown]=SourceGoalFeedbackRequestSchema.options;
export const SourceGoalFeedbackInputSchema=z.discriminatedUnion('kind',[excludeOrigin.extend(goal).strict(),excludeTerm.extend(goal).strict(),notRelevant.extend(goal).strict(),slowDown.extend(goal).strict()]);
export const SourceGoalThemeConfigureInputSchema=ProjectThemeAnalysisSelectionSchema.extend({...goal,expected_version_id:id}).strict().refine(v=>!v.enabled||!!v.agent_id&&!!v.runtime_profile_id,{message:'Explicit Agent and enabled Profile required for analysis consent'});
export const SourceGoalTargetInputSchema=z.object(goal).strict();
export const SourceGoalPreviewInputSchema=z.object({...goal,version_id:id}).strict();
/** `version_id` names the exact active plan; null (no active plan) keeps the retained 409. */
export const SourceGoalResumeInputSchema=z.object({...goal,version_id:id.nullable()}).strict();
/** Pause ignores a shown version; it is accepted because the retained surface always sent it. */
export const SourceGoalPauseInputSchema=z.object({...goal,version_id:id.nullable().optional()}).strict();

export const SourceGoalReceiptSchema=z.object({...base,status:state}).strict();
export const SourceGoalBeginReceiptSchema=z.object({...base,follow_activated:z.boolean()}).strict();
export const SourceGoalCreateReceiptSchema=z.object(base).strict();
export const SourceGoalMessageReceiptSchema=z.object({...base,session_id:id,run_id:id}).strict();
/** `id` is the channel; a dry run reports what a mapping would name, without writing. */
export const SourceGoalLegacyReceiptSchema=z.object({...base,goal_id:id.nullable(),created:z.boolean(),dry_run:z.boolean(),source_connection_id:id.optional(),intent:z.string().max(8000).optional()}).strict();
export const SourceGoalRollbackCompatibilityReceiptSchema=z.object({...base,status:z.literal('legacy'),changed:z.boolean()}).strict();
export const SourceGoalEditReceiptSchema=z.object({...base,version_id:id,revision:z.number().int().nonnegative()}).strict();
export const SourceGoalQueuedRunReceiptSchema=z.object({...base,run_id:id,job_id:id.optional(),status:z.literal('queued')}).strict();
/** The preview runs in a single-attempt Job; its stored result is read through GET /sources/goals/:goalId. */
export const SourceGoalPreviewReceiptSchema=z.object({...base,preview_id:id,job_id:id,status:z.literal('pending')}).strict();
export const SourceGoalSaveReceiptSchema=z.object({...base,version_id:id.nullable(),status:state}).strict();
export const SourceGoalFollowReceiptSchema=z.object({...base,status:state,activated:z.boolean(),prepare:z.boolean()}).strict();
export const SourceGoalFeedbackReceiptSchema=z.object({...base,applied:z.boolean(),duplicate:z.boolean(),kind:state,affected:z.number().int().nonnegative()}).strict();
export const SourceGoalCheckReceiptSchema=z.object({...base,status:z.enum(['queued','in_progress']),job_id:id.optional()}).strict();
export const SourceGoalResumeReceiptSchema=z.object({...base,status:state,prepare:z.boolean().optional(),activated:z.boolean().optional()}).strict();
export const SourceGoalBindingRollbackInputSchema=z.object({...goal,binding_id:id,expected_revision:z.number().int().nonnegative()}).strict();
export const SourceGoalBindingReceiptSchema=z.object({...base,binding_id:id,status:state,revision:z.number().int().nonnegative()}).strict();
export const SourceGoalBindingConfirmInputSchema=SourceGoalBindingConfirmRequestSchema.extend({...goal,binding_id:id}).strict();
export const SourceGoalRepairPublishInputSchema=z.object({...goal,repair_id:id}).strict();
export const SourceGoalRepairPublishReceiptSchema=z.object({...base,repair_id:id,status:z.literal('published'),revision:z.number().int().nonnegative()}).strict();
export const SourceGoalThemeConfigureReceiptSchema=z.object({...base,enabled:z.boolean(),version_id:id}).strict();
export const SourceGoalThemeRetryInputSchema=ProjectThemeRetrySchema.extend(goal).strict();
export const SourceGoalThemeCancelInputSchema=z.object({...goal,round_id:id}).strict();
export const SourceGoalThemeRoundReceiptSchema=z.object({...base,round_id:id,cancel_requested:z.boolean().optional()}).strict();

type Entry={input:z.ZodTypeAny;output:z.ZodTypeAny;title:string;service:string};
const entry=<I extends z.ZodTypeAny,O extends z.ZodTypeAny>(input:I,output:O,title:string,service:string)=>({input,output,title,service});
export const SOURCE_GOAL_OPERATIONS={
  'source.goal.setup.begin':entry(SourceGoalBeginRequestSchema,SourceGoalBeginReceiptSchema,'Create a followed reading topic','SourceGoalConversation.beginIn'),
  'source.goal.setup.message':entry(SourceGoalMessageRequestSchema,SourceGoalMessageReceiptSchema,'Send a topic setup message','SourceGoalConversation.sendIn'),
  'source.goal.setup.legacy':entry(SourceGoalLegacyRequestSchema,SourceGoalLegacyReceiptSchema,'Map a Source Monitor to a topic','mapLegacyGoal'),
  'source.goal.setup.compatibility_rollback':entry(SourceGoalCompatibilityRollbackSchema,SourceGoalRollbackCompatibilityReceiptSchema,'Return a mapped topic to its Monitor schedule','rollbackGoalCompatibility'),
  'source.goal.create':entry(SourceGoalCreateSchema,SourceGoalCreateReceiptSchema,'Create a collection goal','SourceGoalService.create'),
  'source.goal.edit':entry(SourceGoalEditSchema.extend(goal).strict(),SourceGoalEditReceiptSchema,'Edit a topic plan draft','editSourceGoal'),
  'source.goal.explore':entry(SourceGoalTargetInputSchema,SourceGoalQueuedRunReceiptSchema,'Queue topic planning','queueSourceGoalAgent'),
  'source.goal.preview.request':entry(SourceGoalPreviewInputSchema,SourceGoalPreviewReceiptSchema,'Queue a topic plan preview','SourceGoalService.admitPreview (Job)'),
  'source.goal.save':entry(SourceGoalSaveSampleSchema.extend(goal).strict(),SourceGoalSaveReceiptSchema,'Save a previewed topic as reading','SourceGoalService.saveSample'),
  'source.goal.follow':entry(SourceGoalFollowRequestSchema.extend(goal).strict(),SourceGoalFollowReceiptSchema,'Follow a topic','SourceGoalService.follow'),
  'source.goal.feedback':entry(SourceGoalFeedbackInputSchema,SourceGoalFeedbackReceiptSchema,'Narrow a followed topic','SourceGoalService.feedback'),
  'source.goal.check':entry(SourceGoalCheckRequestSchema.extend(goal).strict(),SourceGoalCheckReceiptSchema,'Check a followed topic now','requestGoalCheck'),
  'source.goal.resume':entry(SourceGoalResumeInputSchema,SourceGoalResumeReceiptSchema,'Resume a followed topic','SourceGoalService.resume'),
  'source.goal.pause':entry(SourceGoalPauseInputSchema,SourceGoalReceiptSchema,'Pause a followed topic','SourceGoalService.stop'),
  'source.goal.delete':entry(SourceGoalTargetInputSchema,SourceGoalReceiptSchema,'Delete a followed topic','SourceGoalService.stop'),
  'source.goal.binding.rollback':entry(SourceGoalBindingRollbackInputSchema,SourceGoalBindingReceiptSchema,'Restore a topic Source implementation','SourceGoalRepairService.rollback'),
  'source.goal.binding.confirm_source':entry(SourceGoalBindingConfirmInputSchema,SourceGoalBindingReceiptSchema,'Confirm a changed topic Source','confirmBindingSource'),
  'source.goal.repair.publish':entry(SourceGoalRepairPublishInputSchema,SourceGoalRepairPublishReceiptSchema,'Publish a validated topic Source repair','SourceGoalRepairService.publish'),
  'source.goal.theme.configure':entry(SourceGoalThemeConfigureInputSchema,SourceGoalThemeConfigureReceiptSchema,'Configure topic theme analysis','configureThemeAnalysis'),
  'source.goal.theme.retry':entry(SourceGoalThemeRetryInputSchema,SourceGoalThemeRoundReceiptSchema,'Retry a topic theme analysis','settleThemeRound'),
  'source.goal.theme.cancel':entry(SourceGoalThemeCancelInputSchema,SourceGoalThemeRoundReceiptSchema,'Cancel a topic theme analysis','cancelThemeRound'),
} as const satisfies Record<string,Entry>;
export type SourceGoalOperationId=keyof typeof SOURCE_GOAL_OPERATIONS;
export const SOURCE_GOAL_OPERATION_IDS=Object.keys(SOURCE_GOAL_OPERATIONS) as SourceGoalOperationId[];
export const SOURCE_GOAL_SCHEMAS=Object.fromEntries(Object.entries(SOURCE_GOAL_OPERATIONS).map(([k,v])=>[k,{input:v.input,output:v.output}])) as {[K in SourceGoalOperationId]:{input:(typeof SOURCE_GOAL_OPERATIONS)[K]['input'];output:(typeof SOURCE_GOAL_OPERATIONS)[K]['output']}};
