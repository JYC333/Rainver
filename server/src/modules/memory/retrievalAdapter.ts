import {
  RetrievalRegistry,
  type CanonicalObject,
  type RetrievalDomainAdapter,
  type RetrievalObjectRef,
  type RetrievalObjectType,
  type RevalidatedObject,
  loadSourceConnectionIdsForTargets,
} from "../retrieval";
import {
  shouldRedactMemoryContent,
  type MemoryAuthFields,
} from "./memoryReadAuth";
import { memorySensitivityReadSql } from "./memorySensitivitySql";
import { contentResourceDefinition } from "../access/contentAccessRegistry";
import { isContentAccessLevel, isContentVisibility } from "../access/contentAccessTypes";
import { contentAccessLevelSql, contentReadSql } from "../access/contentAccessSql";

const MEMORY_OBJECT_TYPES = ["memory_entry"] as const;

interface MemoryProjectionRow {
  id: string;
  owner_user_id: string | null;
  sensitivity_level: string | null;
  visibility: string | null;
  access_level: string | null;
  status: string;
  scope_type: string | null;
  memory_type: string;
  title: string | null;
  content: string | null;
  updated_at: Date | string | null;
}

interface MemoryVisibilityRow extends MemoryAuthFields {
  id: string;
  project_id: string | null;
  title: string | null;
  content: string | null;
}

type MemoryProjectableFields = Pick<
  MemoryAuthFields,
  "scope_type" | "visibility" | "access_level" | "owner_user_id" | "sensitivity_level"
>;

// Scope validity is enforced by the canonical table CHECK; projection only
// needs the visibility/access vocabulary checks below.
const MEMORY_RETRIEVAL_PROJECTABLE_SQL = "TRUE";

const MEMORY_DEFINITION = contentResourceDefinition("memory")!;

/**
 * Memory domain adapter for the shared zero-LLM retrieval engine. It owns all
 * Memory-specific SQL — loading `memory_entries` for projection and the live
 * read-access gate. The engine stays domain-agnostic; this is the only place
 * that touches Memory tables.
 *
 * Boundaries this adapter must preserve:
 * - The single read-access gate is `revalidate`, which reuses the canonical
 *   the canonical content rules plus summary-access content redaction. The derived
 *   `retrieval_*` projection is never trusted for read access.
 * - This adapter never writes `memory_entries`. Memory create/update/archive
 *   stay proposal-gated; the projection is derived index data only.
 * - `revalidate` applies the canonical Space, scope, visibility, and grant SQL
 *   predicate. System memory stays excluded from user retrieval.
 */
export const memoryRetrievalAdapter: RetrievalDomainAdapter = {
  objectTypes: MEMORY_OBJECT_TYPES,

  async loadCanonical(db, spaceId, _objectType, objectId): Promise<CanonicalObject | null> {
    const result = await db.query<MemoryProjectionRow>(
      `SELECT id, owner_user_id, visibility, status, memory_type,
              title, content, sensitivity_level, scope_type, access_level, updated_at
         FROM memory_entries
        WHERE space_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [spaceId, objectId],
    );
    const row = result.rows[0];
    if (!row || row.status !== "active" || !isMemoryRetrievalProjectable(row)) return null;
    const title = row.title ?? "";
    const sourceConnectionIds = (await loadSourceConnectionIdsForTargets(
      db,
      spaceId,
      "memory",
      [row.id],
    )).get(row.id) ?? [];
    return {
      objectType: "memory_entry",
      objectId: row.id,
      title,
      slug: null,
      ownerUserId: row.owner_user_id,
      projectFolderId: null,
      visibility: row.visibility,
      status: row.status,
      objectProfile: row.memory_type,
      aliases: [],
      text: joinText([title, row.content]),
      sourceConnectionIds,
      updatedAt: memoryIsoOrNull(row.updated_at),
    };
  },

  async revalidate(db, spaceId, _objectType, objectId, viewerUserId): Promise<RevalidatedObject | null> {
    return (await revalidateMemoryMany(db, spaceId, [objectId], viewerUserId)).get(objectId) ?? null;
  },

  async revalidateMany(db, spaceId, _objectType, objectIds, viewerUserId): Promise<Map<string, RevalidatedObject>> {
    return revalidateMemoryMany(db, spaceId, objectIds, viewerUserId);
  },

  async listObjectIds(db, spaceId): Promise<RetrievalObjectRef[]> {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM memory_entries
        WHERE space_id = $1
          AND status = 'active'
          AND deleted_at IS NULL
          AND ${MEMORY_RETRIEVAL_PROJECTABLE_SQL}`,
      [spaceId],
    );
    return result.rows.map((row) => ({ objectType: "memory_entry" as RetrievalObjectType, objectId: row.id }));
  },
};

async function revalidateMemoryMany(
  db: Parameters<RetrievalDomainAdapter["revalidate"]>[0],
  spaceId: string,
  objectIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, RevalidatedObject>> {
  const ids = uniqueIds(objectIds);
  if (ids.length === 0) return new Map();
  const result = await db.query<MemoryVisibilityRow>(
    `SELECT me.id, me.space_id, me.deleted_at, me.sensitivity_level, me.visibility,
            me.access_level, ${contentAccessLevelSql({ definition: MEMORY_DEFINITION, alias: "me", userExpr: "$3" })} AS effective_access_level,
            me.owner_user_id, me.scope_type, me.project_id, me.title, me.content
       FROM memory_entries me
      WHERE me.space_id = $1
        AND me.id = ANY($2::varchar[])
        AND me.status = 'active'
        AND me.deleted_at IS NULL
        AND ${contentReadSql("memory", "me", "$3")}
        AND ${memorySensitivityReadSql("me", "$3")}`,
    [spaceId, ids, viewerUserId],
  );
  const rows = new Map<string, RevalidatedObject>();
  for (const row of result.rows) {
    rows.set(row.id, {
      title: row.title ?? "",
      text: shouldRedactMemoryContent(row, viewerUserId) ? null : row.content,
    });
  }
  return rows;
}

/**
 * Process-wide registry with only the Memory adapter registered. Memory keeps a
 * separate registry from Knowledge so the memory retrieval surface (create-safety,
 * reindex) can never resolve Knowledge objects, and vice versa.
 */
export const memoryRetrievalRegistry = new RetrievalRegistry();
memoryRetrievalRegistry.register(memoryRetrievalAdapter);

function joinText(parts: Array<string | null>): string {
  return parts
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

/** Normalize a pg timestamptz (Date or string) to an ISO string, or null. */
function memoryIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isMemoryRetrievalProjectable(row: MemoryProjectableFields): boolean {
  return isContentVisibility(row.visibility) && isContentAccessLevel(row.access_level);
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
