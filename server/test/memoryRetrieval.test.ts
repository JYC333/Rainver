import { describe, expect, it } from "vitest";
import {
  RetrievalProjectionService,
  RetrievalSearchService,
  normalizeAlias,
} from "../src/modules/retrieval";
import type { Queryable } from "../src/modules/routeUtils/common";
import {
  isMemoryRetrievalProjectable,
  memoryRetrievalRegistry,
} from "../src/modules/memory/retrievalAdapter";

const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM_A = "33333333-3333-4333-8333-333333333333";
const MEM_B = "44444444-4444-4444-8444-444444444444";

interface MemRow {
  id: string;
  space_id: string;
  status: string;
  deleted_at: unknown;
  sensitivity_level: string | null;
  visibility: string | null;
  access_level: string;
  effective_access_level?: string;
  owner_user_id: string | null;
  scope_type: string | null;
  project_id: string | null;
  title: string | null;
  content: string | null;
}

function memRow(overrides: Partial<MemRow> = {}): MemRow {
  return {
    id: MEM_A,
    space_id: SPACE_A,
    status: "active",
    deleted_at: null,
    sensitivity_level: "normal",
    visibility: "space_shared",
    access_level: "full",
    owner_user_id: USER_A,
    scope_type: "user",
    project_id: null,
    title: "Coffee preferences",
    content: "Prefers oat milk flat white in the morning.",
    ...overrides,
  };
}

interface AliasRow {
  space_id: string;
  object_type: "memory_entry";
  object_id: string;
  alias: string;
  normalized_alias: string;
  alias_kind: string;
  confidence: number;
}

/**
 * Search-side fake DB for the memory retrieval surface. It serves the engine's
 * arm queries from in-memory `retrieval_*` rows and the adapter's revalidate
 * query from in-memory `memory_entries` rows. Any write to `memory_entries` is
 * forbidden: create-safety is read-only.
 */
class MemorySearchFakeDb implements Queryable {
  readonly memories: MemRow[] = [];
  readonly aliases: AliasRow[] = [];
  readonly forbiddenWrites: string[] = [];
  spaceType = "household";
  memoryEntryReadQueries = 0;
  readonly projects = new Map<string, { owner_user_id: string | null }>();
  readonly members = new Set<string>(); // `${projectId}:${userId}`

  addMemory(row: MemRow): void {
    this.memories.push(row);
  }

  addProject(projectId: string, ownerUserId: string | null): void {
    this.projects.set(projectId, { owner_user_id: ownerUserId });
  }

  addMember(projectId: string, userId: string): void {
    this.members.add(`${projectId}:${userId}`);
  }

