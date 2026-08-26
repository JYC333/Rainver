import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { memoryModule } from "../src/modules/memory/index.js";
import { loadConfig } from "../src/config.js";
import { __setMemoryIdentityForTests, __setMemoryServicesFactoryForTests } from "../src/modules/memory/routes.js";
import { MemoryReadValidationError } from "../src/modules/memory/repository.js";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";

let app: FastifyInstance;

beforeEach(() => {
  __setContentCreationContextResolverForTests(async (_db, input) => ({
    spaceId: input.requestSpaceId,
    projectId: input.projectId ?? null,
    visibility: input.projectId ? "space_shared" : "private",
  }));
});

type MemoryServicesFactory = NonNullable<
  Parameters<typeof __setMemoryServicesFactoryForTests>[0]
>;
type MemoryServices = ReturnType<MemoryServicesFactory>;
type MemoryRepository = MemoryServices["repository"];
type MemoryListArgs = Parameters<MemoryRepository["list"]>;
type MemorySearchArgs = Parameters<MemoryRepository["search"]>;
type CreateMemoryProposalArgs = Parameters<MemoryRepository["createMemoryProposal"]>;

afterEach(async () => {
  __setMemoryIdentityForTests(null);
  __setMemoryServicesFactoryForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
});

function memoryConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

function memoryOut(over: Record<string, unknown> = {}) {
  return {
    id: "memory-1",
    space_id: "space-1",
    scope: "user",
    type: "fact",
    status: "active",
    visibility: "private",
    sensitivity_level: "normal",
    confidence: 1,
    importance: 0.5,
    created_at: "2026-06-15T10:00:00.000Z",
    updated_at: "2026-06-15T10:00:00.000Z",
    version: 1,
    ...over,
  };
}

function proposalOut(over: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    space_id: "space-1",
    user_id: "user-1",
    source_session_id: null,
    source_task_id: null,
    source_run_id: null,
    created_by_run_id: null,
    proposal_type: "memory_create",
    target_scope: "user",
    target_namespace: "user.default",
    memory_type: "fact",
    proposed_title: "Remember",
    proposed_content: "content",
    rationale: "Memory creation requested via public API.",
    status: "pending",
    risk_level: "low",
    urgency: "normal",
    visibility: "space_shared",
    preview: false,
    review_deadline: null,
    expires_at: null,
    expired: false,
    created_at: "2026-06-15T10:00:00.000Z",
    decided_at: null,
    resulting_memory_id: null,
    owner_user_id: null,
    subject_user_id: null,
    sensitivity_level: "normal",
    access_level: "full",
    provenance_entries: null,
    source_activity_id: null,
    grant_id: null,
    required_approver_user_id: null,
    requires_approval_type: null,
    egress_approval_status: null,
    egress_approval_id: null,
    project_id: null,
    ...over,
  };
}

