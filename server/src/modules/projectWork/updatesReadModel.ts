import type { ProjectWorkUpdate, ProjectWorkUpdateUndo, ProjectWorkUpdatesResponse } from "@rainver/protocol";
import { HttpError, dateIso, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectReadable, canWriteProject } from "../projects/access.js";

/**
 * The readable account of how a Project has been going.
 *
 * A filter over the same append-only stream everything else folds from, so the
 * story and the record cannot disagree. A separate `project_updates` table was
 * the alternative and would have allowed exactly that, with no way afterwards
 * to say which was right.
 */

const PAGE_SIZE = 30;
// A Task closing is an update. `task.reported` has no close-out producer —
// the readable account belongs to whoever wrote one — so the acceptance is
// rendered as itself rather than given invented words.
//
// The Inquiry kinds are here because an Agent now advances a Thread directly
// (ADR 0017 §2): this is where the person sees what it did, so it is also
// where they undo it. Task lifecycle kinds stay out — Board state is not a
// readable account, and it has its own surface.
const UPDATE_KINDS = [
  "task.reported",
  "project.reported",
  "task.accepted",
  "thread.created",
  "thread.archived",
  "thread.reopened",
  "thread.concluded",
  "thread.next_step_adopted",
  "memory.remembered",
  "memory.revised",
  "memory.archived",
];

/**
 * What undoing each kind means. Absent here means the update records
 * something already settled and there is nothing to put back.
 */
const UNDO_ACTIONS: Record<string, ProjectWorkUpdateUndo["action"]> = {
  "thread.created": "archive_thread",
  "thread.archived": "reopen_thread",
  "thread.reopened": "archive_thread",
  "thread.concluded": "revert_iteration",
  // Archiving is the undo for both: a revision already kept the previous
  // version, and un-revising it would be a second write dressed as a
  // reversal.
  "memory.remembered": "archive_memory",
  "memory.revised": "archive_memory",
};

export function updateUndoAction(eventKind: string): ProjectWorkUpdateUndo["action"] | null {
  return UNDO_ACTIONS[eventKind] ?? null;
}

/** What the Thread's own lifecycle has to be for the reversal to be possible. */
function threadUndoStillApplies(
  action: ProjectWorkUpdateUndo["action"],
  lifecycle: string | null,
): boolean {
  // Only from `archived`. Reopening a `resolved` or `rejected` Thread does
  // succeed, but `transitionLifecycle` records `thread.reopened` for that one
  // transition only — so the reversal would happen and the row would still
  // say it had not, and go on offering the button.
  if (action === "reopen_thread") return lifecycle === "archived";
  // Archiving a Thread the person has since resolved is still legal and still
  // records the reversal, so it stays offered; `superseded` is the one state
  // `transitionLifecycle` refuses outright, and archiving what is archived is
  // a no-op it also refuses.
  if (action === "archive_thread") return lifecycle !== "archived" && lifecycle !== "superseded";
  // A conclusion can only be reverted onto a Thread that is still taking
  // Iterations (`recordIteration` refuses otherwise).
  if (action === "revert_iteration") return lifecycle === "active";
  return true;
}

/**
 * The cursor carries both ordering columns, because neither alone is a key.
 *
 * `project_work_events.id` is a v4 UUID with no time component, so a keyset
 * predicate on the id alone cuts the stream at a random point: half of the
 * page just read comes back, and everything older whose id sorts above the
 * cursor becomes unreachable for good.
 */
function encodeCursor(occurredAt: string, id: string): string {
  return `${occurredAt}|${id}`;
}

function decodeCursor(cursor: string | null): { occurredAt: string; id: string } | null {
  if (!cursor) return null;
  const at = cursor.indexOf("|");
  const occurredAt = at < 0 ? "" : cursor.slice(0, at);
  const id = at < 0 ? "" : cursor.slice(at + 1);
  // A malformed cursor silently restarting the list would make "load more"
  // loop over page one forever, which reads as data rather than a bug.
  if (!occurredAt || !id || Number.isNaN(Date.parse(occurredAt))) {
    throw new HttpError(422, "Invalid updates cursor");
  }
  return { occurredAt, id };
}

