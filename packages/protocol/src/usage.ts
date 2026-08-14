import { z } from "zod";
import {
  ContentAccessLevelSchema,
  IdSchema,
  ISODateTimeSchema,
  SecretResponseGuards,
  VisibilitySchema,
} from "./common.js";

const JsonObjectSchema = z.record(z.unknown());

export const UsageEventTypeSchema = z.enum([
  "llm.generation",
  "llm.embedding",
  "llm.rerank",
  "cli.history_usage",
  "usage.adjustment",
]);
export type UsageEventType = z.infer<typeof UsageEventTypeSchema>;

export const UsageSourceTypeSchema = z.enum([
  "local_run",
  "provider_proxy",
  "cli_history_import",
  "cross_instance_import",
  "manual_import",
]);
export type UsageSourceType = z.infer<typeof UsageSourceTypeSchema>;

export const UsageExecutionChannelSchema = z.enum([
  "managed_api",
  "provider_proxy",
  "local_cli",
  "local_cli_transcript",
  "manual_import",
  "cross_instance_import",
  "unknown",
]);
export type UsageExecutionChannel = z.infer<typeof UsageExecutionChannelSchema>;

export const UsageAccuracySchema = z.enum([
  "provider_reported",
  "proxy_observed",
  "transcript_lower_bound",
  "estimated",
  "quota_snapshot",
  "unknown",
]);
export type UsageAccuracy = z.infer<typeof UsageAccuracySchema>;

export const UsageDedupeConfidenceSchema = z.enum(["high", "medium", "low"]);
export type UsageDedupeConfidence = z.infer<typeof UsageDedupeConfidenceSchema>;

export const UsageBucketNameSchema = z.enum([
  "input",
  "output",
  "input_cache_creation",
  "input_cache_creation_1h",
  "input_cache_read",
  "output_reasoning",
  "input_audio",
  "output_audio",
  "input_image",
  "output_image",
  "embedding_input",
  "total",
]);
export type UsageBucketName = z.infer<typeof UsageBucketNameSchema>;

export const UsageDetailsSchema = z.record(UsageBucketNameSchema, z.number().int().nonnegative());
export type UsageDetails = z.infer<typeof UsageDetailsSchema>;

export const UsageGroupBySchema = z.string();

export const UsageViewSchema = z.enum(["mine", "shared", "all_visible"]);
export type UsageView = z.infer<typeof UsageViewSchema>;

export const UsageQuerySchema = z.object({
  view: UsageViewSchema.optional(),
  from: ISODateTimeSchema.optional(),
  to: ISODateTimeSchema.optional(),
  group_by: UsageGroupBySchema.optional(),
  accuracy: UsageAccuracySchema.optional(),
  execution_channel: UsageExecutionChannelSchema.optional(),
  provider_id: IdSchema.optional(),
  model: z.string().optional(),
  task: z.string().optional(),
  subject_type: z.string().optional(),
  subject_id: z.string().optional(),
  session_id: IdSchema.optional(),
  external_session_id: z.string().optional(),
  session_path: z.string().optional(),
  dimension_key: z.string().optional(),
  dimension_value: z.string().optional(),
  include_imported: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
}).strict();

export const UsageSummaryQuerySchema = UsageQuerySchema;

export const UsageTimeseriesQuerySchema = UsageQuerySchema.extend({
  granularity: z.enum(["day", "week", "month"]).optional(),
});

