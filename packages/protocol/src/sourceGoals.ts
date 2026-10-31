/** Goal orchestration DTOs. These contain references, never credentials or host paths. */
import {z} from 'zod';
import {RuntimeSessionConfigSelectionSchema} from './hosts.js';
import {ActionPreviewSchema} from './memorySessions.js';
import {IdSchema} from './common.js';
import {SourceRecipeDefinitionSchema} from './sourceRecipes.js';
const JsonObject=z.record(z.string(),z.unknown());
export const SourceGoalBudgetSchema=z.object({
 requests_per_run:z.number().int().min(1).max(20).default(8),
 items_per_source:z.number().int().min(1).max(100).default(20),
 agent_attempts:z.number().int().min(1).max(3).default(2),
 repair_attempts:z.number().int().min(0).max(3).default(2),
 interval_seconds:z.number().int().min(3600).max(604800).default(86400),
}).strict();
export const SourceGoalCreateSchema=z.object({
 creation_key:z.string().min(1).max(128).optional(),
 intent:z.string().trim().min(3).max(8000),includes:z.array(z.string().max(200)).max(16).default([]),
 excludes:z.array(z.string().max(200)).max(16).default([]),project_id:IdSchema.nullish(),
 agent_id:IdSchema,runtime_profile_id:IdSchema,budget:SourceGoalBudgetSchema.default({requests_per_run:8,items_per_source:20,agent_attempts:2,repair_attempts:2,interval_seconds:86400}),
}).strict();
export const SourceGoalImplementationSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('agent_search'),query:z.string().trim().min(3).max(1000),route:z.object({profile_sha256:z.string().regex(/^[a-f0-9]{64}$/),agent_id:IdSchema,runtime_profile_id:IdSchema,session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32)}).optional()}).strict(),
 z.object({kind:z.literal('connector')}).strict(),
 z.object({kind:z.literal('recipe'),recipe:SourceRecipeDefinitionSchema}).strict(),
 z.object({kind:z.literal('isolated'),code:z.string().min(1).max(262144).describe('ES module default async ({input,request}) -> {items,cursor}. request(input.endpoint_url) returns {sequence,status,content_type,body_base64,final_url,headers}, NOT fetch Response. Decode JSON via JSON.parse(Buffer.from(response.body_base64, "base64").toString("utf8")). Each item needs stable external_id,title,source_uri,published_at,snapshots:[],evidence:[]. No native network, shell, dependencies or host paths.'),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const SourceGoalBindingSpecSchema=z.object({
 source_connection_id:IdSchema,source_channel_id:IdSchema,
 reason:z.string().min(1).max(2000),implementation:SourceGoalImplementationSchema,
 supports_history:z.boolean(),
}).strict();
export const SourceGoalPlanSchema=z.object({
 analysis_brief:z.string().trim().min(1).max(4000).describe('Analysis purpose for downstream reading: questions, comparison target, useful evidence and expected judgment. Derived from the user intent, not permissions or invented project facts.').optional(),
 title:z.string().trim().min(1).max(60).describe('Short topic label in the user language, ideally 4–12 Chinese characters or 2–6 words; summarize the subject, not the request.').optional(),
 search_path_snapshot:z.enum(['agent','api']).optional(),
 interval_seconds:z.number().int().min(3600).max(604800).optional(),
 filters:z.object({includes:z.array(z.string().max(200)).max(16),excludes:z.array(z.string().max(200)).max(16),excluded_origins:z.array(z.string().url()).max(20).default([])}).strict().optional(),
 intent_snapshot:z.object({intent:z.string().max(8000),includes:z.array(z.string()),excludes:z.array(z.string())}).optional(),
 summary:z.string().min(1).max(4000),sources:z.array(SourceGoalBindingSpecSchema).min(1).max(5),
 limitations:z.array(z.string().max(1000)).max(20),
}).strict().superRefine((p,c)=>{if(new Set(p.sources.map(s=>s.source_channel_id)).size!==p.sources.length || new Set(p.sources.map(s=>s.source_connection_id)).size!==p.sources.length)c.addIssue({code:'custom',message:'Duplicate source channel'});});
export const SourceGoalNativeSourceRequestSchema=z.object({reason:z.string().min(1).max(2000),implementation:z.object({kind:z.literal('agent_search'),query:z.string().trim().min(3).max(1000)}).strict(),supports_history:z.literal(false)}).strict();
export const SourceGoalVersionWriteSchema=z.object({goal_id:IdSchema,expected_revision:z.number().int().nonnegative(),plan:SourceGoalPlanSchema.or(z.object({analysis_brief:z.string().trim().min(1).max(4000).optional(),title:z.string().trim().min(1).max(60).optional(),summary:z.string().min(1).max(4000),sources:z.array(SourceGoalBindingSpecSchema.or(SourceGoalNativeSourceRequestSchema)).min(1).max(5),limitations:z.array(z.string().max(1000)).max(20),interval_seconds:z.number().int().min(3600).max(604800).optional(),filters:z.object({includes:z.array(z.string()),excludes:z.array(z.string()),excluded_origins:z.array(z.string()).default([])}).optional()}).strict())}).strict();
/** Optional manual save: the owner keeps one fresh exact-version Agent-search
 * preview as reading material without continuous following. Following itself
 * is SourceGoalFollowRequestSchema and never requires a preview. */
export const SourceGoalSaveSampleSchema=z.object({version_id:IdSchema,preview_id:IdSchema,idempotency_key:z.string().min(1).max(128)}).strict();
export type SourceGoalSaveSample=z.infer<typeof SourceGoalSaveSampleSchema>;
export const SourceGoalRepairSchema=z.object({binding_id:IdSchema,expected_revision:z.number().int().nonnegative(),implementation:SourceGoalImplementationSchema}).strict();
export const SourceGoalStatusSchema=z.enum(['draft','exploring','needs_information','preview_ready','running','paused','needs_intervention','deleted']);
export const SourceGoalExecutionProgressSchema=z.object({run_id:IdSchema,status:z.string(),phase:z.enum(['queued','working','waiting_for_approval','failed','cancelled','plan_ready','needs_information']),last_action:z.string().nullable(),pending_approvals:z.number().int().nonnegative(),block_reason:z.enum(['source_setup_incomplete','plan_source_unavailable','tool_failed']).nullish(),failure_reason:z.enum(['time_limit','run_failed']).nullable(),updated_at:z.string()}).strict();
export type SourceGoalExecutionProgress=z.infer<typeof SourceGoalExecutionProgressSchema>;
/** One owner confirmation that starts continuous following without a manual
 * preview. Omitted limits keep the goal's current budget; values stay inside
 * the same schema bounds as SourceGoalBudgetSchema. version_id pins an exact
 * plan; omitted means the current plan, or the first plan once prepared. */
export const SourceGoalFollowRequestSchema=z.object({
 idempotency_key:z.string().min(1).max(128),version_id:IdSchema.nullish(),
 interval_seconds:z.number().int().min(3600).max(604800).optional(),
 requests_per_run:z.number().int().min(1).max(20).optional(),
 items_per_source:z.number().int().min(1).max(100).optional(),
}).strict();
export type SourceGoalFollowRequest=z.infer<typeof SourceGoalFollowRequestSchema>;
/** Durable confirmed following intent (source_goals.follow_json). */
export const SourceGoalFollowSchema=z.object({
 confirmed_at:z.string(),confirmed_by_user_id:IdSchema,idempotency_key:z.string(),
 version_id:IdSchema.nullable(),interval_seconds:z.number().int(),requests_per_run:z.number().int(),items_per_source:z.number().int(),
 activated_version_id:IdSchema.nullable(),reused_preview_id:IdSchema.nullable(),last_error:z.string().nullable(),
 /** Owner feedback that only narrows what this topic selects (never widens scope). */
 rules:z.object({excluded_origins:z.array(z.string().url().max(2048)).max(50),excluded_terms:z.array(z.string().trim().min(1).max(200)).max(50)}).strict().optional(),
 /** Applied feedback as `key|payload-hash`; a reused key with another payload is refused. */
 feedback_keys:z.array(z.string().max(160)).max(50).optional(),
}).strict();
export type SourceGoalFollow=z.infer<typeof SourceGoalFollowSchema>;
/** Owner feedback on a followed topic. Only tightening is applied directly:
 * excluding an origin or term, marking one material not relevant, or slowing
 * down. Faster collection, larger budgets or new Sources go through follow and
 * the existing Source/credential gates instead. */
export const SourceGoalFeedbackRequestSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('exclude_origin'),idempotency_key:z.string().min(1).max(128),origin:z.string().url().max(2048)}).strict(),
 z.object({kind:z.literal('exclude_term'),idempotency_key:z.string().min(1).max(128),term:z.string().trim().min(1).max(200)}).strict(),
 z.object({kind:z.literal('not_relevant'),idempotency_key:z.string().min(1).max(128),source_item_id:IdSchema}).strict(),
 z.object({kind:z.literal('slow_down'),idempotency_key:z.string().min(1).max(128),interval_seconds:z.number().int().min(3600).max(604800)}).strict(),
]);
export type SourceGoalFeedbackRequest=z.infer<typeof SourceGoalFeedbackRequestSchema>;
export const SourceGoalSourceHealthSchema=z.enum(['ok','collecting','backoff','needs_permission','failing','stopped']);
/** Lifecycle projection over canonical goal/binding/collection/Run rows. The
 * four dimensions stay separate: missing permission is never "no new items". */
