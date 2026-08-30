import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { PgRoomRepository } from "../src/modules/rooms/repository.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOLDER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";
const HOST = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const MIXED_THREAD = "77777777-7777-4777-8777-777777777777";

const db = useTestDatabase(import.meta.filename);
let roomId = "";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "host_threads",
      "workspace_locations",
      "project_folders",
      "tasks",
      "agents",
      "agent_versions",
      "rooms",
      "projects",
      "hosts",
      "machines",
      "space_memberships",
      "users",
      "spaces",
    ],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, {
    space: SPACE,
    owner: OWNER,
    project: PROJECT,
    now: new Date().toISOString(),
  });
  const room = await db.pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`,
    [SPACE],
  );
  roomId = room.rows[0]!.id;
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`,
    [FOLDER, SPACE, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Test machine', 'desktop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'Test host', 'remote', 'linux_native', 'online', '{"installations":{"claude_code":[{"id":"own","version":"1.0.0","logged_in":true}]}}'::jsonb, $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind,
       display_path, execution_ready, status, preferred, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', true, $5, $5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
  await db.pool.query(
    `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status, created_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Test task', 'ready', $5, $6, $6)`,
    [TASK, SPACE, PROJECT, FOLDER, OWNER, now],
  );
  await seedAgentWithVersion(db.pool, {
    agent: AGENT,
    version: VERSION,
    space: SPACE,
    owner: OWNER,
    now,
  });
});

function threadInsert(input: {
  id: string;
  taskId?: string | null;
  roomId?: string | null;
  agentId?: string | null;
  status?: string;
}) {
  return db.pool.query(
    `INSERT INTO host_threads (
       id, workspace_location_id, task_id, room_id, agent_id, adapter_type,
       runtime_installation, status, created_by_user_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'opencode', 'own', $6, $7, now(), now())`,
    [input.id, LOCATION, input.taskId ?? null, input.roomId ?? null, input.agentId ?? null, input.status ?? "active", OWNER],
  );
}

