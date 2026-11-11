import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ORDINARY_TOOL_CATALOG, type OrdinaryToolsHostReport } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository, type CurrentUser } from "../src/modules/auth/identity.js";
import { MIN_HOST_DAEMON_VERSION } from "../src/modules/hosts/daemonCompatibility.js";
import { hostCommandHarness, seedHostCommandSpace } from "./support/hostCommandHarness.js";

// Real-Postgres coverage for ordinary CLI tools on a Host: Host visibility and
// management authority, capability negotiation with daemons that predate the
// report, the frame the control plane actually sends, and offline answers. The
// daemon is a real WebSocket client; its own handling is covered by
// `packages/host-daemon/test/ordinaryTools.test.ts`.

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKENS: Record<string, string> = { [ADMIN]: "admin-session", [OWNER]: "owner-session", [OTHER]: "other-session" };
const BUILTIN_HOST = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BUILTIN_TOKEN = "builtin-daemon-token";
const LARK_VERSION = ORDINARY_TOOL_CATALOG.lark_cli.managed!.version;

const HELLO_INFO = {
  platform: "linux",
  arch: "x64",
  daemon_version: MIN_HOST_DAEMON_VERSION,
  environment_kind: "linux_native",
  capabilities_json: {} as Record<string, unknown>,
  workspace_reports: [],
  managed_workspaces: [],
  ambient_sessions: [],
};

const REPORT: OrdinaryToolsHostReport = {
  protocol: "ordinary-tools-v1",
  tools: [
    { tool_id: "git", status: "available", source: "path", version: "2.43.0", version_text: "git version 2.43.0", managed_version: null, registered: false, managed_installable: false, managed_catalog_version: null },
    { tool_id: "jq", status: "missing", source: null, version: null, version_text: null, managed_version: null, registered: false, managed_installable: false, managed_catalog_version: null },
    { tool_id: "lark_cli", status: "available", source: "managed", version: "1.0.1", version_text: "lark-cli version 1.0.1", managed_version: "1.0.1", registered: false, managed_installable: true, managed_catalog_version: LARK_VERSION },
  ],
};

let app: FastifyInstance | undefined;
let commands: ReturnType<typeof hostCommandHarness>;
const db = useTestDatabase(import.meta.filename);
/** One keyed command at its retained URL. */
const command = (method: "POST" | "DELETE", url: string, payload?: unknown) => commands.submit(app!, { method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
const sockets: WebSocket[] = [];

function user(id: string, email: string): CurrentUser {
  return { id, email, display_name: id, avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), default_space_id: null, last_login_at: null };
}

function asUser(userId: string) {
  __setAuthIdentityForTests({ userId, spaceId: SPACE, sessionToken: TOKENS[userId] } as never);
}

function wsUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("not listening on TCP");
  return `ws://127.0.0.1:${address.port}/internal/hosts/ws`;
}

/** A daemon: says hello with these capabilities and records every frame it receives. */
async function connectDaemon(token: string, capabilities: Record<string, unknown>, answer?: (frame: Record<string, unknown>, socket: WebSocket) => void) {
  const socket = new (WebSocket as unknown as { new (url: string, init: { headers: Record<string, string> }): WebSocket })(
    wsUrl(), { headers: { Authorization: `Bearer ${token}` } },
  );
  sockets.push(socket);
  const frames: Array<Record<string, unknown>> = [];
  const ack = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token, ...HELLO_INFO, capabilities_json: capabilities })));
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "hello_ack") resolve(frame);
      answer?.(frame, socket);
    });
    socket.addEventListener("error", reject);
    setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
  });
  return { socket, frames, ack: await ack };
}

