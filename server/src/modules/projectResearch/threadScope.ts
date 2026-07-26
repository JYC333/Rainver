import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { HttpError } from "../routeUtils/common";
import { InquiryThreadService } from "../inquiry/threadService";

export interface ResearchThreadScopeRef {
  thread_id: string;
  version: number;
  kind: "question";
  statement: string;
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
    `SELECT id, version, kind, statement
       FROM inquiry_threads
      WHERE space_id=$1 AND project_id=$2 AND kind='question'
        AND lifecycle_status='active' AND statement=$3
      ORDER BY updated_at DESC, id ASC
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
    `SELECT id, version, kind, statement
       FROM inquiry_threads
      WHERE id=$1 AND space_id=$2 AND project_id=$3
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
