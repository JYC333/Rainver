import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostCommandHarness } from "./support/hostCommandHarness.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { agentHostResetFence } from "../src/modules/hosts/hostCommands.js";
import { wakeHostCommandsForHost } from "../src/modules/hosts/hostCommandWorker.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { networkedResumeVerdict } from "../src/modules/runs/sensitiveRuntimeProfile.js";

/**
 * `agent.host_state.reset` (`POST /api/v1/agents/:agentId/host-state/reset`),
 * "clear this Agent's CLI memory on this host", as a journaled Host command.
 *
 * The admission transaction checks who may reach it and what it refuses,
 * retires the Agent's vendor sessions there and commits the intent; the Host
 * archive happens after commit, under the command's identity, and every launch
 * of the Agent on that Host waits on the fence until the Host settles it. The
 * daemon-side journal has its own tests in `packages/host-daemon`.
 */

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let commands: ReturnType<typeof hostCommandHarness>;

const url = (agentId: string) => `/api/v1/agents/${agentId}/host-state/reset`;
const reset = (agentId: string, body: Record<string, unknown>, key?: string) =>
  commands.submit(app!, { method: "POST", url: url(agentId), payload: body }, key);
const fence = () => withQueryableTransaction(db.pool, (tx) => agentHostResetFence(tx, HOST, AGENT));
const intent = async (id: string) => (await db.pool.query<{ status: string; error_code: string | null; effect_json: Record<string, unknown> }>(
  "SELECT status, error_code, effect_json FROM host_command_intents WHERE id = $1", [id])).rows[0]!;

