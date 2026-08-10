import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { loadConfig } from "../src/config";
import {
  __setGoogleOAuthClientForTests,
  __setAuthRepositoryForTests,
  type AuthRepository,
  type AuthFailure,
  type GoogleOAuthClient,
} from "../src/modules/auth";
import {
  __setSpaceRepositoryForTests,
  type SpaceRepository,
} from "../src/modules/spaces";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
  __setGoogleOAuthClientForTests(null);
  __setSpaceRepositoryForTests(null);
  await app?.close();
  app = undefined;
});

function fakeRepo(overrides: Partial<AuthRepository> = {}): AuthRepository {
  return {
    async resolveIdentity() {
      return { ok: true, spaceId: "space-1", userId: "user-1" };
    },
    async getCurrentUser() {
      return {
        id: "user-1",
        email: "u@example.test",
        display_name: "User One",
        avatar_url: null,
        created_at: "2026-06-15T12:00:00.000Z",
        last_login_at: null,
        is_instance_admin: false,
      };
    },
    async getUserSpaces() {
      return [
        {
          id: "space-1",
          name: "Personal",
          type: "personal",
          role: "owner",
          oversight_mode: "none",
          egress_notifications_enabled: false,
          created_at: "2026-06-15T12:00:00.000Z",
          updated_at: "2026-06-15T12:00:00.000Z",
        },
      ];
    },
    async getSpaceForUser() {
      return {
        id: "space-1",
        name: "Personal",
        type: "personal",
        role: "owner",
        oversight_mode: "none",
        egress_notifications_enabled: false,
        created_by_user_id: "user-1",
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      };
    },
    async logout() {},
    async findOrCreateFromGoogle() {
      return {
        id: "user-1",
        email: "u@example.test",
        display_name: "User One",
        avatar_url: null,
        created_at: "2026-06-15T12:00:00.000Z",
        last_login_at: null,
        is_instance_admin: false,
      };
    },
    async createSession() {
      return "raw-session";
    },
    ...overrides,
  };
}

function fakeSpaceRepo(overrides: Partial<SpaceRepository> = {}): SpaceRepository {
  return {
    async createSpace(_userId, input) {
      return {
        id: "space-new",
        name: input.name,
        type: input.type ?? "team",
        role: "owner",
        oversight_mode: input.oversight_mode ?? "none",
        egress_notifications_enabled: true,
        created_by_user_id: "user-1",
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      };
    },
    async listMembers() {
      return [
        {
          user_id: "user-1",
          email: "u@example.test",
          display_name: "User One",
          avatar_url: null,
          role: "owner",
          joined_at: "2026-06-15T12:00:00.000Z",
        },
      ];
    },
    async createInvitation(_userId, spaceId, input) {
      return {
        id: "invite-1",
        space_id: spaceId,
        invited_email: input.email,
        role: input.role ?? "member",
        token: "raw-token",
        status: "pending",
        expires_at: "2026-06-22T12:00:00.000Z",
      };
    },
    async acceptInvitation() {
      return { space_id: "space-1", role: "member", space_name: "Team" };
    },
    async getSnapshotDefaults() {
      return {
        snapshot_retention_days_default: null,
        snapshot_max_count_default: null,
      };
    },
    async updateSnapshotDefaults(_userId, _spaceId, data) {
      return data;
    },
    async getRetrievalSettings(_userId, spaceId) {
      return {
        space_id: spaceId,
        default_search_mode: "hybrid",
        rerank_enabled: false,
        query_rewrite_enabled: false,
        query_rewrite_default: false,
        use_query_cache: true,
        include_trace: false,
        external_egress_enabled: true,
        retrieval_tool_mode: "off",
        context_ops_review_mode: "private_only",
        context_ops_scan_mode: "admins",
        embedding_dimensions: 2560,
        max_results_default: 50,
        ranking_config: rankingConfig(),
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      };
    },
    async updateRetrievalSettings(_userId, spaceId, data) {
      return {
        space_id: spaceId,
        default_search_mode: data.default_search_mode ?? "hybrid",
        rerank_enabled: data.rerank_enabled ?? false,
        query_rewrite_enabled: data.query_rewrite_enabled ?? false,
        query_rewrite_default: data.query_rewrite_default ?? false,
        use_query_cache: data.use_query_cache ?? true,
        include_trace: data.include_trace ?? false,
        external_egress_enabled: data.external_egress_enabled ?? true,
        retrieval_tool_mode: data.retrieval_tool_mode ?? "off",
        context_ops_review_mode: data.context_ops_review_mode ?? "private_only",
        context_ops_scan_mode: data.context_ops_scan_mode ?? "admins",
        embedding_dimensions: data.embedding_dimensions ?? 2560,
        max_results_default: data.max_results_default ?? 50,
        ranking_config: data.ranking_config ?? rankingConfig(),
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      };
    },
    ...overrides,
  };
}

