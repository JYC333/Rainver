import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { activityModule } from "../src/modules/activity/index.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Real-Postgres coverage for what a capture may become: one set of proposals
// per record, an archived record staying archived, and an upload the request
// refuses leaving nothing on disk.

const SPACE = "ac11ac11-0000-4000-8000-000000000001";
const OWNER = "ac11ac11-0000-4000-8000-000000000002";
const PROJECT = "ac11ac11-0000-4000-8000-000000000003";
const owner = { spaceId: SPACE, userId: OWNER };

const db = useTestDatabase(import.meta.filename);
let rainverHome: string;

beforeAll(async () => {
  rainverHome = await mkdtemp(join(tmpdir(), "rainver-activity-upload-"));
});
afterAll(async () => {
  await rm(rainverHome, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["proposals", "activity_records", "projects", "space_memberships", "users", "spaces"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
});

afterEach(() => __setAuthIdentityForTests(null));

async function capture(status: "raw" | "archived" = "raw"): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO activity_records
       (id, space_id, user_id, owner_user_id, activity_type, title, content,
        payload_json, status, visibility, occurred_at, created_at, updated_at, discarded_at)
     VALUES ($1, $2, $3, $3, 'user_capture', 'A thought', 'The body of the thought, worth keeping.',
             '{}'::jsonb, $4::text, 'private', now(), now(), now(), CASE WHEN $4::text = 'archived' THEN now() END)`,
    [id, SPACE, OWNER, status],
  );
  return id;
}

async function proposalCount(): Promise<number> {
  const result = await db.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM proposals WHERE space_id=$1`, [SPACE]);
  return Number(result.rows[0]?.count ?? "0");
}

describe("consolidating a capture (real Postgres)", () => {
  it("generates one set of proposals however often consolidation is requested", async () => {
    if (!db.available) return;
    const activity = new PgActivityRepository(db.pool);
    const id = await capture();
    expect(await activity.consolidate(owner, id)).toHaveLength(1);
    await expect(activity.consolidate(owner, id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await proposalCount()).toBe(1);
  });

  it("leaves an archived capture archived", async () => {
    if (!db.available) return;
    const activity = new PgActivityRepository(db.pool);
    const id = await capture("archived");
    await expect(activity.consolidate(owner, id)).rejects.toMatchObject({ statusCode: 409 });
    const row = await db.pool.query<{ status: string }>(`SELECT status FROM activity_records WHERE id = $1`, [id]);
    expect(row.rows[0]?.status).toBe("archived");
    expect(await proposalCount()).toBe(0);
  });
});

describe("uploading a capture (real Postgres)", () => {
  it("writes nothing to disk for an upload it refuses", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const boundary = "----rainver-upload-test";
      const body = [
        `--${boundary}`, 'Content-Disposition: form-data; name="kind"', "", "photo",
        `--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="a.bin"', "Content-Type: application/octet-stream", "", "hello",
        `--${boundary}--`, "",
      ].join("\r\n");
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(response.statusCode).toBe(422);
      const stored = await readdir(join(rainverHome, "storage", "uploads"), { recursive: true }).catch(() => [] as string[]);
      expect(stored.filter((entry) => entry.includes("."))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
