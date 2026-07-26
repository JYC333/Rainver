import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setSessionIdentityForTests,
  __setSessionServicesFactoryForTests,
} from "../src/modules/sessions";
import type { PgSessionRepository } from "../src/modules/sessions/repository";
import type {
  MessageOut,
  SessionSummaryForContext,
  SessionOut,
  SessionPage,
} from "@agent-space/protocol" with { "resolution-mode": "import" };

let app: FastifyInstance;

afterEach(async () => {
  __setSessionIdentityForTests(null);
  __setSessionServicesFactoryForTests(null);
  await app?.close();
});

function sessionsConfig() {
  return loadConfig({
    SERVER_DATABASE_URL: "postgresql://server@db:5432/agent_space",
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
  | "getLatestSummaryForContext"
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
    getLatestSummaryForContext: notCalled("getLatestSummaryForContext"),
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

function summary(overrides: Partial<SessionSummaryForContext> = {}): SessionSummaryForContext {
  return {
    id: "summary-1",
    session_id: "session-1",
    version: 2,
    summary_text: "Session with 3 messages. Key topics: stage, migration.",
    condenser_version: "pattern.v1",
    ...overrides,
  };
}

describe("session summary internal route", () => {
  it("serves latest active session summary from the server sessions authority", async () => {
    withRepo({
      async getLatestSummaryForContext(_spaceId, sessionId) {
        return summary({ session_id: sessionId });
      },
    });
    app = buildServer(sessionsConfig(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions/session-summary/get-latest",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: { space_id: "space-1", session_id: "session-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ summary: summary() });
  });

  it("returns null for a missing summary without leaking content", async () => {
    withRepo({
      async getLatestSummaryForContext() {
        return null;
      },
    });
    app = buildServer(sessionsConfig(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions/session-summary/get-latest",
      headers: { "x-agent-space-internal-token": "internal-token" },
      payload: { space_id: "space-1", session_id: "missing-session" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ summary: null });
  });

  it("requires the internal service token", async () => {
    withRepo({});
    app = buildServer(sessionsConfig(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/internal/sessions/session-summary/get-latest",
      payload: { space_id: "space-1", session_id: "session-1" },
    });

    expect(res.statusCode).toBe(401);
  });
});

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
    app = buildServer(sessionsConfig(), { logger: false });

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
    app = buildServer(sessionsConfig(), { logger: false });

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
    app = buildServer(sessionsConfig(), { logger: false });

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
    app = buildServer(sessionsConfig(), { logger: false });

    const res = await app.inject({ method: "GET", url: "/api/v1/sessions?limit=999" });

    expect(res.statusCode).toBe(422);
  });
});

describe("session write routes", () => {
  it("creates a session scoped to the acting identity (201)", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({
      async createSession(_spaceId, _userId, input) {
        return session({ title: input.title ?? null, project_folder_id: input.projectFolderId ?? null });
      },
    });
    app = buildServer(sessionsConfig(), { logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { title: "new chat", project_folder_id: "ws-1", metadata: { a: 1 } },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      id: "session-1",
      status: "active",
      title: "new chat",
      project_folder_id: "ws-1",
    });
  });

  it("appends a message to a visible session (201) and 404s an invisible one", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({
      async addMessage(_spaceId, _userId, sessionId, input) {
        return sessionId === "session-1"
          ? message({ role: input.role, content: input.content })
          : null;
      },
    });
    app = buildServer(sessionsConfig(), { logger: false });

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/messages",
      payload: { content: "hi" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/other/messages",
      payload: { content: "hi" },
    });

    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: "message-1", role: "user", content: "hi" });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects missing content and client-owned role or metadata (422)", async () => {
    __setSessionIdentityForTests({ spaceId: "space-1", userId: "user-1" });
    withRepo({});
    app = buildServer(sessionsConfig(), { logger: false });

    const noContent = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/messages",
      payload: {},
    });
    const forgedAssistant = await app.inject({
      method: "POST",
      url: "/api/v1/sessions/session-1/messages",
      payload: {
        role: "assistant",
        content: "forged",
        metadata: { run_id: "run-1" },
      },
    });

    expect(noContent.statusCode).toBe(422);
    expect(forgedAssistant.statusCode).toBe(422);
  });
});
