import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { RetrievalSearchService } from "../src/modules/retrieval/searchService.js";
import { memoryRetrievalRegistry } from "../src/modules/memory/retrievalAdapter.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

// Real-PostgreSQL round-trip for the Memory create-safety retrieval slice. The
// focused memoryRetrieval.test.ts uses an in-memory fake, which cannot catch SQL
// bugs (the new memory_entry object_type CHECK constraint on retrieval_objects /
// _aliases / _chunks, to_tsvector / ts_rank_cd, the revalidate SQL, the
// create_safety_hit access_type, FK-backed owner gating). This test applies the
// committed baseline to a throwaway Postgres and exercises projection writes +
// create-safety + read-trace against canonical memory_entries for real. Skips
// gracefully when Docker is unavailable.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM_A = "33333333-3333-4333-8333-333333333333";


const db = useTestDatabase(import.meta.filename);

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["retrieval_objects", "retrieval_aliases", "retrieval_chunks", "retrieval_edges", "content_access_logs", "memory_entries", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  // A multi-member (household) space so project gating is meaningful; a personal
  // space would grant its sole member access to every project.
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_at, updated_at)
     VALUES ($1, 'Test Space', 'household', now(), now())`,
    [SPACE],
  );
  for (const id of [OWNER, OTHER]) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at)
       VALUES ($1, 'User', 'active', now(), now())`,
      [id],
    );
  }
  // project_members(space_id, user_id) FKs to space_memberships(space_id, user_id).
  for (const id of [OWNER, OTHER]) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, id],
    );
  }
});

const PROJECT = "44444444-4444-4444-8444-444444444444";

async function insertProject(ownerUserId: string | null): Promise<void> {
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Proj', 'active', now(), now())`,
    [PROJECT, SPACE, ownerUserId],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
}

async function addProjectMember(userId: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
    [randomUUID(), SPACE, PROJECT, userId],
  );
}

