export interface SourceConnectionRow {
  id: string;
  space_id: string;
  project_id: string | null;
  provider_connector_id?: string;
  connector_key?: string | null;
  connector_type?: string | null;
  ingestion_mode?: string | null;
  owner_user_id: string;
  credential_id: string | null;
  visibility: string;
  access_level: string;
  name: string;
  status: string;
  capture_policy: string;
  trust_level: string;
  topic_hints_json: unknown;
  consent_json: unknown;
  policy_json: unknown;
  config_json: unknown;
  handler_kind: string;
  active_handler_version_id: string | null;
  active_recipe_version_id: string | null;
  repair_status: string;
  last_handler_run_id: string | null;
  subscription_status?: string | null;
  library_enabled?: boolean | null;
  digest_enabled?: boolean | null;
  recommended_by_user_id?: string | null;
  recommendation_message?: string | null;
  last_notified_at?: unknown;
  created_at: unknown;
  updated_at: unknown;
}

/** Connection governance plus the Channel execution context used by a scan. */
export interface SourceChannelConnectionRow extends SourceConnectionRow {
  source_channel_id: string;
  endpoint_url: string | null;
  fetch_frequency: string;
  schedule_rule_json: unknown;
}

export interface SourceItemRow {
  id: string;
  space_id: string;
  project_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  effective_access_level?: string;
  connection_id: string | null;
  item_type: string;
  source_object_type: string | null;
  source_object_id: string | null;
  created_by_user_id: string | null;
  title: string;
  source_uri: string | null;
  canonical_uri: string | null;
  source_domain: string | null;
  source_external_id: string | null;
  author: string | null;
  occurred_at: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  content_hash: string | null;
  excerpt: string | null;
  library_status?: string | null;
  read_status?: string | null;
  first_opened_at?: unknown;
  last_opened_at?: unknown;
  progress_json?: unknown;
  content_state: string;
  retention_policy: string;
  relevance_score: number | null;
  novelty_score: number | null;
  raw_artifact_id: string | null;
  extracted_artifact_id: string | null;
  summary_artifact_id: string | null;
  search_index_ref: string | null;
  embedding_index_ref: string | null;
  metadata_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface ExtractionJobRow {
  id: string;
  space_id: string;
  connection_id: string | null;
  source_item_id: string | null;
  source_snapshot_id: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  job_type: string;
  status: string;
  started_at: unknown;
  completed_at: unknown;
  items_seen: number | null;
  items_created: number | null;
  items_updated: number | null;
  error_code: string | null;
  error_message: string | null;
  metadata_json: unknown;
  created_at: unknown;
}

export interface EvidenceRow {
  id: string;
  space_id: string;
  project_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  effective_access_level?: string;
  source_item_id: string | null;
  origin_source_item_id: string | null;
  extraction_job_id: string | null;
  source_snapshot_id: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  evidence_type: string;
  title: string;
  content_excerpt: string | null;
  content_hash: string | null;
  artifact_id: string | null;
  source_uri: string | null;
  source_title: string | null;
  source_author: string | null;
  occurred_at: unknown;
  trust_level: string;
  extraction_method: string;
  confidence: number | null;
  status: string;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface EvidenceLinkRow {
  id: string;
  space_id: string;
  evidence_id: string;
  target_type: string;
  target_id: string | null;
  link_type: string;
  status: string;
  confidence: number | null;
  reason: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ProjectSourceBindingRow {
  id: string;
  space_id: string;
  project_id: string;
  source_channel_id: string;
  binding_key: string;
  status: string;
  priority: number;
  delivery_scope: string;
  collection_notifications_enabled: boolean;
  standing_comparison_enabled: boolean;
  filters_json: unknown;
  routing_policy_json: unknown;
  extraction_policy_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ProjectSourceItemLinkRow {
  id: string;
  space_id: string;
  project_id: string;
  project_source_binding_id: string;
  source_channel_id: string | null;
  source_connection_id: string | null;
  source_item_id: string;
  status: string;
  matched_at: unknown;
  match_reason: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const CONNECTION_TABLE_COLUMNS = [
  "id",
  "space_id",
  "project_id",
  "provider_connector_id",
  "owner_user_id",
  "credential_id",
  "visibility",
  "access_level",
  "name",
  "status",
  "capture_policy",
  "trust_level",
  "topic_hints_json",
  "consent_json",
  "policy_json",
  "config_json",
  "handler_kind",
  "active_handler_version_id",
  "active_recipe_version_id",
  "repair_status",
  "last_handler_run_id",
  "created_at",
  "updated_at",
];

export const CONNECTOR_COLUMNS = `id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, config_schema_json, created_at, updated_at`;
export const CONNECTION_COLUMNS = [
  ...CONNECTION_TABLE_COLUMNS,
].join(", ");
export function connectionColumnsForAlias(alias: string): string {
  return [
    ...CONNECTION_TABLE_COLUMNS.map((column) => `${alias}.${column}`),
  ].join(", ");
}
export function connectionColumnsWithConnectorForAlias(alias: string, connectorAlias: string): string {
  return [
    connectionColumnsForAlias(alias),
    `${connectorAlias}.connector_key`,
    `${connectorAlias}.connector_type`,
    `${connectorAlias}.ingestion_mode`,
  ].join(", ");
}
const ITEM_TABLE_COLUMNS = [
  "id",
  "space_id",
  "project_id",
  "owner_user_id",
  "visibility",
  "access_level",
  "connection_id",
  "item_type",
  "source_object_type",
  "source_object_id",
  "created_by_user_id",
  "title",
  "source_uri",
  "canonical_uri",
  "source_domain",
  "source_external_id",
  "author",
  "occurred_at",
  "first_seen_at",
  "last_seen_at",
  "content_hash",
  "excerpt",
  "content_state",
  "retention_policy",
  "relevance_score",
  "novelty_score",
  "raw_artifact_id",
  "extracted_artifact_id",
  "summary_artifact_id",
  "search_index_ref",
  "embedding_index_ref",
  "metadata_json",
  "created_at",
  "updated_at",
];
export const ITEM_COLUMNS = ITEM_TABLE_COLUMNS.join(", ");
export function itemColumnsForAlias(alias: string): string {
  return ITEM_TABLE_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}
export const JOB_COLUMNS = `id, space_id, connection_id, source_item_id, source_snapshot_id, source_object_type, source_object_id, job_type, status, started_at, completed_at, items_seen, items_created, items_updated, error_code, error_message, metadata_json, created_at`;
const EVIDENCE_TABLE_COLUMNS = [
  "id",
  "space_id",
  "project_id",
  "owner_user_id",
  "visibility",
  "access_level",
  "source_item_id",
  "origin_source_item_id",
  "extraction_job_id",
  "source_snapshot_id",
  "source_object_type",
  "source_object_id",
  "evidence_type",
  "title",
  "content_excerpt",
  "content_hash",
  "artifact_id",
  "source_uri",
  "source_title",
  "source_author",
  "occurred_at",
  "trust_level",
  "extraction_method",
  "confidence",
  "status",
  "metadata_json",
  "created_by_user_id",
  "created_by_agent_id",
  "created_by_run_id",
  "created_at",
  "updated_at",
];
export const EVIDENCE_COLUMNS = EVIDENCE_TABLE_COLUMNS.join(", ");
export function evidenceColumnsForAlias(alias: string): string {
  return EVIDENCE_TABLE_COLUMNS.map((column) => `${alias}.${column}`).join(", ");
}
export const EVIDENCE_LINK_COLUMNS = `id, space_id, evidence_id, target_type, target_id, link_type, status, confidence, reason, created_by_user_id, created_by_agent_id, created_by_run_id, created_at, updated_at`;
export const PROJECT_SOURCE_BINDING_COLUMNS = `id, space_id, project_id, source_channel_id, binding_key, status, priority, delivery_scope, collection_notifications_enabled, standing_comparison_enabled, filters_json, routing_policy_json, extraction_policy_json, created_by_user_id, created_at, updated_at`;
export const PROJECT_SOURCE_ITEM_LINK_COLUMNS = `id, space_id, project_id, project_source_binding_id, source_channel_id, source_connection_id, source_item_id, status, matched_at, match_reason, created_at, updated_at`;
