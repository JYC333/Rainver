import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "../src/db/migrator";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

// purgeDeletedNotes reported a 30-day retention window that its DELETE did not
// apply, so it hard-deleted a note the moment that note was soft-deleted. The
// purge is irreversible, so the window has to be real.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 2 });
    await migrate(pool, join(process.cwd(), "migrations"));
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[knowledge-note-purge-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setAuthIdentityForTests(null);
  await pool?.end();
  await database?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(`TRUNCATE notes, space_objects, space_memberships, users, spaces CASCADE`);
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

describe("purgeDeletedNotes retention window (real Postgres)", () => {
  it("keeps a just-deleted note and destroys only one past the reported window", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(pool);

    const recent = await repository.createNote(identity, { title: "Deleted today" }) as { id: string };
    const stale = await repository.createNote(identity, { title: "Deleted long ago" }) as { id: string };
    await repository.deleteNote(identity, recent.id);
    await repository.deleteNote(identity, stale.id);
    await pool.query(
      `UPDATE space_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`,
      [stale.id],
    );

    const result = await repository.purgeDeletedNotes(identity) as { deleted: number; retention_days: number };

    expect(result).toEqual({ deleted: 1, retention_days: 30 });
    const remaining = await pool.query<{ id: string }>(
      `SELECT id FROM space_objects WHERE space_id = $1 AND object_type = 'note'`,
      [SPACE],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([recent.id]);
  });
});