describe("host_threads owner constraints", () => {
  it("accepts Task and Room owners but rejects a mixed owner", async (ctx) => {
    if (!db.available) return ctx.skip();

    await threadInsert({ id: randomUUID(), taskId: TASK });
    await threadInsert({ id: randomUUID(), roomId, agentId: AGENT });
    await expect(threadInsert({ id: MIXED_THREAD, taskId: TASK, roomId, agentId: AGENT }))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("allows only one live Room × Agent thread and releases the slot when closed", async (ctx) => {
    if (!db.available) return ctx.skip();

    const first = randomUUID();
    await threadInsert({ id: first, roomId, agentId: AGENT });
    await expect(threadInsert({ id: randomUUID(), roomId, agentId: AGENT }))
      .rejects.toMatchObject({ code: "23505" });

    await db.pool.query(`UPDATE host_threads SET status = 'closed' WHERE id = $1`, [first]);
    await threadInsert({ id: randomUUID(), roomId, agentId: AGENT });
  });

  it("creates and reads a Room × Agent thread through the repository", async (ctx) => {
    if (!db.available) return ctx.skip();

    const thread = await new PgHostThreadRepository(db.pool).createForRoomAgent({
      workspaceLocationId: LOCATION,
      roomId,
      agentId: AGENT,
      adapterType: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    expect(thread).toMatchObject({
      room_id: roomId,
      agent_id: AGENT,
      task_id: null,
      last_session_id: null,
      status: "active",
    });
    await expect(new PgHostThreadRepository(db.pool).getForRoomAgent(roomId, AGENT))
      .resolves.toMatchObject({ id: thread.id, workspace_location_id: LOCATION });
    await expect(new PgHostThreadRepository(db.pool).getForLocation(thread.id, LOCATION)).resolves.toBeNull();

    const taskThread = await new PgHostThreadRepository(db.pool).create({
      workspaceLocationId: LOCATION,
      taskId: TASK,
      adapterType: "claude_code",
      createdByUserId: OWNER,
    });
    await expect(new PgHostThreadRepository(db.pool).getForLocation(taskThread.id, LOCATION))
      .resolves.toMatchObject({ id: taskThread.id, task_id: TASK });
    await db.pool.query(`UPDATE host_threads SET status = 'closed' WHERE id = $1`, [taskThread.id]);
    await expect(new PgHostThreadRepository(db.pool).getForLocation(taskThread.id, LOCATION)).resolves.toBeNull();
    await new PgHostThreadRepository(db.pool).recordRunOutcome(taskThread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "late-vendor-session",
      sessionReset: false,
    });
    await expect(db.pool.query<{ status: string; vendor_session_id: string | null }>(
      `SELECT status, vendor_session_id FROM host_threads WHERE id = $1`,
      [taskThread.id],
    )).resolves.toMatchObject({ rows: [{ status: "closed", vendor_session_id: null }] });
  });

  it("atomically permits one Room dispatch and releases the claim at terminal outcome", async (ctx) => {
    if (!db.available) return ctx.skip();

    const repository = new PgHostThreadRepository(db.pool);
    const thread = await repository.getOrCreateForRoomAgent({
      workspaceLocationId: LOCATION,
      roomId,
      agentId: AGENT,
      adapterType: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    const firstLock = randomUUID();
    const secondLock = randomUUID();
    const claims = await Promise.all([
      repository.claimRoomDispatch(thread.id, firstLock),
      repository.claimRoomDispatch(thread.id, secondLock),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    const winningLock = claims[0] ? firstLock : secondLock;
    const runId = randomUUID();
    await repository.recordDispatch(thread.id, {
      lastRunId: runId,
      sessionId: randomUUID(),
      dispatchLockId: winningLock,
    });
    await repository.recordRunOutcome(thread.id, {
      lastRunId: runId,
      vendorSessionId: "vendor-session",
      sessionReset: false,
    });
    expect(await repository.claimRoomDispatch(thread.id, randomUUID())).toBe(true);
  });

  it("persists the owner-only member policy and permits a host-bound profile without a provider", async (ctx) => {
    if (!db.available) return ctx.skip();

    await db.pool.query(`UPDATE agents SET project_id = $2 WHERE space_id = $1 AND id = $3`, [SPACE, PROJECT, AGENT]);
    const member = await new PgRoomRepository(db.pool).addAgentMember({
      space_id: SPACE,
      room_id: roomId,
      agent_id: AGENT,
      role: "member",
    });
    expect(member.trigger_policy).toBe("owner_only");

    const profile = await new PgAgentRepository(db.pool).createRuntimeProfile(SPACE, AGENT, {
      name: "Host Reviewer",
      adapterType: "claude_code",
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      runtimeInstallation: "own",
    });
    expect(profile).toMatchObject({
      execution_host_id: HOST,
      workspace_location_id: LOCATION,
      runtime_installation: "own",
      model: null,
    });

    await expect(db.pool.query(
      `UPDATE room_agent_members SET trigger_policy = 'all_members' WHERE id = $1`,
      [member.id],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, adapter_type, execution_host_id,
         runtime_installation, runtime_config_json, runtime_policy_json,
         enabled, is_default, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Partial binding', 'claude_code', $4, 'own', '{}', '{}', true, false, now(), now())`,
      [randomUUID(), SPACE, AGENT, HOST],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("lists only the caller's online Project execution targets", async (ctx) => {
    if (!db.available) return ctx.skip();

    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1`, [HOST]);
    const repository = new PgWorkspaceLocationRepository(db.pool);
    await expect(repository.listHostExecutionTargets(SPACE, PROJECT, OWNER)).resolves.toEqual([
      expect.objectContaining({
        host_id: HOST,
        host_name: "Test host",
        host_online: true,
        locations: [expect.objectContaining({
          id: LOCATION,
          project_folder_id: FOLDER,
          execution_ready: true,
        })],
        adapters: [expect.objectContaining({
          adapter_type: "claude_code",
          installations: [expect.objectContaining({ id: "own", logged_in: true })],
        })],
      }),
    ]);
    await expect(repository.listHostExecutionTargets(SPACE, PROJECT, "not-the-owner")).resolves.toEqual([]);
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [HOST]);
    await expect(repository.listHostExecutionTargets(SPACE, PROJECT, OWNER)).resolves.toEqual([]);
  });

  it("rejects a host binding when the caller or installation is not authorized", async (ctx) => {
    if (!db.available) return ctx.skip();

    await db.pool.query(`UPDATE agents SET project_id = $2 WHERE space_id = $1 AND id = $3`, [SPACE, PROJECT, AGENT]);
    const repository = new PgAgentRepository(db.pool);
    await expect(repository.createRuntimeProfile(SPACE, AGENT, {
      name: "Wrong owner",
      adapterType: "claude_code",
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      runtimeInstallation: "own",
      actorUserId: "another-user",
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository.createRuntimeProfile(SPACE, AGENT, {
      name: "Unknown installation",
      adapterType: "claude_code",
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      runtimeInstallation: "managed:9.9.9",
    })).rejects.toMatchObject({ statusCode: 422 });
  });
});