  addAlias(objectId: string, alias: string, aliasKind = "title", spaceId = SPACE_A): void {
    this.aliases.push({
      space_id: spaceId,
      object_type: "memory_entry",
      object_id: objectId,
      alias,
      normalized_alias: normalizeAlias(alias),
      alias_kind: aliasKind,
      confidence: 1,
    });
  }

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (norm.startsWith("UPDATE memory_entries SET access_count")) {
      return { rows: [] as Row[], rowCount: Array.isArray(params[1]) ? params[1].length : 0 };
    }
    if (norm.startsWith("INSERT INTO content_access_logs")) {
      return { rows: [] as Row[], rowCount: 0 };
    }
    if (/INSERT INTO memory_entries|UPDATE memory_entries|DELETE FROM memory_entries/.test(norm)) {
      this.forbiddenWrites.push(norm);
      throw new Error("forbidden canonical memory write");
    }
    if (norm.includes("FROM retrieval_aliases ra")) {
      const [spaceId, objectTypes, normalized] = params as [string, string[], string[]];
      const rows = this.aliases
        .filter(
          (a) =>
            a.space_id === spaceId &&
            objectTypes.includes(a.object_type) &&
            normalized.includes(a.normalized_alias),
        )
        .map((a, index) => {
          const mem = this.memories.find((m) => m.id === a.object_id);
          return {
            object_type: a.object_type,
            object_id: a.object_id,
            title: mem?.title ?? a.alias,
            snippet: mem?.content ?? null,
            matched_text: a.alias,
            matched_field: a.alias_kind,
            rank: index + 1,
          };
        });
      return result(rows as Row[]);
    }
    if (norm.includes("FROM retrieval_chunks rc")) {
      // No lexical fixtures: the create-safety tests exercise alias + revalidate.
      return result([] as Row[]);
    }
    if (norm.includes("FROM retrieval_edges e")) {
      return result([] as Row[]);
    }
    if (norm.includes("FROM memory_entries")) {
      this.memoryEntryReadQueries += 1;
      const batch = Array.isArray(params[1]);
      const spaceId = batch ? params[0] as string : params[1] as string;
      const ids = batch ? params[1] as string[] : [params[0] as string];
      const viewerUserId = batch && typeof params[2] === "string" ? params[2] as string : null;
      const rows = this.memories.filter(
        (m) => ids.includes(m.id) && m.space_id === spaceId && m.status === "active" && m.deleted_at === null,
      ).filter((m) => {
        if (!viewerUserId) return true;
        if (m.sensitivity_level === "highly_restricted" && m.owner_user_id !== viewerUserId) return false;
        if (m.project_id) {
          const project = this.projects.get(m.project_id);
          const projectAllowed = this.spaceType === "personal"
            || project?.owner_user_id === viewerUserId
            || this.members.has(`${m.project_id}:${viewerUserId}`);
          if (!projectAllowed) return false;
        }
        return m.owner_user_id === viewerUserId || m.visibility === "space_shared";
      }).map((m) => ({ ...m, effective_access_level: m.owner_user_id === viewerUserId ? "full" : m.access_level }));
      return result(rows as Row[]);
    }
    if (norm.includes("FROM spaces WHERE id")) {
      return result([{ type: this.spaceType }] as Row[]);
    }
    if (norm.includes("FROM projects")) {
      if (Array.isArray(params[1])) {
        const [, projectIds] = params as [string, string[]];
        return result(
          projectIds.flatMap((projectId) => {
            const proj = this.projects.get(projectId);
            return proj ? [{ id: projectId, owner_user_id: proj.owner_user_id }] : [];
          }) as Row[],
        );
      }
      const [projectId] = params as [string, string];
      const proj = this.projects.get(projectId);
      return result((proj ? [proj] : []) as Row[]);
    }
    if (norm.includes("FROM project_members")) {
      if (Array.isArray(params[1])) {
        const [, projectIds, userId] = params as [string, string[], string];
        return result(
          projectIds
            .filter((projectId) => this.members.has(`${projectId}:${userId}`))
            .map((projectId) => ({ project_id: projectId })) as Row[],
        );
      }
      const [, projectId, userId] = params as [string, string, string];
      return result((this.members.has(`${projectId}:${userId}`) ? [{ one: 1 }] : []) as Row[]);
    }
    throw new Error(`unexpected SQL: ${norm}`);
  }
}

function service(db: Queryable): RetrievalSearchService {
  return new RetrievalSearchService(db, memoryRetrievalRegistry);
}

describe("Memory zero-LLM retrieval create-safety", () => {
  it("returns exists for a duplicate title the proposer owns", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow());
    db.addAlias(MEM_A, "Coffee preferences", "title");

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.create_safety).toBe("exists");
    expect(out.matches[0]?.object_id).toBe(MEM_A);
    expect(db.forbiddenWrites).toHaveLength(0);
  });

  it("does not surface another user's private memory", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow({ visibility: "private", owner_user_id: USER_B }));
    db.addAlias(MEM_A, "Coffee preferences", "title");

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.create_safety).toBe("unknown");
    expect(out.matches).toHaveLength(0);
  });

  it("does not surface a highly_restricted memory to a non-owner", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow({ sensitivity_level: "highly_restricted", owner_user_id: USER_B }));
    db.addAlias(MEM_A, "Coffee preferences", "title");

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches).toHaveLength(0);
  });

  it("does not surface a cross-space projection", async () => {
    const db = new MemorySearchFakeDb();
    // Canonical row lives in SPACE_B; the alias projection is registered in SPACE_A.
    db.addMemory(memRow({ space_id: SPACE_B }));
    db.addAlias(MEM_A, "Coffee preferences", "title", SPACE_A);

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches).toHaveLength(0);
  });

  it("excludes archived and soft-deleted memories", async () => {
    const archived = new MemorySearchFakeDb();
    archived.addMemory(memRow({ status: "archived" }));
    archived.addAlias(MEM_A, "Coffee preferences", "title");
    expect(
      (await service(archived).assessCreateSafety({
        spaceId: SPACE_A,
        viewerUserId: USER_A,
        objectType: "memory_entry",
        title: "Coffee preferences",
      })).matches,
    ).toHaveLength(0);

    const deleted = new MemorySearchFakeDb();
    deleted.addMemory(memRow({ deleted_at: "2026-06-22T00:00:00Z" }));
    deleted.addAlias(MEM_A, "Coffee preferences", "title");
    expect(
      (await service(deleted).assessCreateSafety({
        spaceId: SPACE_A,
        viewerUserId: USER_A,
        objectType: "memory_entry",
        title: "Coffee preferences",
      })).matches,
    ).toHaveLength(0);
  });

  it("matches summary-access memory but redacts its content for a non-owner", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow({ visibility: "space_shared", access_level: "summary", owner_user_id: USER_B }));
    db.addAlias(MEM_A, "Coffee preferences", "title");

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
    });

    expect(out.matches[0]?.object_id).toBe(MEM_A);
    // Content must not leak through the snippet for summary access.
    expect(out.matches[0]?.snippet).toBeNull();
  });

  it("excludes the memory being edited from its own create-safety check", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow());
    db.addAlias(MEM_A, "Coffee preferences", "title");

    const out = await service(db).assessCreateSafety({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectType: "memory_entry",
      title: "Coffee preferences",
      excludeObjectId: MEM_A,
    });

    expect(out.create_safety).toBe("unknown");
    expect(out.matches).toHaveLength(0);
  });
});