export const SourceGoalFollowStateSchema=z.object({
 intent:z.enum(['unconfirmed','following','paused','deleted']),pending_adjustment:z.boolean(),
 /** Collection audits in flight now: queued (waiting for a worker or Agent slot) and running. */
 collections:z.object({queued:z.number().int().nonnegative(),running:z.number().int().nonnegative()}).strict().default({queued:0,running:0}),
 phase:z.enum(['none','preparing','waiting_for_permission','first_collection','checking','scheduled','stopped','blocked']),
 blocked_reason:z.string().nullable(),
 health:z.enum(['unknown','ok','partial','needs_permission','failing']),
 sources:z.array(z.object({binding_id:IdSchema,source_connection_id:IdSchema,status:z.string(),health:SourceGoalSourceHealthSchema,error:z.string().nullable(),failures:z.number().int(),last_success_at:z.string().nullable(),retry_at:z.string().nullable(),
  /** What kind of decision a stopped source waits for: its Source changed and needs the topic owner's confirmation, access to it is missing, a usage limit was reached, or setup is incomplete. */
  attention:z.enum(['source_changed','access','budget','setup']).nullable().optional(),
  /** Who can resolve it: the viewer, the topic's owner, or nobody through this topic (the Source's owner or access must change first). */
  resolvable_by:z.enum(['you','topic_owner','source_owner']).nullable().optional()}).strict()),
 results:z.object({
  items_total:z.number().int().nonnegative(),important_total:z.number().int().nonnegative(),unjudged_total:z.number().int().nonnegative(),
  not_selected_total:z.number().int().nonnegative().default(0),judgment_failed_total:z.number().int().nonnegative().default(0),
  baseline_total:z.number().int().nonnegative().default(0),new_publication_total:z.number().int().nonnegative().default(0),
  evidenced_change_total:z.number().int().nonnegative().default(0),unknown_freshness_total:z.number().int().nonnegative().default(0),
  /** Recorded cited changes (release/update) after the first-collection window. */
  changes_total:z.number().int().nonnegative().default(0),
  last_outcome:z.enum(['never','new_items','no_new','partial','failed']),last_new_items:z.number().int().nonnegative().nullable(),last_new_changes:z.number().int().nonnegative().nullable().optional(),
  last_checked_at:z.string().nullable(),last_success_at:z.string().nullable(),next_check_at:z.string().nullable(),
 }).strict(),
}).strict();
export type SourceGoalFollowState=z.infer<typeof SourceGoalFollowStateSchema>;
export const SourceGoalOutSchema=z.object({
 id:IdSchema,space_id:IdSchema,owner_user_id:IdSchema,project_id:IdSchema.nullable(),
 execution:SourceGoalExecutionProgressSchema.nullish(),intent_json:JsonObject,budget_json:SourceGoalBudgetSchema,status:SourceGoalStatusSchema,
 revision:z.number().int(),current_version_id:IdSchema.nullable(),active_version_id:IdSchema.nullable(),
 follow_json:SourceGoalFollowSchema.nullish(),follow_state:SourceGoalFollowStateSchema.nullish(),
}).passthrough();
export type SourceGoalPlan=z.infer<typeof SourceGoalPlanSchema>;
export type SourceGoalBindingSpec=z.infer<typeof SourceGoalBindingSpecSchema>;
export type SourceGoalBudget=z.infer<typeof SourceGoalBudgetSchema>;
export type SourceGoalImplementation=z.infer<typeof SourceGoalImplementationSchema>;

