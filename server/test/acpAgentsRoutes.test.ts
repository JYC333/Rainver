import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { acpAgentsModule } from "../src/modules/acpAgents/index.js";
import { __setAcpRegistryForTests, type AcpRegistryEntry } from "../src/modules/acpAgents/registry.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests, __setAuthRepositoryForTests, type AuthRepository, type CurrentUser } from "../src/modules/auth/identity.js";
import { getRuntimeAdapterSpec, listRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/specs.js";
import { AcpAgentService } from "../src/modules/acpAgents/service.js";
import { acpRuntimeProbe } from "../src/modules/hosts/runtimeProbes.js";
import { getDbPool } from "../src/db/pool.js";
import { setDynamicRuntimeAdapterSpecs } from "../src/modules/runtimeAdapters/dynamicSpecs.js";

// Real-Postgres coverage for enabling an ACP-registry agent and installing a
// managed copy of it on a paired host. The registry itself is stubbed (no
// network in tests); the daemon is a real WebSocket client answering the
// `install_tool` frame.

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SPACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN_TOKEN = "admin-session";
const MEMBER_TOKEN = "member-session";

const GOOSE: AcpRegistryEntry = {
  id: "goose",
  name: "goose",
  version: "1.2.3",
  description: "An agent",
  repository: null,
  license: "Apache-2.0",
  icon: null,
  distribution: { kind: "npx", package: "goose-acp@1.2.3", args: [], env: {} },
};

let app: FastifyInstance | undefined;
const db = useTestDatabase(import.meta.filename);

function user(id: string, email: string): CurrentUser {
  return { id, email, display_name: id, avatar_url: null, is_instance_admin: false, created_at: new Date().toISOString(), last_login_at: null };
}

function stubAuth(): AuthRepository {
  const users: Record<string, CurrentUser> = { [ADMIN_TOKEN]: user(ADMIN, "admin@example.test"), [MEMBER_TOKEN]: user(MEMBER, "member@example.test") };
  return {
    async getCurrentUser(sessionToken?: string) {
      const found = sessionToken ? users[sessionToken] : undefined;
      return found ?? { statusCode: 401, detail: "Not authenticated" };
    },
  } as unknown as AuthRepository;
}

function asUser(userId: string) {
  __setAuthIdentityForTests({ userId, spaceId: SPACE, sessionToken: userId === ADMIN ? ADMIN_TOKEN : MEMBER_TOKEN } as never);
}

function httpBaseUrl(): string {
  const address = app!.server.address();
  if (!address || typeof address === "string") throw new Error("not listening on TCP");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  if (!db.available) return;
  app = buildModuleServer(
    loadConfig({ SERVER_DATABASE_URL: db.connectionUri, INSTANCE_ADMIN_EMAIL: "admin@example.test" }),
    [hostsModule, acpAgentsModule],
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["hosts", "settings", "spaces", "users"], { cascade: true });
  const now = new Date().toISOString();
  for (const [id, email] of [[ADMIN, "admin@example.test"], [MEMBER, "member@example.test"]]) {
    await db.pool.query(
      `INSERT INTO users (id, email, display_name, status, created_at, updated_at) VALUES ($1, $2, $1, 'active', $3, $3)`,
      [id, email, now],
    );
  }
  __setAcpRegistryForTests([GOOSE]);
  __setAuthRepositoryForTests(stubAuth());
  setDynamicRuntimeAdapterSpecs([]);
});

afterEach(() => {
  __setAuthIdentityForTests(null);
  __setAuthRepositoryForTests(null);
  __setAcpRegistryForTests(null);
  setDynamicRuntimeAdapterSpecs([]);
});

afterAll(async () => {
  await app?.close();
});

