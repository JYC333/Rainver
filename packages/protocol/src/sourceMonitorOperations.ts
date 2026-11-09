import {z} from 'zod';
import {SourceChannelSchema,SourceChannelStatusSchema,SourceFetchFrequencySchema} from './sourceChannels.js';
const id=z.string().trim().min(1).max(36);
export const SourceMonitorTargetSchema=z.object({source_channel_id:id}).strict();
export const SourceMonitorChangesSchema=z.object({
  source_name:z.string().trim().min(1).max(512).optional(),name:z.string().trim().min(1).max(512).optional(),
  status:SourceChannelStatusSchema.optional(),fetch_frequency:SourceFetchFrequencySchema.optional(),
  schedule_rule:z.record(z.unknown()).nullable().optional(),query:z.record(z.unknown()).optional(),endpoint_url:z.string().url().nullable().optional(),
}).strict().refine(value=>Object.keys(value).length>0,'At least one change is required');
export const SourceMonitorUpdateSchema=SourceMonitorTargetSchema.extend({changes:SourceMonitorChangesSchema}).strict();
export const SourceMonitorOutputSchema=SourceChannelSchema;
/** Receipt of durable enqueue, not completion of the external scan. */
export const SourceMonitorScanOutputSchema=z.object({id,space_id:id,connection_id:id,job_type:z.literal('connection_scan'),status:z.literal('pending'),metadata_json:z.object({source_channel_id:id,created_by:z.literal('manual_scan')}).strict(),created_at:z.string().datetime()}).strict();
