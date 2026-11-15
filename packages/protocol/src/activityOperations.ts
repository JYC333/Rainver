import {z} from 'zod';
import {CaptureRequestSchema,CaptureResponseSchema,RelocationRequestSchema,RelocationResponseSchema} from './capture.js';
import {ProposalOutSchema} from './proposals.js';
import {IdSchema,ISODateTimeSchema} from './common.js';
export const ActivityRecordOutputSchema=z.object({
 id:IdSchema,space_id:IdSchema,user_id:IdSchema.nullable(),project_folder_id:IdSchema.nullable(),agent_id:IdSchema.nullable(),
 source_type:z.string(),title:z.string().nullable(),content:z.string(),source_run_id:IdSchema.nullable(),source_task_id:IdSchema.nullable(),source_session_id:IdSchema.nullable(),source_url:z.string().nullable(),
 status:z.string(),metadata_json:z.record(z.string(),z.unknown()),aggregate_key:z.string().nullable(),visibility:z.string(),access_level:z.string(),owner_user_id:IdSchema.nullable(),
 occurred_at:ISODateTimeSchema.nullable(),created_at:ISODateTimeSchema,updated_at:ISODateTimeSchema,project_id:IdSchema.nullable(),
}).strict();
const settingFields={enabled:z.boolean(),local_time:z.string().regex(/^\d{2}:\d{2}$/),timezone:z.string().min(1),include_source_types:z.array(z.string()),create_experience_proposals:z.boolean(),create_memory_proposals:z.boolean(),experience_confidence_threshold:z.number().min(0).max(1),memory_confidence_threshold:z.number().min(0).max(1),max_experience_proposals_per_day:z.number().int().min(0).max(20),max_memory_proposals_per_day:z.number().int().min(0).max(10)};
export const DailyCaptureSettingPatchSchema=z.object(settingFields).partial().strict();
const settingOutput=z.object({...settingFields,id:IdSchema,space_id:IdSchema,user_id:IdSchema,last_report_date:z.string().nullable(),next_run_at:ISODateTimeSchema.nullable(),created_at:ISODateTimeSchema,updated_at:ISODateTimeSchema}).strict();
const activityTarget=z.object({activity_id:IdSchema}).strict();
const activityCreate=z.object({source_type:z.string().trim().min(1),content:z.string().trim().min(1),title:z.string().nullish(),source_url:z.string().nullish(),project_id:IdSchema.nullish(),project_folder_id:IdSchema.nullish(),user_id:IdSchema.optional(),agent_id:IdSchema.nullish(),source_run_id:IdSchema.nullish(),source_task_id:IdSchema.nullish(),source_session_id:IdSchema.nullish(),occurred_at:ISODateTimeSchema.nullish(),metadata_json:z.record(z.string(),z.unknown()).optional(),visibility:z.enum(['private','selected_users','space_shared']).optional()}).strict();
export const ACTIVITY_OPERATION_SCHEMAS={
 'daily_capture.run':{input:z.object({local_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),create_experience_proposals:z.boolean().nullish(),create_memory_proposals:z.boolean().nullish()}).strict(),output:z.object({job_id:IdSchema,run_id:IdSchema,user_id:IdSchema,status:z.enum(['queued','running','completed']),result:z.record(z.string(),z.unknown()).optional()}).strict()},
 'capture.relocate':{input:RelocationRequestSchema.extend({activity_id:IdSchema}).strict(),output:RelocationResponseSchema},
 'activity.summary.request':{input:z.object({activity_ids:z.array(IdSchema).max(100).optional(),evidence_ids:z.array(IdSchema).max(100).optional(),source_item_ids:z.array(IdSchema).max(100).optional(),summary_goal:z.string().nullish(),create_memory_proposal:z.boolean().optional(),create_knowledge_proposal:z.boolean().optional()}).strict(),output:z.object({job_id:IdSchema,user_id:IdSchema,status:z.enum(['queued','claimed','running','completed']).optional(),result:z.record(z.string(),z.unknown()).nullable().optional()}).strict()},
 'activity.create':{input:activityCreate,output:ActivityRecordOutputSchema},
 'activity.upload':{input:z.object({kind:z.enum(['file','voice']).default('file'),filename:z.string().max(1024),content_type:z.string().min(1).max(255),content_base64:z.string().min(4).max(Math.ceil(25*1024*1024/3)*4).regex(/^[A-Za-z0-9+/]*={0,2}$/),title:z.string().max(32768).optional(),note:z.string().max(32768).optional(),project_id:IdSchema.optional(),project_folder_id:IdSchema.optional()}).strict(),output:z.object({job_id:IdSchema,activity_id:IdSchema,status:z.literal('queued')}).strict()},
 'capture.create':{input:CaptureRequestSchema,output:CaptureResponseSchema},
 'activity.consolidate':{input:activityTarget,output:z.array(ProposalOutSchema)},
 'activity.review':{input:activityTarget,output:ActivityRecordOutputSchema},
 'activity.archive':{input:activityTarget,output:ActivityRecordOutputSchema},
 'daily_capture.settings.patch':{input:DailyCaptureSettingPatchSchema,output:settingOutput},
 'daily_capture.settings.set':{input:DailyCaptureSettingPatchSchema,output:settingOutput},
} as const;
