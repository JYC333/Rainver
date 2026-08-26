import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertMemoryEntry } from "./support/memoryFixtures.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { PgMemoryReadRepository, MemoryReadValidationError } from "../src/modules/memory/repository.js";

// Real-PostgreSQL integration tests for the server memory read model. The
// route/unit suites use fakes, so they cannot catch the defects that only
// surface on the real stack: the scoped WHERE + post-filter
// pagination, jsonb tags parsing, ILIKE search, summary access redaction,
// redaction, cross-user/cross-space visibility, and the project_id membership
// check. These run the actual SQL against a throwaway Postgres (testcontainers)
//
// Skips gracefully when Docker is unavailable so `pnpm test` runs everywhere.

let repo: PgMemoryReadRepository | undefined;

const db = useTestDatabase(import.meta.filename, { max: 10 });

beforeAll(async () => {
  if (!db.available) return;
  repo = new PgMemoryReadRepository(db.pool);
});

const SPACE = "space-1";
const USER = "user-1";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "extracted_evidence", "source_snapshots", "source_items", "provenance_links", "content_access_logs", "content_access_grants", "memory_entries", "project_folders", "projects", "project_members", "space_memberships", "spaces", "users"],
  );
  await db.pool.query("INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Main', 'household', now(), now())", [SPACE]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ('other', 'other', 'active', now(), now()), ('user-1', 'user-1', 'active', now(), now()) ON CONFLICT (id) DO NOTHING`);
  for (const userId of [USER, "other"]) {
    await db.pool.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [`membership-${userId}`, SPACE, userId],
    );
  }
});

async function accessLogs(memoryId: string): Promise<Array<Record<string, unknown>>> {
  const res = await db.pool.query(
    "SELECT *, resource_id AS memory_id, viewer_user_id AS user_id FROM content_access_logs WHERE resource_type = 'memory' AND resource_id = $1 ORDER BY accessed_at",
    [memoryId],
  );
  return res.rows;
}

async function counters(memoryId: string): Promise<{ access_count: number; last_accessed_at: unknown }> {
  const res = await db.pool.query(
    "SELECT access_count, last_accessed_at FROM memory_entries WHERE id = $1",
    [memoryId],
  );
  return res.rows[0] as { access_count: number; last_accessed_at: unknown };
}

describe("PgMemoryReadRepository against real Postgres", () => {
  it("lists only readable rows and paginates the filtered set", async () => {
    if (!db.available || !repo) return;
    // Readable: own private, space_shared. Hidden: another user's private and
    // soft-deleted rows.
    await insertMemoryEntry(db.pool, SPACE, { id: "m-own", owner_user_id: USER, importance: 0.9 });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-shared", owner_user_id: "other", visibility: "space_shared", importance: 0.8 });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-private-other", owner_user_id: "other", visibility: "private", importance: 0.7 });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-deleted", owner_user_id: USER, deleted_at: new Date().toISOString() });

    const page = await repo.list(SPACE, USER, { limit: 50, offset: 0 });
    expect(page.items.map((m) => m.id).sort()).toEqual(["m-own", "m-shared"]);
    expect(page.total).toBe(2);

    // Pagination applies to the readable set.
    const paged = await repo.list(SPACE, USER, { limit: 1, offset: 1 });
    expect(paged.total).toBe(2);
    expect(paged.items).toHaveLength(1);
    expect(paged.items[0]?.id).toBe("m-shared"); // importance DESC → m-own first
  });

  it("redacts summary access content for a non-owner but not the owner", async () => {
    if (!db.available || !repo) return;
    await insertMemoryEntry(db.pool, SPACE, {
      id: "m-sum",
      owner_user_id: "other",
      visibility: "space_shared",
      access_level: "summary",
      content: "secret body",
    });
    const asViewer = await repo.list(SPACE, USER, { limit: 50, offset: 0 });
    expect(asViewer.items[0]?.content).toBeNull();

    const asOwner = await repo.list(SPACE, "other", { limit: 50, offset: 0 });
    expect(asOwner.items[0]?.content).toBe("secret body");
  });

  it("get returns null across users/spaces and parses jsonb tags", async () => {
    if (!db.available || !repo) return;
    await insertMemoryEntry(db.pool, SPACE, {
      id: "m-1",
      owner_user_id: USER,
      tags: ["a", "b"],
    });
    const out = await repo.get(SPACE, USER, "m-1");
    expect(out?.tags).toEqual(["a", "b"]);
    // Another user cannot read a private memory.
    expect(await repo.get(SPACE, "other", "m-1")).toBeNull();
    // Wrong space.
    expect(await repo.get("space-2", USER, "m-1")).toBeNull();
  });

  it("searches active rows by title/content ILIKE with visibility applied", async () => {
    if (!db.available || !repo) return;
    await insertMemoryEntry(db.pool, SPACE, { id: "m-hit", owner_user_id: USER, content: "the server migration plan" });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-miss", owner_user_id: USER, content: "unrelated" });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-hidden", owner_user_id: "other", visibility: "private", content: "server secret" });

    const rows = await repo.search(SPACE, USER, { query: "server", limit: 10 });
    expect(rows.map((m) => m.id).sort()).toEqual(["m-hit"]);
  });

  it("a cross-person get writes one explicit_read trace and bumps the read counters", async () => {
    if (!db.available || !repo || !db.pool) return;
    await insertMemoryEntry(db.pool, SPACE, { id: "m-1", owner_user_id: "other", visibility: "space_shared" });

    await repo.get(SPACE, USER, "m-1");

    const logs = await accessLogs("m-1");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      space_id: SPACE,
      memory_id: "m-1",
      user_id: USER,
      agent_id: null,
      run_id: null,
      access_type: "explicit_read",
      reason: null,
    });
    const c = await counters("m-1");
    expect(c.access_count).toBe(1);
    expect(c.last_accessed_at).not.toBeNull();

    // A second read increments again.
    await repo.get(SPACE, USER, "m-1");
    expect(await accessLogs("m-1")).toHaveLength(2);
    expect((await counters("m-1")).access_count).toBe(2);
  });

  it("does not log when get is not visible to the viewer", async () => {
    if (!db.available || !repo || !db.pool) return;
    await insertMemoryEntry(db.pool, SPACE, { id: "m-priv", owner_user_id: "other", visibility: "private" });

    expect(await repo.get(SPACE, USER, "m-priv")).toBeNull();
    expect(await accessLogs("m-priv")).toHaveLength(0);
    expect((await counters("m-priv")).access_count).toBe(0);
  });

  it("search writes a search_hit trace per returned row; list logs nothing", async () => {
    if (!db.available || !repo || !db.pool) return;
    await insertMemoryEntry(db.pool, SPACE, { id: "m-a", owner_user_id: "other", visibility: "space_shared", content: "server alpha" });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-b", owner_user_id: "other", visibility: "space_shared", content: "server beta" });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-hidden", owner_user_id: "other", visibility: "private", content: "server secret" });

    const rows = await repo.search(SPACE, USER, { query: "server", limit: 10 });
    expect(rows.map((m) => m.id).sort()).toEqual(["m-a", "m-b"]);

    for (const id of ["m-a", "m-b"]) {
      const logs = await accessLogs(id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ access_type: "search_hit", reason: "memory search", user_id: USER });
      expect((await counters(id)).access_count).toBe(1);
    }
    // The non-visible row is neither returned nor logged.
    expect(await accessLogs("m-hidden")).toHaveLength(0);

    // list() reads are never logged.
    await repo.list(SPACE, USER, { limit: 50, offset: 0 });
    expect(await accessLogs("m-a")).toHaveLength(1);
    expect((await counters("m-a")).access_count).toBe(1);
  });

  it("raises on a project filter that is not in the space", async () => {
    if (!db.available || !repo || !db.pool) return;
    // USER owns the project, so the project gate keeps the row visible.
    await db.pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ('proj-1', $1, $2, 'proj-1', 'active', now(), now())",
      [SPACE, USER],
    );
    await insertMemoryEntry(db.pool, SPACE, { id: "m-1", owner_user_id: USER, scope_type: "project", project_id: "proj-1" });
    // Valid project filter returns rows.
    const ok = await repo.list(SPACE, USER, { limit: 50, offset: 0, projectId: "proj-1" });
    expect(ok.items).toHaveLength(1);
    // Unknown project → validation error (→ 422 at the route).
    await expect(
      repo.list(SPACE, USER, { limit: 50, offset: 0, projectId: "missing" }),
    ).rejects.toBeInstanceOf(MemoryReadValidationError);
  });

  it("project-gates list/search/get for a non-member, and reveals after membership", async () => {
    if (!db.available || !repo || !db.pool) return;
    // A shared (non-personal) space: project gating is active.
    await db.pool.query("UPDATE spaces SET type = 'household' WHERE id = $1", [SPACE]);
    // Project owned by another user; USER's own memory is filed under it.
    await db.pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ('proj-x', $1, 'other', 'proj-x', 'active', now(), now())",
      [SPACE],
    );
    await insertMemoryEntry(db.pool, SPACE, { id: "m-proj", owner_user_id: USER, scope_type: "project", project_id: "proj-x", content: "project note" });
    await insertMemoryEntry(db.pool, SPACE, { id: "m-free", owner_user_id: USER, content: "free note" });

    // Non-member of proj-x: the project memory is hidden everywhere; the
    // project-free memory is still visible.
    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items.map((m) => m.id)).toEqual(["m-free"]);
    expect((await repo.search(SPACE, USER, { query: "note", limit: 10 })).map((m) => m.id)).toEqual(["m-free"]);
    expect(await repo.get(SPACE, USER, "m-proj")).toBeNull();

    // Grant membership → the project memory becomes visible.
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ('pm-1', $1, 'proj-x', $2, 'member', 'active', now(), now())`,
      [SPACE, USER],
    );
    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items.map((m) => m.id).sort()).toEqual([
      "m-free",
      "m-proj",
    ]);
    expect((await repo.get(SPACE, USER, "m-proj"))?.id).toBe("m-proj");
  });

  it("does not treat a personal-space project_id as accessible unless the project is in that space", async () => {
    if (!db.available || !repo || !db.pool) return;
    await db.pool.query("UPDATE spaces SET type = 'personal' WHERE id = $1", [SPACE]);
    await db.pool.query("INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ('space-other', 'Other', 'household', now(), now())");
    await db.pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ('proj-other', 'space-other', $1, 'proj-other', 'active', now(), now())",
      [USER],
    );
    // The schema itself refuses a memory that points at a project in another
    // Space (composite project/space FK), so the read gate never sees one.
    await expect(insertMemoryEntry(db.pool, SPACE, {
      id: "m-cross-project",
      owner_user_id: USER,
      scope_type: "project",
      visibility: "space_shared",
      project_id: "proj-other",
    })).rejects.toMatchObject({ code: "23503" });

    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items).toHaveLength(0);
    expect(await repo.get(SPACE, USER, "m-cross-project")).toBeNull();
  });

  it("does not allow a stale active project_members row for a soft-deleted project", async () => {
    if (!db.available || !repo || !db.pool) return;
    await db.pool.query("UPDATE spaces SET type = 'household' WHERE id = $1", [SPACE]);
    await db.pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id, name, status, deleted_at, created_at, updated_at) VALUES ('proj-deleted', $1, 'other', 'proj-deleted', 'active', now(), now(), now())",
      [SPACE],
    );
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ('pm-deleted', $1, 'proj-deleted', $2, 'member', 'active', now(), now())`,
      [SPACE, USER],
    );
    await insertMemoryEntry(db.pool, SPACE, {
      id: "m-deleted-project",
      owner_user_id: USER,
      scope_type: "project",
      visibility: "space_shared",
      project_id: "proj-deleted",
      content: "stale project note",
    });

    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items).toHaveLength(0);
    expect(await repo.search(SPACE, USER, { query: "stale project", limit: 10 })).toHaveLength(0);
  });
});
