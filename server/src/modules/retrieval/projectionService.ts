import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";
import { extractRetrievalLinks } from "./linkExtractor";
import { normalizeAlias, stripMarkdownForSearch } from "./normalize";
import type { RetrievalDomainAdapter, RetrievalRegistry } from "./registry";
import type {
  CanonicalObject,
  RetrievalAlias,
  RetrievalEdge,
  RetrievalObjectRef,
  RetrievalObjectType,
} from "./types";

interface RetrievalObjectRow {
  id: string;
}

interface AliasTargetRow {
  object_type: RetrievalObjectType;
  object_id: string;
}

/**
 * Generic, domain-agnostic projection writer. It loads a canonical object via
 * the registered domain adapter and maintains the derived index tables
 * (`retrieval_objects`, `retrieval_aliases`, `retrieval_chunks`,
 * `retrieval_edges`). It never reads or writes domain tables directly.
 */
export class RetrievalProjectionService {
  constructor(
    private readonly db: Queryable,
    private readonly registry: RetrievalRegistry,
  ) {}

  async reindex(spaceId: string, objectType: RetrievalObjectType, objectId: string): Promise<void> {
    const adapter = this.adapterFor(objectType);
    const object = await adapter.loadCanonical(this.db, spaceId, objectType, objectId);
    if (!object) {
      await this.deleteProjectionForObject(spaceId, objectType, objectId);
      return;
    }
    await this.refreshCanonicalObject(object, spaceId, adapter);
  }

