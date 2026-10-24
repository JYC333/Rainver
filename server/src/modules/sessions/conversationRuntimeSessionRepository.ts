import type { Queryable } from "../routeUtils/common.js";

/**
 * Whether a chat turn holds the conversation. A turn held at the subscription
 * reserve line (`output_json.waiting_for_quota`, `rooms/quotaGate.ts`), or
 * parked until another turn is over (`waiting_for_turn`), does not while it
 * has no job; nor does anything that cannot run before it: a Run parked
 * waiting on it (transitively), and — since a group runs one Run at a time —
 * every Run of its group that is parked on a dependency or queued with no
 * job. A person's turn is never held behind any of them. Any other Run still
 * holds the turn. As in `turnReadModel.turnState`, a successful/degraded
 * chat turn still holds it until `chat_completed`: the Run goes terminal
 * before its reply and continuity are published. Failed/cancelled/orphaned
 * Runs release it even without that event, so recovery never strands a
 * conversation behind a failed turn.
 *
 * `admitting` asks on behalf of one Run about to be admitted: its own
 * group's Runs that cannot run yet — itself, those parked on a dependency,
 * those queued with no job — do not count against it, while one already
 * running, or queued with its job enqueued, does. Its terminal predecessors
 * also do not block it: their results are passed by the group's lifecycle
 * projector before chat completion (including an internal handoff that has
 * no visible reply). A new human turn still waits for chat completion.
 * Callers hold
 * `lockConversation`.
 */
export async function conversationTurnTaken(
  db: Queryable,
  spaceId: string,
  sessionId: string,
  options: { admitting?: { runId: string; groupId: string | null } } = {},
): Promise<boolean> {
  const result = await db.query<{ active: boolean }>(
    `WITH RECURSIVE jobless(id) AS (
       SELECT run.id FROM runs run
        WHERE run.space_id = $1 AND run.session_id = $2 AND run.status = 'queued'
          AND NOT EXISTS (
            SELECT 1 FROM jobs job
             WHERE job.space_id = run.space_id AND job.job_type = 'agent_run'
               AND job.payload_json->>'run_id' = run.id
               AND job.status IN ('pending', 'claimed', 'running')
          )
     ),
     held AS (
       SELECT run.id, run.run_group_id FROM runs run
        WHERE run.id IN (SELECT id FROM jobless)
          AND (run.output_json ? 'waiting_for_quota' OR run.output_json ? 'waiting_for_turn')
     ),
     blocked(id) AS (
       SELECT id FROM held
       UNION
       SELECT waiter.id
         FROM runs waiter
         JOIN blocked ON waiter.output_json->'waiting_for_results'->'depends_on_run_ids' ? blocked.id
        WHERE waiter.space_id = $1 AND waiter.session_id = $2
          AND waiter.status = 'waiting_for_dependency'
     )
     SELECT EXISTS (
       SELECT 1
         FROM runs run
        WHERE run.space_id = $1
          AND run.session_id = $2
          AND run.model_override_json->'chat_turn'->>'schema_version' = 'chat_turn.v1'
          AND (
            run.status IN (
              'queued', 'running', 'cancelling',
              'waiting_for_review', 'waiting_for_dependency'
            )
            OR (
              run.status IN ('succeeded', 'degraded')
              AND NOT EXISTS (
                SELECT 1 FROM run_events event
                 WHERE event.space_id = run.space_id AND event.run_id = run.id
                   AND event.event_type = 'chat_completed'
              )
            )
          )
          AND run.id NOT IN (SELECT id FROM blocked)
          AND NOT (
            run.run_group_id IN (SELECT run_group_id FROM held WHERE run_group_id IS NOT NULL)
            AND (run.status = 'waiting_for_dependency' OR run.id IN (SELECT id FROM jobless))
          )
          AND NOT (
            $4::varchar IS NOT NULL AND run.run_group_id = $4::varchar AND (
              run.id = $3::varchar
              OR run.status = 'waiting_for_dependency'
              OR run.status IN ('succeeded', 'degraded')
              OR run.id IN (SELECT id FROM jobless)
            )
          )
     ) AS active`,
    [spaceId, sessionId, options.admitting?.runId ?? null, options.admitting?.groupId ?? null],
  );
  return result.rows[0]?.active === true;
}

export class ConversationTurnInProgressError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("The previous conversation turn is still in progress");
    this.name = "ConversationTurnInProgressError";
  }
}

/**
 * `claimTurn`'s throw site is several call frames below any caller that
 * needs to distinguish "the turn is transiently busy, retry" from every
 * other failure — and `rooms/service.ts`'s `dispatchRoomMessage` re-wraps
 * this specific error into a generic `HttpError(409, ...)` for its own
 * (correct, HTTP-facing) purposes on the way up, which erases the
 * `instanceof` check. Duck-typed on status code + exact message rather than
 * importing `HttpError` here, to avoid coupling this low-level module to
 * the HTTP error shape. `statusCode === 409` alone is not sufficient — other
 * unrelated failures in the same dispatch path also use 409.
 */
export function isConversationTurnInProgressError(error: unknown): boolean {
  if (error instanceof ConversationTurnInProgressError) return true;
  const candidate = error as { statusCode?: unknown; message?: unknown } | null;
  return Boolean(
    candidate
    && candidate.statusCode === 409
    && candidate.message === new ConversationTurnInProgressError().message,
  );
}

export class PgConversationRuntimeSessionRepository {
  constructor(private readonly db: Queryable) {}

  /** Shared transaction lock for every Conversation filesystem-scope mutation and Run admission. */
  async lockConversation(spaceId: string, sessionId: string): Promise<void> {
    await this.db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${spaceId}:${sessionId}`],
    );
  }

  async claimTurn(input: {
    space_id: string;
    session_id: string;
    user_id: string;
  }): Promise<void> {
    // A Conversation owns one filesystem scope and therefore one active turn,
    // regardless of which Room member submitted it or which Agent is handling
    // the turn. The user id is part of the Run's audit. Do not partition this
    // serialization authority by user id.
    await this.lockConversation(input.space_id, input.session_id);
    if (await conversationTurnTaken(this.db, input.space_id, input.session_id)) throw new ConversationTurnInProgressError();
  }
}
