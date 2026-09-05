import { z } from "zod";

/** Instance-admin-adjustable operating policy; deployment secrets and paths stay out of this DTO. */
export const InstanceOperationsSettingsSchema = z.object({
  backup_service_enabled: z.boolean(),
  backup_interval_hours: z.number().int().min(1).max(168),
  backup_retention_count: z.number().int().min(1).max(365),
  backup_include_logs: z.boolean(),
  backup_on_startup: z.boolean(),
  content_access_log_retention_enabled: z.boolean(),
  content_access_log_retention_days: z.number().int().min(1).max(3650),
  updated_at: z.string().datetime().nullable(),
}).passthrough();
export type InstanceOperationsSettings = z.infer<typeof InstanceOperationsSettingsSchema>;

export const InstanceOperationsSettingsUpdateSchema = z.object({
  backup_interval_hours: z.number().int().min(1).max(168).optional(),
  backup_retention_count: z.number().int().min(1).max(365).optional(),
  backup_include_logs: z.boolean().optional(),
  backup_on_startup: z.boolean().optional(),
  content_access_log_retention_enabled: z.boolean().optional(),
  content_access_log_retention_days: z.number().int().min(1).max(3650).optional(),
}).strict();
export type InstanceOperationsSettingsUpdate = z.infer<typeof InstanceOperationsSettingsUpdateSchema>;