async function closeDaemon(socket: WebSocket, hostId: string) {
  socket.close();
  await expect.poll(async () => (await app!.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json().host_state).toBe("offline");
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: "admin@example.test" }),
    [hostsModule],
  );
  commands = hostCommandHarness(db.pool, loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: "admin@example.test" }));
  await app.listen({ port: 0, host: "127.0.0.1" });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "jobs", "hosts", "machines", "settings", "space_memberships", "spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  const users: Record<string, CurrentUser> = {};
  for (const [id, email] of [[ADMIN, "admin@example.test"], [OWNER, "owner@example.test"], [OTHER, "other@example.test"]] as const) {
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source) VALUES ($1, $2, $1, 'active', $3, $3, 'system')`,
      [id, email, now],
    );
    users[TOKENS[id]!] = user(id, email);
  }
  await seedHostCommandSpace(db.pool, SPACE, [{ user: ADMIN }, { user: OWNER }, { user: OTHER }]);
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
  const register = await app!.inject({ method: "POST", url: "/api/v1/hosts/register", payload: { pairing_code: pairingCode, ...HELLO_INFO } });
  return { hostId, token: register.json().token };
}

describe("ordinary CLI tools on a paired Host", () => {
  it("negotiates by capability, forwards only catalog operations, and is the owner's alone", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const { hostId, token } = await pairHost();

    // Never reported: offline and unknown, not missing.
    const unknown = (await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json();
    expect(unknown).toMatchObject({ host_state: "offline", can_manage: true });
    expect(unknown.tools.every((tool: { host_status: string }) => tool.host_status === "unknown")).toBe(true);

    // An older daemon stays connected for its Runtimes and is sent nothing new.
    const old = await connectDaemon(token, { runtimes: ["git"], versions: { git: "git version 2.43.0" }, installations: {} });
    const updateRequired = (await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json();
    expect(updateRequired.host_state).toBe("update_required");
    const refused = await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/install`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ metadata: { code: "host_update_required" } });
    expect(old.frames.some((frame) => frame.type === "ordinary_tool_request")).toBe(false);
    await closeDaemon(old.socket, hostId);

    const current = await connectDaemon(token, { runtimes: [], versions: {}, installations: {}, ordinary_tools: REPORT }, (frame, socket) => {
      if (frame.type !== "ordinary_tool_request") return;
      const operation = frame.operation as { action: string; tool_id: string };
      socket.send(JSON.stringify(operation.action === "register"
        ? { type: "ordinary_tool_result", request_id: frame.request_id, ok: false, error: "jq was not found on this Host's PATH.", tool: REPORT.tools[1] }
        : { type: "ordinary_tool_result", request_id: frame.request_id, ok: true, error: null, tool: { ...REPORT.tools[2], version: LARK_VERSION, managed_version: LARK_VERSION } }));
    });
    // An ordinary tool is no Runtime: the probe catalog never names one.
    expect(JSON.stringify(current.ack.runtime_probes)).not.toMatch(/lark/);

    const view = (await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json();
    expect(view.host_state).toBe("online");
    expect(view.tools.map((tool: { tool_id: string }) => tool.tool_id)).toEqual(["git", "curl", "jq", "rg", "lark_cli"]);
    const lark = view.tools.find((tool: { tool_id: string }) => tool.tool_id === "lark_cli");
    expect(lark).toMatchObject({
      host_status: "available", reported_live: true, source: "managed", version: "1.0.1", requires_account: true,
      managed: { catalog_version: LARK_VERSION, installed_version: "1.0.1", installable: true, update_available: true },
      sandbox_status: "not_verified", account_status: "not_verified",
    });
    expect(view.tools.find((tool: { tool_id: string }) => tool.tool_id === "curl")).toMatchObject({ host_status: "unknown" });
    expect(view.tools.find((tool: { tool_id: string }) => tool.tool_id === "jq")).toMatchObject({ host_status: "missing", account_status: "not_applicable" });

    // Admitted, then sent by the worker; the status read releases the daemon's answer.
    const installed = await commands.run(app, { method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/install` }, hostId);
    expect(installed.status).toMatchObject({ status: "succeeded", result: { ok: true, tool_id: "lark_cli", tool: { version: LARK_VERSION } } });
    // The catalog's pinned version and nothing else; a paired Host downloads directly. A daemon
    // without command receipts gets the bare frame, once.
    expect(current.frames.find((frame) => frame.type === "ordinary_tool_request")).toEqual({
      type: "ordinary_tool_request", request_id: expect.any(String),
      operation: { action: "install", tool_id: "lark_cli", version: LARK_VERSION },
    });

    const notFound = await commands.run(app, { method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/jq/register`, payload: {} }, hostId);
    expect(notFound.status).toMatchObject({ status: "failed", error: { code: "host_command_failed" }, result: null });
    expect(notFound.status.error?.detail).toMatch(/not found on this Host's PATH/);
    expect(current.frames.at(-1)).toMatchObject({ operation: { action: "register", tool_id: "jq", path: null } });

    expect((await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/jq/install`)).statusCode).toBe(422);
    expect((await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/bash/register`, { path: "/bin/bash" })).statusCode).toBe(422);
    expect((await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/jq/register`, { path: ["/usr/bin/jq"] })).statusCode).toBe(422);
    expect((await command("DELETE", `/api/v1/hosts/${hostId}/ordinary-tools/jq`)).statusCode).toBe(422);
    // Path syntax is the caller's mistake: 422 and nothing is admitted or reaches the daemon.
    const framesBeforeBadPaths = current.frames.length;
    const intentsBefore = (await db.pool.query("SELECT 1 FROM host_command_intents")).rowCount;
    for (const path of ["usr/bin/jq", "./jq", "C:\\tools\\jq.exe", "/usr/bin/jq\u0000x", `/${"a".repeat(4096)}`]) {
      const refusedPath = await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/jq/register`, { path });
      expect(refusedPath.statusCode).toBe(422);
    }
    expect(current.frames).toHaveLength(framesBeforeBadPaths);
    expect((await db.pool.query("SELECT 1 FROM host_command_intents")).rowCount).toBe(intentsBefore);
    // A syntactically valid path is the daemon's to judge; a settled command keeps no Host path.
    const registered = await commands.run(app, { method: "POST", url: `/api/v1/hosts/${hostId}/ordinary-tools/jq/register`, payload: { path: "/opt/tools/jq" } }, hostId);
    expect(current.frames.at(-1)).toMatchObject({ operation: { action: "register", tool_id: "jq", path: "/opt/tools/jq" } });
    expect(JSON.stringify((await db.pool.query("SELECT frozen_json FROM host_command_intents WHERE id = $1", [registered.receipt.id])).rows[0])).not.toContain("/opt/tools/jq");
    const requestsBefore = current.frames.filter((frame) => frame.type === "ordinary_tool_request").length;

    // Someone else's paired Host does not exist for them, for reading, managing or reading a command.
    asUser(OTHER);
    expect((await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).statusCode).toBe(404);
    expect((await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/install`)).statusCode).toBe(404);
    expect((await command("DELETE", `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli?source=managed`)).statusCode).toBe(404);
    expect((await commands.status(app, hostId, installed.receipt.id)).statusCode).toBe(404);
    await commands.process();
    expect(current.frames.filter((frame) => frame.type === "ordinary_tool_request")).toHaveLength(requestsBefore);

    // A Windows Host is not offered ordinary-tool management at all.
    asUser(OWNER);
    await db.pool.query("UPDATE hosts SET platform = 'win32' WHERE id = $1", [hostId]);
    const windows = await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/install`);
    expect(windows.statusCode).toBe(422);
    expect(windows.json().error.message).toMatch(/Linux and macOS Hosts only/);
    expect(current.frames.filter((frame) => frame.type === "ordinary_tool_request")).toHaveLength(requestsBefore);
    await db.pool.query("UPDATE hosts SET platform = 'linux' WHERE id = $1", [hostId]);

    // Offline: the last report, marked as not live. A command is admitted and waits for its Host:
    // nothing is sent, nothing reads as done.
    asUser(OWNER);
    await closeDaemon(current.socket, hostId);
    const offline = (await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json();
    expect(offline.tools.find((tool: { tool_id: string }) => tool.tool_id === "git")).toMatchObject({ host_status: "available", reported_live: false });
    const offlineInstall = await command("POST", `/api/v1/hosts/${hostId}/ordinary-tools/lark_cli/install`);
    expect(offlineInstall.statusCode).toBe(202);
    await commands.process();
    const waiting = await commands.status(app, hostId, offlineInstall.json().data.id);
    expect(waiting.json()).toMatchObject({ status: "pending", result: null });
    // The durable command is what the Host card shows in flight.
    expect((await app.inject({ method: "GET", url: `/api/v1/hosts/${hostId}/ordinary-tools` })).json().operations).toEqual([{ tool_id: "lark_cli", action: "install" }]);
    expect(current.frames.filter((frame) => frame.type === "ordinary_tool_request")).toHaveLength(requestsBefore);
  });
});

