import type { Pool } from "pg";
import { vi } from "vitest";

/**
 * Resolves once a backend in this file's own database is waiting on a lock
 * (`wait_event_type = 'Lock'`), or once `settled()` reports the racing call
 * finished without waiting. Race tests use it to commit the first writer only
 * after the second has run up against its uncommitted state. Scoped to
 * `current_database()`: every file shares the container, not the database.
 */
export async function waitForLockWaiter(
  pool: Pool,
  options: { settled?: () => boolean; lockType?: "advisory" | "any" } = {},
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
    return (result.rowCount ?? 0) > 0;
  }, { timeout: 10_000, interval: 20 });
}
