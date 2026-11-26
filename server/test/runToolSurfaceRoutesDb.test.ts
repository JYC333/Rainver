import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startLocalToolBridge } from "../../packages/agent-cli/dist/localBridge.js";
import { RunToolChannel } from "../../packages/host-daemon/src/runToolChannel.js";
import { HostServerFrameSchema, type HostDaemonFrame, type HostServerFrame } from "@rainver/protocol";
import { hostsModule } from "../src/modules/hosts/index.js";
import { PgHostRepository } from "../src/modules/hosts/repository.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { MIN_HOST_DAEMON_VERSION } from "../src/modules/hosts/daemonCompatibility.js";
import { runTool as callRunTool } from "./support/runTool.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { runsModule } from "../src/modules/runs/index.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { executeRemoteHostCliAdapter, NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { workSkillContentHash } from "../src/modules/skills/workSkill.js";
import { PgRunToolIdentityRepository } from "../src/modules/runs/runToolIdentityRepository.js";
import { dispatchToolAllowance } from "../src/modules/systemActions/scenarioToolAllowance.js";
import { buildRunToolGrants } from "../src/modules/systemActions/runToolGrants.js";
import { ensureDefaultRuntimeProfile, seedMainlineRoomsForAllProjects, seedServerHost } from "./support/domainSeeds.js";
import { invocationDelivery } from "./support/runtimeDelivery.js";

const SPACE = "61111111-1111-4111-8111-111111111111";
const USER = "6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "6ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const VERSION = "6ddddddd-dddd-4ddd-8ddd-dddddddddddd";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let config: ReturnType<typeof loadConfig>;
let address: string;

beforeAll(async () => {
  if (!db.available) return;
  config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, PUBLIC_BASE_URL: "https://browser-only.invalid" });
  app = buildModuleServer(config, [hostsModule, runsModule]);
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(() => {
  __setAuthIdentityForTests(null);
});

afterAll(async () => {
  await app?.close();
});

async function makeRun(runId: string, status = "running"): Promise<void> {
  const allowance = dispatchToolAllowance();
  const grants = await buildRunToolGrants([...allowance], { allowed_tools: [...allowance] });
  await db.pool!.query(
    `INSERT INTO runs (id, space_id, agent_id, agent_version_id, project_id, trust_mode, run_type, trigger_origin, status, mode, owner_user_id, instructed_by_user_id, capabilities_json, permission_snapshot_json, created_at, updated_at, execution_kind, runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json) VALUES ($1, $2, $3, $4, $5, 'trusted_host', 'system', 'manual', $6, 'live', $7, $7, $8::jsonb, $9::jsonb, now(), now(), 'agent', (SELECT p.id FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), 'default', (SELECT p.runtime_key FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), (SELECT jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key, 'backend_mode', p.backend_mode, 'model_provider_id', p.model_provider_id, 'model_name', p.model_name, 'runtime_config_json', p.runtime_config_json, 'runtime_policy_json', p.runtime_policy_json) FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE))`,
    [
      runId, SPACE, AGENT, VERSION, PROJECT, status, USER,
      JSON.stringify([...allowance]),
      JSON.stringify({ tool_grants: grants, scenario_tool_allowance: [...allowance] }),
    ],
  );
}

function get(runId: string, path: string, token: string | null) {
  return callRunTool(config, runId, token ?? "", path.startsWith("tools/") ? path.slice("tools/".length) : undefined);
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool!,
    ["run_tool_identities", "runs", "actors", "agent_versions", "agents", "projects",
      "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  await db.pool!.query(
    `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
     VALUES ($1, 'Owner', 'active', now(), now(), lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [USER],
  );
  await db.pool!.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Tool Surface Space', 'household', $2, now(), now())`, [SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'active', now(), now())`, [randomUUID(), SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Tool Surface Project', 'active', now(), now())`, [PROJECT, SPACE, USER],
  );
  await seedMainlineRoomsForAllProjects(db.pool!);
  await db.pool!.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
     VALUES ($1, $2, $3, 'Worker', 'active', 'standard', 'private', now(), now())`, [AGENT, SPACE, USER],
  );
  await db.pool!.query(
    `INSERT INTO agent_versions (
       id,
       agent_id,
       space_id,
       version_label,
       context_policy_json,
       memory_policy_json,
       capabilities_json,
       tool_permissions_json,
       created_at
     ) VALUES ($1, $2, $3, 'v1', '{}', '{}', '[]', '{}', now())`,
    [VERSION, AGENT, SPACE],
  );
  await db.pool!.query(`UPDATE agents SET current_version_id = $2 WHERE id = $1`, [AGENT, VERSION]);
  await ensureDefaultRuntimeProfile(db.pool!, { agent: AGENT, space: SPACE });
});

describe("the Run tool surface", () => {
  it.for(["agent.delegate", "task.list", null] as const)("supplies current Work Skill instructions on ACP resume with grant %s", async (action, ctx) => {
    if (!db.available) return ctx.skip();
    const hostId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), threadId = randomUUID();
    const vendorSessionId = "retained-session";
    await seedServerHost(db.pool, { id: hostId });
    await makeRun(runId);
    await db.pool.query(`INSERT INTO sessions (id, space_id, user_id, agent_id, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'active', now(), now())`, [sessionId, SPACE, USER, AGENT]);
    await db.pool.query(`INSERT INTO host_threads (id, space_id, execution_host_id, workspace_mode, session_id,
      agent_id, container_kind, runtime_key, vendor_session_id, created_by_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, 'managed', $4, $5, 'conversation', 'opencode', $6, $7, now(), now())`,
    [threadId, SPACE, hostId, sessionId, AGENT, vendorSessionId, USER]);
    const allowed = action ? [action] : [];
    const grants = await buildRunToolGrants(allowed, { allowed_tools: allowed });
    await db.pool.query(`UPDATE runs SET session_id=$2, host_task_thread_id=$3, permission_snapshot_json=$4::jsonb WHERE id=$1`,
      [runId, sessionId, threadId, JSON.stringify({ tool_grants: grants })]);
    await db.pool.query(`INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, created_at, updated_at)
      VALUES ($1, $2, $3, 1, 'running', now(), now())`, [randomUUID(), SPACE, runId]);
    const run = (await new PgRunRepository(db.pool, config).getAgentRun(SPACE, runId))!;
    const request = "Ask Claude for an independent review.";
    const delivery = invocationDelivery(request);
    // The resumed runtime has no Rainver hints in the retained context, as after compaction.
    delivery.planned_items = delivery.planned_items.filter(item => item.semantic_role === "user_input");
    delivery.message_blocks = delivery.message_blocks.filter(block => block.semantic_role === "user_input");
    const sent: Record<string, unknown>[] = [];
    const result = await executeRemoteHostCliAdapter({ run, prompt: "", invocation_delivery: delivery,
      model: null, resume_session_id: vendorSessionId }, hostId, null, {
      config, db: db.pool, bindings: NO_PROVIDER_BINDINGS,
      executor: { async runCommand(input) {
        const controller = input.stdio_controller!;
        const send = (message: Record<string, unknown>) => { sent.push(message); };
        const close = () => {};
        controller.start(send);
        await controller.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }, send, close);
        await controller.receive({ jsonrpc: "2.0", id: 2, result: { sessionId: vendorSessionId } }, send, close);
        const prompt = sent.find(message => message.method === "session/prompt");
        if (prompt) await controller.receive({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } }, send, close);
        return { returncode: 0, stdout: "", stderr: "", timed_out: false };
      } },
    });
    expect(result).toMatchObject({ success: true, error_code: null });
    expect(sent).toContainEqual(expect.objectContaining({ method: "session/resume", params: expect.objectContaining({ sessionId: vendorSessionId }) }));
    const prompt = sent.find(message => message.method === "session/prompt")!.params as { prompt: { text: string }[] };
    expect(prompt.prompt[0]?.text).toBe(request);
    const instructions = prompt.prompt.slice(1).map(block => block.text).join("\n");
    expect(instructions.includes("rainver:work-skill-path")).toBe(action !== null);
    expect(instructions.includes("$RAINVER_CLI list")).toBe(action !== null);
    expect(instructions.includes("agent.delegate")).toBe(action === "agent.delegate");
    expect(instructions.includes('workspace_access: "read"')).toBe(action === "agent.delegate");
    expect(instructions).not.toContain("project.propose_definition");
  });

  it("lists exactly the actions the Run was granted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await get(run, "tools", token);

    expect(response.statusCode).toBe(200);
    const names = (response.json() as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["task.list", "task.report", "artifact.submit"]));
    expect(names).not.toContain("memory.remember");
  });

  it("describes one action with the schema its input is validated against", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await get(run, "tools/artifact.submit", token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; input_schema: { required?: string[] } };
    expect(body.name).toBe("artifact.submit");
    expect(body.input_schema.required).toEqual(
      expect.arrayContaining(["task_id", "path", "artifact_type"]),
    );
  });

  it("answers an explicit permission refusal for an action this Run was not granted, without confirming it exists", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const granted = await get(run, "tools/memory.remember", token);
    const invented = await get(run, "tools/not.an.action", token);

    expect(granted.statusCode).toBe(403);
    expect(invented.statusCode).toBe(403);
    // Identical but for the name the caller itself sent: a real action this Run
    // does not hold and a name nobody registered are indistinguishable, so the
    // surface never confirms what exists elsewhere.
    const shape = (body: unknown, action: string) =>
      JSON.stringify(body).split(action).join("<action>");
    expect(shape(granted.json(), "memory.remember")).toEqual(shape(invented.json(), "not.an.action"));
  });

  it("uses the existing authenticated Host socket for a remote CLI and refuses other Hosts and old launches", async () => {
    const run = randomUUID();
    const launchId = randomUUID();
    await makeRun(run);
    const identities = new PgRunToolIdentityRepository(db.pool);
    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000, "hash", launchId);
    const hosts = new PgHostRepository(db.pool);
    const root = await mkdtemp(join(tmpdir(), "rainver-tool-socket-"));
    const sockets: WebSocket[] = [];
    const channels: Array<() => void> = [];
    let hostId: string | undefined;
    const connect = async (name: string) => {
      const pairing = await hosts.issuePairingCode(USER, name);
      if (!("pairing_code" in pairing)) throw new Error(pairing.detail);
      const info = { platform: "linux", arch: "x64", daemon_version: MIN_HOST_DAEMON_VERSION, environment_kind: "linux_native", capabilities_json: {}, workspace_reports: [], managed_workspaces: [], ambient_sessions: [] };
      const host = await hosts.registerViaPairingCode(pairing.pairing_code, info);
      if (!("token" in host)) throw new Error(host.detail);
      const OpenSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      const socket = new OpenSocket(address.replace(/^http/, "ws") + "/internal/hosts/ws",
        { headers: { Authorization: `Bearer ${host.token}` } });
      sockets.push(socket);
      const channel = new RunToolChannel();
      const send = (frame: HostDaemonFrame) => {
        if (socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(frame));
        return true;
      };
      let onLaunch: ((frame: Extract<HostServerFrame, { type: "launch" }>) => void) | undefined;
      const launched = new Promise<Extract<HostServerFrame, { type: "launch" }>>((resolve) => { onLaunch = resolve; });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("error", reject, { once: true });
        socket.addEventListener("open", () => send({ type: "hello", token: host.token, ...info }));
        socket.addEventListener("message", (event) => {
          const frame = HostServerFrameSchema.parse(JSON.parse(String(event.data)));
          if (frame.type === "hello_ack") { channel.bind(send); resolve(); }
          if (frame.type === "launch") onLaunch?.(frame);
          if (frame.type === "run_tool_result") channel.receive(send, frame);
        });
      });
      channels.push(() => channel.disconnect(send));
      return { ...host, channel, launched };
    };
    try {
      const paired = await connect("Tool Host");
      hostId = paired.host_id;
      const other = await connect("Other Host");
      void sharedHostConnectionRegistry.dispatchLaunch(hostId, run, {
        argv: ["test-runtime"], work_surface: { dir_env: {}, files: [], run_tool_token: token },
      }, undefined, undefined, undefined, null, launchId);
      const frame = await paired.launched;
      const identity = { run_id: frame.run_id, launch_id: frame.launch_id, token: frame.work_surface!.run_tool_token! };
      const request = { id: randomUUID(), method: "GET" as const, path: "tools" };
      expect((await other.channel.invoke(identity, request, AbortSignal.timeout(2000))).status).toBe(403);
      expect((await paired.channel.invoke({ ...identity, launch_id: randomUUID() }, request, AbortSignal.timeout(2000))).status).toBe(403);
      const bridge = await startLocalToolBridge(root, (input, signal) => paired.channel.invoke(identity, input, signal));
      try {
        const cli = join(import.meta.dirname, "../../packages/agent-cli/src/rainver.ts");
        const result = await promisify(execFile)(process.execPath, [cli, "list"], {
          env: { ...process.env, RAINVER_TOOL_BRIDGE: bridge.endpoint },
        });
        expect(JSON.parse(result.stdout)).toMatchObject({ run_id: run, tools: expect.arrayContaining([expect.objectContaining({ name: "task.list" })]) });
        const schema = await promisify(execFile)(process.execPath, [cli, "describe", "artifact.submit"], {
          env: { ...process.env, RAINVER_TOOL_BRIDGE: bridge.endpoint },
        });
        expect(JSON.parse(schema.stdout)).toMatchObject({ name: "artifact.submit" });
        const refused = await paired.channel.invoke(identity, {
          id: randomUUID(), method: "POST", path: "tools/memory.remember", body: { content: "Not granted" },
        }, AbortSignal.timeout(2000));
        expect(refused.status).toBe(403);
        expect(JSON.parse(refused.text)).toMatchObject({ error_code: "system_action_not_granted" });
        await identities.revoke(run);
        expect((await paired.channel.invoke(identity, request, AbortSignal.timeout(2000))).status).toBe(401);
        expect((await app!.inject({ method: "GET", url: `/api/v1/runs/${run}/tools` })).statusCode).toBe(404);
      } finally { await bridge.close(); }
    } finally {
      for (const disconnect of channels) disconnect();
      if (hostId) sharedHostConnectionRegistry.receiveComplete(hostId, run, { exit_code: 0, timed_out: false, error: null }, launchId);
      await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      })));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a request with no token, a wrong token, or another Run's token", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    const other = randomUUID();
    await makeRun(run);
    await makeRun(other);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const otherToken = await identities.issue({ id: other, space_id: SPACE }, 60_000, "hash");

    expect((await get(run, "tools", null)).statusCode).toBe(401);
    expect((await get(run, "tools", "not-a-token")).statusCode).toBe(401);
    // The token is live — for a different Run. It must not reach this one.
    expect((await get(run, "tools", otherToken)).statusCode).toBe(401);
  });

  it("refuses a live token once its Run has stopped running", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");
    await db.pool!.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [run]);

    const response = await get(run, "tools", token);

    expect(response.statusCode).toBe(403);
  });

  it("refuses a revoked token", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000, "hash");
    await identities.revoke(run);

    expect((await get(run, "tools", token)).statusCode).toBe(401);
  });

  it("refuses to call an action the Run was not granted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const token = await new PgRunToolIdentityRepository(db.pool!)
      .issue({ id: run, space_id: SPACE }, 60_000, "hash");

    const response = await callRunTool(config, run, token, "memory.remember", { content: "remember this", rationale: "because" });

    // A refusal the agent can read, not a transport error: the dispatcher
    // answers `ok: false` for an ungranted action.
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, error_code: "system_action_not_granted" });
  });

  it("refuses a call with no token before it reaches any action", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);

    const response = await callRunTool(config, run, "", "task.list", {});

    expect(response.statusCode).toBe(401);
  });
});

describe("the Run detail's Work Skill provenance", () => {
  function detail(runId: string) {
    return app!.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
  }

  it("names the Skill the latest attempt was given, after the identity is revoked", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    const identities = new PgRunToolIdentityRepository(db.pool!);
    await identities.issue({ id: run, space_id: SPACE }, 60_000, "a".repeat(64));
    // A retried attempt is given the Skill afresh; the Run names that one.
    const token = await identities.issue({ id: run, space_id: SPACE }, 60_000, workSkillContentHash());
    await identities.revoke(run);
    await db.pool!.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [run]);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });

    const response = await detail(run);

    expect(response.statusCode).toBe(200);
    expect(response.json().work_skill).toEqual({ content_hash: workSkillContentHash() });
    const digest = await db.pool!.query<{ token_digest: string }>(
      `SELECT token_digest FROM run_tool_identities WHERE run_id = $1`, [run],
    );
    expect(response.body).not.toContain(digest.rows[0]!.token_digest);
    expect(response.body).not.toContain(token);
  });

  it("names no Skill for a Run never dispatched with a work surface", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run, "queued");
    __setAuthIdentityForTests({ spaceId: SPACE, userId: USER });

    const response = await detail(run);

    expect(response.statusCode).toBe(200);
    expect(response.json().work_skill).toBeNull();
  });

  it("returns 404 for the Run from another Space, without its Skill", async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = randomUUID();
    await makeRun(run);
    await new PgRunToolIdentityRepository(db.pool!).issue({ id: run, space_id: SPACE }, 60_000, workSkillContentHash());
    __setAuthIdentityForTests({ spaceId: randomUUID(), userId: USER });

    const response = await detail(run);

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(workSkillContentHash());
  });
});