export const SourceGoalLegacyRequestSchema=z.object({channel_id:IdSchema,dry_run:z.boolean().optional()}).strict();
export const SourceGoalCompatibilityRollbackSchema=z.object({goal_id:IdSchema}).strict();
export const SourceGoalMessageRequestSchema=z.object({search_path:z.enum(['agent','api']).optional(),goal_id:IdSchema,session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32).optional(),content:z.string().trim().min(1).max(8000),idempotency_key:z.string().min(1).max(128),agent_id:IdSchema.optional(),runtime_profile_id:IdSchema.optional()}).strict().refine(v=>!!v.agent_id===!!v.runtime_profile_id,{message:'Agent and runtime profile must be selected together'});
/** Topic creation. With `follow`, creating the topic and its one follow
 * confirmation (frequency and per-run budget) commit in one transaction keyed
 * by `idempotency_key`; `session_config` binds explicit model/mode choices of
 * the selected Profile before the first planning Run is queued. A replay with
 * the same key and payload returns the same topic; a changed payload is refused. */
export const SourceGoalBeginRequestSchema=z.object({search_path:z.enum(['agent','api']).optional(),idempotency_key:z.string().min(1).max(128).optional(),intent:z.string().trim().min(3).max(8000),project_id:IdSchema.nullish(),agent_id:IdSchema.optional(),runtime_profile_id:IdSchema.optional(),
 session_config:z.array(RuntimeSessionConfigSelectionSchema).max(32).optional(),
 follow:z.object({interval_seconds:z.number().int().min(3600).max(604800),requests_per_run:z.number().int().min(1).max(20),items_per_source:z.number().int().min(1).max(100)}).strict().optional(),
}).strict().refine(v=>!!v.agent_id===!!v.runtime_profile_id,{message:'Agent and runtime profile must be selected together'}).refine(v=>!v.session_config||!!v.agent_id,{message:'Model/mode choices require an explicitly selected Agent and runtime profile'}).refine(v=>!v.follow||!!v.idempotency_key,{message:'A confirmed creation requires an idempotency key'});
export type SourceGoalBeginRequest=z.infer<typeof SourceGoalBeginRequestSchema>;
export const SourceGoalContributionSchema=z.object({source_connection_id:IdSchema,source_kind:z.string().optional(),status:z.string(),error:z.string().optional(),output:z.object({items:z.array(z.object({external_id:z.string(),title:z.string(),source_uri:z.string(),published_at:z.string().nullish(),excerpt:z.string().nullish()}).passthrough())}).passthrough().optional(),selection:JsonObject.optional()}).passthrough();
/** One recorded cited change of a stable material for this topic (history). */
export const SourceGoalItemChangeSchema=z.object({id:IdSchema,source_item_id:IdSchema,change_kind:z.enum(['release','update']),evidence_url:z.string(),delivery_kind:z.enum(['baseline','evidenced_change']),selection_status:z.enum(['unjudged','important','not_selected','judgment_failed']),selection_reason:z.string().nullable(),judged_by:z.enum(['topic_rules','collection_agent','owner']).nullable(),goal_run_id:IdSchema,agent_run_id:IdSchema.nullable(),detected_at:z.string()}).passthrough();
/** A binding whose Source the viewer can no longer read: only identity and
 * state remain; its spec, fixture, cursor and gaps are deliberately omitted. */