export const UsageTotalsSchema = z.object({
  event_count: z.number().int().nonnegative(),
  request_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_creation_1h_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nullable(),
  observed_event_percentage: z.number(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageAccuracyMixSchema = z.object({
  provider_reported: z.number().int().nonnegative(),
  proxy_observed: z.number().int().nonnegative(),
  transcript_lower_bound: z.number().int().nonnegative(),
  estimated: z.number().int().nonnegative(),
  quota_snapshot: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

export const UsageBreakdownItemSchema = z.object({
  group_key: z.string(),
  group_label: z.string(),
  totals: UsageTotalsSchema,
  accuracy_mix: UsageAccuracyMixSchema,
  last_seen_at: ISODateTimeSchema.nullable(),
});
export type UsageBreakdownItem = z.infer<typeof UsageBreakdownItemSchema>;

export const UsageSummaryResponseSchema = z.object({
  view: UsageViewSchema,
  from: ISODateTimeSchema,
  to: ISODateTimeSchema,
  group_by: z.string(),
  totals: UsageTotalsSchema,
  items: z.array(UsageBreakdownItemSchema),
  ...SecretResponseGuards,
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponseSchema>;

export const UsageTimeseriesPointSchema = z.object({
  bucket_start: ISODateTimeSchema,
  group_key: z.string(),
  group_label: z.string(),
  totals: UsageTotalsSchema,
  accuracy_mix: UsageAccuracyMixSchema,
});
export type UsageTimeseriesPoint = z.infer<typeof UsageTimeseriesPointSchema>;

export const UsageTimeseriesResponseSchema = z.object({
  from: ISODateTimeSchema,
  to: ISODateTimeSchema,
  granularity: z.enum(["day", "week", "month"]),
  group_by: z.string(),
  items: z.array(UsageTimeseriesPointSchema),
  ...SecretResponseGuards,
});
export type UsageTimeseriesResponse = z.infer<typeof UsageTimeseriesResponseSchema>;

export const UsageEventDTOSchema = z.object({
  id: IdSchema,
  space_id: IdSchema,
  owner_user_id: IdSchema.nullable(),
  visibility: VisibilitySchema,
  access_level: ContentAccessLevelSchema,
  event_type: UsageEventTypeSchema.or(z.string()),
  source_type: UsageSourceTypeSchema,
  source_resource_type: z.string().nullable(),
  source_resource_id: IdSchema.nullable(),
  execution_channel: UsageExecutionChannelSchema,
  meter_subject_type: z.string(),
  meter_subject_id: z.string(),
  provider_id: IdSchema.nullable(),
  provider_type: z.string().nullable(),
  provider_name_snapshot: z.string().nullable(),
  vendor: z.string().nullable(),
  model: z.string().nullable(),
  task: z.string().nullable(),
  run_id: IdSchema.nullable(),
  session_id: IdSchema.nullable(),
  external_session_id: z.string().nullable(),
  session_path: z.string().nullable(),
  session_name: z.string().nullable(),
  agent_id: IdSchema.nullable(),
  project_id: IdSchema.nullable(),
  project_folder_id: IdSchema.nullable(),
  occurred_at: ISODateTimeSchema,
  recorded_at: ISODateTimeSchema,
  usage_details: UsageDetailsSchema,
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().nullable(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_creation_1h_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative(),
  request_count: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nullable(),
  usage_accuracy: UsageAccuracySchema,
  total_tokens_source: z.string(),
  dimensions: JsonObjectSchema,
  metadata: JsonObjectSchema,
  created_at: ISODateTimeSchema,
  ...SecretResponseGuards,
});
export type UsageEventDTO = z.infer<typeof UsageEventDTOSchema>;

export const UsageEventsResponseSchema = z.object({
  items: z.array(UsageEventDTOSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  ...SecretResponseGuards,
});
export type UsageEventsResponse = z.infer<typeof UsageEventsResponseSchema>;

export const UsageDimensionsResponseSchema = z.object({
  providers: z.array(z.object({ id: z.string().nullable(), label: z.string(), total_tokens: z.number().int().nonnegative() })),
  models: z.array(z.object({ model: z.string(), total_tokens: z.number().int().nonnegative() })),
  tasks: z.array(z.object({ task: z.string(), total_tokens: z.number().int().nonnegative() })),
  execution_channels: z.array(z.object({ execution_channel: UsageExecutionChannelSchema, total_tokens: z.number().int().nonnegative() })),
  accuracies: z.array(z.object({ usage_accuracy: UsageAccuracySchema, event_count: z.number().int().nonnegative() })),
  custom_dimension_keys: z.array(z.string()),
  ...SecretResponseGuards,
});
export type UsageDimensionsResponse = z.infer<typeof UsageDimensionsResponseSchema>;

export const UsageSubjectSummarySchema = z.object({
  meter_subject_type: z.string(),
  meter_subject_id: z.string(),
  totals: UsageTotalsSchema,
  last_seen_at: ISODateTimeSchema.nullable(),
});
export type UsageSubjectSummary = z.infer<typeof UsageSubjectSummarySchema>;

export const UsageSubjectsResponseSchema = z.object({
  items: z.array(UsageSubjectSummarySchema),
  total: z.number().int().nonnegative(),
  ...SecretResponseGuards,
});
export type UsageSubjectsResponse = z.infer<typeof UsageSubjectsResponseSchema>;

export const UsageSessionSummarySchema = z.object({
  session_id: IdSchema.nullable(),
  external_session_id: z.string().nullable(),
  session_path: z.string().nullable(),
  session_name: z.string().nullable(),
  run_ids: z.array(IdSchema),
  totals: UsageTotalsSchema,
  last_seen_at: ISODateTimeSchema.nullable(),
});
export type UsageSessionSummary = z.infer<typeof UsageSessionSummarySchema>;

export const UsageSessionsResponseSchema = z.object({
  items: z.array(UsageSessionSummarySchema),
  total: z.number().int().nonnegative(),
  ...SecretResponseGuards,
});
export type UsageSessionsResponse = z.infer<typeof UsageSessionsResponseSchema>;

export const UsageBudgetPreviewQuerySchema = UsageQuerySchema.extend({
  projection_window_days: z.number().int().positive().max(366).optional(),
});

export const UsageBudgetPreviewItemSchema = z.object({
  meter_subject_type: z.string(),
  meter_subject_id: z.string(),
  current_estimated_cost_usd: z.number().nullable(),
  projected_estimated_cost_usd: z.number().nullable(),
  costed_event_percentage: z.number(),
  totals: UsageTotalsSchema,
  last_seen_at: ISODateTimeSchema.nullable(),
});

export const UsageBudgetPreviewResponseSchema = z.object({
  from: ISODateTimeSchema,
  to: ISODateTimeSchema,
  observed_days: z.number(),
  projection_window_days: z.number().int().positive(),
  total_projected_estimated_cost_usd: z.number().nullable(),
  items: z.array(UsageBudgetPreviewItemSchema),
  ...SecretResponseGuards,
});
export type UsageBudgetPreviewResponse = z.infer<typeof UsageBudgetPreviewResponseSchema>;

export const UsageOperationalTotalsQuerySchema = z.object({
  from: ISODateTimeSchema.optional(),
  to: ISODateTimeSchema.optional(),
});

export const UsageOperationalTotalsResponseSchema = z.object({
  from: ISODateTimeSchema,
  to: ISODateTimeSchema,
  totals: UsageTotalsSchema,
  ...SecretResponseGuards,
});
export type UsageOperationalTotalsResponse = z.infer<typeof UsageOperationalTotalsResponseSchema>;

export const UsageCliHistoryRuntimeSchema = z.enum(["claude_code", "codex_cli"]);
export type UsageCliHistoryRuntime = z.infer<typeof UsageCliHistoryRuntimeSchema>;

export const UsageCliHistorySourceKindSchema = z.enum([
  "managed_profile",
  "uploaded_archive",
  "server_path",
  "scanner_manifest",
]);

export const UsageCliHistoryPreviewRequestSchema = z.object({
  runtime: UsageCliHistoryRuntimeSchema,
  source_kind: UsageCliHistorySourceKindSchema.default("managed_profile"),
  credential_profile_id: IdSchema.nullish(),
  target_space_id: IdSchema.nullish(),
});
export type UsageCliHistoryPreviewRequest = z.infer<typeof UsageCliHistoryPreviewRequestSchema>;

export const UsageCliHistoryCommitRequestSchema = z.object({
  import_batch_id: IdSchema,
  target_space_id: IdSchema.nullish(),
  confirmation: z.boolean(),
});
export type UsageCliHistoryCommitRequest = z.infer<typeof UsageCliHistoryCommitRequestSchema>;

const UsageCliHistoryTotalsSchema = z.object({
  event_count: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
});

export const UsageCliHistoryImportResponseSchema = z
  .object({
    import_batch_id: IdSchema,
    status: z.string(),
    detected_runtime: UsageCliHistoryRuntimeSchema.optional(),
    source_kind: z.string(),
    source_fingerprint: z.string().nullable().optional(),
    credential_profile_id: IdSchema.nullable().optional(),
    credential_profile_name: z.string().nullable().optional(),
    target_space_id: IdSchema,
    date_range: z.object({ from: ISODateTimeSchema, to: ISODateTimeSchema }).nullable(),
    totals: UsageCliHistoryTotalsSchema,
    model_breakdown: z.array(z.object({
      model: z.string(),
      totals: UsageCliHistoryTotalsSchema,
    })),
    token_totals_by_accuracy: z.record(UsageCliHistoryTotalsSchema),
    session_count: z.number().int().nonnegative(),
    candidate_event_count: z.number().int().nonnegative(),
    duplicate_count: z.number().int().nonnegative(),
    existing_event_count: z.number().int().nonnegative().optional(),
    imported_event_count: z.number().int().nonnegative().optional(),
    unsupported_file_count: z.number().int().nonnegative(),
    unreadable_file_count: z.number().int().nonnegative(),
    privacy_notice: z.string(),
    confirmation_required: z.boolean().optional(),
    ...SecretResponseGuards,
  })
  .passthrough();
export type UsageCliHistoryImportResponse = z.infer<typeof UsageCliHistoryImportResponseSchema>;
