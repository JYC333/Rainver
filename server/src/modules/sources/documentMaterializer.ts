import { randomUUID } from "node:crypto";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import type {
  ExtractionProfileMaterializationInput,
  ExtractionProfileMaterializationResult,
} from "../extractionProfiles/registry.js";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";

interface DocumentSourceItem {
  id: string;
  title: string;
  canonical_uri: string | null;
  source_uri: string | null;
  source_domain: string | null;
  item_type: string;
  author: string | null;
  occurred_at: unknown;
  excerpt: string | null;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
  reference_object_id: string | null;
  reference_project_id: string | null;
}

function sourceType(
  itemType: string,
): "webpage" | "article" | "pdf" | "file" | "email" {
  if (itemType === "pdf") return "pdf";
  if (itemType === "file") return "file";
  if (itemType === "email") return "email";
  if (itemType === "article") return "article";
  return "webpage";
}

export async function materializeDocumentFromSourceItem(
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
): Promise<ExtractionProfileMaterializationResult | null> {
  return withQueryableTransaction(db, (tx) =>
    materializeDocumentInTransaction(tx, input),
  );
}

async function materializeDocumentInTransaction(
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
): Promise<ExtractionProfileMaterializationResult | null> {
  const result = await db.query<DocumentSourceItem>(
    `SELECT si.id, si.title, si.canonical_uri, si.source_uri, si.source_domain,
            si.item_type, si.author, si.occurred_at, si.excerpt,
            si.created_by_user_id, si.owner_user_id, si.visibility, si.access_level,
            sir.reference_object_id, reference.primary_project_id AS reference_project_id
       FROM source_items si
       LEFT JOIN source_item_references sir
         ON sir.source_item_id = si.id AND sir.space_id = si.space_id
       LEFT JOIN space_objects reference
         ON reference.id = sir.reference_object_id AND reference.space_id = sir.space_id
      WHERE si.space_id = $1 AND si.id = $2 AND si.deleted_at IS NULL
      LIMIT 1
      FOR UPDATE OF si`,
    [input.spaceId, input.sourceItemId],
  );
  const item = result.rows[0];
  if (!item) return null;
  if (item.reference_object_id) {
    if (
      item.reference_project_id &&
      item.reference_project_id !== input.projectId
    ) {
      throw new Error(
        "SourceItem is already materialized for a different Project",
      );
    }
    return { objectId: item.reference_object_id, created: false };
  }

  const canonicalUri = item.canonical_uri?.trim();
  if (!canonicalUri) return null;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `document:${input.spaceId}:${input.projectId}:${canonicalUri}`,
  ]);

  const existing = await db.query<{ object_id: string }>(
    `SELECT source.object_id
       FROM sources source
       JOIN space_objects object
         ON object.id = source.object_id AND object.space_id = source.space_id
      WHERE source.space_id = $1
        AND source.uri = $2
        AND source.metadata_json->>'materialization_profile' = 'generic_document_v1'
        AND object.primary_project_id = $3
        AND object.deleted_at IS NULL
      ORDER BY object.created_at ASC, object.id ASC
      LIMIT 1`,
    [input.spaceId, canonicalUri, input.projectId],
  );
  const now = new Date().toISOString();
  const existingObjectId = existing.rows[0]?.object_id;
  if (existingObjectId) {
    await linkSourceItemReference(db, input, existingObjectId, now);
    return { objectId: existingObjectId, created: false };
  }

  const objectId = randomUUID();
  const object = buildSpaceObjectInsert({
    id: objectId,
    spaceId: input.spaceId,
    objectType: "source",
    title: item.title || canonicalUri,
    summary: item.excerpt,
    visibility: item.visibility,
    accessLevel: item.access_level,
    ownerUserId: item.owner_user_id,
    primaryProjectId: input.projectId,
    createdByUserId: item.created_by_user_id ?? item.owner_user_id,
    createdAt: now,
  });
  await db.query(object.sql, object.params);
  if (item.visibility === "selected_users") {
    await inheritContentAccessGrants(db, {
      spaceId: input.spaceId,
      sourceResourceType: "source_item",
      sourceResourceId: item.id,
      targetResourceType: "space_object",
      targetResourceId: objectId,
      inheritedAt: now,
    });
  }
  await db.query(
    `INSERT INTO sources (
       object_id, space_id, source_type, status, uri, summary, metadata_json
     ) VALUES ($1, $2, $3, 'processed', $4, $5, $6::jsonb)`,
    [
      objectId,
      input.spaceId,
      sourceType(item.item_type),
      canonicalUri,
      item.excerpt,
      JSON.stringify({
        materialization_profile: "generic_document_v1",
        source_item_id: item.id,
        source_uri: item.source_uri,
        source_domain: item.source_domain,
        author: item.author,
        occurred_at: item.occurred_at,
      }),
    ],
  );
  await linkSourceItemReference(db, input, objectId, now);
  return { objectId, created: true };
}

async function linkSourceItemReference(
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
  objectId: string,
  now: string,
): Promise<void> {
  await db.query(
    `INSERT INTO source_item_references (
       source_item_id, space_id, reference_object_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (source_item_id) DO UPDATE SET
       reference_object_id = EXCLUDED.reference_object_id,
       updated_at = EXCLUDED.updated_at`,
    [input.sourceItemId, input.spaceId, objectId, now],
  );
}
