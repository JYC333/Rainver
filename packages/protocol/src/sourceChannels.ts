import { z } from "zod";

export const SourceProviderStatusSchema = z.enum(["active", "disabled"]);

export const SourceConnectorStatusSchema = z.enum(["active", "disabled"]);

export const SourceChannelStatusSchema = z.enum(["active", "paused", "archived"]);

export const SourceChannelTypeSchema = z.enum(["search", "feed", "web_page", "custom_source"]);

export const SourceFetchFrequencySchema = z.enum(["manual", "hourly", "daily", "weekly"]);

export const SourceProviderCategoryOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
}).passthrough();
export type SourceProviderCategoryOption = z.infer<typeof SourceProviderCategoryOptionSchema>;

export const SourceProviderCategoryGroupSchema = z.object({
  group: z.string().min(1),
  options: z.array(SourceProviderCategoryOptionSchema),
}).passthrough();
export type SourceProviderCategoryGroup = z.infer<typeof SourceProviderCategoryGroupSchema>;

/**
 * Setup guidance a Provider offers the channel-creation form. Only arXiv
 * declares category groups today; the shape stays open because the catalog
 * owns which providers publish what.
 */
export const SourceProviderSetupSchemaSchema = z.object({
  category_groups: z.array(SourceProviderCategoryGroupSchema).optional(),
}).passthrough();
export type SourceProviderSetupSchema = z.infer<typeof SourceProviderSetupSchemaSchema>;

export const SourceProviderSchema = z.object({
  id: z.string().min(1),
  provider_key: z.string().min(1),
  display_name: z.string().min(1),
  provider_kind: z.enum(["named", "generic"]),
  category: z.string().min(1),
  status: SourceProviderStatusSchema,
  capabilities: z.record(z.unknown()),
  config_schema: z.record(z.unknown()).nullable(),
  setup_schema: SourceProviderSetupSchemaSchema.nullable().optional(),
}).passthrough();
export type SourceProvider = z.infer<typeof SourceProviderSchema>;

export const SourceConnectorSchema = z.object({
  id: z.string().min(1),
  connector_key: z.string().min(1),
  display_name: z.string().min(1),
  connector_type: z.string().min(1),
  ingestion_mode: z.enum(["pull", "manual", "internal"]),
  status: SourceConnectorStatusSchema,
  capabilities: z.record(z.unknown()),
  config_schema: z.record(z.unknown()).nullable(),
}).passthrough();
export type SourceConnector = z.infer<typeof SourceConnectorSchema>;

export const SourceProviderConnectorSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string().min(1),
  connector_id: z.string().min(1),
  status: SourceConnectorStatusSchema,
  priority: z.number().int().nonnegative(),
  capabilities: z.record(z.unknown()),
  config_schema: z.record(z.unknown()).nullable(),
}).passthrough();

export const SourceChannelQuerySchema = z.record(z.unknown());

export const SourceChannelCapabilitiesSchema = z.object({
  search: z.boolean().optional(),
  supports_full_history: z.boolean().optional(),
  supports_cursor: z.boolean().optional(),
  supports_conditional_fetch: z.boolean().optional(),
  date_fields: z.array(z.string()).optional(),
  dedupe_keys: z.array(z.string()).optional(),
}).passthrough();

export const SourceChannelScanStateSchema = z.object({
  status: z.string().nullable(),
  cursor: z.record(z.unknown()),
  watermark: z.record(z.unknown()),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
}).passthrough();

/**
 * The values the `source_channels.capture_policy` CHECK constraint allows.
 * The read model used to declare a bare string, which is looser than both the
 * database and the create request.
 */
export const SourceChannelCapturePolicySchema = z.enum([
  "reference_only",
  "extract_text",
  "archive_original",
]);

export const SourceChannelSchema = z.object({
  id: z.string().min(1),
  space_id: z.string().min(1),
  source_connection_id: z.string().min(1),
  source_name: z.string().min(1),
  name: z.string().min(1),
  channel_type: SourceChannelTypeSchema,
  endpoint_url: z.string().url().nullable(),
  query: SourceChannelQuerySchema,
  provider_query: SourceChannelQuerySchema,
  query_fingerprint: z.string().min(1),
  status: SourceChannelStatusSchema,
  fetch_frequency: SourceFetchFrequencySchema,
  schedule_rule: z.record(z.unknown()).nullable(),
  provider: z.object({ key: z.string().min(1), display_name: z.string().min(1) }),
  connection_status: z.string().min(1).nullable(),
  capture_policy: SourceChannelCapturePolicySchema.nullable(),
  scan_state: SourceChannelScanStateSchema,
}).passthrough();
export type SourceChannel = z.infer<typeof SourceChannelSchema>;

export const SourceChannelCreateRequestSchema = z.object({
  provider_key: z.string().trim().min(1),
  source_name: z.string().trim().min(1).max(512).optional(),
  name: z.string().trim().min(1).max(512).optional(),
  query: SourceChannelQuerySchema,
  endpoint_url: z.string().url().optional(),
  fetch_frequency: SourceFetchFrequencySchema.optional(),
  schedule_rule: z.record(z.unknown()).optional(),
  capture_policy: SourceChannelCapturePolicySchema.optional(),
}).passthrough();
