import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { activityModule } from "../src/modules/activity/index.js";
import { PgActivityRepository } from "../src/modules/activity/repository.js";
import { PgActivityConsolidationRepository } from "../src/modules/activity/consolidationRepository.js";
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
  await rm(join(rainverHome, "storage", "uploads"), { recursive: true, force: true });
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
  it("still commits a proposal when the derived retrieval index cannot be queried", async () => {
    const id = await capture();
    await db.pool.query(`ALTER TABLE retrieval_aliases RENAME TO unavailable_retrieval_aliases`);
    try {
      expect(await new PgActivityRepository(db.pool).consolidate(owner, id)).toHaveLength(1);
      expect(await proposalCount()).toBe(1);
      const second = await capture();
      const batch = await new PgActivityConsolidationRepository(db.pool).runPending({
        spaceId: SPACE, actingUserId: OWNER, batchLimit: 10, activityIds: [second],
      });
      expect(batch.activities_processed).toEqual([second]);
      expect(await proposalCount()).toBe(2);
      const row = await db.pool.query(`SELECT status FROM activity_records WHERE id=$1`, [id]);
      expect(row.rows[0]?.status).toBe("proposals_generated");
    } finally {
      await db.pool.query(`ALTER TABLE unavailable_retrieval_aliases RENAME TO retrieval_aliases`);
    }
  });
  it("commits at most one proposal across simultaneous direct and batch consolidation", async () => {
    if (!db.available) return;
    const id = await capture();
    const repository = new PgActivityRepository(db.pool);
    const results = await Promise.allSettled([
      repository.consolidate(owner, id),
      repository.consolidate(owner, id),
      new PgActivityConsolidationRepository(db.pool).runPending({ spaceId: SPACE, actingUserId: OWNER, batchLimit: 10, activityIds: [id] }),
    ]);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ statusCode: 409 });
    expect(await proposalCount()).toBe(1);
    const row = await db.pool.query(`SELECT status FROM activity_records WHERE id=$1`, [id]);
    expect(row.rows[0]?.status).toBe("proposals_generated");
  });
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

function multipartBody(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; body: Buffer | string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.name}"`
      : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`;
    const lines = [`--${boundary}`, disposition];
    if (part.contentType) lines.push(`Content-Type: ${part.contentType}`);
    chunks.push(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`));
    chunks.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function storedUploadFiles(): Promise<string[]> {
  const stored = await readdir(join(rainverHome, "storage", "uploads"), { recursive: true }).catch(() => [] as string[]);
  return stored.filter((entry) => entry.includes("."));
}

describe("uploading a capture (real Postgres)", () => {
  it("writes nothing to disk for an upload it refuses", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const boundary = "----rainver-upload-test";
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { name: "kind", body: "photo" },
          { name: "file", filename: "a.bin", contentType: "application/octet-stream", body: "hello" },
        ]),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ detail: "kind must be 'file' or 'voice'" });
      expect(await storedUploadFiles()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("stores a file capture with its own 25 MB budget, not the conversation image limit", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const boundary = "----rainver-upload-ok";
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(boundary, [
          { name: "kind", body: "file" },
          { name: "title", body: "Field notes" },
          { name: "note", body: "Taken on the ridge" },
          { name: "project_id", body: PROJECT },
          { name: "marker", body: "extra-field" },
          { name: "file", filename: "nested/../ridge.bin", contentType: "application/octet-stream", body: bytes },
        ]),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { title: string; content: string; source_type: string; project_id: string; metadata_json: Record<string, unknown> };
      expect(body.title).toBe("Field notes");
      expect(body.content).toBe("Taken on the ridge");
      expect(body.source_type).toBe("file_import");
      expect(body.project_id).toBe(PROJECT);
      expect(body.metadata_json).toMatchObject({
        capture_kind: "file",
        filename: "ridge.bin",
        mime_type: "application/octet-stream",
        size_bytes: bytes.length,
      });
      const stored = await storedUploadFiles();
      expect(stored).toHaveLength(1);
      expect(await readFile(join(rainverHome, "storage", "uploads", stored[0]!))).toEqual(bytes);
    } finally {
      await app.close();
    }
  });

  it("accepts a capture larger than the conversation image limit and refuses one past 25 MB", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const aboveImageLimit = Buffer.alloc(11 * 1024 * 1024, 7);
      const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": "multipart/form-data; boundary=----rainver-11mb" },
        payload: multipartBody("----rainver-11mb", [
          { name: "kind", body: "file" },
          { name: "file", filename: "large.bin", contentType: "application/octet-stream", body: aboveImageLimit },
        ]),
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ metadata_json: { size_bytes: aboveImageLimit.length } });

      const pastActivityLimit = Buffer.alloc(25 * 1024 * 1024 + 1, 9);
      const refused = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": "multipart/form-data; boundary=----rainver-25mb" },
        payload: multipartBody("----rainver-25mb", [
          { name: "kind", body: "file" },
          { name: "file", filename: "too-big.bin", contentType: "application/octet-stream", body: pastActivityLimit },
        ]),
      });
      expect(refused.statusCode).toBe(413);
      expect(refused.json()).toMatchObject({ detail: "file exceeds 25 MB limit" });
    } finally {
      await app.close();
    }
  }, 30_000);

  it("refuses a body that is not multipart", async () => {
    if (!db.available) return;
    __setAuthIdentityForTests(owner);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: rainverHome }), [activityModule]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/activity/upload",
        headers: { "content-type": "application/json" },
        payload: { kind: "file" },
      });
      expect(response.statusCode).toBe(415);
      expect(await storedUploadFiles()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
