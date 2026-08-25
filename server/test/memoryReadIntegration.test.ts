import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { PgMemoryReadRepository, MemoryReadValidationError } from "../src/modules/memory/repository";

// Real-PostgreSQL integration tests for the server memory read model. The
// route/unit suites use fakes, so they cannot catch the defects that only
// surface on the real stack: the scoped WHERE + post-filter
// pagination, jsonb tags parsing, ILIKE search, summary access redaction,
// redaction, cross-user/cross-space visibility, and the project_id membership
// check. These run the actual SQL against a throwaway Postgres (testcontainers)
// loaded with test/fixtures/memorySchema.sql.
//
// Skips gracefully when Docker is unavailable so `pnpm test` runs everywhere.

const SCHEMA = readFileSync(
  join(process.cwd(), "test/fixtures/memorySchema.sql"),
  "utf8",
);

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let repo: PgMemoryReadRepository | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename, { empty: true });
    pool = new Pool({ connectionString: container.getConnectionUri() });
    await pool.query(SCHEMA);
    repo = new PgMemoryReadRepository(pool);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(
      `[memory-read-integration] skipped — Docker/Postgres unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const SPACE = "space-1";
const USER = "user-1";

async function insertMemory(over: Record<string, unknown>): Promise<void> {
  const cols: Record<string, unknown> = {
    id: over.id,
    space_id: SPACE,
    scope_type: "user",
    memory_type: "fact",
    status: "active",
    visibility: "private",
    access_level: "full",
    sensitivity_level: "normal",
    confidence: 1,
    importance: 0.5,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
  const names = Object.keys(cols);
  const placeholders = names.map((n, i) =>
    n === "tags" ? `$${i + 1}::jsonb` : `$${i + 1}`,
  );
  const values = names.map((n) =>
    n === "tags"
      ? cols[n] === undefined
        ? null
        : JSON.stringify(cols[n])
      : cols[n],
  );
  await pool!.query(
    `INSERT INTO memory_entries (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    values,
  );
}

