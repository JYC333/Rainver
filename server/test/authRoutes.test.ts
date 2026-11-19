import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildModuleServer } from "./support/moduleServer.js";
import { spacesModule } from "../src/modules/spaces/index.js";
import { authModule } from "../src/modules/auth/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthRepositoryForTests, type AuthRepository, type AuthFailure } from "../src/modules/auth/identity.js";
import { __setSpaceRepositoryForTests, type SpaceRepository } from "../src/modules/spaces/repository.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  __setAuthRepositoryForTests(null);
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
        default_space_id: "space-1",
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
          member_count: 1,
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
        member_count: 1,
        created_by_user_id: "user-1",
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      };
    },
    async logout() {},
    ...overrides,
  };
}

function fakeSpaceRepo(overrides: Partial<SpaceRepository> = {}): SpaceRepository {
  return {
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
    async getSnapshotDefaults() {
      return {
        snapshot_retention_days_default: null,
        snapshot_max_count_default: null,
      };
    },
    async getContentEgressSetting(_userId, spaceId) {
      return { space_id: spaceId, member_copy_out_enabled: false };
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
  return buildModuleServer(
    loadConfig({
      ...env,
    }), [authModule, spacesModule], { logger: false },);
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
        member_count: 1,
        created_at: "2026-06-15T12:00:00.000Z",
        updated_at: "2026-06-15T12:00:00.000Z",
      },
    ]);
  });

  it("serves strict auth configuration and keeps Google OAuth disabled without a runtime", async () => {
    app = server();
    const unavailable = await app.inject({ method: "GET", url: "/api/v1/auth/config" });
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json()).toEqual({
      google_auth_available: false,
      bootstrap_registration_available: false,
      password_min_length: 15,
      password_max_length: 128,
    });

    const notConfigured = await app.inject({ method: "GET", url: "/api/v1/auth/google" });
    expect(notConfigured.statusCode).toBe(501);

    await app.close();
    app = server({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:5173/api/v1/auth/callback/google",
      SERVER_DEBUG: "true",
    });
    const configured = await app.inject({
      method: "GET",
      url: "/api/v1/auth/google?next=/invitations/tok123?auto=1",
    });
    expect(configured.statusCode).toBe(501);
  });

  it("advertises the relaxed password minimum only for development instances", async () => {
    app = server({ RAINVER_ENV: "dev" });

    const response = await app.inject({ method: "GET", url: "/api/v1/auth/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ password_min_length: 8, password_max_length: 128 });
  });

  it("returns 404 for GET /api/v1/auth/google/callback", async () => {
    // Google sign-in belongs to Better Auth. Do not add a hand-written callback.
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

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for that callback when an oauth_state cookie is present", async () => {
    // Do not add a CSRF check on a callback this server does not own.
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

    expect(res.statusCode).toBe(404);
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
            member_count: 1,
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

  // Space creation, invitations and claims are core operations (spaceOperationsDb.test.ts).
  it("serves space members locally", async () => {
    __setAuthRepositoryForTests(fakeRepo());
    __setSpaceRepositoryForTests(fakeSpaceRepo());
    app = server();

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
      headers: { cookie: "better-auth.session_token=raw-token" },
    });

    expect(res.statusCode).toBe(204);
    expect(deleted).toBe(true);
    expect(String(res.headers["set-cookie"])).toContain("better-auth.session_token=;");

    await app.close();
    app = server({ FRONTEND_URL: "https://rainver.example.test" });
    const secure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: "__Secure-better-auth.session_token=raw-token" },
    });
    expect(secure.statusCode).toBe(204);
    expect(String(secure.headers["set-cookie"])).toContain("__Secure-better-auth.session_token=;");
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