function rankingConfig() {
  const mechanic = {
    state: "disabled" as const,
    calibration_artifact_id: null,
    shipped_at: null,
    eval_gate: { status: "not_run" as const, metric: null, value: null, threshold: 0, checked_at: null },
  };
  return {
    version: 1 as const,
    eval_gate: { min_primary_metric_delta: 0, required_evidence_artifacts: 1 },
    mechanics: {
      visible_edge_backlink: mechanic,
      candidate_owned_salience: mechanic,
      richer_dedup: mechanic,
      autocut: mechanic,
      semantic_results_cache: mechanic,
    },
  };
}

function server(env: Record<string, string> = {}): FastifyInstance {
  return buildServer(
    loadConfig({
      ...env,
    }),
    { logger: false },
  );
}

describe("native server auth routes", () => {
  it("serves auth introspection locally", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    app = server();

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/introspect" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ space_id: "space-1", user_id: "user-1" });
  });

  it("passes authentication denials with the public body shape", async () => {
    __setAuthRepositoryForTests(
      fakeRepo({
        async resolveIdentity() {
          return {
            ok: false,
            reason: "denied",
            statusCode: 401,
            body: JSON.stringify({ detail: "Authentication required" }),
          };
        },
      }),
    );
    app = server();

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/introspect" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ detail: "Authentication required" });
  });

  it("serves /me and /me/spaces from the native repository", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    app = server();

    const me = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: "user-1", display_name: "User One" });

    const spaces = await app.inject({ method: "GET", url: "/api/v1/me/spaces" });
    expect(spaces.statusCode).toBe(200);
    expect(spaces.json()).toEqual([
      {
        id: "space-1",
        name: "Personal",
        type: "personal",
        role: "owner",
        oversight_mode: "none",
        egress_notifications_enabled: false,
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      },
    ]);
  });

  it("serves Google OAuth configuration and login locally", async () => {
    app = server();
    const unavailable = await app.inject({ method: "GET", url: "/api/v1/auth/google-configured" });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json()).toEqual({ google_auth_available: false });

    const notConfigured = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    expect(notConfigured.statusCode).toBe(501);

    await app.close();
    app = server({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:5173/api/v1/auth/google/callback",
      SERVER_DEBUG: "true",
    });
    const configured = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google?next=/invitations/tok123?auto=1",
    });
    expect(configured.statusCode).toBe(307);
    expect(configured.headers.location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(configured.headers.location).toContain("client_id=google-client");
    expect(String(configured.headers["set-cookie"])).toContain("oauth_state=");
    expect(String(configured.headers["set-cookie"])).toContain("post_login_next=");
  });

  it("completes the Google OAuth callback, creates a server session, and redirects safely", async () => {
    let createdProfile: unknown;
    let sessionUser = "";
    const googleClient: GoogleOAuthClient = {
      async exchangeCode(_config, code) {
        expect(code).toBe("oauth-code");
        return { access_token: "access-token" };
      },
      async getUserInfo(accessToken) {
        expect(accessToken).toBe("access-token");
        return {
          sub: "google-sub-1",
          email: "new@example.test",
          email_verified: true,
          name: "New User",
          picture: "https://avatar.example/p.png",
        };
      },
    };
    __setGoogleOAuthClientForTests(googleClient);
    __setAuthRepositoryForTests(
      fakeRepo({
        async findOrCreateFromGoogle(input) {
          createdProfile = input;
          return {
            id: "new-user",
            email: input.email,
            display_name: input.displayName,
            avatar_url: input.avatarUrl ?? null,
            created_at: "2026-06-15T12:00:00.000Z",
            last_login_at: "2026-06-15T12:00:00.000Z",
            is_instance_admin: false,
          };
        },
        async createSession(userId) {
          sessionUser = userId;
          return "raw-session";
        },
      }),
    );
    app = server({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      FRONTEND_URL: "http://localhost:5173",
      SERVER_DEBUG: "true",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?state=state-1&code=oauth-code",
      headers: {
        cookie: "oauth_state=state-1; post_login_next=/invitations/tok123?auto=1",
      },
    });

    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("http://localhost:5173/invitations/tok123?auto=1");
    expect(String(res.headers["set-cookie"])).toContain("session_id=raw-session");
    expect(String(res.headers["set-cookie"])).toContain("oauth_state=;");
    expect(createdProfile).toMatchObject({
      googleSub: "google-sub-1",
      email: "new@example.test",
      displayName: "New User",
    });
    expect(sessionUser).toBe("new-user");
  });

  it("rejects OAuth callback CSRF mismatch with the public redirect", async () => {
    app = server({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      FRONTEND_URL: "http://localhost:5173",
      SERVER_DEBUG: "true",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google/callback?state=wrong&code=oauth-code",
      headers: { cookie: "oauth_state=expected" },
    });

    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe("http://localhost:5173/login?error=csrf");
  });

  it("serves API-key routes locally as the canonical feature-gated response", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    app = server();

    for (const req of [
      { method: "GET", url: "/api/v1/auth/keys" },
      { method: "POST", url: "/api/v1/auth/keys", payload: { name: "key" } },
      { method: "DELETE", url: "/api/v1/auth/keys/key-1" },
    ] as const) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(501);
      expect(res.json().detail).toContain("API key storage is not in the canonical schema");
    }
  });

  it("serves GET /spaces/:id and preserves 404 for missing spaces", async () => {
    __setAuthRepositoryForTests(
      fakeRepo({
        async getSpaceForUser(_userId, spaceId) {
          if (spaceId === "missing") return null;
          return {
            id: spaceId,
            name: "Team",
            type: "team",
            role: "admin",
            oversight_mode: "none",
            egress_notifications_enabled: true,
            created_by_user_id: "user-1",
            created_at: "2026-06-15T12:00:00.000Z",
            updated_at: "2026-06-15T12:00:00.000Z",
          };
        },
      }),
    );
    app = server();

    const ok = await app.inject({ method: "GET", url: "/api/v1/spaces/team-1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: "team-1", role: "admin" });

    const missing = await app.inject({ method: "GET", url: "/api/v1/spaces/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ detail: "Space not found" });
  });

  it("serves space create, members, invitations, and accept locally", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    __setSpaceRepositoryForTests(fakeSpaceRepo());
    app = server();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/spaces",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "Team", type: "team", oversight_mode: "content" }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "space-new", role: "owner", oversight_mode: "content" });

    const members = await app.inject({
      method: "GET",
      url: "/api/v1/spaces/space-new/members",
    });
    expect(members.statusCode).toBe(200);
    expect(members.json()).toEqual([
      {
        user_id: "user-1",
        email: "u@example.test",
        display_name: "User One",
        avatar_url: null,
        role: "owner",
        joined_at: "2026-06-15T12:00:00.000Z",
      },
    ]);

    const invite = await app.inject({
      method: "POST",
      url: "/api/v1/spaces/space-new/invitations",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "invitee@example.test", role: "member" }),
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toMatchObject({ token: "raw-token", invited_email: "invitee@example.test" });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/raw-token/accept",
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ space_id: "space-1", role: "member", space_name: "Team" });
  });

  it("serves space retrieval settings locally", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    __setSpaceRepositoryForTests(fakeSpaceRepo());
    app = server();

    const current = await app.inject({
      method: "GET",
      url: "/api/v1/spaces/space-1/retrieval-settings",
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      space_id: "space-1",
      default_search_mode: "hybrid",
      rerank_enabled: false,
      query_rewrite_enabled: false,
      query_rewrite_default: false,
      use_query_cache: true,
      include_trace: false,
      external_egress_enabled: true,
      context_ops_review_mode: "private_only",
      context_ops_scan_mode: "admins",
      embedding_dimensions: 2560,
      max_results_default: 50,
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/spaces/space-1/retrieval-settings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        default_search_mode: "hybrid_rerank",
        rerank_enabled: true,
        query_rewrite_enabled: true,
        query_rewrite_default: true,
        use_query_cache: false,
        include_trace: true,
        external_egress_enabled: false,
        context_ops_review_mode: "members",
        context_ops_scan_mode: "members",
        embedding_dimensions: 768,
        max_results_default: 12,
      }),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      default_search_mode: "hybrid_rerank",
      rerank_enabled: true,
      query_rewrite_enabled: true,
      query_rewrite_default: true,
      use_query_cache: false,
      include_trace: true,
      external_egress_enabled: false,
      context_ops_review_mode: "members",
      context_ops_scan_mode: "members",
      embedding_dimensions: 768,
      max_results_default: 12,
    });

    const immutable = await app.inject({
      method: "PATCH",
      url: "/api/v1/spaces/space-1/retrieval-settings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ oversight_mode: "full" }),
    });
    expect(immutable.statusCode).toBe(422);
    expect(immutable.json()).toEqual({ detail: "oversight_mode is immutable after Space creation" });
  });

  it("serves logout locally and clears the session cookie", async () => {
    let deleted = false;
    __setAuthRepositoryForTests(
      fakeRepo({
        async logout() {
          deleted = true;
        },
      }),
    );
    app = server();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: "session_id=raw-token" },
    });

    expect(res.statusCode).toBe(204);
    expect(deleted).toBe(true);
    expect(String(res.headers["set-cookie"])).toContain("session_id=;");
  });

  it("forwards repository auth failures from /me", async () => {
    const failure: AuthFailure = {
      statusCode: 401,
      detail: "Not authenticated. Sign in with Google.",
    };
    __setAuthRepositoryForTests(
      fakeRepo({
        async getCurrentUser() {
          return failure;
        },
      }),
    );
    app = server();

    const res = await app.inject({ method: "GET", url: "/api/v1/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ detail: failure.detail });
  });
});
