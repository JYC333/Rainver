import { Pool } from "pg";
import { closeDbPool } from "../../src/db/pool.js";
import { afterAll, beforeAll } from "vitest";
import {
  getTestPostgres,
  isTestPostgresUnavailableError,
  type TestPostgresDatabase,
} from "./sharedPostgres.js";

export interface TestDatabase {
  /** False when the shared container could not be reached; tests then return early. */
  readonly available: boolean;
  /** The file's pool. Throws if the database is unavailable — check `available` first. */
  readonly pool: Pool;
  /** Connection string for code that builds its own client, such as `buildModuleServer` configs. */
  readonly connectionUri: string;
}

/**
 * A real-Postgres database for this test file: cloned from the migrated
 * template in `beforeAll`, dropped in `afterAll`, with the shared skip path
 * when the container is unreachable. Call it at module scope, before any
 * `beforeAll` of your own that needs the pool.
 *
 * Only an unavailable container or a connection error turns into a skip;
 * every other setup error is rethrown so it fails the suite.
 */
export function useTestDatabase(
  fileUrl: string,
  options: { max?: number; empty?: boolean } = {},
): TestDatabase {
  let container: TestPostgresDatabase | undefined;
  let pool: Pool | undefined;
  let available = false;

  beforeAll(async () => {
    try {
      container = await getTestPostgres(fileUrl, { empty: options.empty });
      pool = new Pool({ connectionString: container.getConnectionUri(), max: options.max ?? 3 });
      // `pool.end()` sends each idle client a graceful Terminate; `stop()`
      // then kills the backends. A client whose Terminate is still in flight
      // sees FATAL 57P01 from that kill and emits it as an error, which
      // Vitest 4 would count as an unhandled error after the tests passed.
      pool.on("error", () => undefined);
      available = true;
    } catch (error) {
      if (!isTestPostgresUnavailableError(error)) throw error;
      const name = fileUrl.split("/").pop()?.replace(/\.test\.ts$/, "") ?? fileUrl;
      console.warn(`[${name}] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    // Services under test reach the same database through `getDbPool`;
    // its cached pool would block the DROP behind `stop()`.
    if (container) await closeDbPool(container.getConnectionUri());
    await container?.stop();
  });

  return {
    get available() {
      return available;
    },
    get pool() {
      if (!pool) throw new Error("test database is unavailable; guard with `if (!db.available) return`");
      return pool;
    },
    get connectionUri() {
      if (!container) throw new Error("test database is unavailable; guard with `if (!db.available) return`");
      return container.getConnectionUri();
    },
  };
}
