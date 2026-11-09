import {z} from 'zod';
const id=z.string().trim().min(1).max(36), json=z.record(z.unknown());
const fields={name:z.string().nullable().optional(),agent_id:id.nullable().optional(),project_id:id.nullable().optional(),trigger_type:z.enum(['items_materialized','schedule','manual']).optional(),trigger_config_json:json.optional(),input_config_json:json.optional(),actions_json:json.optional()};
export const SourceProcessingCreateSchema=z.object({source_channel_id:id,rule:z.object({...fields,agent_id:id.nullable().default(null),project_id:id.nullable().default(null)}).strict()}).strict();
export const SourceProcessingUpdateSchema=z.object({source_channel_id:id,rule_id:id,changes:z.object({...fields,status:z.enum(['active','paused','archived']).nullable().optional()}).strict().refine(x=>Object.keys(x).length>0)}).strict();
export const SourceProcessingDispatchSchema=z.object({source_channel_id:id,rule_id:id,mode:z.enum(['run','drain']).default('run')}).strict();
export const SourceExtractionDispatchSchema=z.object({extraction_job_id:id}).strict();
export const SourceDispatchReceiptSchema=z.object({job_id:id.nullable(),status:z.enum(['pending','noop']),source_channel_id:id.nullable(),extraction_job_id:id.nullable(),extraction_status:z.string().nullable()}).strict();
export const SourceProcessingRuleSchema=z.object({id,space_id:id,source_channel_id:id,agent_id:id,project_id:id.nullable(),name:z.string(),status:z.enum(['active','paused','archived']),trigger_type:z.enum(['items_materialized','schedule','manual']),trigger_config_json:json,input_config_json:json,actions_json:json,cursor_json:json.nullable(),last_fired_at:z.string().nullable(),next_run_at:z.string().nullable(),created_by_user_id:id,created_at:z.string(),updated_at:z.string()}).strict();
