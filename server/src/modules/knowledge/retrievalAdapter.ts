import type { Queryable } from "../routeUtils/common";
import { contentReadSql } from "../access/contentAccessSql";
import { objectStatusJoinSql, objectStatusSql } from "../../db/objectStatusSql";
import {
  RetrievalRegistry,
  type CanonicalObject,
  type RetrievalDomainAdapter,
  type RetrievalEdge,
  type RetrievalObjectRef,
  type RetrievalObjectType,
  type RevalidatedObject,
  loadSourceConnectionIdsForTargets,
  sourceConnectionIdsFromMetadata,
} from "../retrieval";
import { KNOWLEDGE_RETRIEVAL_OBJECT_TYPES } from "./retrievalObjectTypes";

interface KnowledgeProjectionRow {
  id: string;
  project_folder_id: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  visibility: string;
  status: string;
  knowledge_kind: string;
  title: string;
  slug: string | null;
  aliases_json: unknown;
  content: string;
  plain_text: string | null;
  excerpt: string | null;
  updated_at: Date | string | null;
}

interface NoteProjectionRow {
  id: string;
  title: string;
  plain_text: string | null;
  excerpt: string | null;
  status: string;
  visibility: string | null;
  created_by_user_id: string | null;
  updated_at: Date | string | null;
}

interface SourceProjectionRow {
  id: string;
  source_type: string;
  title: string;
  uri: string | null;
  raw_text: string | null;
  summary: string | null;
  metadata_json: unknown;
  status: string;
  visibility: string | null;
  created_by_user_id: string | null;
  updated_at: Date | string | null;
}

interface ClaimProjectionRow {
  id: string;
  project_folder_id: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  visibility: string;
  status: string;
  claim_kind: string;
  title: string;
  subject_text: string | null;
  claim_text: string;
  resolution_state: string;
  updated_at: Date | string | null;
}

interface KnowledgeVisibilityRow {
  id: string;
  title: string;
  visibility: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  excerpt: string | null;
  plain_text: string | null;
  content: string | null;
}

interface NoteVisibilityRow {
  id: string;
  title: string;
  visibility: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  excerpt: string | null;
  plain_text: string | null;
}

interface SourceVisibilityRow {
  id: string;
  title: string;
  visibility: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  uri: string | null;
  raw_text: string | null;
  summary: string | null;
}

interface ClaimVisibilityRow {
  id: string;
  title: string;
  visibility: string | null;
  owner_user_id: string | null;
  created_by_user_id: string | null;
  subject_text: string | null;
  claim_text: string | null;
}

interface ClaimSourceProjectionRow {
  claim_id: string;
  source_object_id: string;
  source_object_type: RetrievalObjectType;
  evidence_role: string;
  confidence: number | null;
  locator: string | null;
}

interface ObjectRelationProjectionRow {
  from_object_id: string;
  from_object_type: RetrievalObjectType;
  to_object_id: string;
  to_object_type: RetrievalObjectType;
  link_type: string;
  confidence: number | null;
  evidence_summary: string | null;
  source_claim_id: string | null;
}

interface ClaimSourceConnectionRow {
  source_connection_id: string | null;
  source_metadata_json: unknown;
}

interface ItemSourceProjectionRow {
  knowledge_item_id: string;
  source_id: string;
  // Citation lineage keeps `relation_type` (B12A) — it is not an ontology edge.
  relation_type: string;
  confidence: number | null;
}

/**
 * Knowledge domain adapter for the shared zero-LLM retrieval engine. It owns all
 * Knowledge-specific SQL — loading `knowledge_items` / `notes` / `sources` /
 * `claims` for projection, the visibility revalidation gate, and the derived
 * edges from canonical object relations, curated source links, and claim-source
 * links. The engine stays domain-agnostic; this is the only place that touches
 * Knowledge tables.
 */
