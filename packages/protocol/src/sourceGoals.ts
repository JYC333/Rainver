/** Goal orchestration DTOs. These contain references, never credentials or host paths. */
import {z} from 'zod';
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
 interval_seconds:z.number().int().min(3600).max(604800).optional(),
 filters:z.object({includes:z.array(z.string().max(200)).max(16),excludes:z.array(z.string().max(200)).max(16),excluded_origins:z.array(z.string().url()).max(20).default([])}).strict().optional(),
 intent_snapshot:z.object({intent:z.string().max(8000),includes:z.array(z.string()),excludes:z.array(z.string())}).optional(),
 summary:z.string().min(1).max(4000),sources:z.array(SourceGoalBindingSpecSchema).min(1).max(5),
 limitations:z.array(z.string().max(1000)).max(20),
}).strict().superRefine((p,c)=>{if(new Set(p.sources.map(s=>s.source_channel_id)).size!==p.sources.length || new Set(p.sources.map(s=>s.source_connection_id)).size!==p.sources.length)c.addIssue({code:'custom',message:'Duplicate source channel'});});
export const SourceGoalVersionWriteSchema=z.object({goal_id:IdSchema,expected_revision:z.number().int().nonnegative(),plan:SourceGoalPlanSchema}).strict();
export const SourceGoalStartSchema=z.object({version_id:IdSchema,preview_id:IdSchema,idempotency_key:z.string().min(1).max(128)}).strict();
export const SourceGoalRepairSchema=z.object({binding_id:IdSchema,expected_revision:z.number().int().nonnegative(),implementation:SourceGoalImplementationSchema}).strict();
export const SourceGoalStatusSchema=z.enum(['draft','exploring','needs_information','preview_ready','running','paused','needs_intervention','deleted']);
export const SourceGoalOutSchema=z.object({
 id:IdSchema,space_id:IdSchema,owner_user_id:IdSchema,project_id:IdSchema.nullable(),
 intent_json:JsonObject,budget_json:SourceGoalBudgetSchema,status:SourceGoalStatusSchema,
 revision:z.number().int(),current_version_id:IdSchema.nullable(),active_version_id:IdSchema.nullable(),
}).passthrough();
export type SourceGoalPlan=z.infer<typeof SourceGoalPlanSchema>;
export type SourceGoalBindingSpec=z.infer<typeof SourceGoalBindingSpecSchema>;
export type SourceGoalBudget=z.infer<typeof SourceGoalBudgetSchema>;
export type SourceGoalImplementation=z.infer<typeof SourceGoalImplementationSchema>;

export const SourceGoalLegacyRequestSchema=z.object({channel_id:IdSchema,dry_run:z.boolean().optional()}).strict();
export const SourceGoalCompatibilityRollbackSchema=z.object({goal_id:IdSchema}).strict();
export const SourceGoalMessageRequestSchema=z.object({goal_id:IdSchema,content:z.string().trim().min(1).max(8000),idempotency_key:z.string().min(1).max(128)}).strict();
export const SourceGoalBeginRequestSchema=z.object({idempotency_key:z.string().min(1).max(128).optional(),intent:z.string().trim().min(3).max(8000),project_id:IdSchema.nullish()}).strict();
export const SourceGoalContributionSchema=z.object({source_connection_id:IdSchema,source_kind:z.string().optional(),status:z.string(),error:z.string().optional(),output:z.object({items:z.array(z.object({external_id:z.string(),title:z.string(),source_uri:z.string(),published_at:z.string().nullish(),excerpt:z.string().nullish()}).passthrough())}).passthrough().optional(),selection:JsonObject.optional()}).passthrough();
export const SourceGoalDetailSchema=z.object({can_manage:z.boolean().optional(),legacy:z.object({id:IdSchema,source_connection_id:IdSchema,name:z.string(),channel_name:z.string(),status:z.string(),scheduler_owner:z.string(),schedule:z.object({status:z.string(),next_run_at:z.string().nullish(),last_run_at:z.string().nullish()}).nullish()}).nullish(),goal:SourceGoalOutSchema.extend({session_id:IdSchema.nullish(),legacy_channel_id:IdSchema.nullish(),compatibility_json:JsonObject.nullish()}),messages:z.array(z.object({id:IdSchema,role:z.string(),content:z.string(),run_id:IdSchema.nullish(),metadata_json:JsonObject.nullish()}).passthrough()).nullish(),versions:z.array(z.object({id:IdSchema,plan_json:SourceGoalPlanSchema,revision:z.number()}).passthrough()),previews:z.array(z.object({id:IdSchema,version_id:IdSchema,status:z.string(),expires_at:z.string(),result_json:z.object({observed_at:z.string().optional(),contributions:z.array(SourceGoalContributionSchema),limitations:z.array(z.string()).optional()}).passthrough()}).passthrough()),bindings:z.array(z.object({id:IdSchema,status:z.string(),repair_block_reason:z.enum(['source_repair_calibration_unavailable','source_authority_revoked','source_repair_validation_insufficient']).nullish(),spec_json:SourceGoalBindingSpecSchema,last_success_at:z.string().nullish(),retry_at:z.string().nullish(),gaps_json:z.array(JsonObject),cursor_json:JsonObject}).passthrough()),agent_runs:z.array(z.object({id:IdSchema,status:z.string()}).passthrough()),schedule:z.object({next_run_at:z.string().nullish()}).passthrough().nullish(),repairs:z.array(JsonObject),runs:z.array(JsonObject)}).passthrough();
export type SourceGoalDetail=z.infer<typeof SourceGoalDetailSchema>;

/** Recognizable secret patterns only; arbitrary secrets cannot be detected. */
export const SourceGoalSafeTextSchema=z.string().refine(value=>!/\bBearer\s+\S{12,}|\bsk-(?:proj-)?[\w-]{16,}|(?:api[_ -]?key|password)\s*[:=]\s*\S{8,}/i.test(value),'source_goal_use_credential_channel');
