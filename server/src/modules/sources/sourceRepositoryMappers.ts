import { createHash } from "node:crypto";
import {
  HttpError,
  dateIso,
} from "../routeUtils/common";
import type {
  EvidenceLinkRow,
  EvidenceRow,
  ExtractionJobRow,
  ProjectSourceBindingRow,
  SourceItemRow,
} from "./sourceRepositoryRows";

export function itemOut(row: SourceItemRow) {
  const summaryOnly = row.effective_access_level === "summary";
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    connection_id: row.connection_id,
    item_type: row.item_type,
    source_object_type: row.source_object_type,
    source_object_id: row.source_object_id,
    created_by_user_id: row.created_by_user_id,
    title: row.title,
    source_uri: summaryOnly ? null : row.source_uri,
    canonical_uri: summaryOnly ? null : row.canonical_uri,
    source_domain: row.source_domain,
    source_external_id: summaryOnly ? null : row.source_external_id,
    author: row.author,
    occurred_at: dateIso(row.occurred_at),
    first_seen_at: dateIso(row.first_seen_at),
    last_seen_at: dateIso(row.last_seen_at),
    content_hash: summaryOnly ? null : row.content_hash,
    excerpt: summaryOnly ? null : row.excerpt,
    library_status: row.library_status ?? "new",
    read_status: row.read_status ?? "unread",
    first_opened_at: dateIso(row.first_opened_at),
    last_opened_at: dateIso(row.last_opened_at),
    progress_json: summaryOnly ? {} : row.progress_json ?? {},
    content_state: row.content_state,
    retention_policy: row.retention_policy,
    relevance_score: row.relevance_score,
    novelty_score: row.novelty_score,
    raw_artifact_id: summaryOnly ? null : row.raw_artifact_id,
    extracted_artifact_id: summaryOnly ? null : row.extracted_artifact_id,
    summary_artifact_id: summaryOnly ? null : row.summary_artifact_id,
    search_index_ref: summaryOnly ? null : row.search_index_ref,
    embedding_index_ref: summaryOnly ? null : row.embedding_index_ref,
    metadata_json: summaryOnly ? null : row.metadata_json ?? null,
    effective_access_level: row.effective_access_level ?? "full",
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export function jobOut(row: ExtractionJobRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    connection_id: row.connection_id,
    source_item_id: row.source_item_id,
    source_snapshot_id: row.source_snapshot_id,
    source_object_type: row.source_object_type,
    source_object_id: row.source_object_id,
    job_type: row.job_type,
    status: row.status,
    started_at: dateIso(row.started_at),
    completed_at: dateIso(row.completed_at),
    items_seen: row.items_seen,
    items_created: row.items_created,
    items_updated: row.items_updated,
    error_code: row.error_code,
    error_message: row.error_message,
    metadata_json: row.metadata_json ?? null,
    created_at: dateIso(row.created_at),
  };
}

export function evidenceOut(row: EvidenceRow) {
  const summaryOnly = row.effective_access_level === "summary";
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    source_item_id: row.source_item_id,
    extraction_job_id: row.extraction_job_id,
    source_snapshot_id: row.source_snapshot_id,
    source_object_type: row.source_object_type,
    source_object_id: row.source_object_id,
    evidence_type: row.evidence_type,
    title: row.title,
    content_excerpt: summaryOnly ? null : row.content_excerpt,
    content_hash: summaryOnly ? null : row.content_hash,
    artifact_id: summaryOnly ? null : row.artifact_id,
    source_uri: summaryOnly ? null : row.source_uri,
    source_title: row.source_title,
    source_author: row.source_author,
    occurred_at: dateIso(row.occurred_at),
    trust_level: row.trust_level,
    extraction_method: row.extraction_method,
    confidence: row.confidence,
    status: row.status,
    metadata_json: summaryOnly ? null : row.metadata_json ?? null,
    effective_access_level: row.effective_access_level ?? "full",
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export function evidenceLinkOut(row: EvidenceLinkRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    evidence_id: row.evidence_id,
    target_type: row.target_type,
    target_id: row.target_id,
    link_type: row.link_type,
    status: row.status,
    confidence: row.confidence,
    reason: row.reason,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export function projectSourceBindingOut(row: ProjectSourceBindingRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    source_channel_id: row.source_channel_id,
    binding_key: row.binding_key,
    status: row.status,
    priority: row.priority,
    delivery_scope: row.delivery_scope,
    collection_notifications_enabled: row.collection_notifications_enabled,
    standing_comparison_enabled: row.standing_comparison_enabled,
    filters_json: row.filters_json ?? {},
    routing_policy_json: row.routing_policy_json ?? {},
    extraction_policy_json: row.extraction_policy_json ?? {},
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export type ProjectSourceItemOutRow = SourceItemRow & {
  project_link_id: string;
  project_link_space_id: string;
  project_link_project_id: string;
  project_link_project_source_binding_id: string;
  project_link_source_channel_id: string | null;
  project_link_source_connection_id: string | null;
  project_link_source_item_id: string;
  project_link_status: string;
  project_link_matched_at: unknown;
  project_link_match_reason: string | null;
  project_link_created_at: unknown;
  project_link_updated_at: unknown;
};

export function projectSourceItemOut(row: ProjectSourceItemOutRow) {
  return {
    id: row.project_link_id,
    space_id: row.project_link_space_id,
    project_id: row.project_link_project_id,
    project_source_binding_id: row.project_link_project_source_binding_id,
    source_channel_id: row.project_link_source_channel_id,
    source_connection_id: row.project_link_source_connection_id,
    source_item_id: row.project_link_source_item_id,
    status: row.project_link_status,
    matched_at: dateIso(row.project_link_matched_at),
    match_reason: row.project_link_match_reason,
    created_at: dateIso(row.project_link_created_at),
    updated_at: dateIso(row.project_link_updated_at),
    item: itemOut(row),
  };
}

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    throw new HttpError(422, "url must be a valid URL");
  }
}

export function sourceDomain(value: string): string | null {
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function buildSummary(evidence: EvidenceRow[], items: SourceItemRow[], goal: string | null): string {
  const lines = [goal ? `# ${goal}` : "# Source evidence summary", ""];
  for (const row of evidence) {
    lines.push(`- Evidence: ${row.title}${row.content_excerpt ? ` — ${row.content_excerpt.slice(0, 240)}` : ""}`);
  }
  for (const row of items) {
    lines.push(`- Source item: ${row.title}${row.excerpt ? ` — ${row.excerpt.slice(0, 240)}` : ""}`);
  }
  return lines.join("\n");
}
