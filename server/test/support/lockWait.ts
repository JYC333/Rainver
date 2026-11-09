import type { Pool } from "pg";
import { vi } from "vitest";

/**
 * Resolves once a backend (or `waiters` backends) in this file's own database
 * is waiting on a lock (`wait_event_type = 'Lock'`), or once `settled()`
 * reports the racing call finished without waiting. Race tests use it to
 * commit the first writer only after the second has run up against its
 * uncommitted state. Scoped to
 * `current_database()`: every file shares the container, not the database.
 */
export async function waitForLockWaiter(
  pool: Pool,
  options: { settled?: () => boolean; lockType?: "advisory" | "any"; waiters?: number } = {},
): Promise<void> {
  const lockType = options.lockType ?? "any";
  await vi.waitUntil(async () => {
    if (options.settled?.()) return true;
    const result = await pool.query(
      `SELECT 1
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND ($1::text = 'any' OR wait_event = $1::text)`,
      [lockType],
    );
    return (result.rowCount ?? 0) >= (options.waiters ?? 1);
  }, { timeout: 10_000, interval: 20 });
}

/**
 * Resolves once some backend of this file's database is blocked by the lock
 * holder `holderPid` (`pg_blocking_pids`), or once `settled()` reports the
 * racing call finished without waiting. Stronger than `waitForLockWaiter`
 * when the test holds the lock itself: the waiter is proven to wait on it.
 */
export async function waitForBlockedBy(pool: Pool, holderPid: number, options: { settled?: () => boolean } = {}): Promise<void> {
  await vi.waitUntil(async () => {
    if (options.settled?.()) return true;
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    return (result.rowCount ?? 0) > 0;
  }, { timeout: 10_000, interval: 20 });
}

/**
 * Resolves once backend `pid` is observed in wait event `waitEvent` (e.g.
 * `PgSleep` inside a server-side retry loop), or once `settled()` is true.
 */
export async function waitForBackendWait(
  pool: Pool,
  pid: number,
  waitEvent: string,
  options: { settled?: () => boolean } = {},
): Promise<void> {
  await vi.waitUntil(async () => {
    if (options.settled?.()) return true;
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE pid = $1::int AND datname = current_database() AND wait_event = $2::text`,
      [pid, waitEvent],
    );
    return (result.rowCount ?? 0) > 0;
  }, { timeout: 10_000, interval: 10 });
}