describe("ACP registry agents", () => {
  it("resolves the builtins' registry entries in the refresh loop and keeps them off the hello path, network or not", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    const OPENCODE: AcpRegistryEntry = {
      ...GOOSE, id: "opencode", name: "OpenCode", version: "1.18.23",
      distribution: { kind: "binary", platforms: { "linux-x86_64": { archive: "https://x/opencode.tar.gz", cmd: "./opencode", args: ["acp"], sha256: null, env: {} } } },
    };
    const service = new AcpAgentService(getDbPool(db.connectionUri));
    // Nothing resolved yet: the daemon is told there is no distribution.
    __setAcpRegistryForTests("unavailable");
    expect(acpRuntimeProbe("opencode")?.distribution).toBeNull();

    // The refresh loop fetches and persists; hello reads memory.
    __setAcpRegistryForTests([GOOSE, OPENCODE]);
    await service.refreshRegistryCache();
    expect(acpRuntimeProbe("opencode")).toMatchObject({ distribution: OPENCODE.distribution, version: "1.18.23" });

    // A restart with no network: the persisted answer stands.
    __setAcpRegistryForTests("unavailable");
    await service.refreshRegistryCache();
    expect(acpRuntimeProbe("opencode")).toMatchObject({ distribution: OPENCODE.distribution, version: "1.18.23" });
  });

  it("lets only the instance admin enable a registry agent, which then exists as a remote-only runtime adapter", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    asUser(MEMBER);
    const denied = await app.inject({ method: "PUT", url: "/api/v1/acp-agents/goose" });
    expect(denied.statusCode).toBe(403);

    asUser(ADMIN);
    const missing = await app.inject({ method: "PUT", url: "/api/v1/acp-agents/not-there" });
    expect(missing.statusCode).toBe(404);

    const enabled = await app.inject({ method: "PUT", url: "/api/v1/acp-agents/goose" });
    expect(enabled.statusCode).toBe(201);
    expect(enabled.json()).toMatchObject({ id: "goose", adapter_type: "acp_goose" });

    // The adapter catalog now carries it, shaped as low trust and remote-only.
    const spec = getRuntimeAdapterSpec("acp_goose");
    expect(spec).toMatchObject({
      display_name: "goose",
      runtime_kind: "local_cli",
      baseline_trust_level: "low",
      executable: { command: "acp_goose" },
      distribution: GOOSE.distribution,
      invocation: { protocol: "acp", remote_host_only: true },
      model: { model_provider_mode: "none" },
    });
    expect(listRuntimeAdapterSpecs().map((candidate) => candidate.adapter_type)).toContain("acp_goose");

    // ...and the hosts module offers it for remote dispatch, with the daemon
    // told how to probe it.
    const adapters = await app.inject({ method: "GET", url: "/api/v1/hosts/runtime-adapters", headers: { cookie: `session_id=${ADMIN_TOKEN}` } });
    expect(adapters.json().items).toContainEqual(expect.objectContaining({ adapter_type: "acp_goose", capability_probe: "acp_goose", remote_eligible: true }));

    const listed = await app.inject({ method: "GET", url: "/api/v1/acp-agents" });
    expect(listed.json().items).toEqual([expect.objectContaining({ id: "goose", installed_on: [] })]);

    // Still installed somewhere: refused, naming the host, until removed there.
    const issued = await app.inject({ method: "POST", url: "/api/v1/hosts/pairing-codes", headers: { cookie: `session_id=${ADMIN_TOKEN}` }, payload: { name: "Desk" } });
    const { host_id: deskId, pairing_code: deskCode } = issued.json();
    await app.inject({ method: "POST", url: "/api/v1/hosts/register", payload: { pairing_code: deskCode, platform: "linux", arch: "x64" } });
    await db.pool.query(
      `UPDATE hosts SET capabilities_json = $2::jsonb WHERE id = $1`,
      [deskId, JSON.stringify({ installations: { acp_goose: [{ id: "managed:1.2.3", version: "1.2.3", logged_in: false }] } })],
    );
    const refused = await app.inject({ method: "DELETE", url: "/api/v1/acp-agents/goose" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toMatch(/Desk/);
    expect((await app.inject({ method: "GET", url: "/api/v1/acp-agents" })).json().items[0].installed_on).toEqual([{ host_id: deskId, name: "Desk" }]);
    await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [deskId]);

    const disabled = await app.inject({ method: "DELETE", url: "/api/v1/acp-agents/goose" });
    expect(disabled.statusCode).toBe(204);
    expect(getRuntimeAdapterSpec("acp_goose")).toBeNull();
  });

  it("installs an enabled agent on an owned, connected host, logs it in through the daemon's terminal, and refuses a ModelProvider binding for it", async (ctx) => {
    if (!db.available || !app) return ctx.skip();
    asUser(ADMIN);
    await app.inject({ method: "PUT", url: "/api/v1/acp-agents/goose" });

    const issue = await app.inject({ method: "POST", url: "/api/v1/hosts/pairing-codes", headers: { cookie: `session_id=${ADMIN_TOKEN}` }, payload: { name: "Box" } });
    const { host_id: hostId, pairing_code: pairingCode } = issue.json();
    const register = await app.inject({ method: "POST", url: "/api/v1/hosts/register", payload: { pairing_code: pairingCode, platform: "linux", arch: "x64" } });
    const { token } = register.json();

    const offline = await app.inject({ method: "POST", url: `/api/v1/hosts/${hostId}/installations/acp_goose` });
    expect(offline.statusCode).toBe(502);
    expect(offline.json()).toMatchObject({ ok: false, error: "host_offline" });

    const socket = new WebSocket(`${httpBaseUrl().replace(/^http/, "ws")}/internal/hosts/ws`);
    let resolveInstallFrame: (frame: Record<string, unknown>) => void = () => {};
    const installFrame = new Promise<Record<string, unknown>>((resolve) => { resolveInstallFrame = resolve; });
    const helloAck = new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", token, platform: "linux", arch: "x64", daemon_version: "0.1.0" })));
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type === "hello_ack") resolve(frame);
        if (frame.type === "install_tool") {
          resolveInstallFrame(frame);
          socket.send(JSON.stringify({ type: "tool_result", request_id: frame.request_id, ok: true, error: null, installation: "managed:1.2.3" }));
        }
      });
      socket.addEventListener("error", (event) => reject(event));
      setTimeout(() => reject(new Error("timed out waiting for hello_ack")), 5000);
    });
    // The probe list names the agent, so a daemon that has it reports it.
    const probes = (await helloAck).runtime_probes as Array<Record<string, unknown>>;
    expect(probes).toContainEqual({
      adapter_type: "acp_goose", runtime: null, argv: ["acp_goose"], distribution: GOOSE.distribution,
      version: "1.2.3", login: null, remote_host_only: true,
    });

    const installed = await app.inject({ method: "POST", url: `/api/v1/hosts/${hostId}/installations/acp_goose` });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ ok: true, installation: "managed:1.2.3", host_id: hostId, adapter_type: "acp_goose" });
    expect(await installFrame).toMatchObject({ adapter_type: "acp_goose", version: "1.2.3", distribution: GOOSE.distribution, login: null });

    // Removing a managed copy is the same conversation the other way; `own`
    // is not something the daemon can remove.
    const notManaged = await app.inject({ method: "DELETE", url: `/api/v1/hosts/${hostId}/installations/acp_goose/own` });
    expect(notManaged.statusCode).toBe(422);

    // Not the owner: the host does not exist as far as this user can tell.
    asUser(MEMBER);
    const notOwner = await app.inject({ method: "POST", url: `/api/v1/hosts/${hostId}/installations/acp_goose` });
    expect(notOwner.statusCode).toBe(404);

    // The login terminal: the daemon runs the copy's login on a PTY and the
    // stream relays it; typed input goes back over the same session.
    asUser(ADMIN);
    const seen: Record<string, unknown>[] = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      seen.push(frame);
      if (frame.type === "login_open") {
        expect(frame).toMatchObject({ adapter_type: "acp_goose", installation: "managed:1.2.3", login: null });
        socket.send(JSON.stringify({ type: "login_output", session_id: frame.session_id, data: "code? " }));
      }
      if (frame.type === "login_input") {
        socket.send(JSON.stringify({ type: "login_output", session_id: frame.session_id, data: `got:${String(frame.data).trim()}\n` }));
        socket.send(JSON.stringify({ type: "login_exit", session_id: frame.session_id, exit_code: 0, logged_in: true }));
      }
    });
    const streamUrl = `${httpBaseUrl()}/api/v1/hosts/${hostId}/installations/acp_goose/managed:1.2.3/login/stream`;
    const response = await fetch(streamUrl, { headers: { cookie: `session_id=${ADMIN_TOKEN}` } });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Record<string, unknown>[] = [];
    const readUntil = async (predicate: () => boolean) => {
      while (!predicate()) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
      }
    };
    await readUntil(() => events.some((event) => event.type === "output"));
    expect(events[0]).toMatchObject({ type: "output", data: "code? " });
    const input = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/installations/acp_goose/managed:1.2.3/login/input`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "abc\n" }),
    });
    expect(input.statusCode).toBe(204);
    await readUntil(() => events.some((event) => event.type === "exit"));
    expect(events.map((event) => event.type)).toEqual(["output", "output", "exit"]);
    expect(events[2]).toMatchObject({ exit_code: 0, logged_in: true });
    // After exit there is nothing to type into.
    const late = await app.inject({
      method: "POST",
      url: `/api/v1/hosts/${hostId}/installations/acp_goose/managed:1.2.3/login/input`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x" }),
    });
    expect(late.statusCode).toBe(409);

    const binding = await app.inject({
      method: "PUT",
      url: `/api/v1/hosts/${hostId}/runtime-provider-bindings/acp_goose`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ model_provider_id: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(binding.statusCode).toBe(422);
    expect(binding.json().detail).toMatch(/does not accept a ModelProvider/);
    socket.close();
  });
});
