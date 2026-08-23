import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common";

/**
 * control-center-phase2-plan.md P2 (C4): the durable per-thread message
 * ledger. See `server/src/db/schema/hostThreadMessages.ts` for why rows are
 * never deleted, including `dispatched`/`withdrawn` ones.
 */
export interface HostThreadMessage {
  id: string;
  host_task_thread_id: string;
  prompt: string;
  status: "queued" | "dispatched" | "withdrawn";
  run_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, host_task_thread_id, prompt, status, run_id, created_by_user_id, created_at, updated_at`;

export class PgHostThreadMessageRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(threadId: string, prompt: string, createdByUserId: string): Promise<HostThreadMessage> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostThreadMessage>(
      `INSERT INTO host_thread_messages (
         id, host_task_thread_id, prompt, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'queued', $4, $5, $5)
       RETURNING ${COLUMNS}`,
      [id, threadId, prompt, createdByUserId, now],
    );
    return result.rows[0]!;
  }

  async get(threadId: string, messageId: string): Promise<HostThreadMessage | null> {
    const result = await this.db.query<HostThreadMessage>(
      `SELECT ${COLUMNS} FROM host_thread_messages WHERE id = $1 AND host_task_thread_id = $2 LIMIT 1`,
      [messageId, threadId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Oldest still-queued message, FIFO — the next one `advanceThreadQueue`
   * would dispatch. `id` is a secondary sort key, not because it carries
   * any chronological meaning (it's a random UUID), but so two messages
   * `enqueue()`d in the same millisecond (Node's `Date.toISOString()` is
   * millisecond-resolution, not a DB sequence) still get a *deterministic*
   * order instead of one implementation-defined by Postgres — discovery
   * review, P2. A real monotonic sequence would be the fully correct fix;
   * not worth a schema column for how small the actual exposure is (two
   * sends landing in the same millisecond, ordering only, no data loss).
   */
  async nextQueued(threadId: string): Promise<HostThreadMessage | null> {
    const result = await this.db.query<HostThreadMessage>(
      `SELECT ${COLUMNS} FROM host_thread_messages
        WHERE host_task_thread_id = $1 AND status = 'queued'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [threadId],
    );
    return result.rows[0] ?? null;
  }

  async markDispatched(messageId: string, runId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_thread_messages SET status = 'dispatched', run_id = $2, updated_at = now() WHERE id = $1`,
      [messageId, runId],
    );
  }

  /**
   * Only a still-`queued` message can be withdrawn — one already dispatched
   * has already become a Run and cannot be pulled back; the caller
   * (Cancel) is the only way to stop work already in flight. Returns null
   * for "not found" or "not withdrawable" alike; the route layer turns
   * that into the right status code by checking which.
   */
  async withdraw(threadId: string, messageId: string): Promise<HostThreadMessage | null> {
    const result = await this.db.query<HostThreadMessage>(
      `UPDATE host_thread_messages
          SET status = 'withdrawn', updated_at = now()
        WHERE id = $1 AND host_task_thread_id = $2 AND status = 'queued'
        RETURNING ${COLUMNS}`,
      [messageId, threadId],
    );
    return result.rows[0] ?? null;
  }

  /** Every message ever sent into a thread, oldest first — the durable conversation record (`runs.prompt` is redacted on read). */
  async list(threadId: string): Promise<HostThreadMessage[]> {
    const result = await this.db.query<HostThreadMessage>(
      `SELECT ${COLUMNS} FROM host_thread_messages WHERE host_task_thread_id = $1 ORDER BY created_at ASC`,
      [threadId],
    );
    return result.rows;
  }
}
