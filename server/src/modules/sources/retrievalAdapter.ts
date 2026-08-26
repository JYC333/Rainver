import {
  RetrievalRegistry,
  type CanonicalObject,
  type RetrievalDomainAdapter,
  type RetrievalEdge,
  type RetrievalObjectRef,
  type RetrievalObjectType,
  type RevalidatedObject,
} from "../retrieval/index.js";
import type { Queryable } from "../routeUtils/common.js";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import { evidenceProvenanceReadableClause, sourceItemReadableClause } from "./sourceItemAccess.js";

const SOURCE_RETRIEVAL_OBJECT_TYPES = ["source_item", "extracted_evidence"] as const;
const INDEXABLE_EVIDENCE_STATUSES = ["candidate", "active"] as const;
const SOURCE_ITEM_ACCESS = contentResourceDefinition("source_item")!;
const EVIDENCE_ACCESS = contentResourceDefinition("extracted_evidence")!;

interface SourceItemProjectionRow {
  id: string;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  connection_id: string | null;
  item_type: string;
  title: string;
  source_uri: string | null;
  canonical_uri: string | null;
  source_domain: string | null;
  source_external_id: string | null;
  author: string | null;
  occurred_at: Date | string | null;
  excerpt: string | null;
  content_state: string;
  retention_policy: string;
  metadata_json: unknown;
  updated_at: Date | string | null;
  last_seen_at: Date | string | null;
}

interface EvidenceProjectionRow {
  id: string;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  source_item_id: string | null;
  source_snapshot_connection_id: string | null;
  item_connection_id: string | null;
  evidence_type: string;
  title: string;
  content_excerpt: string | null;
  source_uri: string | null;
  source_title: string | null;
  source_author: string | null;
  occurred_at: Date | string | null;
  trust_level: string;
  extraction_method: string;
  confidence: number | null;
  status: string;
  metadata_json: unknown;
  updated_at: Date | string | null;
}

interface ItemEdgeRow {
  evidence_id: string;
  evidence_type: string;
  confidence: number | null;
}

interface EvidenceEdgeRow {
  source_item_id: string;
}

/**
 * Source domain adapter for the shared retrieval engine.
 *
 * It projects only lightweight source metadata and excerpts. Full snapshots and
 * raw extracted artifacts are intentionally not indexed by default; they remain
 * behind explicit reader/sources policies and future opt-in settings.
 */
export const sourceRetrievalAdapter: RetrievalDomainAdapter = {
  objectTypes: SOURCE_RETRIEVAL_OBJECT_TYPES,

  async loadCanonical(db, spaceId, objectType, objectId): Promise<CanonicalObject | null> {
    if (objectType === "source_item") return loadSourceItem(db, spaceId, objectId);
    if (objectType === "extracted_evidence") return loadExtractedEvidence(db, spaceId, objectId);
    return null;
  },

  async revalidate(db, spaceId, objectType, objectId, viewerUserId): Promise<RevalidatedObject | null> {
    return (await revalidateSourcesMany(db, spaceId, objectType, [objectId], viewerUserId)).get(objectId) ?? null;
  },

  async revalidateMany(db, spaceId, objectType, objectIds, viewerUserId): Promise<Map<string, RevalidatedObject>> {
    return revalidateSourcesMany(db, spaceId, objectType, objectIds, viewerUserId);
  },

  async projectEdges(db, spaceId, object): Promise<RetrievalEdge[]> {
    if (object.objectType === "source_item") {
      return sourceItemEvidenceEdges(db, spaceId, object.objectId);
    }
    if (object.objectType === "extracted_evidence") {
      return evidenceSourceItemEdge(db, spaceId, object.objectId);
    }
    return [];
  },

  async listObjectIds(db, spaceId): Promise<RetrievalObjectRef[]> {
    const refs: RetrievalObjectRef[] = [];
    const items = await db.query<{ id: string }>(
      `SELECT id
         FROM source_items
        WHERE space_id = $1
          AND deleted_at IS NULL`,
      [spaceId],
    );
    for (const row of items.rows) refs.push({ objectType: "source_item" as RetrievalObjectType, objectId: row.id });

    const evidence = await db.query<{ id: string }>(
      `SELECT ee.id
         FROM extracted_evidence ee
         LEFT JOIN source_items ii
          ON ii.space_id = ee.space_id
          AND ii.id = COALESCE(ee.source_item_id, ee.origin_source_item_id)
          AND ii.deleted_at IS NULL
         LEFT JOIN source_snapshots ss
           ON ss.space_id = ee.space_id
          AND ss.id = ee.source_snapshot_id
        WHERE ee.space_id = $1
          AND ee.status = ANY($2::varchar[])
          AND ee.deleted_at IS NULL`,
      [spaceId, [...INDEXABLE_EVIDENCE_STATUSES]],
    );
    for (const row of evidence.rows) refs.push({ objectType: "extracted_evidence" as RetrievalObjectType, objectId: row.id });
    return refs;
  },
};

