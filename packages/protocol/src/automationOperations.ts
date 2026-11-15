import {z} from 'zod';
import {IdSchema} from './common.js';
import type {JsonValue} from './jsonSafety.js';

// Target configs and Workflow inputs are intentionally JSON extension points.
// Validate actual JSON recursively; functions, undefined and nonfinite numbers
// are never accepted. The owner retains its size/depth/secret and target gates.
const json:z.ZodType<JsonValue>=z.lazy(()=>z.union([z.string(),z.number().finite(),z.boolean(),z.null(),z.array(json),z.record(json)]));
export const AutomationJsonRecordSchema=z.record(json);
const text=z.string().min(1);
export const AutomationCreateBodySchema=z.object({
 name:text.max(256),agent_id:IdSchema,project_folder_id:IdSchema.nullish(),project_id:IdSchema.nullish(),
 description:z.string().nullish(),trigger_type:z.enum(['manual','schedule']).nullish(),
 config_json:AutomationJsonRecordSchema.nullish(),
}).strict();
export const AutomationUpdateBodySchema=z.object({
 name:text.max(256).nullish(),description:z.string().nullish(),status:z.enum(['active','paused','archived']).nullish(),
 config_json:AutomationJsonRecordSchema.nullish(),project_id:IdSchema.nullish(),
}).strict();
export const AutomationAutonomyBodySchema=z.object({
 agent_id:IdSchema,name:text.max(256).nullish(),observe_only:z.boolean().optional(),
 autonomy_budget:AutomationJsonRecordSchema.optional(),project_ids:z.array(text).optional(),
 runtime_profile_id:IdSchema.nullish(),cron:text.nullish(),timezone:text.nullish(),
}).strict();
export const AutomationOutSchema=z.object({
 id:IdSchema,space_id:IdSchema,access:z.enum(['full','ops']),owner_user_id:IdSchema,agent_id:IdSchema,
 project_folder_id:IdSchema.nullable(),project_id:IdSchema.nullable(),name:z.string().nullable(),description:z.string().nullable(),
 trigger_type:z.enum(['manual','schedule']),status:z.enum(['active','paused','archived']),
 preflight_snapshot_json:AutomationJsonRecordSchema.nullable(),config_json:AutomationJsonRecordSchema.nullable(),
 next_run_at:z.string().nullable(),last_fired_at:z.string().nullable(),created_at:z.string(),updated_at:z.string(),
}).strict();
export const AUTOMATION_CONFIGURATION_OPERATION_SCHEMAS={
 'automation.create':{input:AutomationCreateBodySchema.extend({space_id:IdSchema}),output:AutomationOutSchema},
 'automation.update':{input:AutomationUpdateBodySchema.extend({space_id:IdSchema,automation_id:IdSchema}),output:AutomationOutSchema},
 'automation.autonomy.configure':{input:AutomationAutonomyBodySchema.extend({space_id:IdSchema}),output:AutomationOutSchema},
} as const;
export type AutomationCreateBody=z.infer<typeof AutomationCreateBodySchema>;
export type AutomationUpdateBody=z.infer<typeof AutomationUpdateBodySchema>;
export type AutomationAutonomyBody=z.infer<typeof AutomationAutonomyBodySchema>;
export type AutomationOut=z.infer<typeof AutomationOutSchema>;

export const AUTOMATION_FIRE_JOB='automation_fire';
export const AutomationFireBodySchema=z.object({prompt:z.string().nullable().optional(),instruction:z.string().nullable().optional(),trigger_type:z.literal('manual').optional()}).strict();
export const AutomationFireInputSchema:z.ZodType<{space_id:string;automation_id:string;prompt?:string|null;instruction?:string|null;trigger_type?:'manual'}>=AutomationFireBodySchema.extend({space_id:IdSchema,automation_id:IdSchema});
export const AutomationFireReceiptSchema:z.ZodType<{space_id:string;automation_id:string;job_id:string;status:'pending'}>=z.object({space_id:IdSchema,automation_id:IdSchema,job_id:IdSchema,status:z.literal('pending')}).strict();
export const AutomationFireRequestSchema=z.object({status:z.enum(['pending','claimed','running','completed','failed','cancelled']),result:AutomationJsonRecordSchema.nullable(),outcome:z.enum(['pending','completed','failed','unknown']),error:z.string().nullable()}).strict();
export const AUTOMATION_FIRE_OPERATION_SCHEMAS={'automation.fire':{input:AutomationFireInputSchema,output:AutomationFireReceiptSchema}} as const;
export type AutomationFireBody=z.infer<typeof AutomationFireBodySchema>;
export type AutomationFireReceipt=z.infer<typeof AutomationFireReceiptSchema>;
export type AutomationFireRequest=z.infer<typeof AutomationFireRequestSchema>;