export const knowledgeRetrievalAdapter: RetrievalDomainAdapter = {
  objectTypes: KNOWLEDGE_RETRIEVAL_OBJECT_TYPES,

  async loadCanonical(db, spaceId, objectType, objectId): Promise<CanonicalObject | null> {
    if (objectType === "knowledge_item") return loadKnowledgeItem(db, spaceId, objectId);
    if (objectType === "note") return loadNote(db, spaceId, objectId);
    if (objectType === "source") return loadSource(db, spaceId, objectId);
    if (objectType === "claim") return loadClaim(db, spaceId, objectId);
    return null;
  },

  async revalidate(db, spaceId, objectType, objectId, viewerUserId): Promise<RevalidatedObject | null> {
    return (await revalidateKnowledgeMany(db, spaceId, objectType, [objectId], viewerUserId)).get(objectId) ?? null;
  },

  async revalidateMany(db, spaceId, objectType, objectIds, viewerUserId): Promise<Map<string, RevalidatedObject>> {
    return revalidateKnowledgeMany(db, spaceId, objectType, objectIds, viewerUserId);
  },

  async projectEdges(db, spaceId, object): Promise<RetrievalEdge[]> {
    const edges: RetrievalEdge[] = [];
    if (object.objectType === "knowledge_item" || object.objectType === "source") {
      edges.push(...(await itemSourceEdges(db, spaceId, object)));
    }
    if (object.objectType === "claim" || object.objectType === "knowledge_item" || object.objectType === "note" || object.objectType === "source") {
      edges.push(...(await claimSourceEdges(db, spaceId, object)));
    }
    edges.push(...(await objectRelationEdges(db, spaceId, object)));
    return edges;
  },

  async listObjectIds(db, spaceId): Promise<RetrievalObjectRef[]> {
    const refs: RetrievalObjectRef[] = [];
    const items = await db.query<{ id: string }>(
      `SELECT ki.object_id AS id
         FROM knowledge_items ki
         JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
        WHERE ki.space_id = $1
          AND so.object_type = 'knowledge_item'
          AND ki.status = 'active'`,
      [spaceId],
    );
    for (const row of items.rows) refs.push({ objectType: "knowledge_item", objectId: row.id });

    const notes = await db.query<{ id: string }>(
      `SELECT n.object_id AS id
         FROM notes n
         JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
        WHERE n.space_id = $1
          AND so.object_type = 'note'
          AND n.status = 'active'`,
      [spaceId],
    );
    for (const row of notes.rows) refs.push({ objectType: "note", objectId: row.id });

    const sources = await db.query<{ id: string }>(
      `SELECT s.object_id AS id
         FROM sources s
         JOIN space_objects so ON so.id = s.object_id AND so.space_id = s.space_id
        WHERE s.space_id = $1
          AND so.object_type = 'source'
          AND s.status = 'processed'`,
      [spaceId],
    );
    for (const row of sources.rows) refs.push({ objectType: "source", objectId: row.id });

    const claims = await db.query<{ id: string }>(
      `SELECT c.object_id AS id
         FROM claims c
         JOIN space_objects so ON so.id = c.object_id AND so.space_id = c.space_id
        WHERE c.space_id = $1
          AND so.object_type = 'claim'
          AND c.status = 'active'`,
      [spaceId],
    );
    for (const row of claims.rows) refs.push({ objectType: "claim", objectId: row.id });
    return refs;
  },
};

/** Process-wide registry with the Knowledge adapter registered. */
export const knowledgeRetrievalRegistry = new RetrievalRegistry();
knowledgeRetrievalRegistry.register(knowledgeRetrievalAdapter);

