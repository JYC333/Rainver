import {z} from 'zod';
import {IdSchema,ISODateTimeSchema} from './common.js';
const filter=z.object({max_items:z.number().int().min(1).max(50).optional()}).strict();
const input=z.object({
 target_space_id:IdSchema,target_run_id:IdSchema,access_mode:z.literal('summary_only'),
 read_expires_in_seconds:z.number().int().min(60).max(86400).optional(),
 memory_filter:filter.nullable().optional(),
}).strict();
const grant=z.object({
 id:IdSchema,granting_user_id:IdSchema,personal_space_id:IdSchema,target_space_id:IdSchema,target_run_id:IdSchema,
 target_agent_id:z.null(),grant_scope:z.literal('run'),access_mode:z.literal('summary_only'),
 status:z.enum(['active','consuming','used','revoked','expired','failed']),memory_filter_json:filter.nullable(),
 read_expires_at:ISODateTimeSchema,revoked_at:ISODateTimeSchema.nullable(),used_at:ISODateTimeSchema.nullable(),
 created_at:ISODateTimeSchema,updated_at:ISODateTimeSchema,
}).strict();
export const PERSONAL_MEMORY_GRANT_OPERATION_SCHEMAS={
 'personal_memory_grant.preview':{input,output:z.object({
  eligible:z.literal(true),target_space_id:IdSchema,target_run_id:IdSchema,access_mode:z.literal('summary_only'),
  proposed_read_expires_at:ISODateTimeSchema,warnings:z.array(z.string()),excluded_sensitivity_levels:z.array(z.string()),max_items:z.number().int().nullable(),
 }).strict()},
 'personal_memory_grant.create':{input,output:grant},
 'personal_memory_grant.revoke':{input:z.object({grant_id:IdSchema}).strict(),output:grant},
} as const;
