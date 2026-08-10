import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { PgSpaceRepository, type SpaceFailure, type SpaceResult } from "../src/modules/spaces/repository";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgSpaceRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    repo = new PgSpaceRepository(pool);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[spaces-repository] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await pool!.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Creator', 'active', now(), now())`,
    [id],
  );
  return id;
}

function isFailure(value: SpaceResult | SpaceFailure): value is SpaceFailure {
  return "statusCode" in value;
}

describe("PgSpaceRepository.createSpace — immutable and defaulted Space policy", () => {
  it("accepts a valid oversight_mode and stores it", async () => {
    if (!available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Full Oversight Team", type: "team", oversight_mode: "full" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({
      oversight_mode: "full",
      egress_notifications_enabled: true,
      role: "owner",
    });
    const row = await pool!.query(
      `SELECT oversight_mode, egress_notifications_enabled FROM spaces WHERE id = $1`,
      [(result as SpaceResult).id],
    );
    expect(row.rows[0]).toEqual({
      oversight_mode: "full",
      egress_notifications_enabled: true,
    });
  });

  it("defaults oversight_mode to 'none' when omitted", async () => {
    if (!available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Default Team", type: "team" });

    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({ oversight_mode: "none" });
  });

  it("rejects an unknown oversight_mode with 422 and creates no row", async () => {
    if (!available || !repo || !pool) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Bad Team", type: "team", oversight_mode: "godmode" });

    expect(result).toMatchObject({ statusCode: 422 });
    const rows = await pool.query("SELECT id FROM spaces WHERE name = 'Bad Team'");
    expect(rows.rowCount).toBe(0);
  });

  it("still rejects explicit personal-type creation regardless of oversight_mode", async () => {
    if (!available || !repo) return;
    const userId = await seedUser();

    const result = await repo.createSpace(userId, { name: "Sneaky Personal", type: "personal", oversight_mode: "full" });

    expect(result).toMatchObject({ statusCode: 400 });
  });
});