interface UpdateRow {
  id: string;
  event_kind: string;
  subject_type: string;
  subject_id: string;
  occurred_at: string;
  cursor_at: string;
  data_json: Record<string, unknown>;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  actor_user_name: string | null;
  actor_agent_name: string | null;
  actor_service: string | null;
  task_id: string | null;
  task_title: string | null;
  thread_id: string | null;
  thread_statement: string | null;
  thread_lifecycle: string | null;
  memory_id: string | null;
  memory_title: string | null;
  memory_status: string | null;
  undone_by_event_id: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function summaryOf(row: UpdateRow): string {
  const explicit = str(row.data_json?.summary);
  if (explicit) return explicit;
  switch (row.event_kind) {
    // Bare, because the row already links the Task by name right beneath it.
    case "task.accepted": return "Accepted";
    case "thread.created": return "Question opened";
    case "thread.archived": return "Question archived";
    case "thread.reopened": return "Question reopened";
    case "thread.concluded": return str(row.data_json?.change_summary) ?? "Concluded";
    case "memory.remembered": return "Remembered something";
    case "memory.revised": return "Revised a memory";
    // No undo of its own: the entry is archived, and putting it back is done
    // from the Memory page, where the whole version chain is readable.
    case "memory.archived": return "Archived a memory";
    case "thread.next_step_adopted": {
      const focus = str(row.data_json?.next_focus_kind);
      return focus ? `Next step: ${focus.replace(/_/g, " ")}` : "Next step adopted";
    }
    default: return "";
  }
}

function toUpdate(row: UpdateRow): Omit<ProjectWorkUpdate, "members"> {
  const undoAction = updateUndoAction(row.event_kind);
  return {
    id: row.id,
    event_kind: row.event_kind as ProjectWorkUpdate["event_kind"],
    occurred_at: dateIso(row.occurred_at)!,
    actor: row.actor_user_id
      ? { kind: "user" as const, id: row.actor_user_id, display_name: row.actor_user_name }
      : row.actor_agent_id
        ? { kind: "agent" as const, id: row.actor_agent_id, display_name: row.actor_agent_name }
        : { kind: null, id: null, display_name: row.actor_service },
    summary: summaryOf(row),
    outcome: str(row.data_json?.outcome) ?? (row.event_kind === "task.accepted" ? "accepted" : null),
    subject: row.task_id
      ? { type: "task" as const, id: row.task_id, title: row.task_title ?? "" }
      : row.thread_id
        ? { type: "inquiry_thread" as const, id: row.thread_id, title: row.thread_statement ?? "" }
        : row.memory_id
          ? { type: "memory_entry" as const, id: row.memory_id, title: row.memory_title ?? "" }
          : null,
    // An undone update keeps its shape but offers no second undo: the reversal
    // is itself a row, and undoing an undo is done from that row.
    //
    // Nor does an update whose reversal could no longer apply. Archiving is
    // what undo means for a memory and only the active head can be archived,
    // so offering it on a superseded row is a button that can only fail; a
    // Thread archived from its own Area is the same story, and the same
    // answer — the state moved on outside the feed, and the feed should stop
    // offering to move it back.
    undo: undoAction && !row.undone_by_event_id
      && (row.memory_id === null || row.memory_status === "active")
      && (row.thread_id === null || threadUndoStillApplies(undoAction, row.thread_lifecycle))
      ? { action: undoAction, target_id: row.subject_id }
      : null,
    undone_by_event_id: row.undone_by_event_id,
  };
}

/**
 * One turn's writes of one kind, collapsed into one update.
 *
 * A decomposition the person asked for is one thing that happened; six rows of
 * it is the per-item ceremony ADR 0017 removed from the approval queue
 * arriving again in the feed. Members keep their own undo so any single one
 * can still be reversed; the fold itself offers none: undoing the whole batch
 * and undoing the one that was wrong are different decisions.
 *
 * Folding is a read concern only: storage stays one row per event, and a fold
 * that spans a page boundary simply splits.
 */
function fold(rows: UpdateRow[]): ProjectWorkUpdate[] {
  const out: ProjectWorkUpdate[] = [];
  let index = 0;
  while (index < rows.length) {
    const head = rows[index]!;
    const batchKey = str(head.data_json?.batch_key);
    let end = index + 1;
    if (batchKey) {
      while (
        end < rows.length
        && rows[end]!.event_kind === head.event_kind
        && str(rows[end]!.data_json?.batch_key) === batchKey
      ) end += 1;
    }
    const group = rows.slice(index, end);
    if (group.length === 1) {
      out.push({ ...toUpdate(head), members: null });
    } else {
      const members = group.map(toUpdate);
      out.push({
        ...toUpdate(head),
        // Derived from the head event, not from the batch key: `fold()` groups
        // only adjacent rows, so one batch interrupted by another event — or
        // split across a page — produces two folds, and keying them both on
        // the batch would give them one id, one React key and one expanded
        // state. Prefixed so it is still not its own first member's id.
        id: `fold:${head.id}`,
        summary: foldSummary(head.event_kind, group.length),
        subject: null,
        undo: null,
        undone_by_event_id: null,
        members,
      });
    }
    index = end;
  }
  return out;
}

function foldSummary(eventKind: string, count: number): string {
  switch (eventKind) {
    case "thread.created": return `Opened ${count} questions`;
    case "thread.archived": return `Archived ${count} questions`;
    case "thread.concluded": return `Concluded ${count} questions`;
    case "memory.remembered": return `Remembered ${count} things`;
    default: return `${count} updates`;
  }
}

export async function getProjectUpdates(
  db: Queryable,
  identity: SpaceUserIdentity,
  projectId: string,
  cursor: string | null,
  limit: number = PAGE_SIZE,
): Promise<ProjectWorkUpdatesResponse> {
  await assertProjectReadable(db, identity.spaceId, projectId, identity.userId);
  const after = decodeCursor(cursor);
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), PAGE_SIZE);

  const rows = await db.query<UpdateRow>(
    `SELECT e.id, e.event_kind, e.subject_type, e.subject_id, e.occurred_at,
            -- The cursor must carry the column's own precision. Round-tripping
            -- through a JS Date truncates to milliseconds, and a writer using
            -- SQL now() would then make every row inside the truncated window
            -- unreachable — the same failure the composite key exists to fix.
            e.occurred_at::text AS cursor_at, e.data_json,
            a.user_id AS actor_user_id, a.agent_id AS actor_agent_id,
            au.display_name AS actor_user_name, ag.name AS actor_agent_name,
            a.service_name AS actor_service,
            t.id AS task_id, t.title AS task_title,
            th.object_id AS thread_id, th.statement AS thread_statement,
            th.lifecycle_status AS thread_lifecycle,
            me.id AS memory_id, me.title AS memory_title, me.status AS memory_status,
            undone.id AS undone_by_event_id
       FROM project_work_events e
       JOIN actors a ON a.id = e.actor_id
       LEFT JOIN users au ON au.id = a.user_id
       LEFT JOIN agents ag ON ag.id = a.agent_id
       -- A subject the reader cannot see contributes no row: an update naming
       -- it would leak its title, which is the part worth reading.
       LEFT JOIN tasks t ON t.id = e.subject_id AND t.space_id = e.space_id
                        AND e.subject_type = 'task' AND t.deleted_at IS NULL
                        AND ${contentReadSql("task", "t", "$2")}
       LEFT JOIN inquiry_threads th ON th.object_id = e.subject_id AND th.space_id = e.space_id
                        AND e.subject_type = 'inquiry_thread'
       LEFT JOIN space_objects tho ON tho.id = th.object_id AND tho.space_id = th.space_id
                        AND ${contentReadSql("space_object", "tho", "$2")}
       -- A direct memory write is private to the person in the turn, so the
       -- gate is ownership: nobody else's updates name what they remembered.
       LEFT JOIN memory_entries me ON me.id = e.subject_id AND me.space_id = e.space_id
                        AND e.subject_type = 'memory_entry' AND me.owner_user_id = $2
                        AND me.deleted_at IS NULL
       -- Lateral, so an event named by more than one reversal cannot
       -- duplicate its own row: a duplicate consumes a slot of the page
       -- budget, breaks the keyset cursor, and makes the fold's adjacency
       -- scan see the same row twice. Scoped to the Project as well as the
       -- Space, so nothing outside it can mark a row here undone.
       LEFT JOIN LATERAL (
         SELECT u.id
           FROM project_work_events u
          WHERE u.space_id = e.space_id AND u.project_id = e.project_id
            AND u.data_json->>'undo_of_event_id' = e.id
          LIMIT 1
       ) undone ON true
      WHERE e.space_id = $1 AND e.project_id = $3
        AND e.event_kind = ANY ($4::text[])
        AND (e.subject_type <> 'task' OR t.id IS NOT NULL)
        AND (e.subject_type <> 'inquiry_thread' OR tho.id IS NOT NULL)
        AND (e.subject_type <> 'memory_entry' OR me.id IS NOT NULL)
        AND ($5::timestamptz IS NULL
             OR (e.occurred_at, e.id) < ($5::timestamptz, $6::text))
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT $7::int`,
    [
      identity.spaceId, identity.userId, projectId, UPDATE_KINDS,
      after?.occurredAt ?? null, after?.id ?? null, pageSize + 1,
    ],
  );

  const page = rows.rows.slice(0, pageSize);
  const items = fold(page);
  const last = page[page.length - 1];
  return {
    items,
    viewer_can_write: await canWriteProject(db, identity.spaceId, projectId, identity.userId),
    next_cursor: rows.rows.length > pageSize && last
      ? encodeCursor(last.cursor_at, last.id)
      : null,
  };
}
