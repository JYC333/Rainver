import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
export const ResearchAdhocInputSchema=z.object({project_id:id,prompt:z.string().transform(value=>value.trim().slice(0,4000)).pipe(z.string().min(1)),section_key:z.string().trim().min(1).max(512).default('understanding'),source_item_ids:z.array(id).max(20).default([]),execution:z.object({model_provider_id:id.optional(),model_name:z.string().trim().min(1).max(512).optional()}).strict().default({})}).strict();
export const ResearchAdhocReceiptSchema=z.object({run_id:id,job_id:id,note_id:id,space_id:id,project_id:id,status:z.literal('queued'),daily_limit:z.number().int().positive(),daily_used:z.number().int().positive()}).strict();
