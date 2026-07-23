export interface KnowledgeItemRow {
  id: string;
  space_id: string;
  project_id: string | null;
  workspace_id: string | null;
  root_item_id: string | null;
  supersedes_item_id: string | null;
  redirect_to_item_id: string | null;
  knowledge_kind: string;
  slug: string | null;
  aliases_json: unknown;
  title: string;
  content: string;
  content_json: unknown;
  content_format: string;
  content_schema_version: unknown;
  plain_text: string | null;
  excerpt: string | null;
  status: string;
  visibility: string;
  verification_status: string;
  reflection_status: string;
  tags_json: unknown;
  confidence: number | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_from_proposal_id: string | null;
  approved_by_user_id: string | null;
  version: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
  deprecated_at: unknown;
}

export interface KnowledgeRelationRow {
  id: string;
  space_id: string;
  from_item_id: string;
  to_item_id: string;
  relation_type: string;
  status: string;
  confidence: number | null;
  evidence_summary: string | null;
  source_proposal_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_from_assessment_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ClaimRow {
  id: string;
  space_id: string;
  subject_object_id: string | null;
  subject_text: string | null;
  claim_kind: string;
  claim_text: string;
  normalized_claim_hash: string;
  holder_object_id: string | null;
  holder_type: string | null;
  holder_id: string | null;
  confidence: number | null;
  confidence_method: string;
  resolution_state: string;
  valid_from: unknown;
  valid_until: unknown;
  observed_at: unknown;
  metadata_json: unknown;
  status: string;
  visibility: string;
  title: string;
  excerpt: string | null;
  owner_user_id: string | null;
  primary_project_id: string | null;
  workspace_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_by_run_id: string | null;
  created_from_proposal_id: string | null;
  approved_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

export interface ClaimSourceRow {
  id: string;
  space_id: string;
  claim_id: string;
  source_object_id: string | null;
  source_ref_type: string | null;
  source_ref_id: string | null;
  source_connection_id: string | null;
  source_policy_snapshot_json: unknown;
  locator: string | null;
  quote_excerpt: string | null;
  evidence_role: string;
  source_trust: string | null;
  confidence: number | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
}

export interface ClaimRelationRow {
  id: string;
  space_id: string;
  from_claim_id: string;
  to_claim_id: string;
  relation_type: string;
  status: string;
  confidence: number | null;
  evidence_summary: string | null;
  source_proposal_id: string | null;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ObjectRelationRow {
  id: string;
  space_id: string;
  from_object_id: string;
  from_object_type: string | null;
  to_object_id: string;
  to_object_type: string | null;
  relation_type: string;
  status: string;
  confidence: number | null;
  evidence_summary: string | null;
  source_claim_id: string | null;
  source_object_id: string | null;
  source_proposal_id: string | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_by_agent_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface SourceRow {
  id: string;
  space_id: string;
  source_type: string;
  title: string;
  uri: string | null;
  content_ref: string | null;
  raw_text: string | null;
  summary: string | null;
  metadata_json: unknown;
  status: string;
  source_activity_id: string | null;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface NoteRow {
  id: string;
  space_id: string;
  title: string;
  content_json: unknown;
  content_format: string;
  content_schema_version: unknown;
  plain_text: string | null;
  excerpt: string | null;
  status: string;
  primary_project_id: string | null;
  collection_id: string | null;
  collection_sort_order: number | string | null;
  created_from_activity_id: string | null;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
  deleted_at: unknown;
  version: unknown;
  content_hash: string | null;
  updated_by_user_id: string | null;
  updated_by_run_id: string | null;
}

export interface NoteCollectionRow {
  id: string;
  space_id: string;
  parent_id: string | null;
  name: string;
  system_role: string;
  sort_order: number | string;
  is_system: boolean;
  is_hidden: boolean;
  project_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ProvenanceLinkRow {
  source_type: string;
  source_id: string;
  source_trust: string | null;
  evidence_json: unknown;
  created_at: unknown;
}

export const KNOWLEDGE_ITEM_COLUMNS = `
  ki.object_id AS id, ki.space_id, so.primary_project_id AS project_id,
  so.workspace_id, ki.root_item_id, ki.supersedes_item_id,
  ki.redirect_to_item_id, ki.knowledge_kind, ki.slug, ki.aliases_json,
  so.title, ki.content, ki.content_json, ki.content_format,
  ki.content_schema_version, ki.plain_text, so.summary AS excerpt,
  so.status, so.visibility, ki.verification_status, ki.reflection_status,
  ki.tags_json, ki.confidence, so.owner_user_id,
  so.created_by_user_id, so.created_by_agent_id, so.created_by_run_id,
  ki.created_from_proposal_id,
  ki.approved_by_user_id, ki.version, so.created_at, so.updated_at,
  so.archived_at, ki.deprecated_at
`;

export const KNOWLEDGE_ITEM_FROM = `
  knowledge_items ki
  JOIN space_objects so
    ON so.id = ki.object_id
   AND so.space_id = ki.space_id
   AND so.object_type = 'knowledge_item'
`;

export const KNOWLEDGE_RELATION_COLUMNS = `
  id, space_id, from_item_id, to_item_id, relation_type, status, confidence,
  evidence_summary, source_proposal_id, created_by_user_id, created_by_agent_id,
  created_from_assessment_id, created_at, updated_at
`;

export const CLAIM_COLUMNS = `
  c.object_id AS id, c.space_id, c.subject_object_id, c.subject_text,
  c.claim_kind, c.claim_text, c.normalized_claim_hash, c.holder_object_id,
  c.holder_type, c.holder_id, c.confidence, c.confidence_method,
  c.resolution_state, c.valid_from, c.valid_until, c.observed_at,
  c.metadata_json, so.status, so.visibility, so.title, so.summary AS excerpt,
  so.owner_user_id, so.primary_project_id, so.workspace_id,
  so.created_by_user_id, so.created_by_agent_id, so.created_by_run_id,
  c.created_from_proposal_id, c.approved_by_user_id, so.created_at,
  so.updated_at, so.archived_at
`;

export const CLAIM_FROM = `
  claims c
  JOIN space_objects so
    ON so.id = c.object_id
   AND so.space_id = c.space_id
   AND so.object_type = 'claim'
`;

export const CLAIM_SOURCE_COLUMNS = `
  id, space_id, claim_id, source_object_id, source_ref_type, source_ref_id,
  source_connection_id, source_policy_snapshot_json, locator, quote_excerpt,
  evidence_role, source_trust, confidence, metadata_json, created_by_user_id,
  created_at
`;

export const CLAIM_RELATION_COLUMNS = `
  id, space_id, from_claim_id, to_claim_id, relation_type, status, confidence,
  evidence_summary, source_proposal_id, created_by_user_id, created_by_agent_id,
  created_at, updated_at
`;

export const OBJECT_RELATION_COLUMNS = `
  id, space_id, from_object_id, to_object_id, relation_type, status, confidence,
  evidence_summary, source_claim_id, source_object_id, source_proposal_id,
  metadata_json, created_by_user_id, created_by_agent_id, created_at, updated_at
`;

export const SOURCE_COLUMNS = `
  s.object_id AS id, s.space_id, s.source_type, so.title, s.uri,
  s.content_ref, s.raw_text, s.summary, s.metadata_json, so.status,
  s.source_activity_id, so.created_by_user_id, so.created_at, so.updated_at
`;

export const SOURCE_FROM = `
  sources s
  JOIN space_objects so
    ON so.id = s.object_id
   AND so.space_id = s.space_id
   AND so.object_type = 'source'
`;

export const NOTE_COLUMNS = `
  n.object_id AS id, n.space_id, so.title, n.content_json, n.content_format,
  n.content_schema_version, n.plain_text, so.summary AS excerpt, so.status,
  so.primary_project_id, n.created_from_activity_id, so.created_by_user_id,
  so.created_at, so.updated_at, so.archived_at, so.deleted_at,
  n.version, n.content_hash, n.updated_by_user_id, n.updated_by_run_id,
  first_collection.collection_id, first_collection.sort_order AS collection_sort_order
`;

export const NOTE_FROM = `
  notes n
  JOIN space_objects so
    ON so.id = n.object_id
   AND so.space_id = n.space_id
   AND so.object_type = 'note'
`;

export const NOTE_COLLECTION_COLUMNS = `
  id, space_id, parent_id, name, system_role, sort_order, is_system,
  is_hidden, project_id, created_at, updated_at
`;

export const KNOWLEDGE_KINDS = new Set(["concept", "lesson", "procedure", "decision", "question", "answer", "summary"]);
export const CONTENT_FORMATS = new Set(["markdown", "plain", "prosemirror_json"]);
export const KNOWLEDGE_VISIBILITIES = new Set(["private", "space_shared", "selected_users"]);
export const NOTE_STATUSES = new Set(["active", "archived", "deleted"]);
export const CLAIM_KINDS = new Set(["fact", "hypothesis", "belief", "preference", "commitment", "question", "interpretation", "instruction", "metric", "relationship", "event"]);
export const CLAIM_STATUSES = new Set(["active", "disputed", "superseded", "rejected", "archived"]);
export const CLAIM_CONFIDENCE_METHODS = new Set(["human_confirmed", "source_extracted", "llm_extracted", "inferred", "imported"]);
export const CLAIM_RESOLUTION_STATES = new Set(["unreviewed", "confirmed", "contradicted", "stale", "needs_source"]);
export const CLAIM_EVIDENCE_ROLES = new Set(["supports", "contradicts", "mentions", "derived_from", "cites", "summarizes"]);
export const CLAIM_SOURCE_REF_TYPES = new Set(["activity", "artifact", "run_event", "extracted_evidence", "source_snapshot", "external_pointer", "source_item"]);
export const CLAIM_SOURCE_TRUST_LEVELS = new Set(["trusted", "normal", "untrusted", "unknown"]);
export const OBJECT_RELATION_TYPES = new Set(["related_to", "references", "depends_on", "part_of", "source_for", "derived_from", "about", "supports", "contradicts", "supersedes", "refines", "same_as", "affiliated_with", "cites", "authored_by"]);
export const OBJECT_RELATION_STATUSES = new Set(["candidate", "active", "rejected", "archived"]);
export const RELATION_TYPES = new Set([
  "related_to",
  "explains",
  "depends_on",
  "prerequisite_of",
  "part_of",
  "example_of",
  "applies_to",
  "supports",
  "contradicts",
  "derived_from",
  "summarizes",
  "updates",
]);
export const SOURCE_TYPES = new Set(["activity_record", "chat_capture", "webpage", "article", "paper", "pdf", "file", "email", "manual_reference", "external_note"]);
export const SOURCE_STATUSES = new Set(["raw", "processing", "processed", "archived", "error"]);
