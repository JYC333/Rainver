import {z} from 'zod';
const id=z.string().trim().min(1).max(36);
const options={
  binding_key:z.string().trim().min(1).max(128).nullable().optional(),
  priority:z.coerce.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  delivery_scope:z.enum(['project_members','source_subscribers']).nullable().optional(),
  collection_notifications_enabled:z.boolean().nullable().optional(),standing_comparison_enabled:z.boolean().nullable().optional(),
  filters:z.record(z.unknown()).nullable().optional(),routing_policy:z.record(z.unknown()).nullable().optional(),extraction_policy:z.record(z.unknown()).nullable().optional(),
};
export const ProjectSourceBindInputSchema=z.object({project_id:id,source_channel_id:id,...options,backfill_history:z.boolean().nullable().optional()}).strict();
export const ProjectSourceTargetSchema=z.object({project_id:id,binding_id:id}).strict();
export const ProjectSourceUpdateInputSchema=ProjectSourceTargetSchema.extend({changes:z.object({...options,status:z.enum(['active','paused','archived']).nullable().optional()}).strict()}).strict();
export const ProjectSourceBackfillOutputSchema=z.object({binding_id:id,project_id:id,source_channel_id:id,created_links:z.number().int().nonnegative(),reactivated_links:z.number().int().nonnegative(),archived_links:z.number().int().nonnegative(),evidence_links:z.number().int().nonnegative()}).strict();
export const ProjectSourceBindingOutputSchema=z.object({
  id,space_id:id,project_id:id,source_channel_id:id,binding_key:z.string(),status:z.enum(['active','paused','archived']),priority:z.number().int(),
  delivery_scope:z.enum(['project_members','source_subscribers']),collection_notifications_enabled:z.boolean(),standing_comparison_enabled:z.boolean(),
  filters_json:z.record(z.unknown()),routing_policy_json:z.record(z.unknown()),extraction_policy_json:z.record(z.unknown()),
  extraction_profile:z.object({key:z.string(),display_name:z.string(),entity_type:z.string(),graph_lens_id:z.string().nullable()}).strict().nullable().optional(),
  created_by_user_id:id.nullable(),created_at:z.string(),updated_at:z.string(),backfill_result:ProjectSourceBackfillOutputSchema.optional(),
}).strict();
export const ProjectSourceUnbindOutputSchema=z.object({id,status:z.literal('archived')}).strict();
