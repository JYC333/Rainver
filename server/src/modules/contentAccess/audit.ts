import type { Queryable } from "../routeUtils/common.js";
import { HttpError, withQueryableTransaction } from "../routeUtils/common.js";
import { contentResourceDefinition } from "../access/contentAccessRegistry.js";
import type { RetrievalObjectType } from "@rainver/protocol";

export interface ContentAccessLogEntry {
  id: string;
  space_id: string;
  resource_type: string;
  resource_id: string;
  owner_user_id: string;
  viewer_user_id: string;
  viewer_display_name: string;
  agent_id: string | null;
  run_id: string | null;
  access_type: string;
  reason: string | null;
  accessed_at: string;
}

export function contentResourceTypeForRetrievalObject(
  objectType: RetrievalObjectType,
): string | null {
  switch (objectType) {
    case "knowledge_item":
    case "note":
    case "source":
    case "claim":
    case "inquiry_thread":
      return "space_object";
    case "memory_entry":
      return "memory";
    case "source_item":
    case "extracted_evidence":
      return objectType;
    case "project_public_summary":
      return null;
  }
}

export class ContentAccessAuditService {
  constructor(private readonly db: Queryable) {}

  async recordReads(input: {
    spaceId: string;
    resourceType: string;
    resourceIds: readonly string[];
    viewerUserId: string;
    accessType: string;
    reason?: string | null;
    agentId?: string | null;
    runId?: string | null;
  }): Promise<number> {
    const definition = contentResourceDefinition(input.resourceType);
    if (!definition) throw new HttpError(404, "Content type not found");
    const resourceIds = [...new Set(input.resourceIds)];
    if (resourceIds.length === 0) return 0;
    const alias = "audited_resource";
    const active = definition.activePredicate?.(alias) ?? "true";
    return withQueryableTransaction(this.db, async (db) => {
      if (input.resourceType === "memory") {
        await db.query(
          `UPDATE memory_entries
              SET access_count = COALESCE(access_count, 0) + 1,
                  last_accessed_at = now()
            WHERE space_id = $1 AND id = ANY($2::varchar[])`,
          [input.spaceId, resourceIds],
        );
      }
      const result = await db.query(
        `INSERT INTO content_access_logs (
           id, space_id, resource_type, resource_id, owner_user_id,
           viewer_user_id, agent_id, run_id, access_type, reason, accessed_at
         )
         SELECT gen_random_uuid()::text, ${alias}.space_id, $3::varchar(64), ${alias}.id,
                ${alias}.${definition.ownerColumn}, $4::varchar(36), $5::varchar(36),
                $6::varchar(36), $7::varchar(64), $8::varchar(512), now()
           FROM ${definition.tableName} ${alias}
          WHERE ${alias}.space_id = $1
            AND ${alias}.id = ANY($2::varchar[])
            AND ${active}
            AND ${alias}.${definition.ownerColumn} IS NOT NULL
            AND ${alias}.${definition.ownerColumn} <> $4::varchar(36)`,
        [input.spaceId, resourceIds, input.resourceType, input.viewerUserId,
          input.agentId ?? null, input.runId ?? null, input.accessType,
          input.reason ?? null],
      );
      return result.rowCount ?? 0;
    });
  }

  async listForOwner(input: {
    spaceId: string;
    resourceType: string;
    resourceId: string;
    ownerUserId: string;
    limit: number;
    offset: number;
  }): Promise<{ items: ContentAccessLogEntry[]; limit: number; offset: number; returned: number; has_more: boolean }> {
    const definition = contentResourceDefinition(input.resourceType);
    if (!definition) throw new HttpError(404, "Content type not found");
    const alias = "owned_resource";
    const active = definition.activePredicate?.(alias) ?? "true";
    const owned = await this.db.query(
      `SELECT 1
         FROM ${definition.tableName} ${alias}
        WHERE ${alias}.space_id = $1 AND ${alias}.id = $2
          AND ${active} AND ${alias}.${definition.ownerColumn} = $3
        LIMIT 1`,
      [input.spaceId, input.resourceId, input.ownerUserId],
    );
    if (owned.rows.length === 0) throw new HttpError(404, "Content not found");

    const result = await this.db.query<Omit<ContentAccessLogEntry, "accessed_at"> & { accessed_at: Date | string }>(
      `SELECT l.id, l.space_id, l.resource_type, l.resource_id,
              l.owner_user_id, l.viewer_user_id,
              u.display_name AS viewer_display_name, l.agent_id, l.run_id,
              l.access_type, l.reason, l.accessed_at
         FROM content_access_logs l
         JOIN users u ON u.id = l.viewer_user_id
        WHERE l.space_id = $1 AND l.resource_type = $2 AND l.resource_id = $3
          AND l.owner_user_id = $4
        ORDER BY l.accessed_at DESC, l.id DESC
        LIMIT $5 OFFSET $6`,
      [input.spaceId, input.resourceType, input.resourceId, input.ownerUserId,
        input.limit + 1, input.offset],
    );
    const hasMore = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit).map((row) => ({
      ...row,
      accessed_at: new Date(row.accessed_at).toISOString(),
    }));
    return { items: rows, limit: input.limit, offset: input.offset, returned: rows.length, has_more: hasMore };
  }
}

/**
 * Records a successful detail read of a single resource.
 *
 * ADR 0013 decision 18: the log exists so decision 17's demotion disclosure can
 * name the people who actually saw the content. Retrieval and context paths log
 * through `recordReads` directly; ordinary detail endpoints use this wrapper so
 * a demoted Task or Artifact does not report an empty reader list. Same-owner
 * reads are dropped by the `owner <> viewer` predicate inside `recordReads`, so
 * callers do not need to pre-check ownership.
 */
export async function recordDetailRead(
  db: Queryable,
  input: {
    spaceId: string;
    viewerUserId: string;
    resourceType: string;
    resourceId: string;
    accessType?: string;
  },
): Promise<void> {
  await new ContentAccessAuditService(db).recordReads({
    spaceId: input.spaceId,
    resourceType: input.resourceType,
    resourceIds: [input.resourceId],
    viewerUserId: input.viewerUserId,
    accessType: input.accessType ?? "detail_read",
  });
}
