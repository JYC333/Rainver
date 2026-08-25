import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { PgKnowledgeRepository } from "../src/modules/knowledge/repository";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";

// purgeDeletedNotes reported a 30-day retention window that its DELETE did not
// apply, so it hard-deleted a note the moment that note was soft-deleted. The
// purge is irreversible, so the window has to be real.

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";


const db = useTestDatabase(__filename, { max: 2 });

beforeAll(async () => {
  if (!db.available) return;
  __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["notes", "space_objects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Space','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`, [randomUUID(), SPACE, USER, now]);
});

describe("purgeDeletedNotes retention window (real Postgres)", () => {
  it("keeps a just-deleted note and destroys only one past the reported window", async () => {
    if (!db.available) return;
    const identity = { spaceId: SPACE, userId: USER };
    const repository = new PgKnowledgeRepository(db.pool);

    const recent = await repository.createNote(identity, { title: "Deleted today" }) as { id: string };
    const stale = await repository.createNote(identity, { title: "Deleted long ago" }) as { id: string };
    await repository.deleteNote(identity, recent.id);
    await repository.deleteNote(identity, stale.id);
    await db.pool.query(
      `UPDATE space_objects SET deleted_at = now() - interval '31 days' WHERE id = $1`,
      [stale.id],
    );

    const result = await repository.purgeDeletedNotes(identity) as { deleted: number; retention_days: number };

    expect(result).toEqual({ deleted: 1, retention_days: 30 });
    const remaining = await db.pool.query<{ id: string }>(
      `SELECT id FROM space_objects WHERE space_id = $1 AND object_type = 'note'`,
      [SPACE],
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([recent.id]);
  });
});