describe("Memory retrieval project gating", () => {
  const PROJECT = "99999999-9999-4999-8999-999999999999";

  function dbWithProjectMemory(spaceType: string): MemorySearchFakeDb {
    const db = new MemorySearchFakeDb();
    db.spaceType = spaceType;
    db.addMemory(memRow({ project_id: PROJECT, owner_user_id: USER_A, visibility: "space_shared" }));
    db.addAlias(MEM_A, "Coffee preferences", "title");
    db.addProject(PROJECT, USER_A);
    return db;
  }

  async function search(db: MemorySearchFakeDb, viewer: string) {
    return service(db).search({
      spaceId: SPACE_A,
      viewerUserId: viewer,
      objectTypes: ["memory_entry"],
      query: "Coffee preferences",
    });
  }

  it("hides project memory from a non-member in a shared space", async () => {
    const db = dbWithProjectMemory("household");
    const out = await search(db, USER_B); // USER_B is not a member and not the owner
    expect(out.items).toHaveLength(0);
  });

  it("shows project memory to an active project member", async () => {
    const db = dbWithProjectMemory("household");
    db.addMember(PROJECT, USER_B);
    const out = await search(db, USER_B);
    expect(out.items.map((i) => i.object_id)).toContain(MEM_A);
  });

  it("shows project memory to the project owner", async () => {
    const db = dbWithProjectMemory("household");
    const out = await search(db, USER_A);
    expect(out.items.map((i) => i.object_id)).toContain(MEM_A);
  });

  it("shows all project memory to the sole member of a personal space", async () => {
    const db = dbWithProjectMemory("personal");
    // USER_B is not a member/owner of the project, but in a personal space the
    // caller is the sole member and sees everything.
    const out = await search(db, USER_B);
    expect(out.items.map((i) => i.object_id)).toContain(MEM_A);
  });

  it("does not project-gate memory with no project_id", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow({ project_id: null, owner_user_id: USER_A, visibility: "space_shared" }));
    db.addAlias(MEM_A, "Coffee preferences", "title");
    const out = await search(db, USER_B); // non-member, but row has no project
    expect(out.items.map((i) => i.object_id)).toContain(MEM_A);
  });
});

describe("Memory retrieval batch revalidation", () => {
  it("batch revalidates exact candidates once and reuses the seed gate", async () => {
    const db = new MemorySearchFakeDb();
    db.addMemory(memRow({ id: MEM_A, title: "Coffee preferences", content: "First preference." }));
    db.addMemory(memRow({ id: MEM_B, title: "Coffee preferences", content: "Second preference." }));
    db.addAlias(MEM_A, "Coffee preferences", "title");
    db.addAlias(MEM_B, "Coffee preferences", "title");

    const out = await service(db).search({
      spaceId: SPACE_A,
      viewerUserId: USER_A,
      objectTypes: ["memory_entry"],
      query: "Coffee preferences",
      maxResults: 10,
    });

    expect(out.items.map((item) => item.object_id).sort()).toEqual([MEM_A, MEM_B].sort());
    expect(db.memoryEntryReadQueries).toBe(1);
  });
});