async function directThread(vendorSession: string | null = "vendor-1", dispatchLock: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO host_threads (
       id, space_id, execution_host_id, workspace_mode, agent_id, container_kind, container_user_id,
       runtime_key, runtime_installation, status, vendor_session_id, dispatch_lock_id, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 'managed', $4, 'direct', $5, 'claude_code', 'own', 'active', $6, $7, $5, now(), now())`,
    [id, SPACE, HOST, AGENT, OWNER, vendorSession, dispatchLock],
  );
  return id;
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["host_command_intents", "jobs", "runs", "host_threads", "tasks", "workspace_locations", "project_folders", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source)
     VALUES ($1, 'other@example.com', 'Other', 'active', $2, $2, 'system')`,
    [OTHER, now],
  );
  await db.pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'member', 'active', $4, $4)`,
    [randomUUID(), SPACE, OTHER, now],
  );
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  // `seedAgentWithVersion` makes a space_shared Agent; the owner check only
  // bites when the Agent has one, so say so explicitly.
  await db.pool.query(`UPDATE agents SET owner_user_id = $2, visibility = 'private' WHERE id = $1`, [AGENT, OWNER]);
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', '{"host_command_receipts":1}'::jsonb, $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  app = buildModuleServer(config, [hostsModule]);
  commands = hostCommandHarness(db.pool, config);
  __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

describe("clearing an Agent's host state", () => {
  it("requires a host, and hides one the caller does not own", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect((await reset(AGENT, {})).statusCode).toBe(422);
    // A Host is user-scoped (B63). Someone else's machine is not this
    // person's to clear, and is indistinguishable from none.
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, OTHER]);
    expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(404);
    expect((await db.pool.query("SELECT 1 FROM host_command_intents")).rowCount).toBe(0);
  });

  it("hides an Agent outside the Space and one the caller does not own", async (ctx) => {
    if (!db.available) return ctx.skip();
    expect((await reset(randomUUID(), { host_id: HOST })).statusCode).toBe(404);
    // The Agent's owner decides what it remembers. A member who happens to
    // own the machine it runs on does not.
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    await db.pool.query(`UPDATE hosts SET owner_user_id = $2 WHERE id = $1`, [HOST, OTHER]);
    expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(404);
  });

  it("refuses a Host that cannot journal the reset, before retiring anything", async (ctx) => {
    if (!db.available) return ctx.skip();
    const thread = await directThread();
    await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
    const refused = await reset(AGENT, { host_id: HOST });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ metadata: { code: "host_update_required" } });
    expect((await db.pool.query("SELECT vendor_session_id FROM host_threads WHERE id = $1", [thread])).rows[0]).toEqual({ vendor_session_id: "vendor-1" });
  });

  it("clears an ownerless Agent for whoever owns the machine, through a journaled command", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The `space_shared` Space and Project Assistants have no owner. The state
    // being cleared is on the caller's own machine (ADR 0003 §4).
    await db.pool.query(`UPDATE agents SET owner_user_id = NULL, visibility = 'space_shared' WHERE id = $1`, [AGENT]);
    const thread = await directThread();
    vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(true);
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand").mockResolvedValue({
      sent: true, outcome: "completed", replayed: false, error: null,
      result: { type: "managed_workspace_result", request_id: "r1", action: "reset", ok: true, changed: true, error: null },
    });
    const { receipt, status } = await commands.run(app!, { method: "POST", url: url(AGENT), payload: { host_id: HOST } }, HOST);
    expect(status).toMatchObject({ status: "succeeded", kind: "agent_host_state_reset", result: { agent_id: AGENT, host_id: HOST, profiles_archived: true, sessions_retired: 1 } });
    expect(send).toHaveBeenCalledWith(HOST, expect.objectContaining({ command_id: receipt.id, command: expect.objectContaining({ type: "agent_profiles_reset", agent_id: AGENT }) }), expect.any(Number));
    expect((await db.pool.query("SELECT status, vendor_session_id FROM host_threads WHERE id = $1", [thread])).rows[0]).toEqual({ status: "session_reset", vendor_session_id: null });
    expect(await fence()).toBeNull();
  });

  it("refuses while a dispatch holds this Agent's thread, before touching the host", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The profile is what a launching run is about to read.
    await directThread(null, randomUUID());
    const response = await reset(AGENT, { host_id: HOST });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/handling a message/i);
    expect((await db.pool.query("SELECT 1 FROM host_command_intents")).rowCount).toBe(0);
  });

  it("refuses while a Task Run is in flight on this Agent's Location thread", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Task thread never claims the dispatch lock — its admission serialises
    // on the latest Run's status — so the lock alone could not see this Run.
    const now = new Date().toISOString();
    const folder = randomUUID();
    const location = randomUUID();
    const task = randomUUID();
    await db.pool.query(
      `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
       VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
      [folder, SPACE, PROJECT, now],
    );
    await db.pool.query(
      `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         display_path, execution_ready, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`,
      [location, SPACE, folder, HOST, now],
    );
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, created_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Test task', 'ready', $5, $6, $6)`,
      [task, SPACE, PROJECT, folder, OWNER, now],
    );
    const thread = await new PgHostThreadRepository(db.pool).create({
      executionHostId: HOST, workspaceLocationId: location, taskId: task, runtimeKey: "claude_code", createdByUserId: OWNER,
    });
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode, owner_user_id, visibility, host_task_thread_id, created_at, updated_at, execution_kind, runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json)
       VALUES ($1, $2, $3, $4, 'system', 'manual', 'running', 'live', $5, 'private', $6, now(), now(), 'agent', (SELECT p.id FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), 'default', (SELECT p.runtime_key FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE), (SELECT jsonb_build_object('id', p.id, 'runtime_key', p.runtime_key, 'backend_mode', p.backend_mode, 'model_provider_id', p.model_provider_id, 'model_name', p.model_name, 'runtime_config_json', p.runtime_config_json, 'runtime_policy_json', p.runtime_policy_json) FROM agent_runtime_profiles p WHERE p.space_id = $2::varchar(36) AND p.agent_id = $3::varchar(36) AND p.is_default = TRUE))`,
      [runId, SPACE, AGENT, VERSION, OWNER, thread.id],
    );

    const refused = await reset(AGENT, { host_id: HOST });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/in flight/i);
    await expect(db.pool.query<{ status: string }>(`SELECT status FROM host_threads WHERE id = $1`, [thread.id]))
      .resolves.toMatchObject({ rows: [{ status: "active" }] });

    // Once the Run has settled the guard admits the reset.
    await db.pool.query(`UPDATE runs SET status = 'succeeded' WHERE id = $1`, [runId]);
    expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
  });

  describe("a Task Run of this Agent waiting for review on a shared Location thread (ADR 0036 §15)", () => {
    const OTHER_AGENT = "99999999-9999-4999-8999-999999999999";
    const OTHER_VERSION = "88888888-8888-4888-8888-888888888888";
    const PROFILE_KEY = (agent: string) => `agents/${agent}/location/loc/claude_code/ambient`;
    let tick = 0;
    /** A Location Task thread on this Host. */
    const locationThread = async () => {
      const now = new Date().toISOString();
      const folder = randomUUID(), location = randomUUID(), task = randomUUID();
      await db.pool.query(`INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
        VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`, [folder, SPACE, PROJECT, now]);
      await db.pool.query(`INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
          display_path, execution_ready, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`, [location, SPACE, folder, HOST, now]);
      await db.pool.query(`INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, created_by_user_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'Test task', 'ready', $5, $6, $6)`, [task, SPACE, PROJECT, folder, OWNER, now]);
      return (await new PgHostThreadRepository(db.pool).create({
        executionHostId: HOST, workspaceLocationId: location, taskId: task, runtimeKey: "claude_code", createdByUserId: OWNER,
      })).id;
    };
    /** A Task Run on the thread, created in order, whose open attempt was launched through the real bind. */
    const launchedRun = async (thread: string, agent: string, version: string, resumes: string | null) => {
      const id = randomUUID();
      tick += 1;
      await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent, version, existingAgent: true,
        now: new Date(Date.UTC(2026, 10, 23, 0, 0, tick)).toISOString() });
      await db.pool.query(`UPDATE runs SET status='running', host_task_thread_id=$2,
          model_override_json=jsonb_build_object('host_thread', jsonb_build_object('schema_version','host_thread.v1','runtime_session_id',$3::text))
        WHERE id=$1`, [id, thread, resumes]);
      await db.pool.query(`INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, started_at, created_at, updated_at)
        VALUES ($1, $2, $3, 1, 'running', now(), now(), now())`, [randomUUID(), SPACE, id]);
      const launch = randomUUID();
      expect(await new PgRunRepository(db.pool).bindAttemptLaunch({ space_id: SPACE, run_id: id, launch_id: launch,
        isolation: { host_id: HOST, host_kind: "remote", egress_profile: "default", sandbox_mode: "read_write", profile_key: PROFILE_KEY(agent) } })).toBe(true);
      return { id, launch };
    };
    /** `authorization.request` paused the Run (and its attempt) while its launch is still reporting. */
    const pause = (runId: string) => db.pool.query(
      `WITH r AS (UPDATE runs SET status='waiting_for_review' WHERE id=$1 RETURNING id) UPDATE run_attempts SET status='waiting_for_review' WHERE run_id IN (SELECT id FROM r)`, [runId]);
    /** The orchestrator records the session the launch reported, once its adapter returns. */
    const park = (runId: string, session: string, launch: string) =>
      new PgRunRepository(db.pool).recordParkedHostThreadSession({ run_id: runId, space_id: SPACE, vendor_session_id: session, launch_id: launch });
    const verdict = (thread: string, runId: string, session: string, agent = AGENT) =>
      networkedResumeVerdict(db.pool, { threadId: thread, runId, vendorSessionId: session, profileKey: PROFILE_KEY(agent) });
    const retired = async (thread: string) => (await db.pool.query<{ ids: string[] }>(
      "SELECT retired_vendor_session_ids AS ids FROM host_threads WHERE id=$1", [thread])).rows[0].ids;

    it("locks and checks the thread although its latest Run is another Agent's, and a park reported after the reset never resumes", async (ctx) => {
      if (!db.available) return ctx.skip();
      await seedAgentWithVersion(db.pool, { agent: OTHER_AGENT, version: OTHER_VERSION, space: SPACE, owner: OWNER });
      const thread = await locationThread();
      // This Agent's Task Run launched, resuming the session it was created with, and was paused for review.
      const waiting = await launchedRun(thread, AGENT, VERSION, "vendor-early");
      await pause(waiting.id);
      // Another Agent ran on the same Location thread after it and parked too: its latest Run is not this Agent's.
      const foreign = await launchedRun(thread, OTHER_AGENT, OTHER_VERSION, null);
      await pause(foreign.id);
      await park(foreign.id, "vendor-foreign", foreign.launch);

      // Resumed (queued again) the waiting Run is in flight on that thread: the reset is refused there too.
      await db.pool.query("UPDATE runs SET status='queued' WHERE id=$1", [waiting.id]);
      const refused = await reset(AGENT, { host_id: HOST });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toMatch(/in flight/i);
      await db.pool.query("UPDATE runs SET status='waiting_for_review' WHERE id=$1", [waiting.id]);

      // Waiting for review, it is admitted; the session that Run was frozen to is retired and counted.
      const accepted = await reset(AGENT, { host_id: HOST });
      expect(accepted.statusCode).toBe(202);
      expect((await db.pool.query("SELECT frozen_json->>'sessions_retired' AS n FROM host_command_intents WHERE kind='agent_host_state_reset'")).rows[0].n).toBe("1");
      expect(await retired(thread)).toEqual(["vendor-early"]);

      // Only now does the paused launch's report arrive and the orchestrator park the Run in the session it named.
      await park(waiting.id, "vendor-late", waiting.launch);
      expect((await db.pool.query("SELECT model_override_json#>>'{host_thread,runtime_session_id}' AS s FROM runs WHERE id=$1", [waiting.id])).rows[0].s).toBe("vendor-late");
      // Its launch predates the reset: the session is retired and its resume refused before any frame.
      expect(await retired(thread)).toEqual(["vendor-early", "vendor-late"]);
      expect(await verdict(thread, waiting.id, "vendor-late")).toBe("unconfirmed");
      // Even had the retirement been lost, the frozen record alone refuses it.
      await db.pool.query("UPDATE host_threads SET retired_vendor_session_ids='[]'::jsonb WHERE id=$1", [thread]);
      expect(await verdict(thread, waiting.id, "vendor-late")).toBe("unconfirmed");
      // The other Agent's parked session is untouched by this Agent's reset.
      expect(await verdict(thread, foreign.id, "vendor-foreign", OTHER_AGENT)).toBe("resumable");
    });

    it("a launch bound after the reset parks and resumes as before; a late outcome of an earlier launch never becomes the pointer", async (ctx) => {
      if (!db.available) return ctx.skip();
      const thread = await locationThread();
      const before = await launchedRun(thread, AGENT, VERSION, null);
      await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1", [before.id]);
      expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
      // A Run launched after the reset (its record holds the new generation) parks and resumes legitimately.
      const after = await launchedRun(thread, AGENT, VERSION, null);
      expect((await db.pool.query("SELECT launch_isolation_json->>'host_reset_generation' AS g FROM run_attempts WHERE run_id=$1", [after.id])).rows[0].g).toBe("1");
      await pause(after.id);
      await park(after.id, "vendor-after", after.launch);
      expect(await verdict(thread, after.id, "vendor-after")).toBe("resumable");
      expect(await retired(thread)).toEqual([]);
      // The cancelled earlier launch reports late: its session is retired, not recorded as the pointer.
      const threads = new PgHostThreadRepository(db.pool);
      await threads.recordRunOutcome(thread, { lastRunId: before.id, vendorSessionId: "vendor-before", sessionReset: false });
      expect((await db.pool.query("SELECT vendor_session_id FROM host_threads WHERE id=$1", [thread])).rows[0].vendor_session_id).toBeNull();
      expect(await retired(thread)).toEqual(["vendor-before"]);
      // Once the Host settled the first reset, a second one makes that park stale in turn.
      await db.pool.query(`UPDATE host_command_intents SET status='succeeded', effect_json=effect_json||'{"receipt":{"at":"now"}}'::jsonb`);
      expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
      expect(await verdict(thread, after.id, "vendor-after")).toBe("unconfirmed");
    });

    describe("serialized with the reset (ADR 0036 §16)", () => {
      /** Polls until a backend of this test database waits on a heavyweight lock of `kind`, or `done` settles first. */
      const waitsOnLock = async (kind: "advisory" | "row", done: Promise<unknown>) => {
        let settled = false;
        void done.then(() => { settled = true; }, () => { settled = true; });
        const events = kind === "advisory" ? ["advisory"] : ["tuple", "transactionid"];
        for (let i = 0; i < 300 && !settled; i += 1) {
          const waiting = await db.pool.query(
            `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = ANY($1::text[])`,
            [events]);
          if (waiting.rowCount) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };

      it("a park arriving after the reset's scan but before its commit waits for it, is retired, and is never imported", async (ctx) => {
        if (!db.available) return ctx.skip();
        const thread = await locationThread();
        const waiting = await launchedRun(thread, AGENT, VERSION, "vendor-early");
        await pause(waiting.id);
        // The reset admission, through its real route, scans this Agent's parked sessions; the paused launch's report
        // arrives right after that scan, while the reset's transaction is still open.
        const original = PgHostThreadRepository.prototype.retireAgentSessionsOnHost;
        let parked: Promise<void> | null = null;
        let parkBlocked = false;
        vi.spyOn(PgHostThreadRepository.prototype, "retireAgentSessionsOnHost").mockImplementation(
          async function (this: PgHostThreadRepository, agentId: string, hostId: string) {
            const count = await original.call(this, agentId, hostId);
            parked = park(waiting.id, "vendor-late", waiting.launch);
            parkBlocked = await waitsOnLock("advisory", parked);
            return count;
          });
        expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
        await parked;
        // The park did not commit inside the reset's window: it waited on the fence and ran after the intent.
        expect(parkBlocked).toBe(true);
        expect((await db.pool.query("SELECT model_override_json#>>'{host_thread,runtime_session_id}' AS s FROM runs WHERE id=$1", [waiting.id])).rows[0].s).toBe("vendor-late");
        expect(await retired(thread)).toEqual(["vendor-early", "vendor-late"]);
        expect(await verdict(thread, waiting.id, "vendor-late")).toBe("unconfirmed");
        // Ambient import treats it as the Agent's session, not the owner's history.
        const location = (await db.pool.query<{ id: string }>("SELECT workspace_location_id AS id FROM host_threads WHERE id=$1", [thread])).rows[0].id;
        const listed = () => new PgHostThreadRepository(db.pool).listVendorSessionIds({ workspaceLocationId: location, runtimeKey: "claude_code", runtimeInstallation: "own" });
        expect(await listed()).toContain("vendor-late");
        // Even were its retirement lost, the Run's own parked session is excluded from import.
        await db.pool.query("UPDATE host_threads SET retired_vendor_session_ids='[]'::jsonb WHERE id=$1", [thread]);
        expect(await listed()).toContain("vendor-late");
      });

      it("a park after the reset with no trusted launch record is retired too", async (ctx) => {
        if (!db.available) return ctx.skip();
        const thread = await locationThread();
        const waiting = await launchedRun(thread, AGENT, VERSION, null);
        await pause(waiting.id);
        expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
        await new PgRunRepository(db.pool).recordParkedHostThreadSession({ run_id: waiting.id, space_id: SPACE, vendor_session_id: "vendor-unrecorded", launch_id: null });
        expect(await retired(thread)).toEqual(["vendor-unrecorded"]);
        expect(await verdict(thread, waiting.id, "vendor-unrecorded")).toBe("unconfirmed");
      });

      it("a launch recorded before generations is judged on its attempt's creation, not a re-claim's start after approval", async (ctx) => {
        if (!db.available) return ctx.skip();
        const thread = await locationThread();
        const legacy = await launchedRun(thread, AGENT, VERSION, null);
        // A record bound before generations were kept, on an attempt created a minute ago.
        await db.pool.query(`UPDATE run_attempts SET launch_isolation_json = launch_isolation_json - 'host_reset_generation',
            created_at = now() - interval '1 minute', started_at = now() - interval '1 minute' WHERE run_id=$1`, [legacy.id]);
        await pause(legacy.id);
        await park(legacy.id, "vendor-legacy", legacy.launch);
        expect(await verdict(thread, legacy.id, "vendor-legacy")).toBe("resumable");
        expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
        // Judged on the record alone: drop what the reset retired.
        await db.pool.query("UPDATE host_threads SET retired_vendor_session_ids='[]'::jsonb WHERE id=$1", [thread]);
        expect(await verdict(thread, legacy.id, "vendor-legacy")).toBe("unconfirmed");
        // The approval puts the same attempt back in the queue and the real claim takes it again, rewriting its start.
        const attempt = (await db.pool.query<{ id: string }>("SELECT id FROM run_attempts WHERE run_id=$1", [legacy.id])).rows[0].id;
        await db.pool.query(`WITH r AS (UPDATE runs SET status='queued' WHERE id=$1 RETURNING id)
          UPDATE run_attempts SET status='queued' WHERE run_id IN (SELECT id FROM r)`, [legacy.id]);
        const reclaimedAt = new Date(Date.now() + 60_000).toISOString();
        expect((await new PgRunRepository(db.pool).claimRunExecution({ space_id: SPACE, run_id: legacy.id, started_at: reclaimedAt })).outcome).toBe("started");
        const after = (await db.pool.query<{ id: string; later: boolean }>(
          `SELECT a.id, a.started_at > (SELECT max(created_at) FROM host_command_intents) AS later FROM run_attempts a WHERE a.run_id=$1`, [legacy.id])).rows;
        expect(after).toEqual([{ id: attempt, later: true }]);
        // Still the launch from before the reset: its parked session and its late outcome are refused.
        expect(await verdict(thread, legacy.id, "vendor-legacy")).toBe("unconfirmed");
        await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1", [legacy.id]);
        await new PgHostThreadRepository(db.pool).recordRunOutcome(thread, { lastRunId: legacy.id, vendorSessionId: "vendor-legacy-outcome", sessionReset: false });
        expect((await db.pool.query("SELECT vendor_session_id FROM host_threads WHERE id=$1", [thread])).rows[0].vendor_session_id).toBeNull();
        expect(await retired(thread)).toContain("vendor-legacy-outcome");
      });

      it("locks the threads it covers in id order, so two Agents' resets over shared Location threads cannot deadlock", async (ctx) => {
        if (!db.available) return ctx.skip();
        await seedAgentWithVersion(db.pool, { agent: OTHER_AGENT, version: OTHER_VERSION, space: SPACE, owner: OWNER });
        const LOW = "00000000-0000-4000-8000-000000000001", HIGH = "ffffffff-ffff-4fff-8fff-fffffffffff1";
        const first = await locationThread(), second = await locationThread();
        // The higher id written first, so a scan in physical order meets it before the lower one.
        await db.pool.query("UPDATE host_threads SET id=$2 WHERE id=$1", [first, HIGH]);
        await db.pool.query("UPDATE host_threads SET id=$2 WHERE id=$1", [second, LOW]);
        for (const thread of [HIGH, LOW]) {
          for (const [agent, version] of [[AGENT, VERSION], [OTHER_AGENT, OTHER_VERSION]] as const) {
            const run = await launchedRun(thread, agent, version, null);
            await pause(run.id);
          }
        }
        // Another writer holds the higher thread: the reset must already hold the lower one while it waits.
        const blocker = await db.pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT 1 FROM host_threads WHERE id=$1 FOR UPDATE", [HIGH]);
          const pending = reset(AGENT, { host_id: HOST });
          expect(await waitsOnLock("row", pending)).toBe(true);
          const probe = await db.pool.connect();
          try {
            await probe.query("BEGIN");
            await expect(probe.query("SELECT 1 FROM host_threads WHERE id=$1 FOR UPDATE NOWAIT", [LOW])).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await probe.query("ROLLBACK");
            probe.release();
          }
          await blocker.query("ROLLBACK");
          expect((await pending).statusCode).toBe(202);
        } finally {
          blocker.release();
        }
        // Both Agents' resets, at once, over the same two threads: each is admitted.
        await db.pool.query(`UPDATE host_command_intents SET status='succeeded', effect_json=effect_json||'{"receipt":{"at":"now"}}'::jsonb`);
        const both = await Promise.all([reset(AGENT, { host_id: HOST }, "again-a"), reset(OTHER_AGENT, { host_id: HOST }, "again-b")]);
        expect(both.map((response) => response.statusCode)).toEqual([202, 202]);
      });
    });
  });

  it("refuses while a Room re-add restore of this Agent on this Host is unfinished, and admits once it settles", async (ctx) => {
    if (!db.available) return ctx.skip();
    await directThread();
    await db.pool.query(
      `INSERT INTO jobs (id, job_type, space_id, user_id, agent_id, status, priority, payload_json, attempts, max_attempts, scheduled_at, created_at, updated_at)
       VALUES ('restore-job', 'room_agent_workspace_restore', $1, $2, $3, 'pending', 0, $4::jsonb, 0, 5, now(), now(), now())`,
      [SPACE, OWNER, AGENT, JSON.stringify({ agent_id: AGENT, host_id: HOST, thread_id: "t", room_id: "r", conversation_id: "c" })]);
    const refused = await reset(AGENT, { host_id: HOST });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.metadata).toMatchObject({ code: "host_restore_in_progress" });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM host_command_intents")).rows[0].n).toBe(0);
    // Its retirement rolled back with the refusal: the vendor session is still the thread's.
    expect((await db.pool.query("SELECT vendor_session_id FROM host_threads WHERE agent_id = $1", [AGENT])).rows[0].vendor_session_id).toBe("vendor-1");
    await db.pool.query(`UPDATE jobs SET status = 'completed' WHERE id = 'restore-job'`);
    expect((await reset(AGENT, { host_id: HOST })).statusCode).toBe(202);
  });

  it("holds launches on the fence while the Host is offline or its answer is lost, and replays the same command", async (ctx) => {
    if (!db.available) return ctx.skip();
    await directThread();
    const accepted = await reset(AGENT, { host_id: HOST }, "reset-offline");
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().data.id as string;
    // A second reset of the same Agent here is the same scope: refused, never a second effect.
    const busy = await reset(AGENT, { host_id: HOST });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.metadata).toMatchObject({ code: "host_command_busy", command_id: id });

    // Offline: nothing leaves; the command waits, and the fence holds.
    vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(false);
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    await commands.process();
    expect(send).not.toHaveBeenCalled();
    expect(await intent(id)).toMatchObject({ status: "pending" });
    expect((await fence())?.id).toBe(id);

    // Online, and the answer is lost after the frame left: dispatched, still fenced, retried later.
    vi.mocked(sharedHostConnectionRegistry.isOnline).mockReturnValue(true);
    send.mockResolvedValueOnce({ sent: true, outcome: null, replayed: false, result: null, error: "host_timeout" });
    await wakeHostCommandsForHost(db.pool, HOST);
    await commands.process();
    const lost = await intent(id);
    expect(lost.status).toBe("dispatched");
    expect(lost.effect_json).toMatchObject({ journaled: true, sends: 1 });
    expect((await fence())?.id).toBe(id);

    // The repeat carries the same identity; the Host's journal replays its receipt.
    send.mockResolvedValueOnce({ sent: true, outcome: "completed", replayed: true, error: null,
      result: { type: "managed_workspace_result", request_id: "first-send", action: "reset", ok: true, changed: true, error: null } });
    await wakeHostCommandsForHost(db.pool, HOST);
    await commands.process();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1].command_id).toBe(id);
    expect(send.mock.calls[1]![1]).toEqual(send.mock.calls[0]![1]);
    expect(await intent(id)).toMatchObject({ status: "succeeded" });
    expect(await fence()).toBeNull();

    // A transport retry of the request replays its receipt; after the Host is revoked
    // neither the replay nor the status read releases anything.
    expect((await reset(AGENT, { host_id: HOST }, "reset-offline")).json()).toEqual(accepted.json());
    expect((await commands.status(app!, HOST, id)).json()).toMatchObject({ status: "succeeded", result: { profiles_archived: true } });
    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    expect((await reset(AGENT, { host_id: HOST }, "reset-offline")).statusCode).toBe(404);
    expect((await commands.status(app!, HOST, id)).statusCode).toBe(404);
  });

  it("keeps the fence closed on a reset that was sent and whose Job was then cancelled", async (ctx) => {
    if (!db.available) return ctx.skip();
    await directThread();
    const id = (await reset(AGENT, { host_id: HOST })).json().data.id as string;
    vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(true);
    vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand").mockResolvedValue({ sent: true, outcome: null, replayed: false, result: null, error: "host_disconnected" });
    await commands.process();
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE id = (SELECT job_id FROM host_command_intents WHERE id = $1)`, [id]);
    // Sent, never confirmed: unknown, so it reads as needs_attention and still holds launches.
    expect((await fence())?.id).toBe(id);
    expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_job_cancelled" });
    // The confirmation the fence waits for is the earlier command's own receipt: the next reset
    // re-delivers its exact identity before sending itself (`agentHostResetReconcileHostDb`).
    vi.mocked(sharedHostConnectionRegistry.requestHostCommand).mockResolvedValue({ sent: true, outcome: "completed", replayed: true, error: null,
      result: { type: "managed_workspace_result", request_id: "x", action: "reset", ok: true, changed: false, error: null } });
    const { receipt, status } = await commands.run(app!, { method: "POST", url: url(AGENT), payload: { host_id: HOST } }, HOST);
    expect(status.status).toBe("succeeded");
    expect(vi.mocked(sharedHostConnectionRegistry.requestHostCommand).mock.calls.map((call) => call[1].command_id)).toEqual([id, id, receipt.id]);
    expect((await intent(id)).effect_json.receipt).toMatchObject({ by: receipt.id });
    expect(await fence()).toBeNull();
  });
});
