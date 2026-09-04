import type { RunTurn } from "@rainver/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { loadProjectChatActionPreviews } from "../agents/projectChatActionPreviews.js";
import {
  appendActionPreviewParts,
  projectHostThreadTurn,
  projectRunEventTurn,
  type HostThreadEventRow,
  type RunEventRow,
} from "./turnProjection.js";

/**
 * The turn a Run produced, whichever log recorded it.
 *
 * The caller has already decided the viewer may read this Run; this only
 * chooses the log, loads it, and folds it into parts.
 *
 * A Run bound to a host thread wrote `host_thread_events` — the richer trace,
 * with the assistant's own text. A managed Run wrote `run_events`, which
 * records what happened but not what was said, so its prose comes from the
 * assistant message the Run finalized into.
 */
export async function loadRunTurn(
  db: Queryable,
  input: { spaceId: string; runId: string },
): Promise<RunTurn | null> {
  const run = await db.query<{
    id: string;
    host_task_thread_id: string | null;
    status: string;
    is_chat_turn: boolean;
    error_message: string | null;
    error_code: string | null;
    authorization_request_id: string | null;
    supervisor_review: boolean | null;
    updated_at: string | Date | null;
  }>(
    `SELECT id, host_task_thread_id, status, updated_at, error_message,
            error_json->>'error_code' AS error_code,
            error_json->>'authorization_request_id' AS authorization_request_id,
            (error_json->>'supervisor_review' = 'true') AS supervisor_review,
            (model_override_json->'chat_turn'->>'schema_version' = 'chat_turn.v1') AS is_chat_turn
       FROM runs WHERE id = $1 AND space_id = $2`,
    [input.runId, input.spaceId],
  );
  const row = run.rows[0];
  if (!row) return null;

  // Always the whole turn. A partial read cannot be applied to what a client
  // already holds — part indices restart at 0, the reply and the Proposals
  // are appended unconditionally, and a tool call whose start fell before the
  // cursor would arrive a second time. A reconnecting client asks for the
  // turn again; a turn is small.
  const projection = row.host_task_thread_id
    ? projectHostThreadTurn(await loadHostThreadRows(db, row.host_task_thread_id, input.runId))
    : projectRunEventTurn(
        await loadRunEventRows(db, input.spaceId, input.runId),
        { replyText: await loadReplyText(db, input.spaceId, input.runId) },
      );

  // `chat_completed` is written to `run_events` for every chat turn, whichever
  // host it ran on — so the host projection, which only sees
  // `host_thread_events`, cannot find its own terminal. It is read here
  // instead of being folded in, because the two logs answer different
  // questions: one is what the Agent did, the other is whether the reply has
  // been written.
  const chatCompleted = row.is_chat_turn
    ? await loadChatCompletion(db, input.spaceId, input.runId)
    : null;

  const state = turnState(row.status, chatCompleted, Boolean(row.is_chat_turn));
  // A paused turn is waiting on a person, and the reader needs to know which
  // kind of waiting: an authorization they can grant, or a review somebody
  // else owes it. Saying only "working" hides that anything is expected of
  // them at all.
  // Classified on `supervisor_review`, not on the presence of an
  // authorization id. Three paths pause a Run: an authorization request
  // (which sets the id), a supervisor hold (which sets this flag), and a
  // policy that requires approval on a run action — and that third one sets
  // neither. It is an approval, so the flag is what tells the three apart.
  const blockedOn = state === "blocked"
    ? (row.supervisor_review === true ? "run_decision" as const : "authorization" as const)
    : null;

  // A Run can fail with nothing in either log to say why: the stale-run
  // reaper marks `orphaned` in one statement that writes no event, and a
  // cancellation writes none either. The Run row itself is then the only
  // record, and a person asking what went wrong deserves better than
  // "the assistant could not complete this turn".
  const withFailure = state === "failed"
      && !projection.parts.some((part) => part.type === "diagnostic" && part.level === "error")
    ? {
        ...projection,
        parts: [...projection.parts, {
          type: "diagnostic" as const,
          index: projection.parts.length,
          level: "error" as const,
          text: row.error_message ?? failureText(row.status),
          error_code: row.error_code,
        }],
      }
    : projection;

  const previews = await loadProjectChatActionPreviews(db, input.spaceId, input.runId);
  const withPreviews = appendActionPreviewParts(withFailure, previews.map((preview) => ({
    action_id: preview.action_id,
    tool_call_id: preview.tool_call_id ?? null,
    status: preview.status,
    proposal_id: preview.proposal_id ?? null,
    proposal_type: preview.proposal_type ?? null,
    title: preview.title ?? null,
    summary: preview.summary ?? null,
    risk_level: preview.risk_level ?? null,
    scope: preview.scope ?? null,
  })));

  return {
    schema_version: "run_turn.v1",
    run_id: row.id,
    state,
    source: withPreviews.source,
    parts: withPreviews.parts,
    blocked_on: blockedOn,
    cursor: withPreviews.cursor,
    updated_at: isoDate(row.updated_at),
  };
}

