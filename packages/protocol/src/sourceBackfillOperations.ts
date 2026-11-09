import {z} from 'zod';
const id=z.string().min(1).max(36);
export const SourceBackfillStrategySchema=z.object({
  window_unit:z.enum(['date_window','page_cursor','id_cursor']).default('date_window'),
  history_mode:z.enum(['bounded_range','all_available','current_snapshot']).default('bounded_range'),
  from:z.string().trim().nullable().default(null),to:z.string().trim().nullable().default(null),
  window_size:z.coerce.number().int().min(1).max(365).default(30),
  max_items:z.coerce.number().int().min(1).max(10000).default(100),
  direction:z.literal('backward').default('backward'),
  monitoring_field:z.enum(['submittedDate','lastUpdatedDate']).default('submittedDate'),
}).strict();
export const SourceBackfillQuotaSchema=z.object({window:z.enum(['minute','hour','day']).default('minute'),limit_count:z.coerce.number().int().min(1).max(1000).default(10)}).strict();
export const SourceBackfillPreviewInputSchema=z.object({source_channel_id:id,strategy:SourceBackfillStrategySchema.default({}),quota_policy:SourceBackfillQuotaSchema.default({})}).strict();
export const SourceBackfillCreateInputSchema=SourceBackfillPreviewInputSchema.extend({
  // Domain uniqueness is also used by internal orchestration, independently
  // of the explicit core request header. Neither key replaces the other.
  idempotency_key:z.string().trim().min(1).max(256),
  project_source_binding_id:id.nullable().default(null),project_operation_id:id.nullable().default(null),
}).strict();
export const SourceBackfillControlInputSchema=z.object({source_channel_id:id,source_backfill_plan_id:id}).strict();
export const SourceBackfillPreviewOutputSchema=z.object({
  strategy:SourceBackfillStrategySchema,quota_policy:SourceBackfillQuotaSchema,
  segments:z.array(z.object({from:z.string().optional(),to:z.string().optional(),cursor:z.number().optional(),max_items:z.number(),monitoring_field:z.enum(['submittedDate','lastUpdatedDate']).optional()}).strict()),
}).strict();
export const SourceBackfillReceiptSchema=z.object({plan_id:id,source_channel_id:id,status:z.enum(['draft','proposed','approved','running','paused','completed','failed','cancelled'])}).strict();
export type SourceBackfillStrategy=z.output<typeof SourceBackfillStrategySchema>;
