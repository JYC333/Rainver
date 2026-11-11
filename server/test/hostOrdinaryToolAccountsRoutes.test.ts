import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { ordinaryAccountKey } from "../src/modules/hosts/ordinaryToolAccountRoutes.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository, type CurrentUser } from "../src/modules/auth/identity.js";
import { MIN_HOST_DAEMON_VERSION } from "../src/modules/hosts/daemonCompatibility.js";
import { hostCommandHarness, seedHostCommandSpace } from "./support/hostCommandHarness.js";

// Real-Postgres coverage for personal ordinary-tool accounts: who may reach
// whose account, what the daemon is told (a key derived from the session
// user, never a client value), negotiation with older or unsupported daemons,
// and the setup/login stream's lifecycle. The daemon is a real WebSocket
// client; its process handling is `packages/host-daemon/test/ordinaryToolAccounts.test.ts`.

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKENS: Record<string, string> = { [ADMIN]: "admin-session", [OWNER]: "owner-session", [MEMBER]: "member-session" };
const BUILTIN_HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BUILTIN_TOKEN = "builtin-daemon-token";
const NAMES: Record<string, string> = {
  [ordinaryAccountKey(ADMIN)]: "Admin", [ordinaryAccountKey(OWNER)]: "Owner", [ordinaryAccountKey(MEMBER)]: "Member",
};

const TOOLS = {
  protocol: "ordinary-tools-v1",
  tools: [{ tool_id: "lark_cli", status: "available", source: "managed", version: "1.0.99", version_text: "lark-cli version 1.0.99", managed_version: "1.0.99", registered: false, managed_installable: true, managed_catalog_version: "1.0.99" }],
};
const CAPABILITIES = {
  runtimes: [], versions: {}, installations: {}, ordinary_tools: TOOLS,
  ordinary_tool_accounts: { protocol: "ordinary-tool-accounts-v1", supported: true, reason: null },
};

let app: FastifyInstance | undefined;
const db = useTestDatabase(import.meta.filename);
const sockets: WebSocket[] = [];

function user(id: string, email: string): CurrentUser {
  return { id, email, display_name: id, avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), default_space_id: null, last_login_at: null };
}
function asUser(userId: string) {
  __setAuthIdentityForTests({ userId, spaceId: SPACE, sessionToken: TOKENS[userId] } as never);
}
function baseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("not listening on TCP");
  return `http://127.0.0.1:${address.port}`;
}

/** A daemon that answers account frames as the real one would, keyed only by account_key. */
/** `leak`: a daemon that adds token-like fields, which the contract must not let through. */
async function connectDaemon(token: string, capabilities: Record<string, unknown>, leak = false) {
  const socket = new (WebSocket as unknown as { new (url: string, init: { headers: Record<string, string> }): WebSocket })(
    `${baseUrl().replace(/^http/, "ws")}/internal/hosts/ws`, { headers: { Authorization: `Bearer ${token}` } },
  );
  sockets.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "hello", token, platform: "linux", arch: "x64", daemon_version: MIN_HOST_DAEMON_VERSION, environment_kind: "linux_native",
      capabilities_json: capabilities, workspace_reports: [], managed_workspaces: [], ambient_sessions: [],
    })));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "hello_ack") resolve();
      const name = NAMES[String(frame.account_key)] ?? null;
      const signedIn = { state: "signed_in", account: { user_name: name, app_id: "cli_x", brand: "feishu", refresh_pending: false, expires_at: null, refresh_expires_at: null, verified: frame.action === "verify" ? true : null }, reason: null };
      if (frame.type === "ordinary_account_request") {
        socket.send(JSON.stringify({
          type: "ordinary_account_result", request_id: frame.request_id, ok: true, error: null,
          status: frame.action === "logout" ? { state: "not_logged_in", account: null, reason: null } : signedIn,
          ...(frame.action === "logout" ? { logout: { local_cleared: true, remote_revocation: "attempted_unconfirmed" } } : {}),
          ...(leak ? { access_token: "LEAKED-TOKEN", stdout: "refresh_token=LEAKED-TOKEN" } : {}),
        }));
      }
      if (frame.type === "ordinary_account_session_open") {
        if (leak) {
          // Refused by the strict event schema; the person never sees it.
          socket.send(JSON.stringify({ type: "ordinary_account_session_event", session_id: frame.session_id, event: {
            kind: "authorization", url: "https://accounts.feishu.cn/verify?user_code=LEAK", user_code: "LEAK", expires_in: 600, refresh_token: "LEAKED-TOKEN",
          } }));
        }
        socket.send(JSON.stringify({ type: "ordinary_account_session_event", session_id: frame.session_id, event: {
          kind: "authorization", url: `https://accounts.feishu.cn/verify?user_code=${String(frame.account_key).slice(0, 4)}`, user_code: String(frame.account_key).slice(0, 4), expires_in: 600,
        } }));
        if (frame.flow === "init") {
          socket.send(JSON.stringify({ type: "ordinary_account_session_event", session_id: frame.session_id, event: { kind: "exit", outcome: "completed", error: null, status: { state: "not_logged_in", account: null, reason: null } } }));
        }
      }
      if (frame.type === "ordinary_account_session_close") {
        socket.send(JSON.stringify({ type: "ordinary_account_session_event", session_id: frame.session_id, event: { kind: "exit", outcome: "cancelled", error: null, status: null } }));
      }
    });
    socket.addEventListener("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
  });
  return { socket, frames };
}