describe("memory read routes", () => {
  it("lists memories with the public pagination shape", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list(_spaceId: MemoryListArgs[0], _userId: MemoryListArgs[1], filters: MemoryListArgs[2]) {
          return {
            items: [memoryOut({ id: `page-${filters.limit}-${filters.offset}` })],
            total: 1,
            limit: filters.limit,
            offset: filters.offset,
          };
        },
        async get() {
          throw new Error("not used");
        },
        async search() {
          throw new Error("not used");
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory?type=fact&status=active&limit=10&offset=5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      items: [{ id: "page-10-5" }],
      total: 1,
      limit: 10,
      offset: 5,
    });
  });

  it("returns 422 for an out-of-range limit", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new Error("should not run");
        },
        async get() {
          throw new Error("x");
        },
        async search() {
          throw new Error("x");
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);
    const res = await app.inject({ method: "GET", url: "/api/v1/memory?limit=999" });
    expect(res.statusCode).toBe(422);
  });

  it("maps a project filter validation error to 422", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new MemoryReadValidationError("project_id 'p1' not found in space 'space-1'");
        },
        async get() {
          throw new Error("x");
        },
        async search() {
          throw new Error("x");
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);
    const res = await app.inject({ method: "GET", url: "/api/v1/memory?project_id=p1" });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("not found in space");
  });

  it("gets a memory or 404s when not readable", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new Error("x");
        },
        async get(_s: string, _u: string, memoryId: string) {
          return memoryId === "ok" ? memoryOut({ id: "ok" }) : null;
        },
        async search() {
          throw new Error("x");
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    expect((await app.inject({ method: "GET", url: "/api/v1/memory/ok" })).statusCode).toBe(200);
    const missing = await app.inject({ method: "GET", url: "/api/v1/memory/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ detail: "Memory not found" });
  });

  it("ignores body space_id/user_id and scopes search to the authenticated identity", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new Error("x");
        },
        async get() {
          throw new Error("x");
        },
        async search(spaceId: MemorySearchArgs[0], userId: MemorySearchArgs[1], filters: MemorySearchArgs[2]) {
          return [
            memoryOut({
              id: `${userId}-search`,
              space_id: spaceId,
              title: filters.query,
            }),
          ];
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    // A hostile body tries to read another space as another user; both are ignored.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      payload: { query: "server", space_id: "space-2", user_id: "user-9", limit: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ id: "user-1-search", space_id: "space-1", title: "server" }),
    ]);
  });

  it("rejects a memory retrieval brief for non-memory object types", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory/retrieval/brief",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", object_types: ["knowledge_item"] }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("memory_entry");
  });

  it("creates a memory_create proposal without mutating memory directly", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new Error("x");
        },
        async get() {
          throw new Error("x");
        },
        async search() {
          throw new Error("x");
        },
        async createMemoryProposal(
          _spaceId: CreateMemoryProposalArgs[0],
          _userId: CreateMemoryProposalArgs[1],
          command: CreateMemoryProposalArgs[2],
        ) {
          return proposalOut({
            proposed_title: command.title,
            proposed_content: command.content,
          });
        },
        async updateMemoryProposal() {
          throw new Error("x");
        },
        async archiveMemoryProposal() {
          throw new Error("x");
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/memory",
      payload: {
        title: "Remember",
        content: "content",
        type: "fact",
        visibility: "space_shared",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      proposal_type: "memory_create",
      status: "pending",
      proposed_title: "Remember",
      proposed_content: "content",
    });
  });

  it("creates memory_update and memory_archive proposals for target memories", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list() {
          throw new Error("x");
        },
        async get() {
          throw new Error("x");
        },
        async search() {
          throw new Error("x");
        },
        async createMemoryProposal() {
          throw new Error("x");
        },
        async updateMemoryProposal(
          _spaceId: string,
          _userId: string,
          memoryId: string,
          command: { content?: string | null },
        ) {
          return proposalOut({
            id: "proposal-update",
            proposal_type: "memory_update",
            proposed_content: command.content,
            resulting_memory_id: memoryId,
          });
        },
        async archiveMemoryProposal(
          _spaceId: string,
          _userId: string,
          memoryId: string,
        ) {
          return proposalOut({
            id: "proposal-archive",
            proposal_type: "memory_archive",
            resulting_memory_id: memoryId,
          });
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/memory/memory-1",
      payload: { content: "new content" },
    });
    const del = await app.inject({
      method: "DELETE",
      url: "/api/v1/memory/memory-1",
    });

    expect(patch.statusCode).toBe(202);
    expect(patch.json()).toMatchObject({
      id: "proposal-update",
      proposal_type: "memory_update",
      proposed_content: "new content",
      resulting_memory_id: "memory-1",
    });
    expect(del.statusCode).toBe(202);
    expect(del.json()).toMatchObject({
      id: "proposal-archive",
      proposal_type: "memory_archive",
      resulting_memory_id: "memory-1",
    });
  });
});