  async deleteProjectionForObject(
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM retrieval_edges
        WHERE space_id = $1
          AND (
            (from_object_type = $2 AND from_object_id = $3)
            OR (to_object_type = $2 AND to_object_id = $3)
          )`,
      [spaceId, objectType, objectId],
    );
    await this.db.query(
      `DELETE FROM retrieval_objects
        WHERE space_id = $1 AND object_type = $2 AND object_id = $3`,
      [spaceId, objectType, objectId],
    );
  }

  /** Rebuild the whole space across every registered domain. Returns per-type counts. */
  async reindexAll(spaceId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const objects: Array<{ object: CanonicalObject; adapter: RetrievalDomainAdapter }> = [];
    for (const adapter of this.registry.adapters()) {
      const refs = await adapter.listObjectIds(this.db, spaceId);
      for (const ref of refs) {
        const object = await adapter.loadCanonical(this.db, spaceId, ref.objectType, ref.objectId);
        if (!object) continue;
        objects.push({ object, adapter });
        counts[ref.objectType] = (counts[ref.objectType] ?? 0) + 1;
      }
    }
    await this.clearSpaceProjection(spaceId, this.registry.objectTypes());
    for (const { object } of objects) {
      await this.insertObjectProjection(object, spaceId);
    }
    for (const { object, adapter } of objects) {
      await this.projectEdgesForObject(spaceId, object, adapter);
    }
    return counts;
  }

  private adapterFor(objectType: RetrievalObjectType): RetrievalDomainAdapter {
    const adapter = this.registry.adapterFor(objectType);
    if (!adapter) throw new Error(`no retrieval adapter registered for object type ${objectType}`);
    return adapter;
  }

  private async refreshCanonicalObject(
    object: CanonicalObject,
    spaceId: string,
    adapter: RetrievalDomainAdapter,
  ): Promise<void> {
    await this.deleteObjectProjectionRow(spaceId, object.objectType, object.objectId);
    // Only outgoing edges are cleared here: projectEdgesForObject below only
    // ever recomputes edges *from* this object (extracted links, then
    // adapter.projectEdges). Deleting incoming edges too would orphan other
    // objects' edges pointing at this one — they're only recomputed when
    // *their* source object is reindexed.
    await this.deleteOutgoingEdgesForObject(spaceId, object.objectType, object.objectId);
    await this.insertObjectProjection(object, spaceId);
    await this.projectEdgesForObject(spaceId, object, adapter);
  }

  private async clearSpaceProjection(
    spaceId: string,
    objectTypes: readonly RetrievalObjectType[],
  ): Promise<void> {
    if (objectTypes.length === 0) return;
    await this.db.query(
      `DELETE FROM retrieval_edges
        WHERE space_id = $1 AND from_object_type = ANY($2::retrieval_object_type[])`,
      [spaceId, objectTypes],
    );
    await this.db.query(
      `DELETE FROM retrieval_objects
        WHERE space_id = $1 AND object_type = ANY($2::retrieval_object_type[])`,
      [spaceId, objectTypes],
    );
  }

  private async deleteObjectProjectionRow(
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM retrieval_objects
        WHERE space_id = $1 AND object_type = $2 AND object_id = $3`,
      [spaceId, objectType, objectId],
    );
  }

  private async deleteOutgoingEdgesForObject(
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM retrieval_edges
        WHERE space_id = $1 AND from_object_type = $2 AND from_object_id = $3`,
      [spaceId, objectType, objectId],
    );
  }

  private async insertObjectProjection(
    object: CanonicalObject,
    spaceId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const contentHash = hashObject({
      objectType: object.objectType,
      objectId: object.objectId,
      title: object.title,
      slug: object.slug,
      status: object.status,
      visibility: object.visibility,
      aliases: object.aliases,
      text: object.text,
      sourceConnectionIds: object.sourceConnectionIds,
    });
    const inserted = await this.db.query<RetrievalObjectRow>(
      `INSERT INTO retrieval_objects (
         id, space_id, object_type, object_id, project_folder_id, owner_user_id,
         visibility, status, title, slug, object_kind, content_hash,
         source_connection_ids_json, indexed_at, updated_at, source_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13::jsonb, $14, $14, $15
       )
       RETURNING id`,
      [
        randomUUID(),
        spaceId,
        object.objectType,
        object.objectId,
        object.projectFolderId,
        object.ownerUserId,
        object.visibility,
        object.status,
        object.title,
        object.slug,
        object.objectKind,
        contentHash,
        JSON.stringify([...new Set(object.sourceConnectionIds)].sort()),
        now,
        // Canonical content freshness (distinct from indexed_at/updated_at = reindex time).
        object.updatedAt,
      ],
    );
    const retrievalObjectId = inserted.rows[0]?.id;
    if (!retrievalObjectId) return;

    await this.insertAliases(spaceId, retrievalObjectId, object);
    await this.insertChunks(spaceId, retrievalObjectId, object);
  }

  private async projectEdgesForObject(
    spaceId: string,
    object: CanonicalObject,
    adapter: RetrievalDomainAdapter,
  ): Promise<void> {
    await this.projectExtractedLinks(spaceId, object);
    if (adapter.projectEdges) {
      const edges = await adapter.projectEdges(this.db, spaceId, object);
      for (const edge of edges) await this.insertEdge(spaceId, edge);
    }
  }

  private async insertAliases(
    spaceId: string,
    retrievalObjectId: string,
    object: CanonicalObject,
  ): Promise<void> {
    const aliases: RetrievalAlias[] = [
      aliasEntry(object.title, "title", 1),
      ...(object.slug ? [aliasEntry(object.slug, object.objectType === "source" ? "url" : "slug", 0.95)] : []),
      ...object.aliases.map((alias) => aliasEntry(alias, object.objectType === "source" ? "url" : "alias", 0.9)),
    ];
    const seen = new Set<string>();
    for (const alias of aliases) {
      if (!alias.normalizedAlias) continue;
      const key = `${alias.aliasKind}:${alias.normalizedAlias}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.db.query(
        `INSERT INTO retrieval_aliases (
           id, retrieval_object_id, space_id, object_type, object_id,
           alias, normalized_alias, alias_kind, confidence, created_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10
         )
         ON CONFLICT (space_id, object_type, object_id, normalized_alias, alias_kind)
         DO NOTHING`,
        [
          randomUUID(),
          retrievalObjectId,
          spaceId,
          object.objectType,
          object.objectId,
          alias.alias,
          alias.normalizedAlias,
          alias.aliasKind,
          alias.confidence,
          new Date().toISOString(),
        ],
      );
    }
  }

  private async insertChunks(
    spaceId: string,
    retrievalObjectId: string,
    object: CanonicalObject,
  ): Promise<void> {
    const chunks = chunksFromText(stripMarkdownForSearch(object.text));
    for (const chunk of chunks) {
      await this.db.query(
        `INSERT INTO retrieval_chunks (
           id, retrieval_object_id, space_id, object_type, object_id,
           chunk_index, plain_text, tsv, content_hash, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, to_tsvector('simple', $7), $8, $9, $9
         )`,
        [
          randomUUID(),
          retrievalObjectId,
          spaceId,
          object.objectType,
          object.objectId,
          chunk.chunkIndex,
          chunk.plainText,
          chunk.contentHash,
          new Date().toISOString(),
        ],
      );
    }
  }

  private async projectExtractedLinks(spaceId: string, object: CanonicalObject): Promise<void> {
    for (const link of extractRetrievalLinks(object.text)) {
      const normalizedCandidates = [
        normalizeAlias(link.target),
        normalizeAlias(link.label),
      ].filter((entry) => entry.length > 0);
      const resolved = await this.resolveUniqueAlias(spaceId, normalizedCandidates);
      if (!resolved) continue;
      if (resolved.object_type === object.objectType && resolved.object_id === object.objectId) continue;
      await this.insertEdge(spaceId, {
        from: { objectType: object.objectType, objectId: object.objectId },
        to: { objectType: resolved.object_type, objectId: resolved.object_id },
        relationType: link.origin === "source_ref" ? "references" : "related_to",
        edgeOrigin: link.origin,
        edgeStatus: "suggested",
        confidence: link.origin === "source_ref" ? 0.95 : 0.85,
        evidence: {
          extracted_target: link.target,
          label: link.label,
          evidence_text: link.evidenceText,
        },
      });
    }
  }

  private async resolveUniqueAlias(
    spaceId: string,
    normalizedCandidates: string[],
  ): Promise<AliasTargetRow | null> {
    const candidates = [...new Set(normalizedCandidates)].filter(Boolean);
    if (!candidates.length) return null;
    const result = await this.db.query<AliasTargetRow>(
      `SELECT DISTINCT object_type, object_id
         FROM retrieval_aliases
        WHERE space_id = $1
          AND normalized_alias = ANY($2::text[])`,
      [spaceId, candidates],
    );
    if (result.rows.length !== 1) return null;
    return result.rows[0]!;
  }

  private async insertEdge(spaceId: string, edge: RetrievalEdge): Promise<void> {
    await this.db.query(
      `INSERT INTO retrieval_edges (
         id, space_id, from_object_type, from_object_id, to_object_type, to_object_id,
         relation_type, edge_origin, edge_status, confidence, evidence_json,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11::jsonb,
         $12, $12
       )
       ON CONFLICT (
         space_id, from_object_type, from_object_id, to_object_type,
         to_object_id, relation_type, edge_origin
       )
       DO UPDATE SET
         edge_status = EXCLUDED.edge_status,
         confidence = EXCLUDED.confidence,
         evidence_json = EXCLUDED.evidence_json,
         updated_at = EXCLUDED.updated_at`,
      [
        randomUUID(),
        spaceId,
        edge.from.objectType,
        edge.from.objectId,
        edge.to.objectType,
        edge.to.objectId,
        edge.relationType,
        edge.edgeOrigin,
        edge.edgeStatus,
        edge.confidence,
        JSON.stringify(edge.evidence),
        new Date().toISOString(),
      ],
    );
  }
}

function aliasEntry(alias: string, aliasKind: string, confidence: number): RetrievalAlias {
  return {
    alias,
    normalizedAlias: normalizeAlias(alias),
    aliasKind,
    confidence,
  };
}

function chunksFromText(text: string): Array<{ chunkIndex: number; plainText: string; contentHash: string }> {
  const source = text.trim();
  if (!source) return [];
  const size = 2200;
  const chunks: Array<{ chunkIndex: number; plainText: string; contentHash: string }> = [];
  for (let start = 0; start < source.length; start += size) {
    const plainText = source.slice(start, start + size).trim();
    if (!plainText) continue;
    chunks.push({
      chunkIndex: chunks.length,
      plainText,
      contentHash: hashObject({ plainText }),
    });
  }
  return chunks;
}

function hashObject(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function objectRefKey(ref: RetrievalObjectRef): string {
  return `${ref.objectType}:${ref.objectId}`;
}
