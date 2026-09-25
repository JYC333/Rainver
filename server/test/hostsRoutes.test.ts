import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { resolveHostApiBaseUrl } from "../src/modules/runs/runWorkSurface.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";
import type { CurrentUser } from "../src/modules/auth/identity.js";
import { ensureDefaultRuntimeProfile, seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";
import { __resetHostRegisterRateLimitForTests, HOST_REGISTER_MAX_ATTEMPTS } from "../src/modules/hosts/pairingRateLimit.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { SERVER_OPENCODE_RELEASE } from "../src/modules/runtimeAdapters/opencodeRelease.js";
import { MIN_HOST_DAEMON_VERSION } from "../src/modules/hosts/daemonCompatibility.js";
import { supportsRuntimeBackendMode } from "../src/modules/runtimeAdapters/runtimeDefinitions.js";

/** A daemon's whole hello, as `helloInfo()` sends it; the wire requires all of it. */
const HELLO_INFO = {
  platform: "linux",
  arch: "x64",
  daemon_version: MIN_HOST_DAEMON_VERSION,
  environment_kind: "linux_native",
  capabilities_json: {},
  workspace_reports: [],
  managed_workspaces: [],
  ambient_sessions: [],
};

// Real-Postgres coverage for the hosts HTTP surface (pairing-code issue ->
// daemon register -> owner-scoped list -> revoke). Auth identity resolution
// is stubbed (a fixed bearer-token -> user map), matching this route's own
// `getCurrentUser`/`sessionTokenFromRequest` pattern (mirrors `spaces`
// routes, which is the correct pattern for a user-scoped, not
// Space-scoped, resource) — hosts persistence itself stays on the real
// test-Postgres container, per this repo's real-DB testing policy.

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_TOKEN = "owner-session-token";
const OTHER_TOKEN = "other-session-token";

let app: FastifyInstance | undefined;

function stubAuth(): AuthRepository {
  const users: Record<string, CurrentUser> = {
    [OWNER_TOKEN]: {
      id: OWNER,
      email: null,
      display_name: "Owner",
      avatar_url: null,
      is_instance_admin: false,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
    [OTHER_TOKEN]: {
      id: OTHER_USER,
      email: null,
      display_name: "Other",
      avatar_url: null,
      is_instance_admin: false,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
  };
  const notImplemented = () => {
    throw new Error("not implemented in this fake — hosts routes only call getCurrentUser");
  };
  return {
    resolveIdentity: notImplemented,
    async getCurrentUser(sessionToken?: string) {
      const user = sessionToken ? users[sessionToken] : undefined;
      if (!user) return { statusCode: 401, detail: "Not authenticated" };
      return user;
    },
    getUserSpaces: notImplemented,
    getSpaceForUser: notImplemented,
    logout: notImplemented,
  } as unknown as AuthRepository;
}

function authCookie(token: string): string {
  return `better-auth.session_token=${token}`;
}

function httpBaseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function hostSocket(token?: string): WebSocket {
  const url = `${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`;
  if (!token) return new WebSocket(url);
  return new (WebSocket as unknown as {
    new (url: string, init: { headers: Record<string, string> }): WebSocket;
  })(url, { headers: { Authorization: `Bearer ${token}` } });
}

const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  // "localhost" is the trusted proxy, so forwarded headers from inject() and the
  // test's own socket are believed — a callback address that ignores them has
  // to ignore them even then.
  app = buildModuleServer(loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_TRUSTED_PROXY_HOST: "localhost",
    INSTANCE_ADMIN_EMAIL: "instance-admin@example.test",
  }), [hostsModule]);
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  __resetHostRegisterRateLimitForTests();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "agent_versions", "agents", "hosts", "projects", "spaces", "users"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Owner', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system'), ($2, 'Other', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`,
    [OWNER, OTHER_USER],
  );
});

describe("hosts routes", () => {
  it("lets ordinary members read Server Runtime health but forbids them from retrying provisioning", async (ctx) => {
    if (!db.available || !app || !db.pool) return ctx.skip();
    const hostId = await new PgHostRepository(db.pool).ensureServerHostId();
    __setAuthIdentityForTests({ spaceId: "host-route-space", userId: OTHER_USER });

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/hosts/${hostId}/runtime-provisioning/opencode`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      host_id: hostId,
      runtime_key: "opencode",
      installation: { state: "queued" },
    });

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/runtime-provisioning/opencode/retry`,
    });
    expect(retry.statusCode).toBe(403);
    expect(retry.json()).toMatchObject({ detail: "Managing the built-in host requires instance admin" });
    expect((await db.pool.query(
      `SELECT 1 FROM host_runtime_provisioning WHERE host_id = $1 AND runtime_key = 'opencode'`,
      [hostId],
    )).rowCount).toBe(0);
  });

  it("reports each runtime's backend-mode support from the registry the server enforces", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    // The composer gates ModelProvider mode on this row. Derived from anything
    // other than the AgentRuntimeDefinition, it offered a mode that Profile
    // admission (`supportsRuntimeBackendMode`) then answered with 422.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/runtime-definitions",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    for (const item of items) {
      expect(item).not.toHaveProperty("provider_binding");
      expect(item).toMatchObject({
        supports_runtime_native: supportsRuntimeBackendMode(String(item.runtime_key), "runtime_native"),
        supports_model_provider: supportsRuntimeBackendMode(String(item.runtime_key), "model_provider"),
      });
    }
    expect(items.find((item) => item.runtime_key === "opencode")).toMatchObject({ supports_model_provider: true });
    expect(items.find((item) => item.runtime_key === "claude_code")).toMatchObject({ supports_model_provider: false });
  });

  it("rejects pairing-code issuance without a session", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const response = await app.inject({ method: "POST", url: "/api/v1/hosts/pairing-codes", payload: { name: "Desktop" } });
    expect(response.statusCode).toBe(401);
  });

  it("runs the full pairing -> register -> list -> revoke flow", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());

    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Desktop" },
    });
    expect(issue.statusCode).toBe(201);
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    expect(hostId).toBeTruthy();
    expect(pairingCode).toBeTruthy();

    // No session cookie at all — the daemon authenticates with the pairing
    // code itself, not a user session.
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    expect(register.statusCode).toBe(201);
    expect(register.json()).toMatchObject({ host_id: hostId, name: "Desktop" });

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO },
    });
    expect(reuse.statusCode).toBe(401);

    const listAsOwner = await app.inject({
      method: "GET",
      url: "/api/v1/hosts",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(listAsOwner.statusCode).toBe(200);
    const ownerItems = listAsOwner.json().items as Array<{ id: string; kind: string }>;
    expect(ownerItems.some((h) => h.id === hostId)).toBe(true);
    expect(ownerItems.some((h) => h.kind === "server")).toBe(true);

    const listAsOther = await app.inject({
      method: "GET",
      url: "/api/v1/hosts",
      headers: { cookie: authCookie(OTHER_TOKEN) },
    });
    expect(listAsOther.statusCode).toBe(200);
    const otherItems = listAsOther.json().items as Array<{ id: string }>;
    expect(otherItems.some((h) => h.id === hostId)).toBe(false);

    const revokeAsOther = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/revoke`,
      headers: { cookie: authCookie(OTHER_TOKEN) },
    });
    expect(revokeAsOther.statusCode).toBe(404);

    const revokeAsOwner = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/revoke`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(revokeAsOwner.statusCode).toBe(204);
  });

  it("rejects an unknown pairing code at registration", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: "bogus", ...HELLO_INFO },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rate-limits unauthenticated host registration attempts", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    for (let i = 0; i < HOST_REGISTER_MAX_ATTEMPTS; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/hosts/register",
        payload: { pairing_code: "bogus", ...HELLO_INFO },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: "bogus", ...HELLO_INFO },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "host_register_rate_limited" });
  });

  it("lets a bearer-authenticated host revoke itself and invalidates that token", async (ctx) => {
    if (!db.available || !app || !db.pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Self Unregistering Host" },
    });
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: issue.json().pairing_code, ...HELLO_INFO },
    });
    const { host_id: hostId, token } = register.json();

    const noAuth = await app.inject({ method: "POST", url: "/api/v1/hosts/me/revoke" });
    expect(noAuth.statusCode).toBe(401);

    const revoke = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/revoke",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(204);

    const row = await db.pool.query("SELECT status, token_hash FROM hosts WHERE id = $1", [hostId]);
    expect(row.rows[0]).toMatchObject({ status: "revoked", token_hash: null });
    const reuse = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("registers, lists, and removes a daemon-registered workspace by host bearer token", async (ctx) => {
    if (!db.available || !app || !db.pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('workspace-space', 'Space', 'household', $1, now(), now())`,
      [OWNER],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ('workspace-project', 'workspace-space', $1, 'Project', 'active', now(), now())`,
      [OWNER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);

    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Laptop" },
    });
    const { pairing_code: pairingCode } = issue.json();
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO },
    });
    const { token: hostToken } = register.json();

    const noAuth = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      payload: { project_id: "workspace-project", name: "mapping" },
    });
    expect(noAuth.statusCode).toBe(401);

    const notWriter = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { project_id: "no-such-project", name: "mapping" },
    });
    expect(notWriter.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { project_id: "workspace-project", name: "mapping", display_path: "~/dev/mapping" },
    });
    expect(created.statusCode).toBe(201);
    const folder = created.json();
    expect(folder).toMatchObject({
      host_kind: "remote",
      root_path: null,
      display_path: "~/dev/mapping",
      registered_from: "daemon_registered",
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostToken}` },
      payload: { project_id: "workspace-project", name: "mapping" },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/v1/hosts/me/workspaces/${folder.id}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(remove.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(listAfter.json().items).toHaveLength(0);
  });

  it("never lets one host's token list, create in, or remove another host's workspace", async (ctx) => {
    if (!db.available || !app || !db.pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('cross-host-space', 'Space', 'household', $1, now(), now())`,
      [OWNER],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ('cross-host-project', 'cross-host-space', $1, 'Project', 'active', now(), now())`,
      [OWNER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);

    async function pairAndRegister(name: string): Promise<string> {
      const issue = await app!.inject({
        method: "POST",
        url: "/api/v1/hosts/pairing-codes",
        headers: { cookie: authCookie(OWNER_TOKEN) },
        payload: { name },
      });
      const register = await app!.inject({
        method: "POST",
        url: "/api/v1/hosts/register",
        payload: { pairing_code: issue.json().pairing_code, ...HELLO_INFO },
      });
      return register.json().token as string;
    }

    const tokenA = await pairAndRegister("Host A");
    const tokenB = await pairAndRegister("Host B");

    const createdOnA = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { project_id: "cross-host-project", name: "only-on-a" },
    });
    expect(createdOnA.statusCode).toBe(201);
    const folderOnA = createdOnA.json();

    // Host B's token must see none of Host A's workspaces.
    const listFromB = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(listFromB.json().items).toHaveLength(0);

    // Host B's token must not be able to remove Host A's workspace.
    const removeFromB = await app.inject({
      method: "DELETE",
      url: `/api/v1/hosts/me/workspaces/${folderOnA.id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(removeFromB.statusCode).toBe(404);

    // The workspace is still there, and only Host A's own token can remove it.
    const listFromA = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(listFromA.json().items).toHaveLength(1);
    const removeFromA = await app.inject({
      method: "DELETE",
      url: `/api/v1/hosts/me/workspaces/${folderOnA.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(removeFromA.statusCode).toBe(204);
  });

  it("rejects a raw (unexchanged) pairing code presented as a bearer token", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Never Exchanged" },
    });
    const { pairing_code: pairingCode } = issue.json();

    const asBearerToken = await app.inject({
      method: "GET",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${pairingCode}` },
    });
    expect(asBearerToken.statusCode).toBe(401);
  });

  it("uploads a diff/output for a Run bound to the caller's own workspace, and rejects another host's token (ADR 0016 D7)", async (ctx) => {
    if (!db.available || !app || !db.pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
       VALUES ('upload-space', 'Space', 'household', $1, now(), now())`,
      [OWNER],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
       VALUES ('upload-project', 'upload-space', $1, 'Project', 'active', now(), now())`,
      [OWNER],
    );
    await seedMainlineRoomsForAllProjects(db.pool);
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
       VALUES ('upload-agent', 'upload-space', NULL, 'Agent', 'active', 'standard', 'space_shared', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, created_at)
       VALUES ('upload-agent-version', 'upload-agent', 'upload-space', 'v1', 'x', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, now())`,
    );

    async function pairAndRegister(name: string): Promise<{ hostId: string; token: string }> {
      const issue = await app!.inject({
        method: "POST",
        url: "/api/v1/hosts/pairing-codes",
        headers: { cookie: authCookie(OWNER_TOKEN) },
        payload: { name },
      });
      const register = await app!.inject({
        method: "POST",
        url: "/api/v1/hosts/register",
        payload: { pairing_code: issue.json().pairing_code, ...HELLO_INFO },
      });
      const body = register.json();
      return { hostId: body.host_id as string, token: body.token as string };
    }

    const hostA = await pairAndRegister("Upload Host A");
    const hostB = await pairAndRegister("Upload Host B");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/me/workspaces",
      headers: { authorization: `Bearer ${hostA.token}` },
      payload: { project_id: "upload-project", name: "mapping" },
    });
    const locationId = created.json().id as string;
    await ensureDefaultRuntimeProfile(db.pool, {
      agent: "upload-agent",
      space: "upload-space",
      runtimeKey: "claude_code",
      executionHostId: hostA.hostId,
      workspaceLocationId: locationId,
      workspaceMode: "location",
      runtimeInstallation: "managed:1.0.0",
      now,
    });
    const runId = "upload-run-1";
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, workspace_location_id, owner_user_id, created_at, updated_at, execution_kind, runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json)
       VALUES ($1, 'upload-space', 'upload-agent', 'upload-agent-version', 'agent', 'manual', 'succeeded', 'live', $2, $3, $4, $4, 'agent', (SELECT p.id FROM agent_runtime_profiles p WHERE p.space_id = 'upload-space' AND p.agent_id = 'upload-agent' AND p.is_default = TRUE), 'default', (SELECT p.runtime_key FROM agent_runtime_profiles p WHERE p.space_id = 'upload-space' AND p.agent_id = 'upload-agent' AND p.is_default = TRUE), (SELECT jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key, 'backend_mode', p.backend_mode, 'model_provider_id', p.model_provider_id, 'model_name', p.model_name, 'runtime_config_json', p.runtime_config_json, 'runtime_policy_json', p.runtime_policy_json) FROM agent_runtime_profiles p WHERE p.space_id = 'upload-space' AND p.agent_id = 'upload-agent' AND p.is_default = TRUE))`,
      [runId, locationId, OWNER, now],
    );

    const diffFromB = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/me/runs/${runId}/diff`,
      headers: { authorization: `Bearer ${hostB.token}` },
      payload: { diff: "diff --git a/x b/x\n" },
    });
    expect(diffFromB.statusCode).toBe(404);

    const diffFromA = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/me/runs/${runId}/diff`,
      headers: { authorization: `Bearer ${hostA.token}` },
      payload: { diff: "diff --git a/x b/x\n+hello\n" },
    });
    expect(diffFromA.statusCode).toBe(201);
    expect(diffFromA.json().artifact_id).toBeTruthy();

    const outputsFromA = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/me/runs/${runId}/outputs`,
      headers: { authorization: `Bearer ${hostA.token}` },
      payload: { files: [{ name: "report.md", content: "# done" }] },
    });
    expect(outputsFromA.statusCode).toBe(201);
    expect(outputsFromA.json().artifact_ids).toHaveLength(1);

    const noAuth = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/me/runs/${runId}/diff`,
      payload: { diff: "diff --git a/x b/x\n" },
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it("hands a paired host FRONTEND_URL whatever the daemon or the request claims", async (ctx) => {
    // Where a Run's children send their bearer token is configuration. A
    // daemon's own `server_url` and a request's forwarded host are attested by
    // someone else; neither may move it.
    if (!db.available || !app || !db.pool) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Reporting Box" },
    });
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    const socket = hostSocket(token);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          token,
          ...HELLO_INFO,
          platform: "linux",
          arch: "x64",
          server_url: "http://laptop.local:3000",
        }));
      });
      socket.addEventListener("message", () => resolve(), { once: true });
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });

    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    expect(await resolveHostApiBaseUrl(db.pool, config, hostId)).toBe(new URL(config.frontendUrl).origin);

    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
    socket.close();
    await closed;
  });

  it("authenticates a real WebSocket hello and records a heartbeat (phase 1 wire contract)", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "WS Box" },
    });
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    const socket = hostSocket(token);
    const helloAck = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, platform: "linux", arch: "x64" }));
      });
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });
    expect(helloAck).toMatchObject({ type: "hello_ack", host_id: hostId });
    // The daemon asks each runtime for its options exactly as the adapter
    // spec launches it, so the spec is the only place a runtime is added.
    const probes = helloAck.runtime_probes as Array<{ runtime_key: string; runtime: string | null; argv: string[]; login: unknown }>;
    expect(probes.every((probe) => typeof probe.runtime_key === "string" && probe.runtime_key.length > 0)).toBe(true);
    expect(probes.some((probe) => "adapter_type" in probe)).toBe(false);
    expect(probes.map((probe) => probe.runtime).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(probes.find((probe) => probe.runtime === "opencode")).toMatchObject({
      runtime_key: "opencode",
      argv: ["opencode", "acp", "--cwd", "rainver:remote-workspace-cwd"],
      login: { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json" },
      // A paired Host installs what the ACP registry publishes, never the
      // Server's release pin. The registry refresh has not run here, so it is
      // told there is nothing to install rather than handed the pin.
      distribution: null,
      version: null,
    });
    expect(probes.find((probe) => probe.runtime === "codex")?.argv).toEqual(["codex-acp"]);

    // Daemon and server use the current installation/configOptions contract
    // directly; obsolete heartbeat layouts are not projected forward.
    socket.send(JSON.stringify({
      type: "heartbeat", ...HELLO_INFO,
      capabilities_json: {
        runtimes: ["claude", "git"],
        versions: { claude: "2.1.0", git: "git version 2.44" },
        installations: {
          claude_code: [{
            id: "own", version: "2.1.0", logged_in: true,
            runtime_version: "2.1.0",
            options: { config_options: [{
              id: "model", name: "Model", description: null, category: "model", type: "select",
              current_value: "sonnet",
              options: [{ value: "sonnet", name: "Sonnet", description: null, group: null }],
            }] },
          }],
        },
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterHello = await app.inject({
      method: "GET",
      url: "/api/v1/hosts",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    const stored = (afterHello.json().items as Array<{ id: string; capabilities_json: Record<string, unknown> }>).find((h) => h.id === hostId)!.capabilities_json;
    expect(stored).toEqual({
      runtimes: ["claude", "git"],
      versions: { claude: "2.1.0", git: "git version 2.44" },
      installations: {
        claude_code: [{
          id: "own", version: "2.1.0", logged_in: true,
          runtime_version: "2.1.0",
          health_check_protocol: null,
          // The version this copy could be rolled back to, carried through
          // normalization — the host card's rollback button reads it, and a
          // field dropped here is a field the product never sees. Null for the
          // machine's own copy, which the daemon never upgrades.
          rollback_version: null,
          // Whether this runtime has a subscription to read at all, stated by
          // the control plane so the host card does not keep a second copy of
          // that list in step.
          reports_subscription_quota: true,
            options: {
              config_options: [{
                id: "model", name: "Model", description: null, category: "model", type: "select",
                current_value: "sonnet",
                options: [{ value: "sonnet", name: "Sonnet", description: null, group: null }],
              }],
              auth_methods: [],
              cli_login_available: false,
              session_available: null,
              prompt_capabilities: null,
            },
        }],
      },
    });
    const onlineHost = (afterHello.json().items as Array<{ id: string; status: string }>).find((h) => h.id === hostId);
    expect(onlineHost?.status).toBe("online");

    const heartbeatAck = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
      socket.send(JSON.stringify({ type: "heartbeat", ...HELLO_INFO }));
      setTimeout(() => reject(new Error("timed out waiting for heartbeat_ack")), 5000);
    });
    expect(heartbeatAck).toMatchObject({ type: "heartbeat_ack" });
    expect(heartbeatAck.runtime_probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_key: "opencode" }),
    ]));

    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
    socket.close();
    await closed;

    // The client's own "close" event fires independently of the server
    // finishing its close handler's `markOffline` write — poll briefly
    // rather than assuming synchronization the WebSocket protocol doesn't
    // provide. Server-side close handling marks the host offline well
    // before the heartbeat-staleness window would.
    let offlineStatus: string | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const afterClose = await app.inject({
        method: "GET",
        url: "/api/v1/hosts",
        headers: { cookie: authCookie(OWNER_TOKEN) },
      });
      offlineStatus = (afterClose.json().items as Array<{ id: string; status: string }>).find((h) => h.id === hostId)?.status;
      if (offlineStatus === "offline") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(offlineStatus).toBe("offline");
  });

  it("tells the built-in Server Host's daemon to install the release-pinned OpenCode", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const hosts = new PgHostRepository(db.pool);
    const serverHostId = await hosts.ensureServerHostId();
    const token = await hosts.rotateBuiltinHostToken(serverHostId);

    const socket = hostSocket(token);
    const helloAck = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, environment_kind: "server" }));
      });
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });
    expect(helloAck).toMatchObject({ type: "hello_ack", host_id: serverHostId });

    // Which copy a machine installs is resolved once, in the probe, by the
    // host's kind: this daemon is the Server Runtime, so it is told the
    // version this Rainver release pins (ADR 0022, Phase 2 §1).
    const probes = helloAck.runtime_probes as Array<Record<string, unknown>>;
    expect(probes.find((probe) => probe.runtime_key === "opencode")).toMatchObject({
      version: SERVER_OPENCODE_RELEASE.version,
      distribution: SERVER_OPENCODE_RELEASE.distribution,
    });

    // The same answer on every refresh, not only at hello.
    const heartbeatAck = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))), { once: true });
      socket.send(JSON.stringify({ type: "heartbeat", ...HELLO_INFO, environment_kind: "server" }));
      setTimeout(() => reject(new Error("timed out waiting for heartbeat_ack")), 5000);
    });
    expect(heartbeatAck.runtime_probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime_key: "opencode", version: SERVER_OPENCODE_RELEASE.version }),
    ]));

    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
    socket.close();
    await closed;
  });

  it("closes an already-connected daemon's live WebSocket immediately on revoke, instead of only blocking its next reconnect", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Revoke While Connected" },
    });
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    const socket = hostSocket(token);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, platform: "linux", arch: "x64" }));
      });
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "hello_ack") resolve();
      });
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });

    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/revoke`,
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    expect(revoke.statusCode).toBe(204);

    const closeCode = await Promise.race([
      closed,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("socket was not closed by revoke")), 5000)),
    ]);
    expect(closeCode).toBe(1008);
  });

  it("rejects a WebSocket upgrade without a host bearer, a heartbeat before hello, and a mismatched hello token", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "WS Auth Box" },
    });
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: issue.json().pairing_code, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    // The *answer*, not merely "it did not open": an `error`-or-`close` assertion
    // is satisfied by a crash, a refused connection, or the server being gone,
    // so it could not tell a refusal from an outage. The upgrade must be
    // answered 401.
    const unauthenticated = await app!.inject({
      method: "GET",
      url: "/internal/hosts/ws",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
      },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const socket = hostSocket(token);
    const beforeHello = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "heartbeat", ...HELLO_INFO })));
      socket.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      socket.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    });
    expect(beforeHello.frame).toMatchObject({ type: "error", detail: "not_authenticated" });
    expect(beforeHello.code).toBe(1008);

    const mismatch = hostSocket(token);
    const rejection = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      mismatch.addEventListener("open", () => mismatch.send(JSON.stringify({ type: "hello", token: "not-a-real-token", ...HELLO_INFO })));
      mismatch.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      mismatch.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    });
    expect(rejection.frame).toMatchObject({ type: "error", detail: "invalid_token" });
    expect(rejection.code).toBe(1008);
  });

  /**
   * The wire is versioned by the daemon, not per frame: a daemon from before
   * the `adapter_type` -> `runtime_key` rename reads `runtime_key` as absent
   * and silently falls back to the raw argv command, so every Run it accepts
   * fails for a reason that names neither the daemon nor the rename. The
   * host is refused at hello instead, and stays offline with the version it
   * reported recorded beside it.
   */
  it("refuses a hello from a daemon below the minimum version and leaves the host offline", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Lagging Daemon Host" },
    });
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    const socket = hostSocket(token);
    const rejection = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, daemon_version: "0.1.0" }));
      });
      socket.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      socket.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for the outdated-daemon rejection")), 5000);
    });
    expect(rejection.frame.type).toBe("error");
    expect(String(rejection.frame.detail)).toContain("daemon_outdated");
    expect(String(rejection.frame.detail)).toContain(MIN_HOST_DAEMON_VERSION);
    expect(rejection.code).toBe(1008);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/hosts",
      headers: { cookie: authCookie(OWNER_TOKEN) },
    });
    const host = (listed.json().items as Array<Record<string, unknown>>).find((item) => item.id === hostId);
    expect(host).toMatchObject({ status: "offline", daemon_version: "0.1.0" });

    // A daemon at the floor is admitted on the same host, so the gate is the
    // version and not the host.
    const current = hostSocket(token);
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      current.addEventListener("open", () => current.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO })));
      current.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
      current.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });
    expect(ack).toMatchObject({ type: "hello_ack", host_id: hostId });
    const closed = new Promise<void>((resolve) => current.addEventListener("close", () => resolve()));
    current.close();
    await closed;
  });

  it("rejects a second WebSocket hello instead of switching the connection identity", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "Single Hello Host" },
    });
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/register",
      payload: { pairing_code: issue.json().pairing_code, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();
    const socket = hostSocket(token);
    const rejection = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      let helloAcked = false;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO })));
      socket.addEventListener("message", (event) => {
        const next = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (next.type === "hello_ack" && !helloAcked) {
          helloAcked = true;
          socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO }));
          return;
        }
        frame = next;
      });
      socket.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for duplicate hello rejection")), 5000);
    });
    expect(rejection.frame).toMatchObject({ type: "error", detail: "hello_already_processed" });
    expect(rejection.code).toBe(1008);
  });

  it("rejects a WebSocket hello presenting a raw (unexchanged) pairing code as the token", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    __setAuthRepositoryForTests(stubAuth());
    const issue = await app.inject({
      method: "POST",
      url: "/api/v1/hosts/pairing-codes",
      headers: { cookie: authCookie(OWNER_TOKEN) },
      payload: { name: "WS Pairing Only" },
    });
    const { pairing_code: pairingCode } = issue.json();

    const socket = hostSocket(pairingCode);
    const failed = await new Promise<boolean>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(false));
      socket.addEventListener("error", () => resolve(true));
      socket.addEventListener("close", () => resolve(true));
      setTimeout(() => reject(new Error("timed out waiting for pairing-code upgrade to fail")), 5000);
    });
    expect(failed).toBe(true);
  });
});
