import {
  dateIso,
  numberValue,
  objectValue,
  optionalObject,
  stringArray,
} from "../routeUtils/common.js";
import type {
  ClaimRow,
  ClaimSourceRow,
  KnowledgeItemRow,
  NoteCollectionRow,
  NoteRow,
  ObjectRelationRow,
  SourceRow,
} from "./knowledgeRepositoryRows.js";
import { isKnowledgeRetrievalProjectedRelation } from "./retrievalObjectTypes.js";
import { isContentOwner } from "../access/contentAccessPolicy.js";

export function knowledgeSummaryOut(row: KnowledgeItemRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    project_folder_id: row.project_folder_id,
    knowledge_kind: row.knowledge_kind,
    slug: row.slug,
    title: row.title,
    content_preview: row.excerpt ?? (row.plain_text ?? row.content).slice(0, 280),
    excerpt: row.excerpt,
    status: row.status,
    visibility: row.visibility,
    verification_status: row.verification_status,
    reflection_status: row.reflection_status,
    tags: stringArray(row.tags_json),
    confidence: row.confidence,
    version: numberValue(row.version) ?? 1,
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function knowledgeItemOut(row: KnowledgeItemRow, sourceRefs: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...knowledgeSummaryOut(row),
    root_item_id: row.root_item_id,
    supersedes_item_id: row.supersedes_item_id,
    redirect_to_item_id: row.redirect_to_item_id,
    aliases: stringArray(row.aliases_json),
    content: row.content,
    content_json: optionalObject(row.content_json),
    content_format: row.content_format,
    content_schema_version: numberValue(row.content_schema_version) ?? 1,
    plain_text: row.plain_text,
    source_refs: sourceRefs,
    pinned_source_ref: optionalObject(row.pinned_source_ref_json),
    owner_user_id: row.owner_user_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_from_proposal_id: row.created_from_proposal_id,
    approved_by_user_id: row.approved_by_user_id,
    created_at: dateIso(row.created_at),
    archived_at: dateIso(row.archived_at),
    deprecated_at: dateIso(row.deprecated_at),
  };
}

export function claimSummaryOut(row: ClaimRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    subject_object_id: row.subject_object_id,
    subject_text: row.subject_text,
    claim_kind: row.claim_kind,
    claim_text: row.claim_text,
    normalized_claim_hash: row.normalized_claim_hash,
    confidence: row.confidence,
    confidence_method: row.confidence_method,
    resolution_state: row.resolution_state,
    status: row.status,
    visibility: row.visibility,
    title: row.title,
    excerpt: row.excerpt,
    primary_project_id: row.primary_project_id,
    project_folder_id: row.project_folder_id,
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export function claimOut(row: ClaimRow, sources: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...claimSummaryOut(row),
    holder_object_id: row.holder_object_id,
    holder_type: row.holder_type,
    holder_id: row.holder_id,
    valid_from: dateIso(row.valid_from),
    valid_until: dateIso(row.valid_until),
    observed_at: dateIso(row.observed_at),
    metadata: objectValue(row.metadata_json),
    sources,
    owner_user_id: row.owner_user_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_by_run_id: row.created_by_run_id,
    created_from_proposal_id: row.created_from_proposal_id,
    approved_by_user_id: row.approved_by_user_id,
    created_at: dateIso(row.created_at),
    archived_at: dateIso(row.archived_at),
  };
}

export function claimSourceOut(row: ClaimSourceRow): Record<string, unknown> {
  const out = normalizeDates({ ...row });
  delete out.source_policy_snapshot_json;
  delete out.metadata_json;
  return {
    ...out,
    source_policy_snapshot: objectValue(row.source_policy_snapshot_json),
    metadata: objectValue(row.metadata_json),
  };
}

export function objectRelationOut(row: ObjectRelationRow): Record<string, unknown> {
  const out = normalizeDates({ ...row });
  delete out.from_object_type;
  delete out.to_object_type;
  delete out.metadata_json;
  return {
    ...out,
    retrieval_projected: isKnowledgeRetrievalProjectedRelation(row.from_object_type, row.to_object_type),
    metadata: objectValue(row.metadata_json),
  };
}

export function sourceSummaryOut(row: SourceRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    source_type: row.source_type,
    title: row.title,
    uri: row.uri,
    status: row.status,
    source_activity_id: row.source_activity_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export function sourceOut(row: SourceRow): Record<string, unknown> {
  return {
    ...sourceSummaryOut(row),
    content_ref: row.content_ref,
    raw_text: row.raw_text,
    summary: row.summary,
    metadata: objectValue(row.metadata_json),
    created_by_user_id: row.created_by_user_id,
  };
}

/**
 * Every folder the note is placed in, in placement order. A note with no
 * placement (nothing has filed it yet) has an empty list, not a null folder.
 */
function notePlacementsOut(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as { collection_id?: unknown; sort_order?: unknown };
    return typeof row?.collection_id === "string"
      ? [{ collection_id: row.collection_id, sort_order: numberValue(row.sort_order) ?? 0 }]
      : [];
  });
}

export function noteSummaryOut(row: NoteRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    title: row.title,
    excerpt: row.excerpt,
    status: row.status,
    content_format: row.content_format,
    primary_project_id: row.primary_project_id,
    project_role: row.project_role,
    role_project_id: row.role_project_id,
    placements: notePlacementsOut(row.placements),
    version: numberValue(row.version) ?? 1,
    content_hash: row.content_hash,
    updated_by_user_id: row.updated_by_user_id,
    updated_by_run_id: row.updated_by_run_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    deleted_at: dateIso(row.deleted_at),
  };
}

export function noteOut(row: NoteRow): Record<string, unknown> {
  return {
    ...noteSummaryOut(row),
    content_json: optionalObject(row.content_json),
    content_schema_version: numberValue(row.content_schema_version) ?? 1,
    plain_text: row.plain_text,
    created_from_activity_id: row.created_from_activity_id,
    created_by_user_id: row.created_by_user_id,
    archived_at: dateIso(row.archived_at),
  };
}

export function noteCollectionOut(row: NoteCollectionRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    parent_id: row.parent_id,
    name: row.name,
    system_role: row.system_role,
    sort_order: numberValue(row.sort_order) ?? 0,
    is_system: row.is_system,
    is_hidden: row.is_hidden,
    project_id: row.project_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

export function normalizeDates(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    if (key.endsWith("_at")) row[key] = dateIso(row[key]);
  }
  return row;
}

export function canMutateKnowledge(row: KnowledgeItemRow, userId: string): boolean {
  return isContentOwner(row, userId);
}

export function canMutateClaim(row: ClaimRow, userId: string): boolean {
  return isContentOwner(row, userId);
}

