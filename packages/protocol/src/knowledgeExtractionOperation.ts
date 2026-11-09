import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
export const KnowledgeExtractionInputSchema=z.object({project_id:id,source_kind:z.enum(['note','inquiry_thread','experiment_interpretation']),source_id:id,agent_id:id,runtime_profile_id:id.nullable().default(null)}).strict();
export const KnowledgeExtractionReceiptSchema=z.object({run_id:id,space_id:id,status:z.literal('queued')}).strict();