describe("ordinary CLI tools on the built-in Host", () => {
  it("is visible to members and managed by the instance admin only", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    await db.pool.query(
      `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
       VALUES ('machine-builtin', NULL, 'Instance', 'server', now(), now())`,
    );
    await db.pool.query(
      `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, token_hash, capabilities_json, created_at, updated_at)
       VALUES ($1, NULL, 'machine-builtin', 'Server', 'server', 'server', 'offline', $2, '{}'::jsonb, now(), now())`,
      [BUILTIN_HOST, createHash("sha256").update(BUILTIN_TOKEN).digest("hex")],
    );
    // A daemon with command receipts: every command arrives as one journaled `host_command`.
    const daemon = await connectDaemon(BUILTIN_TOKEN, { runtimes: [], versions: {}, installations: {}, ordinary_tools: REPORT, host_command_receipts: 1 }, (frame, socket) => {
      if (frame.type === "host_command") {
        const inner = frame.command as { request_id: string };
        socket.send(JSON.stringify({ type: "host_command_result", request_id: frame.request_id, command_id: frame.command_id, outcome: "completed", replayed: false, error: null,
          result: { type: "ordinary_tool_result", request_id: inner.request_id, ok: true, error: null, tool: null } }));
      }
    });

    asUser(OWNER);
    const memberView = await app.inject({ method: "GET", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools` });
    expect(memberView.statusCode).toBe(200);
    expect(memberView.json()).toMatchObject({ host_state: "online", can_manage: false });
    // Managing it is instance-admin work: a member gets the hidden 404 and nothing is admitted.
    expect((await command("POST", `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools/lark_cli/install`)).statusCode).toBe(404);
    expect(daemon.frames.some((frame) => frame.type === "host_command")).toBe(false);

    asUser(ADMIN);
    expect((await app.inject({ method: "GET", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools` })).json().can_manage).toBe(true);
    const installed = await commands.run(app, { method: "POST", url: `/api/v1/hosts/${BUILTIN_HOST}/ordinary-tools/lark_cli/install` }, BUILTIN_HOST);
    expect(installed.status).toMatchObject({ status: "succeeded", result: { ok: true, tool_id: "lark_cli" } });
    // One journaled send carrying the intent's identity; the built-in Host carries the
    // admin-selected download route frozen when the command was admitted.
    const sent = daemon.frames.filter((frame) => frame.type === "host_command");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      command_id: installed.receipt.id, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      command: { type: "ordinary_tool_request", operation: { action: "install", tool_id: "lark_cli", version: LARK_VERSION }, egress_transport: { mode: "direct" } },
    });
    // Settled, the intent keeps neither the egress route (a proxy URL may carry credentials) nor any path.
    const frozen = (await db.pool.query<{ frozen_json: Record<string, unknown> }>("SELECT frozen_json FROM host_command_intents WHERE id = $1", [installed.receipt.id])).rows[0]!.frozen_json;
    expect(frozen).not.toHaveProperty("egress_transport");
    expect(frozen).toMatchObject({ operation: { action: "install", tool_id: "lark_cli" } });
  });
});