beforeEach(async () => {
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["retrieval_edges", "retrieval_chunks", "retrieval_aliases", "retrieval_objects", "extracted_evidence", "source_snapshots", "source_items", "provenance_links", "content_access_logs", "content_access_grants", "memory_entries", "project_folders", "projects", "project_members", "space_memberships", "spaces"],
  );
  await pool.query("INSERT INTO spaces (id, type) VALUES ($1, 'household')", [SPACE]);
  for (const userId of [USER, "other"]) {
    await pool.query(
      `INSERT INTO space_memberships
         (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [`membership-${userId}`, SPACE, userId],
    );
  }
});

async function accessLogs(memoryId: string): Promise<Array<Record<string, unknown>>> {
  const res = await pool!.query(
    "SELECT *, resource_id AS memory_id, viewer_user_id AS user_id FROM content_access_logs WHERE resource_type = 'memory' AND resource_id = $1 ORDER BY accessed_at",
    [memoryId],
  );
  return res.rows;
}

async function counters(memoryId: string): Promise<{ access_count: number; last_accessed_at: unknown }> {
  const res = await pool!.query(
    "SELECT access_count, last_accessed_at FROM memory_entries WHERE id = $1",
    [memoryId],
  );
  return res.rows[0] as { access_count: number; last_accessed_at: unknown };
}

describe("PgMemoryReadRepository against real Postgres", () => {
  it("lists only readable rows and paginates the filtered set", async () => {
    if (!available || !repo) return;
    // Readable: own private, space_shared. Hidden: another user's private and
    // soft-deleted rows.
    await insertMemory({ id: "m-own", owner_user_id: USER, importance: 0.9 });
    await insertMemory({ id: "m-shared", owner_user_id: "other", visibility: "space_shared", importance: 0.8 });
    await insertMemory({ id: "m-private-other", owner_user_id: "other", visibility: "private", importance: 0.7 });
    await insertMemory({ id: "m-deleted", owner_user_id: USER, deleted_at: new Date().toISOString() });

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
    if (!available || !repo) return;
    await insertMemory({
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
    if (!available || !repo) return;
    await insertMemory({
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
    if (!available || !repo) return;
    await insertMemory({ id: "m-hit", owner_user_id: USER, content: "the server migration plan" });
    await insertMemory({ id: "m-miss", owner_user_id: USER, content: "unrelated" });
    await insertMemory({ id: "m-hidden", owner_user_id: "other", visibility: "private", content: "server secret" });

    const rows = await repo.search(SPACE, USER, { query: "server", limit: 10 });
    expect(rows.map((m) => m.id).sort()).toEqual(["m-hit"]);
  });

  it("a cross-person get writes one explicit_read trace and bumps the read counters", async () => {
    if (!available || !repo || !pool) return;
    await insertMemory({ id: "m-1", owner_user_id: "other", visibility: "space_shared" });

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
    if (!available || !repo || !pool) return;
    await insertMemory({ id: "m-priv", owner_user_id: "other", visibility: "private" });

    expect(await repo.get(SPACE, USER, "m-priv")).toBeNull();
    expect(await accessLogs("m-priv")).toHaveLength(0);
    expect((await counters("m-priv")).access_count).toBe(0);
  });

  it("search writes a search_hit trace per returned row; list logs nothing", async () => {
    if (!available || !repo || !pool) return;
    await insertMemory({ id: "m-a", owner_user_id: "other", visibility: "space_shared", content: "server alpha" });
    await insertMemory({ id: "m-b", owner_user_id: "other", visibility: "space_shared", content: "server beta" });
    await insertMemory({ id: "m-hidden", owner_user_id: "other", visibility: "private", content: "server secret" });

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
    if (!available || !repo || !pool) return;
    await insertMemory({ id: "m-1", owner_user_id: USER, scope_type: "project", project_id: "proj-1" });
    // USER owns the project, so the project gate keeps the row visible.
    await pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id) VALUES ('proj-1', $1, $2)",
      [SPACE, USER],
    );
    // Valid project filter returns rows.
    const ok = await repo.list(SPACE, USER, { limit: 50, offset: 0, projectId: "proj-1" });
    expect(ok.items).toHaveLength(1);
    // Unknown project → validation error (→ 422 at the route).
    await expect(
      repo.list(SPACE, USER, { limit: 50, offset: 0, projectId: "missing" }),
    ).rejects.toBeInstanceOf(MemoryReadValidationError);
  });

  it("project-gates list/search/get for a non-member, and reveals after membership", async () => {
    if (!available || !repo || !pool) return;
    // A shared (non-personal) space: project gating is active.
    await pool.query("UPDATE spaces SET type = 'household' WHERE id = $1", [SPACE]);
    // Project owned by another user; USER's own memory is filed under it.
    await pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id) VALUES ('proj-x', $1, 'other')",
      [SPACE],
    );
    await insertMemory({ id: "m-proj", owner_user_id: USER, scope_type: "project", project_id: "proj-x", content: "project note" });
    await insertMemory({ id: "m-free", owner_user_id: USER, content: "free note" });

    // Non-member of proj-x: the project memory is hidden everywhere; the
    // project-free memory is still visible.
    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items.map((m) => m.id)).toEqual(["m-free"]);
    expect((await repo.search(SPACE, USER, { query: "note", limit: 10 })).map((m) => m.id)).toEqual(["m-free"]);
    expect(await repo.get(SPACE, USER, "m-proj")).toBeNull();

    // Grant membership → the project memory becomes visible.
    await pool.query(
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
    if (!available || !repo || !pool) return;
    await pool.query("UPDATE spaces SET type = 'personal' WHERE id = $1", [SPACE]);
    await pool.query("INSERT INTO spaces (id, type) VALUES ('space-other', 'household')");
    await pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id) VALUES ('proj-other', 'space-other', $1)",
      [USER],
    );
    await insertMemory({
      id: "m-cross-project",
      owner_user_id: USER,
      scope_type: "project",
      visibility: "space_shared",
      project_id: "proj-other",
    });

    expect((await repo.list(SPACE, USER, { limit: 50, offset: 0 })).items).toHaveLength(0);
    expect(await repo.get(SPACE, USER, "m-cross-project")).toBeNull();
  });

  it("does not allow a stale active project_members row for a soft-deleted project", async () => {
    if (!available || !repo || !pool) return;
    await pool.query("UPDATE spaces SET type = 'household' WHERE id = $1", [SPACE]);
    await pool.query(
      "INSERT INTO projects (id, space_id, owner_user_id, deleted_at) VALUES ('proj-deleted', $1, 'other', now())",
      [SPACE],
    );
    await pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ('pm-deleted', $1, 'proj-deleted', $2, 'member', 'active', now(), now())`,
      [SPACE, USER],
    );
    await insertMemory({
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