export const SourceGoalUnavailableBindingSchema=z.object({id:IdSchema,goal_id:IdSchema,source_connection_id:IdSchema,status:z.string(),revision:z.number().int(),unavailable:z.literal(true),collection_error:z.literal('source_unavailable')}).strict();
export const SourceGoalDetailSchema=z.object({changes:z.array(SourceGoalItemChangeSchema).optional(),native_runs:z.array(z.object({id:IdSchema,status:z.string(),phase:z.string().optional(),version_id:IdSchema}).passthrough()).optional(),action_previews:z.array(ActionPreviewSchema).optional(),can_manage:z.boolean().optional(),legacy:z.object({id:IdSchema,source_connection_id:IdSchema,name:z.string(),channel_name:z.string(),status:z.string(),scheduler_owner:z.string(),schedule:z.object({status:z.string(),next_run_at:z.string().nullish(),last_run_at:z.string().nullish()}).nullish()}).nullish(),goal:SourceGoalOutSchema.extend({session_id:IdSchema.nullish(),legacy_channel_id:IdSchema.nullish(),compatibility_json:JsonObject.nullish()}),messages:z.array(z.object({id:IdSchema,role:z.string(),content:z.string(),run_id:IdSchema.nullish(),metadata_json:JsonObject.nullish()}).passthrough()).nullish(),versions:z.array(z.object({id:IdSchema,plan_json:SourceGoalPlanSchema,revision:z.number()}).passthrough()),previews:z.array(z.object({id:IdSchema,version_id:IdSchema,status:z.string(),expires_at:z.string(),result_json:z.object({observed_at:z.string().optional(),contributions:z.array(SourceGoalContributionSchema),limitations:z.array(z.string()).optional()}).passthrough()}).passthrough()),bindings:z.array(z.union([SourceGoalUnavailableBindingSchema,z.object({id:IdSchema,status:z.string(),collection_error:z.string().nullish(),repair_block_reason:z.enum(['source_repair_calibration_unavailable','source_authority_revoked','source_repair_validation_insufficient']).nullish(),spec_json:SourceGoalBindingSpecSchema,last_success_at:z.string().nullish(),retry_at:z.string().nullish(),gaps_json:z.array(JsonObject),cursor_json:JsonObject}).passthrough()])),agent_runs:z.array(z.object({id:IdSchema,status:z.string(),chat_completed:z.boolean().optional()}).passthrough()),schedule:z.object({next_run_at:z.string().nullish()}).passthrough().nullish(),repairs:z.array(JsonObject),runs:z.array(JsonObject)}).passthrough();
export type SourceGoalDetail=z.infer<typeof SourceGoalDetailSchema>;