describe("Memory retrieval projection eligibility", () => {
  const base = {
    scope_type: "user",
    visibility: "space_shared",
    access_level: "full",
    owner_user_id: null,
    sensitivity_level: "normal",
  };

  it("keeps memories that can be returned by at least one viewer", () => {
    expect(isMemoryRetrievalProjectable(base)).toBe(true);
    expect(isMemoryRetrievalProjectable({ ...base, visibility: "private", owner_user_id: USER_A })).toBe(true);
    expect(isMemoryRetrievalProjectable({ ...base, visibility: "selected_users" })).toBe(true);
  });

  it("drops memory rows that this retrieval surface can never return", () => {
    expect(isMemoryRetrievalProjectable({ ...base, visibility: "unknown" })).toBe(false);
    expect(isMemoryRetrievalProjectable({ ...base, access_level: "unknown" })).toBe(false);
  });
});

/**
 * Projection-side fake DB: confirms reindexing a memory writes only derived
 * `retrieval_*` rows and never the canonical `memory_entries` table.
 */
class MemoryProjectionFakeDb implements Queryable {
  readonly forbiddenWrites: string[] = [];
  readonly inserts: string[] = [];
  active = true;
  rowOverrides: Partial<MemRow> = {};

  async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const norm = sql.replace(/\s+/g, " ").trim();
    if (/INSERT INTO memory_entries|UPDATE memory_entries|DELETE FROM memory_entries/.test(norm)) {
      this.forbiddenWrites.push(norm);
      throw new Error("forbidden canonical memory write");
    }
    if (norm.includes("FROM memory_entries")) {
      if (!this.active) return result([] as Row[]);
      return result([
        {
          id: MEM_A,
          space_id: SPACE_A,
          status: "active",
          deleted_at: null,
          owner_user_id: USER_A,
          visibility: "space_shared",
          access_level: "full",
          memory_type: "semantic",
          title: "Coffee preferences",
          content: "Prefers oat milk flat white.",
          sensitivity_level: "normal",
          scope_type: "user",
          ...this.rowOverrides,
        },
      ] as Row[]);
    }
    if (norm.startsWith("SELECT pl.target_id,")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_objects")) {
      this.inserts.push("retrieval_objects");
      return result([{ id: "retrieval-object-1" }] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_aliases")) {
      this.inserts.push("retrieval_aliases");
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_chunks")) {
      this.inserts.push("retrieval_chunks");
      return result([] as Row[]);
    }
    if (norm.startsWith("SELECT DISTINCT object_type, object_id FROM retrieval_aliases")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("DELETE FROM retrieval_edges") || norm.startsWith("DELETE FROM retrieval_objects")) {
      return result([] as Row[]);
    }
    if (norm.startsWith("INSERT INTO retrieval_edges")) {
      this.inserts.push("retrieval_edges");
      return result([] as Row[]);
    }
    throw new Error(`unexpected SQL: ${norm}`);
  }
}

describe("Memory retrieval projection boundary", () => {
  it("reindexes a memory into derived rows without any canonical memory write", async () => {
    const db = new MemoryProjectionFakeDb();

    await new RetrievalProjectionService(db, memoryRetrievalRegistry).reindex(SPACE_A, "memory_entry", MEM_A);

    expect(db.forbiddenWrites).toHaveLength(0);
    expect(db.inserts).toContain("retrieval_objects");
    expect(db.inserts).toContain("retrieval_aliases");
  });

  it("drops the projection when the memory is no longer active", async () => {
    const db = new MemoryProjectionFakeDb();
    db.active = false;

    await new RetrievalProjectionService(db, memoryRetrievalRegistry).reindex(SPACE_A, "memory_entry", MEM_A);

    expect(db.inserts).not.toContain("retrieval_objects");
    expect(db.forbiddenWrites).toHaveLength(0);
  });

  it("does not project rows with invalid access metadata", async () => {
    const db = new MemoryProjectionFakeDb();
    db.rowOverrides = { visibility: "unknown" };

    await new RetrievalProjectionService(db, memoryRetrievalRegistry).reindex(SPACE_A, "memory_entry", MEM_A);

    expect(db.inserts).not.toContain("retrieval_objects");
    expect(db.forbiddenWrites).toHaveLength(0);
  });
});

function result<Row>(rows: Row[]) {
  return { rows, rowCount: rows.length };
}
