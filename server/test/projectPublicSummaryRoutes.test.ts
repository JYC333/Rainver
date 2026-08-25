import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer";
import { projectsModule } from "../src/modules/projects";
import { loadConfig } from "../src/config";
import {
  __setAuthIdentityForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
} from "../src/modules/auth";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  await app?.close();
  app = undefined;
});

function config() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
  });
}

/** Auth repository that always denies, so routes return 401 before any DB work. */
function denyingAuth(): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: false, reason: "denied", statusCode: 401, body: { detail: "Unauthorized" } };
    },
    async getSpaceForUser() {
      throw new Error("not used");
    },
    async getCurrentUser() {
      throw new Error("not used");
    },
    async getUserSpaces() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async findOrCreateFromGoogle() {
      throw new Error("not used");
    },
    async createSession() {
      throw new Error("not used");
    },
  } as unknown as AuthRepository;
}

describe("Project public summary routes", () => {
  it("rejects an upsert body missing summary_text", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [projectsModule]);

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/project-1/public-summary",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ topics: ["discovery"] }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("summary_text");
  });

  it("rejects a draft request with a non-numeric max_tokens", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [projectsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/public-summary/draft",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ max_tokens: "lots" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("max_tokens");
  });

  it("rejects a public-summary search for any other object type", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [projectsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/public-summaries/search",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", object_types: ["memory_entry"] }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("project_public_summary");
  });

  it("rejects a project retrieval brief for any other object type", async () => {
    __setAuthIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    app = buildModuleServer(config(), [projectsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/retrieval/brief",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ query: "alpha", object_types: ["memory_entry"] }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toContain("project_public_summary");
  });

  it("requires authentication for the draft route", async () => {
    __setAuthRepositoryForTests(denyingAuth());
    app = buildModuleServer(config(), [projectsModule]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/public-summary/draft",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(401);
  });
});
