import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, objectValue, optionalString } from "../routeUtils/common.js";
import { InquiryThreadService } from "../inquiry/threadService.js";

export interface ResearchThreadScopeRef {
  thread_id: string;
  version: number;
  kind: "question";
  statement: string;
}

export function normalizeThreadScope(value: unknown): ResearchThreadScopeRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = objectValue(item);
    const threadId = optionalString(row.thread_id);
    const statement = optionalString(row.statement);
    const version = row.version;
    if (!threadId || !statement || typeof version !== "number" || !Number.isInteger(version) || version < 1) return [];
    return [{ thread_id: threadId, version, kind: "question" as const, statement }];
  });
}

export interface ResearchThreadDriftResult {
  /** True when the pinned ref no longer matches the Thread's live row (or the Thread is gone/inactive). */
  drifted: boolean;
  /** The Thread's current row, or null if it no longer exists/is no longer an active Question. */
  current: { id: string; version: number; statement: string } | null;
}

/**
 * The pinned Inquiry Thread is the sole Question authority for a research
 * Workflow — Project.current_focus and the legacy research profile are
 * presentation/setup state, never compared here.
 */
export async function checkPinnedThreadDrift(
  db: Queryable,
  spaceId: string,
  projectId: string,
  pinned: ResearchThreadScopeRef,
  options?: { forUpdate?: boolean },
): Promise<ResearchThreadDriftResult> {
  const result = await db.query<{ id: string; version: number; statement: string }>(
    `SELECT object_id AS id, version, statement FROM inquiry_threads
      WHERE object_id=$1 AND space_id=$2 AND project_id=$3
        AND kind='question' AND lifecycle_status='active'${options?.forUpdate ? " FOR UPDATE" : ""}`,
    [pinned.thread_id, spaceId, projectId],
  );
  const row = result.rows[0] ?? null;
  const drifted = !row || row.version !== pinned.version || row.statement !== pinned.statement;
  return { drifted, current: row };
}

/**
 * Resolves the authoritative Inquiry Thread for one research workflow.
 *
 * A Project may own many workflows, each scoped to a different Question.
 * When the caller does not select an existing Thread, the refined/materialized
 * question becomes a normal Inquiry Question instead of a Project-wide
 * synthetic bridge row. The returned version is snapshotted into both the
 * workflow and each operation.
 */
export async function resolveResearchThreadScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  researchQuestion: string,
  requestedThreadId: string | null,
): Promise<ResearchThreadScopeRef> {
  if (requestedThreadId) {
    const selected = await loadQuestion(db, identity.spaceId, projectId, requestedThreadId);
    if (!selected) throw new HttpError(422, "thread_id must reference an active Question in this Project");
    if (selected.statement.trim() !== researchQuestion.trim()) {
      throw new HttpError(409, "The materialized research question differs from the selected Thread; revise the Thread before starting");
    }
    return selected;
  }

  const matching = await db.query<ThreadRow>(
    `SELECT t.object_id AS id, t.version, t.kind, t.statement
       FROM inquiry_threads t
       JOIN space_objects so ON so.id = t.object_id AND so.space_id = t.space_id
      WHERE t.space_id=$1 AND t.project_id=$2 AND t.kind='question'
        AND t.lifecycle_status='active' AND t.statement=$3
      ORDER BY so.updated_at DESC, t.object_id ASC
      LIMIT 1`,
    [identity.spaceId, projectId, researchQuestion],
  );
  if (matching.rows[0]) return toRef(matching.rows[0]);

  const created = await new InquiryThreadService(db).createThread(identity, projectId, {
    kind: "question",
    statement: researchQuestion,
  });
  return {
    thread_id: String(created.id),
    version: Number(created.version),
    kind: "question",
    statement: String(created.statement),
  };
}

interface ThreadRow {
  id: string;
  version: number;
  kind: string;
  statement: string;
}

async function loadQuestion(
  db: Queryable,
  spaceId: string,
  projectId: string,
  threadId: string,
): Promise<ResearchThreadScopeRef | null> {
  const row = await db.query<ThreadRow>(
    `SELECT object_id AS id, version, kind, statement
       FROM inquiry_threads
      WHERE object_id=$1 AND space_id=$2 AND project_id=$3
        AND kind='question' AND lifecycle_status='active'`,
    [threadId, spaceId, projectId],
  );
  return row.rows[0] ? toRef(row.rows[0]) : null;
}

function toRef(row: ThreadRow): ResearchThreadScopeRef {
  return {
    thread_id: row.id,
    version: row.version,
    kind: "question",
    statement: row.statement,
  };
}
