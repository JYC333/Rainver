import { z } from "zod";

export const ManagedHostEgressModeSchema = z.enum(["direct", "system_tun", "http_proxy"]);
export type ManagedHostEgressMode = z.infer<typeof ManagedHostEgressModeSchema>;

/** Instance-admin-adjustable operating policy; deployment secrets and paths stay out of this DTO. */
export const InstanceOperationsSettingsSchema = z.object({
  backup_service_enabled: z.boolean(),
  backup_interval_hours: z.number().int().min(1).max(168),
  backup_retention_count: z.number().int().min(1).max(365),
  backup_include_logs: z.boolean(),
  backup_on_startup: z.boolean(),
  content_access_log_retention_enabled: z.boolean(),
  content_access_log_retention_days: z.number().int().min(1).max(3650),
  managed_host_egress_mode: ManagedHostEgressModeSchema,
  managed_host_proxy_url: z.string().nullable(),
  managed_host_no_proxy: z.string().nullable(),
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
  managed_host_egress_mode: ManagedHostEgressModeSchema.optional(),
  managed_host_proxy_url: z.string().nullable().optional(),
  managed_host_no_proxy: z.string().nullable().optional(),
}).strict();
export type InstanceOperationsSettingsUpdate = z.infer<typeof InstanceOperationsSettingsUpdateSchema>;