/** Recognizable secret patterns only; arbitrary secrets cannot be detected. */
export const SourceGoalSafeTextSchema=z.string().refine(value=>!/\bBearer\s+\S{12,}|\bsk-(?:proj-)?[\w-]{16,}|(?:api[_ -]?key|password)\s*[:=]\s*\S{8,}/i.test(value),'source_goal_use_credential_channel');

/** What a binding stopped by a Source change would confirm (see the server's reconfirm.ts). */
export const SourceGoalBindingReconfirmationSchema=z.object({
 binding_id:IdSchema,binding_revision:z.number().int(),
 resolvable_by:z.enum(['you','topic_owner','source_access','not_needed']),
 source_name:z.string().nullable(),
 current:z.object({capture_policy:z.string().nullable(),retention_policy:z.string().nullable(),source_status:z.string(),channel_status:z.string(),uses_credential:z.boolean()}).strict().nullable(),
 changed:z.array(z.string()).nullable(),
 related_changes:z.array(z.object({kind:z.string(),at:z.string()}).strict()),
 authority:z.string().nullable(),
}).strict();
export type SourceGoalBindingReconfirmation=z.infer<typeof SourceGoalBindingReconfirmationSchema>;
/** The owner confirms exactly what was shown: the binding revision and the Source state token. */
export const SourceGoalBindingConfirmRequestSchema=z.object({binding_revision:z.number().int().nonnegative(),authority:z.string().min(16).max(128)}).strict();
export type SourceGoalBindingConfirmRequest=z.infer<typeof SourceGoalBindingConfirmRequestSchema>;

/** Manual collection binds to the active plan currently shown; null is legacy-only. */
export const SourceGoalCheckRequestSchema=z.object({expected_version_id:IdSchema.nullable()}).strict();
