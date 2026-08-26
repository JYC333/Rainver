import { randomUUID } from "node:crypto";
import type { Pool } from "../../db/pool.js";
import { withDbTransaction, serializeCalls } from "../routeUtils/common.js";

const LOCK_PREFIX = "host_thread_events:";

/**
 * control-center-phase2-plan.md P1 (C2): the normalized conversation event
 * log for a task thread — server-side normalized text/tool-activity/status/
 * diagnostic events, not the vendor's raw stream. See
 * `server/src/db/schema/hostThreadEvents.ts` for why this is a sibling table
 * to `run_events`, not a new value in that table's closed vocabulary.
 */
export type HostThreadEventType =
  | "assistant_text"
  /** Reasoning, kept apart from the answer rather than shown as one. */
  | "assistant_thought"
  | "tool_activity_started"
  | "tool_activity_finished"
  | "status"
  | "diagnostic"
  | "plan_updated";

export interface HostThreadEvent {
  id: string;
  host_task_thread_id: string;
  run_id: string;
  project_id: string;
  event_index: number;
  event_type: HostThreadEventType;
  text: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input_summary: string | null;
  tool_kind: string | null;
  tool_result_summary: string | null;
  status: string | null;
  created_at: string;
}

export interface NewHostThreadEvent {
  event_type: HostThreadEventType;
  text?: string | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_input_summary?: string | null;
  tool_kind?: string | null;
  tool_result_summary?: string | null;
  status?: string | null;
}

const COLUMNS = `id, host_task_thread_id, run_id, project_id, event_index, event_type,
  text, tool_call_id, tool_name, tool_input_summary, tool_kind, tool_result_summary, status, created_at`;

export class PgHostThreadEventRepository {
  // A real Pool, not the generic Queryable other repositories in this module
  // accept: append() needs to hold a transaction-scoped advisory lock across
  // several statements on one dedicated connection, which a plain
  // Pool.query()/PoolClient.query() call cannot do (see append()'s comment).
  constructor(private readonly db: Pool) {}

  /**
   * Appends events one at a time (not a single batch INSERT) so each row's
   * `event_index` is assigned from a fresh `COALESCE(MAX+1, 0)` read against
   * what the previous row in this same call just committed — the same
   * per-row-sequential approach `PgRunRepository.appendRunEvent` uses for
   * `run_events`. Call volume per chunk is small (a handful of normalized
   * events per stdout push), so the extra round trips are not a concern in
   * phase 1.
   *
   * `createSerializedThreadEventSink` already serializes every call made
   * through one sink instance, but a sink is constructed per Run
   * (`orchestrationService.ts`), not per thread — two Runs concurrently
   * active on the same thread would still each hold their own independent
   * promise chain and race this method's `event_index` read (discovery
   * review, P1). A `pg_advisory_xact_lock` keyed on the thread — held for
   * this whole batch, across every event, not just one INSERT — closes that
   * gap at the database level regardless of how many processes or sink
   * instances are writing: whichever writer gets the lock first commits its
   * whole batch before the next one's `event_index` read can even start.
   */
  async append(
    threadId: string,
    runId: string,
    events: NewHostThreadEvent[],
  ): Promise<HostThreadEvent[]> {
    if (events.length === 0) return [];
    return withDbTransaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${LOCK_PREFIX}${threadId}`]);
      const written: HostThreadEvent[] = [];
      for (const event of events) {
        const result = await client.query<HostThreadEvent>(
          `INSERT INTO host_thread_events (
             id, host_task_thread_id, run_id, project_id, event_index, event_type,
             text, tool_call_id, tool_name, tool_input_summary, tool_kind,
             tool_result_summary, status, created_at
           )
           VALUES (
             $1, $2, $3,
             (SELECT pf.project_id
                FROM host_task_threads t
                JOIN workspace_locations wl ON wl.id = t.workspace_location_id
                JOIN project_folders pf ON pf.id = wl.project_folder_id
               WHERE t.id = $2::varchar),
             (SELECT COALESCE(MAX(event_index) + 1, 0)
                FROM host_thread_events
               WHERE host_task_thread_id = $2::varchar),
             $4, $5, $6, $7, $8, $9, $10, $11, now()
           )
           RETURNING ${COLUMNS}`,
          [
            randomUUID(),
            threadId,
            runId,
            event.event_type,
            event.text ?? null,
            event.tool_call_id ?? null,
            event.tool_name ?? null,
            event.tool_input_summary ?? null,
            event.tool_kind ?? null,
            event.tool_result_summary ?? null,
            event.status ?? null,
          ],
        );
        written.push(result.rows[0]!);
      }
      return written;
    });
  }

  /** Cursor read: every event after `afterIndex`, oldest first. */
  async listAfter(threadId: string, afterIndex: number, limit = 500): Promise<HostThreadEvent[]> {
    const result = await this.db.query<HostThreadEvent>(
      `SELECT ${COLUMNS} FROM host_thread_events
        WHERE host_task_thread_id = $1 AND event_index > $2
        ORDER BY event_index ASC
        LIMIT $3`,
      [threadId, afterIndex, limit],
    );
    return result.rows;
  }
}

/**
 * `on_stdout_chunk`/`on_stderr_chunk` in `executeRemoteHostCliAdapter` are
 * synchronous, un-awaited callbacks — a stdout chunk and a stderr chunk can
 * arrive back-to-back and both call the sink before either's `append()` has
 * committed. `serializeCalls` (`routeUtils/common.ts`) keeps this one sink
 * instance's calls in the order they were produced regardless of how many
 * arrive before the first settles; `append()`'s own advisory lock is what
 * actually guarantees `event_index` correctness against *other* concurrently
 * active sink instances for the same thread (a second Run, in a future
 * phase) — the two are complementary, not redundant: this keeps one run's
 * stdout/stderr interleaving honest, the lock keeps the table honest.
 *
 * The returned function's promise resolves once every write queued up to
 * and including this call has settled and never rejects — a per-chunk
 * caller can ignore it (`void sink(drafts)`, correct: stdout processing
 * must not block on a DB round trip), while the caller emitting the run's
 * terminal status event can `await` that one call to guarantee every
 * earlier event has actually committed before the Run itself is reported
 * terminal.
 */
export function createSerializedThreadEventSink(
  repository: PgHostThreadEventRepository,
  threadId: string,
  runId: string,
): (drafts: NewHostThreadEvent[]) => Promise<void> {
  return serializeCalls((drafts: NewHostThreadEvent[]) => repository.append(threadId, runId, drafts));
}
