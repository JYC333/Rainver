import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";

/**
 * control-center-phase2-plan.md P2 (C4): the durable per-thread message
 * ledger. See `server/src/db/schema/hostThreadMessages.ts` for why rows are
 * never deleted, including `dispatched`/`withdrawn` ones.
 */
export interface HostThreadMessage {
  id: string;
  host_task_thread_id: string;
  task_id: string;
  prompt: string;
  status: "queued" | "dispatched" | "withdrawn";
  /**
   * The ModelProvider binding resolved for this message at dispatch time, or
   * null for the executing machine's ambient login. This is the provenance
   * record for a remote run's binding — see the schema file for why
   * `runs.model_provider_id` is not.
   */
  model_provider_id: string | null;
  model: string | null;
  reasoning_effort: string | null;
  run_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, host_task_thread_id, task_id, prompt, status, model_provider_id, model, reasoning_effort, run_id, created_by_user_id, created_at, updated_at`;

export class PgHostThreadMessageRepository {
  constructor(private readonly db: Queryable) {}

  async enqueue(
    threadId: string,
    taskId: string,
    prompt: string,
    createdByUserId: string,
    binding: { provider_id: string | null; model: string | null; reasoning_effort?: string | null } = { provider_id: null, model: null },
  ): Promise<HostThreadMessage> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.query<HostThreadMessage>(
      `INSERT INTO host_thread_messages (
         id, host_task_thread_id, task_id, prompt, status, model_provider_id, model, reasoning_effort, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8, $9, $9)
       RETURNING ${COLUMNS}`,
      [id, threadId, taskId, prompt, binding.provider_id, binding.model, binding.reasoning_effort ?? null, createdByUserId, now],
    );
    return result.rows[0]!;
  }

  /**
   * The backend this thread is on: what its newest message that will run, or
   * already ran, resolved to. Null if the thread has neither.
   *
   * A thread has no backend column: the message carries the resolved provider
   * and model already, and a second copy on the thread could disagree with the
   * run that actually happened.
   *
   * A **queued** message counts as much as a dispatched one. A binding is
   * frozen at enqueue, and the queue drains FIFO, so a queued override is
   * precisely what this thread runs next — reading only dispatched rows would
   * let a message sent while a run was still active be resolved against the
   * older backend and land *after* the override, flipping the thread back
   * mid-conversation. Withdrawn messages are excluded: they never run.
   *
   * `provider_id: null` on such a message is a real answer ("this thread runs
   * on the machine's own login"), which is why the absence of a row and a row
   * holding null are different results.
   */
  async currentBinding(
    threadId: string,
  ): Promise<{ provider_id: string | null; model: string | null; reasoning_effort: string | null } | null> {
    const result = await this.db.query<{ model_provider_id: string | null; model: string | null; reasoning_effort: string | null }>(
      `SELECT model_provider_id, model, reasoning_effort FROM host_thread_messages
        WHERE host_task_thread_id = $1 AND status <> 'withdrawn'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [threadId],
    );
    const row = result.rows[0];
    return row
      ? { provider_id: row.model_provider_id, model: row.model, reasoning_effort: row.reasoning_effort }
      : null;
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

  /** Withdraw every still-queued admission for a Task on this thread. The
   * queue lock is held by the caller when this is used for terminal-task or
   * authority-loss reconciliation. */
  async withdrawQueuedForTask(threadId: string, taskId: string): Promise<void> {
    await this.db.query(
      `UPDATE host_thread_messages
          SET status = 'withdrawn', updated_at = now()
        WHERE host_task_thread_id = $1 AND task_id = $2 AND status = 'queued'`,
      [threadId, taskId],
    );
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
