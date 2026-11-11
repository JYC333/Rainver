import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { sessionsModule } from "../src/modules/sessions/index.js";
import { loadConfig } from "../src/config.js";
import {
  __setExecutionContextServiceFactoryForTests,
  __setSessionIdentityForTests,
  __setSessionServicesFactoryForTests,
} from "../src/modules/sessions/routes.js";
import type { PgSessionRepository } from "../src/modules/sessions/repository.js";
import type {
  MessageOut,
  SessionOut,
  SessionPage,
} from "@rainver/protocol";
import { __setContentCreationContextResolverForTests } from "../src/modules/access/creationContext.js";

let app: FastifyInstance;

beforeEach(() => {
  __setContentCreationContextResolverForTests(async (_db, input) => ({
    spaceId: input.requestSpaceId,
    projectId: input.projectId ?? null,
    visibility: input.projectId ? "space_shared" : "private",
  }));
});

afterEach(async () => {
  __setSessionIdentityForTests(null);
  __setSessionServicesFactoryForTests(null);
  __setExecutionContextServiceFactoryForTests(null);
  __setContentCreationContextResolverForTests(null);
  await app?.close();
});

function sessionsConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/rainver",
    SERVER_INTERNAL_TOKEN: "internal-token",
  });
}

type Repo = Pick<
  PgSessionRepository,
  | "listSessions"
  | "getSession"
  | "listMessages"
  | "createSession"
  | "addMessage"
  | "reflectSession"
>;

const notCalled = (name: string) => () => {
  throw new Error(`${name} should not run`);
};

/** A repository fake that throws for every method unless overridden. */
function repo(overrides: Partial<Repo>): Repo {
  return {
    listSessions: notCalled("listSessions"),
    getSession: notCalled("getSession"),
    listMessages: notCalled("listMessages"),
    createSession: notCalled("createSession"),
    addMessage: notCalled("addMessage"),
    reflectSession: notCalled("reflectSession"),
    ...overrides,
  } as Repo;
}

function withRepo(overrides: Partial<Repo>) {
  __setSessionServicesFactoryForTests(() => ({ repository: repo(overrides) }));
}

function session(overrides: Partial<SessionOut> = {}): SessionOut {
  return {
    id: "session-1",
    space_id: "space-1",
    user_id: "user-1",
    project_folder_id: null,
    title: "chat",
    status: "active",
    created_at: "2026-06-14T10:00:00.000Z",
    updated_at: "2026-06-14T10:05:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<MessageOut> = {}): MessageOut {
  return {
    id: "message-1",
    session_id: "session-1",
    space_id: "space-1",
    user_id: "user-1",
    role: "user",
    content: "hello",
    metadata_json: null,
    created_at: "2026-06-14T10:01:00.000Z",
    ...overrides,
  };
}

describe("session read routes", () => {
  it("serves the session list from the server read model with space/user scope", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({
      async listSessions(_spaceId, _userId, limit, offset) {
        return {
          items: [session({ id: `session-${limit}-${offset}` })],
          total: 1,
          limit,
          offset,
        } satisfies SessionPage;
      },
    });
    app = buildModuleServer(sessionsConfig(), [sessionsModule]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sessions?limit=25&offset=10",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      items: [{ id: "session-25-10" }],
      total: 1,
      limit: 25,
      offset: 10,
    });
  });

  it("serves a visible session detail and 404s an invisible one", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({
      async getSession(_spaceId, _userId, sessionId) {
        return sessionId === "session-1" ? session({ id: sessionId }) : null;
      },
    });
    app = buildModuleServer(sessionsConfig(), [sessionsModule]);

    const ok = await app.inject({ method: "GET", url: "/api/v1/sessions/session-1" });
    const missing = await app.inject({ method: "GET", url: "/api/v1/sessions/other" });

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: "session-1", status: "active" });
    expect(missing.statusCode).toBe(404);
  });

  it("serves messages for a visible session and 404s when not visible", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({
      async listMessages(_spaceId, _userId, sessionId, limit, offset) {
        return sessionId === "session-1"
          ? [message({ id: `message-${limit}-${offset}` })]
          : null;
      },
    });
    app = buildModuleServer(sessionsConfig(), [sessionsModule]);

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/session-1/messages",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/sessions/other/messages",
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([message({ id: "message-100-0" })]);
    expect(missing.statusCode).toBe(404);
  });

  it("rejects an out-of-range limit with 422", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({});
    app = buildModuleServer(sessionsConfig(), [sessionsModule]);

    const res = await app.inject({ method: "GET", url: "/api/v1/sessions?limit=999" });

    expect(res.statusCode).toBe(422);
  });
});