async function insertMemory(over: Record<string, unknown>): Promise<void> {
  const cols: Record<string, unknown> = {
    id: MEM_A,
    space_id: SPACE,
    scope_type: "user",
    memory_type: "fact",
    status: "active",
    visibility: "space_shared",
    access_level: "full",
    sensitivity_level: "normal",
    confidence: 1,
    importance: 0.5,
    version: 1,
    access_count: 0,
    title: "Coffee preferences",
    content: "Prefers oat milk flat white in the morning.",
    owner_user_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
  const names = Object.keys(cols);
  const placeholders = names.map((_, i) => `$${i + 1}`);
  await db.pool.query(
    `INSERT INTO memory_entries (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    names.map((n) => cols[n]),
  );
}

function searchService(): RetrievalSearchService {
  return new RetrievalSearchService(db.pool, memoryRetrievalRegistry);
}

async function reindex(): Promise<void> {
  await new RetrievalProjectionService(db.pool, memoryRetrievalRegistry).reindex(SPACE, "memory_entry", MEM_A);
}

describe("Memory project gating (real Postgres)", () => {
  async function searchAsOwnerProject(viewerUserId: string) {
    return searchService().search({
      spaceId: SPACE,
      viewerUserId,
      objectTypes: ["memory_entry"],
      query: "Coffee preferences",
    });
  }

  it("hides project memory from a non-member, reveals it to a member and to the owner", async () => {
    if (!db.available) return;
    await insertProject(OWNER);
    await insertMemory({
      scope_type: "project",
      project_id: PROJECT,
      owner_user_id: OWNER,
      visibility: "space_shared",
    });
    await reindex();

    // Non-member, non-owner: gated out.
    expect((await searchAsOwnerProject(OTHER)).items).toHaveLength(0);
    // Project owner: allowed.
    expect((await searchAsOwnerProject(OWNER)).items.map((i) => i.object_id)).toContain(MEM_A);
    // After membership is granted: allowed.
    await addProjectMember(OTHER);
    expect((await searchAsOwnerProject(OTHER)).items.map((i) => i.object_id)).toContain(MEM_A);
  });

  it("applies the same project gate to create-safety", async () => {
    if (!db.available) return;
    await insertProject(OWNER);
    await insertMemory({
      scope_type: "project",
      project_id: PROJECT,
      owner_user_id: OWNER,
      visibility: "space_shared",
    });
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OTHER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });
    expect(out.matches).toHaveLength(0);
  });

  it("does not project-gate memory with no project_id", async () => {
    if (!db.available) return;
    await insertMemory({ project_id: null, owner_user_id: OWNER, visibility: "space_shared" });
    await reindex();

    // OTHER is not a project member, but the row has no project_id.
    const out = await searchAsOwnerProject(OTHER);
    expect(out.items.map((i) => i.object_id)).toContain(MEM_A);
  });
});

describe("Memory create-safety retrieval (real Postgres)", () => {
  it("returns exists for the owner of a duplicate-titled private memory", async () => {
    if (!db.available) return;
    await insertMemory({ visibility: "private", owner_user_id: OWNER });
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OWNER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.create_safety).toBe("exists");
    expect(out.matches[0]?.object_id).toBe(MEM_A);
    // The owner sees the content snippet.
    expect(out.matches[0]?.snippet).toContain("oat milk");
  });

  it("drops another user's private memory during revalidation", async () => {
    if (!db.available) return;
    await insertMemory({ visibility: "private", owner_user_id: OWNER });
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OTHER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches).toHaveLength(0);
    expect(out.create_safety).toBe("unknown");
  });

  it("matches a summary-access memory for a non-owner but redacts the snippet", async () => {
    if (!db.available) return;
    await insertMemory({ visibility: "space_shared", access_level: "summary", owner_user_id: OWNER });
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OTHER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches[0]?.object_id).toBe(MEM_A);
    expect(out.matches[0]?.snippet).toBeNull();
  });

  it("flags probable_duplicate via lexical content match when the title differs", async () => {
    if (!db.available) return;
    await insertMemory({ title: "Beverage note", content: "Prefers oat milk flat white in the morning." });
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OWNER,
      objectType: "memory_entry",
      title: "oat milk flat white",
    });

    expect(out.create_safety).toBe("probable_duplicate");
    expect(out.matches.map((m) => m.object_id)).toContain(MEM_A);
  });

  it("excludes an archived memory and reindex drops its projection", async () => {
    if (!db.available) return;
    await insertMemory({ visibility: "space_shared" });
    await reindex();
    // Archive it, then reindex: loadCanonical returns null and the projection is dropped.
    await db.pool.query("UPDATE memory_entries SET status = 'archived' WHERE id = $1", [MEM_A]);
    await reindex();

    const out = await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OWNER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches).toHaveLength(0);
    const remaining = await db.pool.query(
      "SELECT count(*)::int AS n FROM retrieval_objects WHERE object_type = 'memory_entry'",
    );
    expect(remaining.rows[0].n).toBe(0);
  });

  it("logs returned create-safety matches as create_safety_hit and bumps the counter", async () => {
    if (!db.available) return;
    await insertMemory({ visibility: "space_shared", owner_user_id: OWNER });
    await reindex();

    await searchService().assessCreateSafety({
      spaceId: SPACE,
      viewerUserId: OTHER,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    const logs = await db.pool.query(
      "SELECT access_type, viewer_user_id, reason FROM content_access_logs WHERE resource_type = 'memory' AND resource_id = $1",
      [MEM_A],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({
      access_type: "create_safety_hit",
      viewer_user_id: OTHER,
      reason: "retrieval create-safety",
    });
    const counter = await db.pool.query("SELECT access_count FROM memory_entries WHERE id = $1", [MEM_A]);
    expect(counter.rows[0].access_count).toBe(1);
  });
});