async function revalidateKnowledgeMany(
  db: Queryable,
  spaceId: string,
  objectType: RetrievalObjectType,
  objectIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, RevalidatedObject>> {
  const ids = uniqueIds(objectIds);
  if (ids.length === 0) return new Map();
  if (objectType === "knowledge_item") {
    const result = await db.query<KnowledgeVisibilityRow>(
      `SELECT ki.object_id AS id, so.title, so.visibility, so.owner_user_id,
              so.created_by_user_id, so.summary AS excerpt, ki.plain_text,
              ki.content
         FROM knowledge_items ki
         JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
        WHERE ki.space_id = $1
          AND ki.object_id = ANY($2::varchar[])
          AND so.object_type = 'knowledge_item'
          AND ki.status = 'active'
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [spaceId, ids, viewerUserId],
    );
    const rows = new Map<string, RevalidatedObject>();
    for (const row of result.rows) {
      rows.set(row.id, { title: row.title, text: row.excerpt ?? row.plain_text ?? row.content });
    }
    return rows;
  }

  if (objectType === "note") {
    const result = await db.query<NoteVisibilityRow>(
      `SELECT n.object_id AS id, so.title, so.visibility, so.owner_user_id,
              so.created_by_user_id, so.summary AS excerpt, n.plain_text
         FROM notes n
         JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
        WHERE n.space_id = $1
          AND n.object_id = ANY($2::varchar[])
          AND so.object_type = 'note'
          AND n.status = 'active'
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [spaceId, ids, viewerUserId],
    );
    const rows = new Map<string, RevalidatedObject>();
    for (const row of result.rows) {
      rows.set(row.id, { title: row.title, text: row.excerpt ?? row.plain_text });
    }
    return rows;
  }

  if (objectType === "claim") {
    const result = await db.query<ClaimVisibilityRow>(
      `SELECT c.object_id AS id, so.title, so.visibility, so.owner_user_id,
              so.created_by_user_id, c.subject_text, c.claim_text
         FROM claims c
         JOIN space_objects so ON so.id = c.object_id AND so.space_id = c.space_id
        WHERE c.space_id = $1
          AND c.object_id = ANY($2::varchar[])
          AND so.object_type = 'claim'
          AND c.status = 'active'
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [spaceId, ids, viewerUserId],
    );
    const rows = new Map<string, RevalidatedObject>();
    for (const row of result.rows) {
      rows.set(row.id, { title: row.title, text: joinText([row.claim_text]) });
    }
    return rows;
  }

  const result = await db.query<SourceVisibilityRow>(
    `SELECT s.object_id AS id, so.title, so.visibility, so.owner_user_id,
            so.created_by_user_id, s.uri, s.raw_text, s.summary
       FROM sources s
       JOIN space_objects so ON so.id = s.object_id AND so.space_id = s.space_id
      WHERE s.space_id = $1
        AND s.object_id = ANY($2::varchar[])
        AND so.object_type = 'source'
        AND s.status = 'processed'
        AND ${contentReadSql("space_object", "so", "$3")}`,
    [spaceId, ids, viewerUserId],
  );
  const rows = new Map<string, RevalidatedObject>();
  for (const row of result.rows) {
    rows.set(row.id, { title: row.title, text: row.summary ?? row.raw_text ?? row.uri });
  }
  return rows;
}

async function loadKnowledgeItem(db: Queryable, spaceId: string, objectId: string): Promise<CanonicalObject | null> {
  const result = await db.query<KnowledgeProjectionRow>(
    `SELECT ki.object_id AS id, so.project_folder_id, so.owner_user_id,
            so.created_by_user_id, so.visibility, ki.status,
            ki.knowledge_kind, so.title, ki.slug, ki.aliases_json, ki.content,
            ki.plain_text, so.summary AS excerpt, so.updated_at
       FROM knowledge_items ki
       JOIN space_objects so ON so.id = ki.object_id AND so.space_id = ki.space_id
      WHERE ki.space_id = $1
        AND ki.object_id = $2
        AND so.object_type = 'knowledge_item'`,
    [spaceId, objectId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  const text = joinText([row.title, row.slug, row.plain_text, row.excerpt, row.content]);
  const sourceConnectionIds = await sourceConnectionIdsForTarget(db, spaceId, "knowledge", row.id);
  return {
    objectType: "knowledge_item",
    objectId: row.id,
    title: row.title,
    slug: row.slug,
    projectFolderId: row.project_folder_id,
    ownerUserId: row.owner_user_id ?? row.created_by_user_id,
    visibility: row.visibility,
    status: row.status,
    objectProfile: row.knowledge_kind,
    aliases: stringArray(row.aliases_json),
    text,
    sourceConnectionIds,
    updatedAt: isoOrNull(row.updated_at),
  };
}

async function loadNote(db: Queryable, spaceId: string, objectId: string): Promise<CanonicalObject | null> {
  const result = await db.query<NoteProjectionRow>(
    `SELECT n.object_id AS id, so.title, n.plain_text, so.summary AS excerpt,
            n.status, so.visibility, so.created_by_user_id, so.updated_at
       FROM notes n
       JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
      WHERE n.space_id = $1
        AND n.object_id = $2
        AND so.object_type = 'note'`,
    [spaceId, objectId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  const sourceConnectionIds = await sourceConnectionIdsForTarget(db, spaceId, "note", row.id);
  return {
    objectType: "note",
    objectId: row.id,
    title: row.title,
    slug: null,
    projectFolderId: null,
    ownerUserId: row.created_by_user_id,
    visibility: row.visibility ?? "space_shared",
    status: row.status,
    objectProfile: "note",
    aliases: [],
    text: joinText([row.title, row.excerpt, row.plain_text]),
    sourceConnectionIds,
    updatedAt: isoOrNull(row.updated_at),
  };
}

async function loadSource(db: Queryable, spaceId: string, objectId: string): Promise<CanonicalObject | null> {
  const result = await db.query<SourceProjectionRow>(
    `SELECT s.object_id AS id, s.source_type, so.title, s.uri, s.raw_text,
            s.summary, s.metadata_json, s.status, so.visibility,
            so.created_by_user_id, so.updated_at
       FROM sources s
       JOIN space_objects so ON so.id = s.object_id AND so.space_id = s.space_id
      WHERE s.space_id = $1
        AND s.object_id = $2
        AND so.object_type = 'source'`,
    [spaceId, objectId],
  );
  const row = result.rows[0];
  if (!row || row.status === "archived") return null;
  return {
    objectType: "source",
    objectId: row.id,
    title: row.title,
    slug: row.uri,
    projectFolderId: null,
    ownerUserId: row.created_by_user_id,
    visibility: row.visibility ?? "space_shared",
    status: row.status,
    objectProfile: row.source_type,
    aliases: row.uri ? [row.uri] : [],
    text: joinText([row.title, row.uri, row.summary, row.raw_text]),
    sourceConnectionIds: sourceConnectionIdsFromMetadata(row.metadata_json),
    updatedAt: isoOrNull(row.updated_at),
  };
}

async function loadClaim(db: Queryable, spaceId: string, objectId: string): Promise<CanonicalObject | null> {
  const result = await db.query<ClaimProjectionRow>(
    `SELECT c.object_id AS id, so.project_folder_id, so.owner_user_id,
            so.created_by_user_id, so.visibility, c.status, c.claim_kind,
            so.title, c.subject_text, c.claim_text, c.resolution_state,
            so.updated_at
       FROM claims c
       JOIN space_objects so ON so.id = c.object_id AND so.space_id = c.space_id
      WHERE c.space_id = $1
        AND c.object_id = $2
        AND so.object_type = 'claim'`,
    [spaceId, objectId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "active") return null;
  const sourceConnectionIds = await sourceConnectionIdsForClaim(db, spaceId, row.id);
  return {
    objectType: "claim",
    objectId: row.id,
    title: row.title,
    slug: null,
    projectFolderId: row.project_folder_id,
    ownerUserId: row.owner_user_id ?? row.created_by_user_id,
    visibility: row.visibility,
    status: row.status,
    objectProfile: row.claim_kind,
    aliases: [],
    text: joinText([row.title, row.subject_text, row.claim_text]),
    sourceConnectionIds,
    updatedAt: isoOrNull(row.updated_at),
  };
}

async function sourceConnectionIdsForTarget(
  db: Queryable,
  spaceId: string,
  targetType: string,
  targetId: string,
): Promise<string[]> {
  return (await loadSourceConnectionIdsForTargets(db, spaceId, targetType, [targetId])).get(targetId) ?? [];
}

async function sourceConnectionIdsForClaim(db: Queryable, spaceId: string, claimId: string): Promise<string[]> {
  const rows = await db.query<ClaimSourceConnectionRow>(
    `SELECT cs.source_connection_id, s.metadata_json AS source_metadata_json
       FROM claim_sources cs
       LEFT JOIN sources s
         ON s.object_id = cs.source_object_id
        AND s.space_id = cs.space_id
      WHERE cs.space_id = $1 AND cs.claim_id = $2`,
    [spaceId, claimId],
  );
  const ids = new Set<string>();
  for (const row of rows.rows) {
    if (row.source_connection_id) ids.add(row.source_connection_id);
    for (const id of sourceConnectionIdsFromMetadata(row.source_metadata_json)) ids.add(id);
  }
  return [...ids];
}

async function itemSourceEdges(db: Queryable, spaceId: string, object: CanonicalObject): Promise<RetrievalEdge[]> {
  const where = object.objectType === "knowledge_item" ? "knowledge_item_id = $2" : "source_id = $2";
  const rows = await db.query<ItemSourceProjectionRow>(
    `SELECT knowledge_item_id, source_id, relation_type, confidence
       FROM knowledge_item_sources
      WHERE space_id = $1 AND ${where}`,
    [spaceId, object.objectId],
  );
  return rows.rows.map((row) => ({
    from: { objectType: "knowledge_item", objectId: row.knowledge_item_id },
    to: { objectType: "source", objectId: row.source_id },
    linkType: row.relation_type,
    edgeOrigin: "source_link_projection",
    edgeStatus: "derived",
    confidence: row.confidence ?? 0.9,
    evidence: { source_link: true },
  }));
}

async function claimSourceEdges(db: Queryable, spaceId: string, object: CanonicalObject): Promise<RetrievalEdge[]> {
  const clause = object.objectType === "claim" ? "cs.claim_id = $2" : "cs.source_object_id = $2";
  const rows = await db.query<ClaimSourceProjectionRow>(
    `SELECT cs.claim_id, cs.source_object_id,
            so.object_type AS source_object_type, cs.evidence_role,
            cs.confidence, cs.locator
       FROM claim_sources cs
       JOIN space_objects so
         ON so.id = cs.source_object_id
        AND so.space_id = cs.space_id
       ${objectStatusJoinSql("so")}
      WHERE cs.space_id = $1
        AND ${clause}
        AND cs.source_object_id IS NOT NULL
        AND so.object_type = ANY($3::varchar[])
        AND ${objectStatusSql()} NOT IN ('archived', 'deleted')`,
    [spaceId, object.objectId, KNOWLEDGE_RETRIEVAL_OBJECT_TYPES],
  );
  return rows.rows.map((row) => ({
    from: { objectType: "claim", objectId: row.claim_id },
    to: { objectType: row.source_object_type, objectId: row.source_object_id },
    linkType: row.evidence_role,
    edgeOrigin: "claim_source_projection",
    edgeStatus: "derived",
    confidence: row.confidence ?? 0.9,
    evidence: { locator: row.locator },
  }));
}

async function objectRelationEdges(db: Queryable, spaceId: string, object: CanonicalObject): Promise<RetrievalEdge[]> {
  const rows = await db.query<ObjectRelationProjectionRow>(
    `SELECT r.from_object_id, from_so.object_type AS from_object_type,
            r.to_object_id, to_so.object_type AS to_object_type,
            r.link_type, r.confidence, r.evidence_summary,
            r.source_claim_id
       FROM object_relations r
       JOIN space_objects from_so
         ON from_so.id = r.from_object_id
        AND from_so.space_id = r.space_id
       JOIN space_objects to_so
         ON to_so.id = r.to_object_id
        AND to_so.space_id = r.space_id
      WHERE r.space_id = $1
        AND r.status = 'active'
        AND from_so.object_type = ANY($3::varchar[])
        AND to_so.object_type = ANY($3::varchar[])
        AND (
          r.from_object_id = $2
          OR r.to_object_id = $2
        )`,
    [spaceId, object.objectId, KNOWLEDGE_RETRIEVAL_OBJECT_TYPES],
  );
  return rows.rows.map((row) => ({
    from: { objectType: row.from_object_type, objectId: row.from_object_id },
    to: { objectType: row.to_object_type, objectId: row.to_object_id },
    linkType: row.link_type,
    edgeOrigin: "object_relation_projection",
    edgeStatus: "derived",
    confidence: row.confidence ?? 0.9,
    evidence: {
      evidence_summary: row.evidence_summary,
      source_claim_id: row.source_claim_id,
    },
  }));
}

function joinText(parts: Array<string | null>): string {
  return parts
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/** Normalize a pg timestamptz (Date or string) to an ISO string, or null. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
