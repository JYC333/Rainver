import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthRepositoryForTests, type AuthRepository } from "../src/modules/auth/identity.js";
import type { CurrentUser } from "../src/modules/auth/identity.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

/** A daemon's whole hello, as `helloInfo()` sends it; the wire requires all of it. */
const HELLO_INFO = {
  platform: "linux",
  arch: "x64",
  daemon_version: "0.1.0",
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
    findOrCreateFromGoogle: notImplemented,
  } as unknown as AuthRepository;
}

function authCookie(token: string): string {
  return `session_id=${token}`;
}

function httpBaseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("server is not listening on a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [hostsModule]);
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(() => {
  __setAuthRepositoryForTests(null);
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "agent_versions", "agents", "hosts", "projects", "spaces", "users"],
    { cascade: true },
  );
  await db.pool.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Owner', 'active', now(), now()), ($2, 'Other', 'active', now(), now())`,
    [OWNER, OTHER_USER],
  );
});

describe("hosts routes", () => {
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
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64", daemon_version: "0.1.0" },
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
      `INSERT INTO agent_versions (id, agent_id, space_id, version_label, system_prompt, model_config_json, runtime_config_json, context_policy_json, memory_policy_json, capabilities_json, tool_permissions_json, runtime_policy_json, created_at)
       VALUES ('upload-agent-version', 'upload-agent', 'upload-space', 'v1', 'x', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
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
    const runId = "upload-run-1";
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, workspace_location_id, adapter_type, owner_user_id, created_at, updated_at)
       VALUES ($1, 'upload-space', 'upload-agent', 'upload-agent-version', 'agent', 'manual', 'succeeded', 'live', $2, 'claude_code', $3, $4, $4)`,
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

  it("keeps the control-plane address the daemon reports, so a proxy address can be derived", async (ctx) => {
    // The daemon sends `server_url` because the server cannot guess an address
    // a paired machine can resolve. Dropping it at this wire boundary is
    // silent: every provider-bound run on the host then fails dispatch with
    // provider_proxy_not_reachable, and nothing upstream looks broken.
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
      payload: { pairing_code: pairingCode, ...HELLO_INFO, platform: "linux", arch: "x64" },
    });
    const { token } = register.json();

    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          token,
          ...HELLO_INFO,
          platform: "linux",
          arch: "x64",
          daemon_version: "0.1.0",
          server_url: "http://laptop.local:3000",
        }));
      });
      socket.addEventListener("message", () => resolve(), { once: true });
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });

    const row = await db.pool.query("SELECT daemon_server_url FROM hosts WHERE id = $1", [hostId]);
    expect(row.rows[0]?.daemon_server_url).toBe("http://laptop.local:3000");

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

    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    const helloAck = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, platform: "linux", arch: "x64", daemon_version: "0.1.0" }));
      });
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });
    expect(helloAck).toMatchObject({ type: "hello_ack", host_id: hostId });
    // The daemon asks each runtime for its options exactly as the adapter
    // spec launches it, so the spec is the only place a runtime is added.
    const probes = helloAck.runtime_probes as Array<{ adapter_type: string; runtime: string | null; argv: string[]; login: unknown }>;
    expect(probes.map((probe) => probe.runtime).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(probes.find((probe) => probe.runtime === "opencode")).toMatchObject({
      adapter_type: "opencode",
      argv: ["opencode", "acp", "--cwd", "rainver:remote-workspace-cwd"],
      login: { command: ["opencode", "auth", "login"], home_subdir: ".local/share/opencode", credential_file: "auth.json" },
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
          options: { config_options: [{
            id: "model", name: "Model", description: null, category: "model", type: "select",
            current_value: "sonnet",
            options: [{ value: "sonnet", name: "Sonnet", description: null, group: null }],
          }] },
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
      expect.objectContaining({ adapter_type: "opencode" }),
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

    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, platform: "linux", arch: "x64", daemon_version: "0.1.0" }));
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

  it("rejects a WebSocket hello with an invalid token and a heartbeat before hello", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    const rejection = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token: "not-a-real-token", ...HELLO_INFO })));
      socket.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      socket.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    });
    expect(rejection.frame).toMatchObject({ type: "error", detail: "invalid_token" });
    expect(rejection.code).toBe(1008);

    const socket2 = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    const beforeHello = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      socket2.addEventListener("open", () => socket2.send(JSON.stringify({ type: "heartbeat", ...HELLO_INFO })));
      socket2.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      socket2.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    });
    expect(beforeHello.frame).toMatchObject({ type: "error", detail: "not_authenticated" });
    expect(beforeHello.code).toBe(1008);
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
    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
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

    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    const rejection = await new Promise<{ frame: Record<string, unknown>; code: number }>((resolve, reject) => {
      let frame: Record<string, unknown> | undefined;
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token: pairingCode, ...HELLO_INFO })));
      socket.addEventListener("message", (event) => {
        frame = JSON.parse(String(event.data));
      });
      socket.addEventListener("close", (event) => resolve({ frame: frame ?? {}, code: event.code }));
      setTimeout(() => reject(new Error("timed out waiting for close")), 5000);
    });
    expect(rejection.frame).toMatchObject({ type: "error", detail: "invalid_token" });
    expect(rejection.code).toBe(1008);
  });
});
