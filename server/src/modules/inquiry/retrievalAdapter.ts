import {
  RetrievalRegistry,
  type CanonicalObject,
  type RetrievalDomainAdapter,
  type RetrievalObjectRef,
  type RetrievalObjectType,
  type RevalidatedObject,
} from "../retrieval/index.js";
import { canReadProject } from "../projects/access.js";
import type { Queryable } from "../routeUtils/common.js";
import { threadReadableSql } from "./threadAccess.js";

const INQUIRY_OBJECT_TYPES = ["inquiry_thread"] as const;

interface ThreadProjectionRow {
  id: string;
  project_id: string;
  kind: string;
  statement: string;
  lifecycle_status: string;
  updated_at: Date | string | null;
  owner_user_id: string | null;
  visibility: string;
  current_answer_summary: string | null;
  known_gaps: string | null;
  proposed_claim: string | null;
  predictions: string | null;
}

const THREAD_PROJECTION_SELECT = `SELECT t.object_id AS id, t.project_id, t.kind, t.statement, t.lifecycle_status,
            so.updated_at, so.owner_user_id, so.visibility,
            qs.current_answer_summary, qs.known_gaps, hs.proposed_claim, hs.predictions
       FROM inquiry_threads t
       JOIN space_objects so ON so.id = t.object_id AND so.space_id = t.space_id
       LEFT JOIN inquiry_question_states qs ON qs.thread_id = t.object_id
       LEFT JOIN inquiry_hypothesis_states hs ON hs.thread_id = t.object_id`;

/**
 * Inquiry Domain adapter for the shared zero-LLM retrieval engine. Threads are
 * `space_objects` rows (ADR 0011 decision 1) whose Inquiry state lives in the
 * Inquiry tables, so this adapter reads those tables directly. `revalidate`
 * is the access gate: the Thread root's content predicate (a private Thread is
 * its owner's) and read access to its Project. The canonical object carries
 * the root's real owner and visibility, which projection and taint
 * attribution depend on.
 */
export const inquiryRetrievalAdapter: RetrievalDomainAdapter = {
  objectTypes: INQUIRY_OBJECT_TYPES,

  async loadCanonical(db, spaceId, _objectType, threadId): Promise<CanonicalObject | null> {
    const result = await db.query<ThreadProjectionRow>(
      `${THREAD_PROJECTION_SELECT}
      WHERE t.space_id = $1 AND t.object_id = $2
      LIMIT 1`,
      [spaceId, threadId],
    );
    const row = result.rows[0];
    if (!row || row.lifecycle_status === "superseded") return null;
    return {
      objectType: "inquiry_thread",
      objectId: row.id,
      title: row.statement,
      slug: null,
      projectFolderId: null,
      ownerUserId: row.owner_user_id,
      visibility: row.visibility,
      status: row.lifecycle_status,
      objectProfile: row.kind,
      aliases: [],
      text: joinText([row.statement, row.current_answer_summary, row.known_gaps, row.proposed_claim, row.predictions]),
      sourceConnectionIds: [],
      updatedAt: isoOrNull(row.updated_at),
    };
  },

  async revalidate(db, spaceId, _objectType, threadId, viewerUserId): Promise<RevalidatedObject | null> {
    return (await revalidateThreads(db, spaceId, [threadId], viewerUserId)).get(threadId) ?? null;
  },

  async revalidateMany(db, spaceId, _objectType, threadIds, viewerUserId): Promise<Map<string, RevalidatedObject>> {
    return revalidateThreads(db, spaceId, threadIds, viewerUserId);
  },

  async listObjectIds(db, spaceId): Promise<RetrievalObjectRef[]> {
    const result = await db.query<{ id: string }>(
      `SELECT object_id AS id FROM inquiry_threads WHERE space_id = $1 AND lifecycle_status <> 'superseded'`,
      [spaceId],
    );
    return result.rows.map((row) => ({ objectType: "inquiry_thread" as RetrievalObjectType, objectId: row.id }));
  },
};

export const inquiryRetrievalRegistry = new RetrievalRegistry();
inquiryRetrievalRegistry.register(inquiryRetrievalAdapter);

async function revalidateThreads(
  db: Queryable,
  spaceId: string,
  threadIds: readonly string[],
  viewerUserId: string,
): Promise<Map<string, RevalidatedObject>> {
  const ids = uniqueIds(threadIds);
  if (ids.length === 0) return new Map();
  const rows = await db.query<ThreadProjectionRow>(
    `${THREAD_PROJECTION_SELECT}
      WHERE t.space_id = $1 AND t.object_id = ANY($2::varchar[]) AND t.lifecycle_status <> 'superseded'
        AND ${threadReadableSql("so", "$3", "read")}`,
    [spaceId, ids, viewerUserId],
  );
  const projectIds = [...new Set(rows.rows.map((row) => row.project_id))];
  const readableProjects = new Set(
    (await Promise.all(projectIds.map(async (projectId) => [
      projectId,
      await canReadProject(db, spaceId, projectId, viewerUserId),
    ] as const))).filter(([, readable]) => readable).map(([projectId]) => projectId),
  );
  const out = new Map<string, RevalidatedObject>();
  for (const row of rows.rows) {
    if (!readableProjects.has(row.project_id)) continue;
    out.set(row.id, {
      title: row.statement,
      text: joinText([row.current_answer_summary, row.known_gaps, row.proposed_claim, row.predictions]),
    });
  }
  return out;
}

function joinText(parts: Array<string | null>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n");
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}