async function loadHostThreadRows(
  db: Queryable,
  threadId: string,
  runId: string,
): Promise<HostThreadEventRow[]> {
  // Scoped to this Run: a host thread outlives one turn, carrying every turn
  // the conversation ever dispatched into it.
  const result = await db.query<HostThreadEventRow>(
    `SELECT event_index, event_type, text, tool_call_id, tool_name,
            tool_input_summary, tool_kind, tool_result_summary, status
       FROM host_thread_events
      WHERE host_task_thread_id = $1 AND run_id = $2
      ORDER BY event_index ASC
      LIMIT 2000`,
    [threadId, runId],
  );
  return result.rows;
}

async function loadRunEventRows(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<RunEventRow[]> {
  const result = await db.query<RunEventRow>(
    `SELECT event_index, event_type, status, summary, error_code, error_message, metadata_json
       FROM run_events
      WHERE space_id = $1 AND run_id = $2
      ORDER BY event_index ASC
      LIMIT 2000`,
    [spaceId, runId],
  );
  return result.rows;
}

/**
 * Whether the turn's reply has been written, and whether it succeeded.
 *
 * `chat_completed` is appended after the assistant message, so its presence
 * is the one signal that a client may go and read that message.
 */
async function loadChatCompletion(
  db: Queryable,
  spaceId: string,
  runId: string,
): Promise<"succeeded" | "failed" | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status FROM run_events
      WHERE space_id = $1 AND run_id = $2 AND event_type = 'chat_completed'
      ORDER BY event_index DESC
      LIMIT 1`,
    [spaceId, runId],
  );
  const status = result.rows[0]?.status;
  if (!status) return null;
  return status === "failed" ? "failed" : "succeeded";
}

/**
 * A managed Run's prose.
 *
 * `run_events` does not carry it: the text arrives as deltas on the live
 * stream and is never persisted there. What survives is the assistant message
 * the Run finalized into, which is this Run's reply by `messages.run_id`.
 */
async function loadReplyText(db: Queryable, spaceId: string, runId: string): Promise<string | null> {
  const result = await db.query<{ content: string }>(
    `SELECT content FROM messages
      WHERE space_id = $1 AND run_id = $2 AND role = 'assistant'
      LIMIT 1`,
    [spaceId, runId],
  );
  return result.rows[0]?.content ?? null;
}

/**
 * Whether the turn is over, and how it ended.
 *
 * The Run's status is the authority for anything that fails or is abandoned:
 * a reaped Run is marked `orphaned` in one statement that writes no event at
 * all, so a reader that trusted the log alone would wait on it forever.
 *
 * Success is the other way round. A chat Run reaches `succeeded` several
 * steps before its reply is written — usage, materialization, verification
 * and finalization all still to come — so for a chat turn only the log's own
 * `chat_completed`, appended after the message, may say the turn is done.
 * Reporting `done` any earlier tells a client to go and read a reply that is
 * not there yet.
 */
function turnState(
  status: string,
  chatCompleted: "succeeded" | "failed" | null,
  isChatTurn: boolean,
): RunTurn["state"] {
  switch (status) {
    case "failed":
    case "cancelled":
    case "orphaned":
      return "failed";
    case "succeeded":
    case "degraded":
      if (!isChatTurn) return "done";
      return chatCompleted === null ? "working" : chatCompleted === "failed" ? "failed" : "done";
    case "queued":
    case "running":
    case "cancelling":
    case "waiting_for_dependency":
      return "working";
    case "waiting_for_review":
      // Stopped, waiting on a person. Not `working` — nothing is happening —
      // and not `failed`; the turn resumes when somebody decides.
      return "blocked";
    default:
      // `ck_runs_status` admits nothing else. A value that reaches here is a
      // status the constraint gained without this switch being updated, and
      // treating it as still running is the safe reading — a turn wrongly
      // called finished sends a reader after a reply that is not there.
      return "working";
  }
}

/** What a Run that failed silently is telling us, from its status alone. */
function failureText(status: string): string {
  switch (status) {
    case "orphaned":
      return "This turn was abandoned: its worker stopped without finishing.";
    case "cancelled":
      return "This turn was cancelled.";
    default:
      return "The assistant could not complete this turn.";
  }
}

function isoDate(value: string | Date | null): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