/** Opens a setup/login stream as the current test user and collects its events until it ends. */
async function openStream(hostId: string, flow: string, headers: Record<string, string> = { "x-rainver-space-id": SPACE }) {
  const response = await fetch(`${baseUrl()}/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account/session/stream?flow=${flow}`, { headers });
  const events: Array<Record<string, unknown>> = [];
  const done = (async () => {
    if (response.status !== 200 || !response.body) return;
    const reader = response.body.getReader();
    let buffer = "";
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
      buffer += new TextDecoder().decode(value);
      for (let index; (index = buffer.indexOf("\n\n")) >= 0;) {
        const line = buffer.slice(0, index).replace(/^data: /, "");
        buffer = buffer.slice(index + 2);
        events.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  })();
  return { status: response.status, events, done };
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: "admin@example.test" }), [hostsModule]);
  commands = hostCommandHarness(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: "admin@example.test" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "jobs", "hosts", "machines", "settings", "space_memberships", "spaces", "users"], { cascade: true });
  const users: Record<string, CurrentUser> = {};
  for (const [id, email] of [[ADMIN, "admin@example.test"], [OWNER, "owner@example.test"], [MEMBER, "member@example.test"]] as const) {
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source) VALUES ($1, $2, $1, 'active', now(), now(), 'system')`,
      [id, email],
    );
    users[TOKENS[id]!] = user(id, email);
  }
  await seedHostCommandSpace(db.pool, SPACE, [{ user: ADMIN }, { user: OWNER }, { user: MEMBER }]);
  __setAuthRepositoryForTests({
    async getCurrentUser(sessionToken?: string) {
      return (sessionToken && users[sessionToken]) || { statusCode: 401, detail: "Not authenticated" };
    },
  } as unknown as AuthRepository);
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
});

afterAll(async () => {
  await app?.close();
});

async function pairHost(): Promise<{ hostId: string; token: string }> {
  asUser(OWNER);
  const issue = await app!.inject({ method: "POST", url: "/api/v1/hosts/pairing-codes", headers: { cookie: `better-auth.session_token=${TOKENS[OWNER]}` }, payload: { name: "Desk" } });
  const { host_id: hostId, pairing_code: pairingCode } = issue.json();
  const register = await app!.inject({ method: "POST", url: "/api/v1/hosts/register", payload: {
    pairing_code: pairingCode, platform: "linux", arch: "x64", daemon_version: MIN_HOST_DAEMON_VERSION, environment_kind: "linux_native",
    capabilities_json: {}, workspace_reports: [], managed_workspaces: [], ambient_sessions: [],
  } });
  return { hostId, token: register.json().token };
}

let commands: ReturnType<typeof hostCommandHarness>;
const logout = (hostId: string) => commands.run(app!, { method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account/logout` }, hostId);
const account = (hostId: string) => app!.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account` });

describe("personal ordinary-tool accounts on a paired Host", () => {
  it("serves the owner's own account only, and negotiates older and unsupported daemons", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { hostId, token } = await pairHost();
    expect((await account(hostId)).json()).toMatchObject({ availability: "offline", status: null, sandbox_status: "not_verified" });

    // A daemon without the capability keeps running Runtimes and is sent nothing new.
    const old = await connectDaemon(token, { runtimes: [], versions: {}, installations: {}, ordinary_tools: TOOLS });
    expect((await account(hostId)).json()).toMatchObject({ availability: "update_required" });
    expect((await openStream(hostId, "login")).status).toBe(409);
    expect(old.frames.some((frame) => String(frame.type).startsWith("ordinary_account"))).toBe(false);
    old.socket.close();
    await expect.poll(async () => (await account(hostId)).json().availability).toBe("offline");

    // macOS: the daemon says it cannot keep users apart, so nothing is attempted.
    const mac = await connectDaemon(token, { ...CAPABILITIES, ordinary_tool_accounts: { protocol: "ordinary-tool-accounts-v1", supported: false, reason: "Keychain" } });
    expect((await account(hostId)).json()).toMatchObject({ availability: "unsupported", reason: "Keychain" });
    expect(mac.frames.some((frame) => String(frame.type).startsWith("ordinary_account"))).toBe(false);
    mac.socket.close();
    await expect.poll(async () => (await account(hostId)).json().availability).toBe("offline");

    const noTool = await connectDaemon(token, { ...CAPABILITIES, ordinary_tools: { ...TOOLS, tools: [{ ...TOOLS.tools[0], status: "missing", source: null }] } });
    expect((await account(hostId)).json()).toMatchObject({ availability: "tool_unavailable" });
    noTool.socket.close();
    await expect.poll(async () => (await account(hostId)).json().availability).toBe("offline");

    const daemon = await connectDaemon(token, CAPABILITIES);
    const live = (await account(hostId)).json();
    expect(live).toMatchObject({ availability: "live", status: { state: "signed_in", account: { user_name: "Owner" } }, session_active: false });
    // The daemon gets a derived key and fixed fields: no user id, path, env or argv.
    expect(daemon.frames.find((frame) => frame.type === "ordinary_account_request")).toEqual({
      type: "ordinary_account_request", request_id: expect.any(String), tool_id: "lark_cli", account_key: ordinaryAccountKey(OWNER), action: "status",
    });
    expect(JSON.stringify(daemon.frames)).not.toContain(OWNER);
    expect((await app.inject({ method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account/verify` })).json())
      .toMatchObject({ status: { account: { verified: true } } });
    // Logging out changes the account: a durable command, released through its status read.
    expect((await logout(hostId)).status).toMatchObject({ status: "succeeded", result: { tool_id: "lark_cli", status: { state: "not_logged_in" }, logout: { local_cleared: true, remote_revocation: "attempted_unconfirmed" } } });
    expect(daemon.frames.filter((frame) => frame.type === "ordinary_account_request").at(-1)).toEqual({
      type: "ordinary_account_request", request_id: expect.any(String), tool_id: "lark_cli", account_key: ordinaryAccountKey(OWNER), action: "logout",
    });
    expect((await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools/jq/account` })).statusCode).toBe(422);
    expect((await openStream(hostId, "bot")).status).toBe(422);
    // A cross-site page cannot start a login: no fetch metadata and none of our headers.
    expect((await openStream(hostId, "login", {})).status).toBe(403);

    // Nobody else reaches a paired Host's accounts, not even the instance admin.
    const before = daemon.frames.length;
    for (const other of [MEMBER, ADMIN]) {
      asUser(other);
      expect((await account(hostId)).statusCode).toBe(404);
      expect((await openStream(hostId, "login")).status).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account/session/cancel` })).statusCode).toBe(404);
      expect((await commands.submit(app, { method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/account/logout` })).statusCode).toBe(404);
    }
    expect(daemon.frames).toHaveLength(before);

    // A disconnect ends an open login visibly rather than leaving it waiting.
    asUser(OWNER);
    const stream = await openStream(hostId, "login");
    await expect.poll(() => stream.events.length).toBe(1);
    daemon.socket.close();
    await stream.done;
    expect(stream.events.at(-1)).toEqual({ type: "exit", outcome: "failed", error: "host_disconnected", status: null });
  });
});

describe("personal ordinary-tool accounts on the built-in Host", () => {
  it("lets each member manage their own account without binary authority, and keeps sessions apart", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ('machine-builtin', NULL, 'Instance', 'server', now(), now())`);
    await db.pool.query(
      `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, token_hash, capabilities_json, created_at, updated_at)
       VALUES ($1, NULL, 'machine-builtin', 'Server', 'server', 'server', 'offline', $2, '{}'::jsonb, now(), now())`,
      [BUILTIN_HOST, createHash("sha256").update(BUILTIN_TOKEN).digest("hex")],
    );
    const daemon = await connectDaemon(BUILTIN_TOKEN, CAPABILITIES);

    asUser(MEMBER);
    expect((await account(BUILTIN_HOST)).json()).toMatchObject({ availability: "live", status: { account: { user_name: "Member" } } });
    // Their own account, yes; the shared binary, no.
    expect((await commands.submit(app, { method: "POST", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools/lark_cli/install` })).statusCode).toBe(404);

    const setup = await openStream(BUILTIN_HOST, "init");
    await setup.done;
    expect(setup.events.map((event) => event.type)).toEqual(["authorization", "exit"]);
    expect(setup.events[1]).toMatchObject({ outcome: "completed" });

    const memberLogin = await openStream(BUILTIN_HOST, "login");
    await expect.poll(() => memberLogin.events.length).toBe(1);
    expect(memberLogin.events[0]).toMatchObject({ type: "authorization", user_code: ordinaryAccountKey(MEMBER).slice(0, 4) });
    expect((await account(BUILTIN_HOST)).json().session_active).toBe(true);

    // The admin has their own account and cannot see or cancel the member's session.
    asUser(ADMIN);
    expect((await account(BUILTIN_HOST)).json()).toMatchObject({ status: { account: { user_name: "Admin" } }, session_active: false });
    expect((await app.inject({ method: "POST", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools/lark_cli/account/session/cancel` })).statusCode).toBe(404);
    const adminLogin = await openStream(BUILTIN_HOST, "login");
    await expect.poll(() => adminLogin.events.length).toBe(1);
    expect(adminLogin.events[0]).toMatchObject({ user_code: ordinaryAccountKey(ADMIN).slice(0, 4) });
    expect(memberLogin.events).toHaveLength(1);

    // The member's second stream supersedes their first; the admin's is untouched.
    asUser(MEMBER);
    const again = await openStream(BUILTIN_HOST, "login");
    await memberLogin.done;
    expect(memberLogin.events.at(-1)).toMatchObject({ type: "exit", outcome: "cancelled" });
    await expect.poll(() => again.events.length).toBe(1);
    expect(adminLogin.events).toHaveLength(1);

    // Cancelling names no session: it is the caller's own, and the stream hears it end.
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools/lark_cli/account/session/cancel` });
    expect(cancelled.json()).toEqual({ cancelled: true });
    await again.done;
    expect(again.events.at(-1)).toMatchObject({ type: "exit", outcome: "cancelled" });
    expect(adminLogin.events).toHaveLength(1);

    const opens = daemon.frames.filter((frame) => frame.type === "ordinary_account_session_open");
    expect(new Set(opens.map((frame) => frame.account_key))).toEqual(new Set([ordinaryAccountKey(MEMBER), ordinaryAccountKey(ADMIN)]));
    for (const frame of opens) expect(Object.keys(frame).sort()).toEqual(["account_key", "flow", "session_id", "tool_id", "type"]);
  });
});

describe("what an account answer can carry", () => {
  it("passes only contract fields to the person, whatever else a daemon sends", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { hostId, token } = await pairHost();
    const daemon = await connectDaemon(token, CAPABILITIES, true);

    const status = await account(hostId);
    expect(status.json()).toMatchObject({ availability: "live", status: { state: "signed_in", account: { user_name: "Owner" } } });
    const loggedOut = await logout(hostId);
    expect(loggedOut.status).toMatchObject({ result: { logout: { local_cleared: true, remote_revocation: "attempted_unconfirmed" } } });
    const released = await commands.status(app, hostId, loggedOut.receipt.id);

    const setup = await openStream(hostId, "init");
    await setup.done;
    expect(setup.events).toEqual([
      { type: "authorization", url: expect.stringMatching(/^https:\/\/accounts\.feishu\.cn\//), user_code: ordinaryAccountKey(OWNER).slice(0, 4), expires_in: 600 },
      { type: "exit", outcome: "completed", error: null, status: { state: "not_logged_in", account: null, reason: null } },
    ]);
    const stored = JSON.stringify((await db.pool.query("SELECT result_json FROM host_command_intents WHERE id = $1", [loggedOut.receipt.id])).rows);
    for (const body of [status.body, released.body, stored, JSON.stringify(setup.events)]) expect(body).not.toMatch(/LEAKED|LEAK"|access_token|refresh_token|stdout/);
    // The refused event was answered as an invalid frame, not forwarded.
    expect(daemon.frames.some((frame) => frame.type === "error" && /invalid_frame ordinary_account_session_event/.test(String(frame.detail)))).toBe(true);
  });
});