export const sourceRetrievalRegistry = new RetrievalRegistry();
sourceRetrievalRegistry.register(sourceRetrievalAdapter);

async function loadSourceItem(
  db: Parameters<RetrievalDomainAdapter["loadCanonical"]>[0],
  spaceId: string,
  itemId: string,
): Promise<CanonicalObject | null> {
  const result = await db.query<SourceItemProjectionRow>(
    `SELECT id, owner_user_id, visibility, access_level,
            connection_id, item_type, title, source_uri, canonical_uri,
            source_domain, source_external_id, author, occurred_at, excerpt,
            content_state, retention_policy, metadata_json,
            updated_at, last_seen_at
       FROM source_items
      WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [spaceId, itemId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    objectType: "source_item",
    objectId: row.id,
    title: row.title,
    slug: row.canonical_uri ?? row.source_uri,
    projectFolderId: null,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    status: row.content_state,
    objectProfile: row.item_type,
    aliases: stringValues([row.source_uri, row.canonical_uri, row.source_domain, row.source_external_id, row.author]),
    text: sourceItemText(row),
    sourceConnectionIds: row.connection_id ? [row.connection_id] : [],
    updatedAt: isoOrNull(row.updated_at ?? row.last_seen_at ?? row.occurred_at),
  };
}

async function loadExtractedEvidence(
  db: Parameters<RetrievalDomainAdapter["loadCanonical"]>[0],
  spaceId: string,
  evidenceId: string,
): Promise<CanonicalObject | null> {
  const result = await db.query<EvidenceProjectionRow>(
    evidenceSelectSql(
      `ee.space_id = $1
        AND ee.id = $2
        AND ee.deleted_at IS NULL
        AND ee.status = ANY($3::varchar[])
        AND (ii.id IS NOT NULL OR ss.id IS NOT NULL)`,
    ),
    [spaceId, evidenceId, [...INDEXABLE_EVIDENCE_STATUSES]],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    objectType: "extracted_evidence",
    objectId: row.id,
    title: row.title,
    slug: null,
    projectFolderId: null,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    status: row.status,
    objectProfile: row.evidence_type,
    aliases: stringValues([row.source_title, row.source_author, row.source_uri]),
    text: evidenceText(row),
    sourceConnectionIds: stringValues([row.item_connection_id, row.source_snapshot_connection_id]),
    updatedAt: isoOrNull(row.updated_at ?? row.occurred_at),
  };
}

async function revalidateSourcesMany(
  db: Parameters<RetrievalDomainAdapter["revalidate"]>[0],
  spaceId: string,
  objectType: RetrievalObjectType,
  objectIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, RevalidatedObject>> {
  const ids = uniqueIds(objectIds);
  if (ids.length === 0) return new Map();
  if (objectType === "source_item") {
    const result = await db.query<SourceItemProjectionRow>(
      `SELECT id, owner_user_id, visibility, access_level,
              connection_id, item_type, title, source_uri, canonical_uri,
              source_domain, source_external_id, author, occurred_at, excerpt,
              content_state, retention_policy, metadata_json,
              updated_at, last_seen_at
         FROM source_items
        WHERE space_id = $1
          AND id = ANY($2::varchar[])
          AND deleted_at IS NULL
          AND ${sourceItemReadableClause("source_items", "$3", false)}
          AND ${contentAccessLevelSql({ definition: SOURCE_ITEM_ACCESS, alias: "source_items", userExpr: "$3" })} = 'full'`,
      [spaceId, ids, viewerUserId],
    );
    return new Map(result.rows.map((row) => [row.id, { title: row.title, text: sourceItemText(row) }]));
  }
  if (objectType === "extracted_evidence") {
    const result = await db.query<EvidenceProjectionRow>(
      evidenceSelectSql(
        `ee.space_id = $1
          AND ee.id = ANY($2::varchar[])
          AND ee.deleted_at IS NULL
          AND ee.status = ANY($3::varchar[])
          AND (ii.id IS NOT NULL OR ss.id IS NOT NULL)
          AND ${contentReadSql("extracted_evidence", "ee", "$4")}
          AND ${contentAccessLevelSql({ definition: EVIDENCE_ACCESS, alias: "ee", userExpr: "$4" })} = 'full'
          AND ${evidenceProvenanceReadableClause("ee", "$4", true)}`,
      ),
      [spaceId, ids, [...INDEXABLE_EVIDENCE_STATUSES], viewerUserId],
    );
    return new Map(result.rows.map((row) => [row.id, { title: row.title, text: evidenceText(row) }]));
  }
  return new Map();
}

async function sourceItemEvidenceEdges(
  db: Queryable,
  spaceId: string,
  itemId: string,
): Promise<RetrievalEdge[]> {
  const result = await db.query<ItemEdgeRow>(
    `SELECT id AS evidence_id, evidence_type, confidence
       FROM extracted_evidence
      WHERE space_id = $1
        AND COALESCE(source_item_id, origin_source_item_id) = $2
        AND status = ANY($3::varchar[])
        AND deleted_at IS NULL`,
    [spaceId, itemId, [...INDEXABLE_EVIDENCE_STATUSES]],
  );
  return result.rows.map((row) => ({
    from: { objectType: "source_item", objectId: itemId },
    to: { objectType: "extracted_evidence", objectId: row.evidence_id },
    linkType: "has_evidence",
    edgeOrigin: "source",
    edgeStatus: "derived",
    confidence: boundedConfidence(row.confidence, 0.8),
    evidence: { evidence_type: row.evidence_type },
  }));
}

async function evidenceSourceItemEdge(
  db: Queryable,
  spaceId: string,
  evidenceId: string,
): Promise<RetrievalEdge[]> {
  const result = await db.query<EvidenceEdgeRow>(
    `SELECT COALESCE(ee.source_item_id, ee.origin_source_item_id) AS source_item_id
       FROM extracted_evidence ee
       JOIN source_items ii
         ON ii.space_id = ee.space_id
        AND ii.id = COALESCE(ee.source_item_id, ee.origin_source_item_id)
        AND ii.deleted_at IS NULL
      WHERE ee.space_id = $1
        AND ee.id = $2
        AND ee.status = ANY($3::varchar[])
        AND ee.deleted_at IS NULL`,
    [spaceId, evidenceId, [...INDEXABLE_EVIDENCE_STATUSES]],
  );
  const sourceItemId = result.rows[0]?.source_item_id;
  if (!sourceItemId) return [];
  return [{
    from: { objectType: "extracted_evidence", objectId: evidenceId },
    to: { objectType: "source_item", objectId: sourceItemId },
    linkType: "evidence_for",
    edgeOrigin: "source",
    edgeStatus: "derived",
    confidence: 0.9,
    evidence: { source_item_id: sourceItemId },
  }];
}

function evidenceSelectSql(whereClause: string): string {
  return `SELECT ee.id, ee.owner_user_id, ee.visibility, ee.access_level,
                 COALESCE(ee.source_item_id, ee.origin_source_item_id) AS source_item_id,
                 ss.connection_id AS source_snapshot_connection_id,
                 ii.connection_id AS item_connection_id, ee.evidence_type, ee.title,
                 ee.content_excerpt, ee.source_uri, ee.source_title, ee.source_author,
                 ee.occurred_at, ee.trust_level, ee.extraction_method, ee.confidence,
                 ee.status, ee.metadata_json, ee.updated_at
            FROM extracted_evidence ee
            LEFT JOIN source_items ii
              ON ii.space_id = ee.space_id
             AND ii.id = COALESCE(ee.source_item_id, ee.origin_source_item_id)
            LEFT JOIN source_snapshots ss
              ON ss.space_id = ee.space_id
             AND ss.id = ee.source_snapshot_id
           WHERE ${whereClause}`;
}

function sourceItemText(row: SourceItemProjectionRow): string {
  return joinText([
    `Title: ${row.title}`,
    row.author ? `Author: ${row.author}` : null,
    row.source_uri ? `URL: ${row.source_uri}` : null,
    row.source_domain ? `Domain: ${row.source_domain}` : null,
    row.occurred_at ? `Occurred at: ${isoOrNull(row.occurred_at)}` : null,
    row.excerpt ? `Excerpt: ${row.excerpt}` : null,
    metadataText(row.metadata_json),
  ]);
}

function evidenceText(row: EvidenceProjectionRow): string {
  return joinText([
    `Evidence: ${row.title}`,
    `Type: ${row.evidence_type}`,
    row.source_title ? `Source title: ${row.source_title}` : null,
    row.source_author ? `Source author: ${row.source_author}` : null,
    row.source_uri ? `Source URL: ${row.source_uri}` : null,
    row.content_excerpt ? `Excerpt: ${row.content_excerpt}` : null,
    row.extraction_method ? `Extraction method: ${row.extraction_method}` : null,
  ]);
}

function metadataText(value: unknown): string | null {
  const record = objectRecord(value);
  if (!record) return null;
  const lines: string[] = [];
  const keys = ["connector_key", "capture_method", "categories", "primary_category", "search_query", "authors"];
  for (const key of keys) {
    const raw = record[key];
    const rendered = Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(0, 10).join(", ")
      : typeof raw === "string" && raw.trim().length > 0
        ? raw.trim()
        : "";
    if (rendered) lines.push(`${key}: ${rendered}`);
  }
  return lines.length ? `Metadata:\n${lines.join("\n")}` : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function joinText(parts: Array<string | null>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n");
}

function stringValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function boundedConfidence(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
