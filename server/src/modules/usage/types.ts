export type UsageEventType =
  | "llm.generation"
  | "llm.embedding"
  | "llm.rerank"
  | "cli.history_usage"
  | "usage.adjustment";

export type UsageSourceType =
  | "local_run"
  | "provider_proxy"
  | "cli_history_import"
  | "cross_instance_import"
  | "manual_import";

export type UsageExecutionChannel =
  | "managed_api"
  | "provider_proxy"
  | "local_cli"
  | "local_cli_transcript"
  | "manual_import"
  | "cross_instance_import"
  | "unknown";

export type UsageAccuracy =
  | "provider_reported"
  | "proxy_observed"
  | "transcript_lower_bound"
  | "estimated"
  | "quota_snapshot"
  | "unknown";

export type UsageDedupeConfidence = "high" | "medium" | "low";

export type TotalTokensSource =
  | "provider_total"
  | "sum_of_buckets"
  | "estimated"
  | "unknown";

export type UsageBucketName =
  | "input"
  | "output"
  | "input_cache_creation"
  | "input_cache_read"
  | "output_reasoning"
  | "input_audio"
  | "output_audio"
  | "input_image"
  | "output_image"
  | "embedding_input"
  | "total";

export type UsageDetails = Partial<Record<UsageBucketName, number>>;

export interface UsageObservation {
  space_id: string;
  event_type: UsageEventType;
  source_type: UsageSourceType;
  source_resource_type?: string | null;
  source_resource_id?: string | null;
  space_system_task?: boolean;
  execution_channel: UsageExecutionChannel;
  meter_subject_type?: string | null;
  meter_subject_id?: string | null;
  subject_user_id?: string | null;
  subject_team_id?: string | null;
  adapter_type?: string | null;
  runtime_tool_version?: string | null;
  provider_id?: string | null;
  provider_type?: string | null;
  provider_name_snapshot?: string | null;
  vendor?: string | null;
  model?: string | null;
  task?: string | null;
  run_id?: string | null;
  root_run_id?: string | null;
  parent_run_id?: string | null;
  run_group_id?: string | null;
  session_id?: string | null;
  external_session_id?: string | null;
  session_path?: string | null;
  session_name?: string | null;
  agent_id?: string | null;
  project_id?: string | null;
  project_folder_id?: string | null;
  trigger_origin?: string | null;
  occurred_at?: string | Date | null;
  request_count?: number | null;
  estimated_cost_usd?: number | null;
  usage_schema?: string | null;
  usage_details?: Record<string, unknown> | null;
  cost_details?: Record<string, unknown> | null;
  provider_usage?: Record<string, unknown> | null;
  usage_accuracy?: UsageAccuracy | null;
  dedupe_confidence?: UsageDedupeConfidence | null;
  import_batch_id?: string | null;
  idempotency_key?: string | null;
  dimensions?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  origin_space_id?: string | null;
  origin_instance_id?: string | null;
  reporting_instance_id?: string | null;
  pricing_rule_id?: string | null;
  pricing_tier_name?: string | null;
  currency?: string | null;
}

export interface NormalizedUsageObservation {
  id: string;
  instance_id: string;
  reporting_instance_id: string;
  origin_instance_id: string;
  space_id: string;
  owner_user_id: string | null;
  visibility: "private" | "space_shared" | "selected_users";
  access_level: "full" | "summary";
  origin_space_id: string | null;
  event_type: UsageEventType;
  source_type: UsageSourceType;
  source_resource_type: string | null;
  source_resource_id: string | null;
  execution_channel: UsageExecutionChannel;
  meter_subject_type: string;
  meter_subject_id: string;
  subject_user_id: string | null;
  subject_team_id: string | null;
  adapter_type: string | null;
  runtime_tool_version: string | null;
  provider_id: string | null;
  provider_type: string | null;
  provider_name_snapshot: string | null;
  vendor: string | null;
  model: string | null;
  task: string | null;
  run_id: string | null;
  root_run_id: string | null;
  parent_run_id: string | null;
  run_group_id: string | null;
  session_id: string | null;
  external_session_id: string | null;
  session_path: string | null;
  session_name: string | null;
  agent_id: string | null;
  project_id: string | null;
  project_folder_id: string | null;
  trigger_origin: string | null;
  occurred_at: string;
  recorded_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number | null;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reasoning_tokens: number;
  request_count: number;
  estimated_cost_usd: number | null;
  usage_schema: string;
  usage_details_json: UsageDetails;
  cost_details_json: Record<string, unknown>;
  provider_usage_json: Record<string, unknown>;
  usage_normalization_version: number;
  total_tokens_source: TotalTokensSource;
  currency: string;
  pricing_rule_id: string | null;
  pricing_tier_name: string | null;
  dimensions_json: Record<string, unknown>;
  usage_accuracy: UsageAccuracy;
  dedupe_confidence: UsageDedupeConfidence;
  import_batch_id: string | null;
  idempotency_key: string;
  metadata_json: Record<string, unknown>;
  grant_snapshots: UsageGrantSnapshot[];
  created_at: string;
}

export interface UsageGrantSnapshot {
  id: string;
  user_id: string;
  granted_by_user_id: string;
  access_level: "full" | "summary";
  created_at: string;
}

export interface UsageAttribution {
  owner_user_id: string | null;
  visibility: "private" | "space_shared" | "selected_users";
  access_level: "full" | "summary";
  source_resource_type: string | null;
  source_resource_id: string | null;
  project_folder_id: string | null;
  project_id: string | null;
  grant_snapshots: UsageGrantSnapshot[];
}
