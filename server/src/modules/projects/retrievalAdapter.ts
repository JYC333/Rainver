import {
  RetrievalRegistry,
  type CanonicalObject,
  type RetrievalDomainAdapter,
  type RetrievalObjectRef,
  type RetrievalObjectType,
  type RevalidatedObject,
  sourceConnectionIdsFromSourceRefs,
} from "../retrieval/index.js";

const PROJECT_PUBLIC_SUMMARY_OBJECT_TYPES = ["project_public_summary"] as const;

interface ProjectPublicSummaryProjectionRow {
  project_id: string;
  name: string;
  description: string | null;
  current_focus: string | null;
  owner_user_id: string | null;
  status: string;
  summary_text: string;
  topics_json: unknown;
  highlights_json: unknown;
  source_refs_json: unknown;
  review_status: string;
  updated_at: Date | string | null;
}

/**
 * Projects domain adapter for the shared zero-LLM retrieval engine.
 *
 * It indexes only the deliberately public, redacted high-level project summary.
 * Concrete project memory, artifacts, docs, and memo content are never read here
 * and remain behind their own project/member gates.
 */
export const projectRetrievalAdapter: RetrievalDomainAdapter = {
  objectTypes: PROJECT_PUBLIC_SUMMARY_OBJECT_TYPES,

  async loadCanonical(db, spaceId, _objectType, objectId): Promise<CanonicalObject | null> {
    const row = await loadSummaryRow(db, spaceId, objectId);
    if (!row || row.status !== "active" || row.review_status !== "approved") return null;
    const topics = stringArray(row.topics_json);
    const highlights = stringArray(row.highlights_json);
    return {
      objectType: "project_public_summary",
      objectId: row.project_id,
      title: row.name,
      slug: null,
      projectFolderId: null,
      ownerUserId: row.owner_user_id,
      visibility: "space_shared",
      status: row.review_status,
      objectProfile: "project_public_summary",
      aliases: [...topics],
      text: joinText([
        row.name,
        row.description,
        row.current_focus,
        row.summary_text,
        topics.join("\n"),
        highlights.join("\n"),
      ]),
      sourceConnectionIds: sourceConnectionIdsFromSourceRefs(row.source_refs_json),
      updatedAt: summaryIsoOrNull(row.updated_at),
    };
  },

  async revalidate(db, spaceId, _objectType, objectId): Promise<RevalidatedObject | null> {
    return (await revalidateProjectSummaries(db, spaceId, [objectId])).get(objectId) ?? null;
  },

  async revalidateMany(db, spaceId, _objectType, objectIds): Promise<Map<string, RevalidatedObject>> {
    return revalidateProjectSummaries(db, spaceId, objectIds);
  },

  async listObjectIds(db, spaceId): Promise<RetrievalObjectRef[]> {
    const result = await db.query<{ project_id: string }>(
      `SELECT ps.project_id
         FROM project_public_summaries ps
         JOIN projects p
           ON p.id = ps.project_id
          AND p.space_id = ps.space_id
        WHERE ps.space_id = $1
          AND ps.review_status = 'approved'
          AND p.status = 'active'
          AND p.deleted_at IS NULL`,
      [spaceId],
    );
    return result.rows.map((row) => ({
      objectType: "project_public_summary" as RetrievalObjectType,
      objectId: row.project_id,
    }));
  },
};

export const projectRetrievalRegistry = new RetrievalRegistry();
projectRetrievalRegistry.register(projectRetrievalAdapter);

async function revalidateProjectSummaries(
  db: Parameters<RetrievalDomainAdapter["revalidate"]>[0],
  spaceId: string,
  projectIds: readonly string[],
): Promise<Map<string, RevalidatedObject>> {
  const ids = uniqueIds(projectIds);
  if (ids.length === 0) return new Map();
  const result = await db.query<ProjectPublicSummaryProjectionRow>(
    `SELECT ps.project_id,
            p.name,
            p.description,
            p.current_focus,
            p.owner_user_id,
            p.status,
            ps.summary_text,
            ps.topics_json,
            ps.highlights_json,
            ps.source_refs_json,
            ps.review_status
       FROM project_public_summaries ps
       JOIN projects p
         ON p.id = ps.project_id
        AND p.space_id = ps.space_id
      WHERE ps.space_id = $1
        AND ps.project_id = ANY($2::varchar[])
        AND p.deleted_at IS NULL
        AND p.status = 'active'
        AND ps.review_status = 'approved'`,
    [spaceId, ids],
  );
  return new Map(
    result.rows.map((row) => [
      row.project_id,
      {
        title: row.name,
        text: joinText([
          row.current_focus,
          row.summary_text,
          stringArray(row.topics_json).join("\n"),
          stringArray(row.highlights_json).join("\n"),
        ]),
      },
    ]),
  );
}

async function loadSummaryRow(
  db: Parameters<RetrievalDomainAdapter["loadCanonical"]>[0],
  spaceId: string,
  projectId: string,
): Promise<ProjectPublicSummaryProjectionRow | null> {
  const result = await db.query<ProjectPublicSummaryProjectionRow>(
    `SELECT ps.project_id,
            p.name,
            p.description,
            p.current_focus,
            p.owner_user_id,
            p.status,
            ps.summary_text,
            ps.topics_json,
            ps.highlights_json,
            ps.source_refs_json,
            ps.review_status,
            ps.updated_at
       FROM project_public_summaries ps
       JOIN projects p
         ON p.id = ps.project_id
        AND p.space_id = ps.space_id
      WHERE ps.space_id = $1
        AND ps.project_id = $2
        AND p.deleted_at IS NULL
      LIMIT 1`,
    [spaceId, projectId],
  );
  return result.rows[0] ?? null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function joinText(parts: Array<string | null>): string {
  return parts
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n");
}

/** Normalize a pg timestamptz (Date or string) to an ISO string, or null. */
function summaryIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
