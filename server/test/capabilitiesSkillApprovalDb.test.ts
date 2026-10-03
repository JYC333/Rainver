import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { approveSkillImportInTransaction, PgCapabilitiesRepository } from "../src/modules/capabilities/repository.js";
import type { Pool } from "../src/db/pool.js";
import { waitForLockWaiter } from "./support/lockWait.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["skill_local_overlays", "skill_packages", "skill_sources", "users", "spaces"], { cascade: true });
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Main', 'personal', now(), now())`, [SPACE]);
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Owner', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [USER],
  );
});

describe("skill import approval (real Postgres)", () => {
  it("marks an imported package reviewed and records who approved it", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, created_by_user_id, created_at)
       VALUES ($1, $2, 'upload', 'hash', now(), $3, now())`,
      [sourceId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, risk_level, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'example-skill', 'low', 'imported', now(), now())`,
      [packageId, SPACE, sourceId],
    );

    const approved = await approveSkillImportInTransaction({
      db: db.pool, spaceId: SPACE, userId: USER, proposalId: randomUUID(), skillPackageId: packageId,
    });

    expect(approved).toMatchObject({ id: packageId, status: "reviewed" });
    const row = await db.pool.query<{ manifest_json: { review?: { reviewed_by_user_id?: string } } }>(
      `SELECT manifest_json FROM skill_packages WHERE id = $1`, [packageId]);
    expect(row.rows[0]?.manifest_json.review?.reviewed_by_user_id).toBe(USER);
  });
});

describe("skill local overlay writes (real Postgres)", () => {
  it("keeps one active overlay per scope when two first saves race", async () => {
    if (!db.available) return;
    const sourceId = randomUUID();
    const packageId = randomUUID();
    await db.pool.query(
      `INSERT INTO skill_sources (id, space_id, source_type, content_hash, fetched_at, created_by_user_id, created_at)
       VALUES ($1, $2, 'upload', 'hash', now(), $3, now())`,
      [sourceId, SPACE, USER],
    );
    await db.pool.query(
      `INSERT INTO skill_packages (id, space_id, source_id, package_name, risk_level, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'example-skill', 'low', 'imported', now(), now())`,
      [packageId, SPACE, sourceId],
    );
    const identity = { spaceId: SPACE, userId: USER };
    const first = await db.pool.connect();
    try {
      await first.query("BEGIN");
      await new PgCapabilitiesRepository(first as unknown as Pool).upsertSkillLocalOverlay(identity, packageId, {
        scope_type: "space",
        status: "active",
        overlay_json: { alias: "first", endpoint_defaults: {}, user_preferences: {} },
      });
      let settled = false;
      const second = new PgCapabilitiesRepository(db.pool).upsertSkillLocalOverlay(identity, packageId, {
        scope_type: "space",
        status: "active",
        overlay_json: { alias: "second", endpoint_defaults: {}, user_preferences: {} },
      }).finally(() => { settled = true; });
      await waitForLockWaiter(db.pool, { settled: () => settled });
      await first.query("COMMIT");
      await expect(second).resolves.toMatchObject({ overlay_json: { alias: "second" } });
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      first.release();
    }
    const active = await db.pool.query<{ alias: string }>(
      `SELECT overlay_json->>'alias' AS alias FROM skill_local_overlays WHERE skill_package_id = $1 AND status = 'active'`,
      [packageId],
    );
    expect(active.rows).toEqual([{ alias: "second" }]);
  });
});
