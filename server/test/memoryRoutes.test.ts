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

afterEach(async () => {
  __setMemoryIdentityForTests(null);
  __setMemoryServicesFactoryForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
});

function memoryConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
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



  it("passes the agent-written and session filters through to the read model", async () => {
    __setMemoryIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    let seen: MemoryListArgs[2] | null = null;
    __setMemoryServicesFactoryForTests(() => ({
      repository: {
        async list(_spaceId: string, _userId: string, filters: MemoryListArgs[2]) {
          seen = filters;
          return { items: [], total: 0, limit: filters.limit, offset: filters.offset };
        },
      } as unknown as MemoryServices["repository"],
    }));
    app = buildModuleServer(memoryConfig(), [memoryModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/memory?created_by=agent&session=session-1&run=run-1&since=2026-08-01T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(200);
    // Agent-authored memory is read after the fact (ADR 0003 §2). Do not
    // require a per-write approval to list it. The page must be able to ask for it.
    expect(seen).toMatchObject({
      writtenBy: "agent",
      sessionId: "session-1",
      // `?run=` is the only action link a paused turn's attention item
      // carries; a page that ignored it would silently show everything.
      runId: "run-1",
      since: "2026-08-01T00:00:00.000Z",
    });
  });
});
