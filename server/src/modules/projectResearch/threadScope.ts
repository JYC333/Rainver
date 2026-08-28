import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError, objectValue, optionalString } from "../routeUtils/common.js";
import { InquiryThreadService } from "../inquiry/threadService.js";
import type { ThreadEventProvenance } from "../inquiry/threadWorkEvents.js";

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
 * Whether a materialized question that reads differently from the Thread is a
 * *refinement of that same Thread* rather than a different Question's.
 *
 * Assessment legitimately rewrites the question it plans queries from — it
 * may translate it, narrow it, or make it answerable — and the strategy
 * carries that rewritten text. Comparing the two texts therefore rejects the
 * pipeline's own correct output (`research.start_acquisition` could never
 * start once assessment changed a word), while the thing the comparison was
 * protecting against — a strategy built for a *different* Question — is a
 * question of provenance, so provenance is what is checked: the strategy's
 * research-context version belongs to an assessment session for this Thread.
 * The Thread's own statement stays the authoritative question either way.
 */
async function questionRefines(
  db: Queryable,
  spaceId: string,
  queryStrategyId: string | null,
  threadId: string,
): Promise<boolean> {
  if (!queryStrategyId) return false;
  const result = await db.query(
    `SELECT 1 FROM research_query_strategies strategy
       JOIN project_research_question_assessment_sessions session
         ON session.research_context_version_id = strategy.research_context_version_id
        AND session.space_id = strategy.space_id
      WHERE strategy.id = $1 AND strategy.space_id = $2 AND session.thread_id = $3
      LIMIT 1`,
    [queryStrategyId, spaceId, threadId],
  );
  return (result.rowCount ?? 0) > 0;
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
  options?: { queryStrategyId?: string | null; provenance?: ThreadEventProvenance },
): Promise<ResearchThreadScopeRef> {
  if (requestedThreadId) {
    const selected = await loadQuestion(db, identity.spaceId, projectId, requestedThreadId);
    if (!selected) throw new HttpError(422, "thread_id must reference an active Question in this Project");
    if (selected.statement.trim() !== researchQuestion.trim()
      && !(await questionRefines(db, identity.spaceId, options?.queryStrategyId ?? null, requestedThreadId))) {
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

  // A Run materialised this question, so the Project's account says so — the
  // same attribution the proposal appliers make.
  const created = await new InquiryThreadService(db).createThread(identity, projectId, {
    kind: "question",
    statement: researchQuestion,
  }, options?.provenance);
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
