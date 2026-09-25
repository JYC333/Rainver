import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { loadConfig } from "../src/config.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { recordHostThreadOutcome } from "../src/modules/hosts/threadOutcome.js";
import { resolveRuntimeProfileScope, runtimeProfileKey } from "../src/modules/runs/remoteProviderBinding.js";
import { PgHostThreadEventRepository } from "../src/modules/hosts/threadEventRepository.js";
import { PgRoomRepository } from "../src/modules/rooms/repository.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { isTerminalRunStatus } from "../src/modules/runs/orchestrationResults.js";

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
const CONVERSATION = "88888888-8888-4888-8888-888888888888";
const OTHER_TASK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DISPATCH_PROFILE = "aaaa1111-1111-4111-8111-111111111111";

const db = useTestDatabase(import.meta.filename);
let roomId = "";

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    [
      "host_threads",
      "sessions",
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
    `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [CONVERSATION, SPACE, PROJECT, roomId, now],
  );
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
       display_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`,
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

describe("host_threads owner constraints", () => {
  it("creates and reads a Task thread through the repository", async (ctx) => {
    if (!db.available) return ctx.skip();
    const taskThread = await new PgHostThreadRepository(db.pool).create({
      workspaceLocationId: LOCATION,
      taskId: TASK,
      runtimeKey: "claude_code",
      createdByUserId: OWNER,
    });
    await expect(new PgHostThreadRepository(db.pool).getForLocation(taskThread.id, LOCATION, TASK))
      .resolves.toMatchObject({ id: taskThread.id, task_id: TASK });
    await db.pool.query(`UPDATE host_threads SET status = 'closed' WHERE id = $1`, [taskThread.id]);
    await expect(new PgHostThreadRepository(db.pool).getForLocation(taskThread.id, LOCATION, TASK)).resolves.toBeNull();
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

  it("keys Conversation host continuity by Session × Agent", async (ctx) => {
    if (!db.available) return ctx.skip();

    const repository = new PgHostThreadRepository(db.pool);
    const first = await repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    expect(first).toMatchObject({
      session_id: CONVERSATION,
      container_kind: "conversation",
      workspace_mode: "managed",
      workspace_location_id: null,
    });
    const dispatchLockId = randomUUID();
    expect(await repository.claimConversationDispatch(first.id, dispatchLockId)).toBe(true);
    const runId = randomUUID();
    await repository.recordConversationDispatch(first.id, {
      lastRunId: runId,
      sessionId: CONVERSATION,
      dispatchLockId,
    });
    await expect(repository.getForConversationAgent(SPACE, CONVERSATION, AGENT))
      .resolves.toMatchObject({ id: first.id, last_run_id: runId, last_session_id: CONVERSATION });
    await expect(repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      createdByUserId: OWNER,
    })).resolves.toMatchObject({ id: first.id });
    await expect(db.pool.query(
      `INSERT INTO host_threads (
         id, space_id, execution_host_id, workspace_mode, session_id, agent_id, container_kind,
         runtime_key, runtime_installation, status, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, 'managed', $4, $5, 'conversation', 'claude_code', 'own', 'active', $6, now(), now())`,
      [randomUUID(), SPACE, HOST, CONVERSATION, AGENT, OWNER],
    )).rejects.toMatchObject({ code: "23505" });

    const closed = await repository.closeConversationAgentForRoom(SPACE, roomId, AGENT);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ id: first.id, status: "closed" });
    expect(closed[0]?.pending_archive_at).toEqual(expect.any(String));
  });

  it("records a standing-context digest only for a Run that carried it and landed", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repository = new PgHostThreadRepository(db.pool);
    const thread = await repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    const read = async () => (await db.pool.query<{
      identity_digest: string | null;
      identity_digest_run_id: string | null;
      context_tokens: number | null;
      context_window_tokens: number | null;
    }>(
      `SELECT identity_digest, identity_digest_run_id, context_tokens, context_window_tokens
         FROM host_threads WHERE id = $1`,
      [thread.id],
    )).rows[0];

    // A dispatch that never reached the runtime says nothing was sent.
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: null,
      sessionReset: false,
      landed: false,
      identity: { digest: "digest-1", sent: true },
    });
    expect(await read()).toMatchObject({ identity_digest: null });

    const landedRun = randomUUID();
    await repository.recordRunOutcome(thread.id, {
      lastRunId: landedRun,
      vendorSessionId: "vendor-1",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-1", sent: true },
      contextWindow: { used: 42_000, size: 200_000 },
    });
    expect(await read()).toMatchObject({
      identity_digest: "digest-1",
      identity_digest_run_id: landedRun,
      context_tokens: 42_000,
      context_window_tokens: 200_000,
    });

    // A resumed turn that did not carry the block keeps what the session holds.
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-1",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-1", sent: false },
    });
    expect(await read()).toMatchObject({ identity_digest: "digest-1", identity_digest_run_id: landedRun });

    // A new vendor session under a Run that did not carry the block holds no
    // identity at all, and its occupancy is unknown.
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-2",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-1", sent: false },
    });
    expect(await read()).toMatchObject({ identity_digest: null, context_tokens: null });

    // Less in context than last time, in the same session: the vendor
    // compacted it and may have summarized the standing context away.
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-2",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-2", sent: true },
      contextWindow: { used: 90_000, size: 200_000 },
    });
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-2",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-2", sent: false },
      contextWindow: { used: 30_000, size: 200_000 },
    });
    expect(await read()).toMatchObject({ identity_digest: null, context_tokens: 30_000 });

    // A reset forgets everything the old session held.
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-2",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-2", sent: true },
      contextWindow: { used: 10, size: 100 },
    });
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: null,
      sessionReset: true,
    });
    expect(await read()).toMatchObject({ identity_digest: null, context_tokens: null, context_window_tokens: null });
  });

  it("never brings back a session the thread retired, however late a Run reports on it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const repository = new PgHostThreadRepository(db.pool);
    const thread = await repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    const outcome = (vendorSessionId: string | null, extra: Partial<Parameters<typeof repository.recordRunOutcome>[1]> = {}) =>
      repository.recordRunOutcome(thread.id, { lastRunId: randomUUID(), vendorSessionId, sessionReset: false, landed: true, ...extra });
    await outcome("vendor-old");
    await outcome(null, { sessionReset: true });
    await outcome("vendor-new", { identity: { digest: "digest-new", sent: true }, contextWindow: { used: 30_000, size: 200_000 } });
    // Dispatched before the reset, it ran after it on the session it was given.
    await outcome("vendor-old", { identity: { digest: "digest-old", sent: true }, contextWindow: { used: 150_000, size: 200_000 } });
    const row = (await db.pool.query<{ vendor_session_id: string; status: string; identity_digest: string; context_tokens: number }>(
      `SELECT vendor_session_id, status, identity_digest, context_tokens FROM host_threads WHERE id = $1`,
      [thread.id],
    )).rows[0];
    expect(row).toEqual({ vendor_session_id: "vendor-new", status: "active", identity_digest: "digest-new", context_tokens: 30_000 });
  });

  it("reads a resume as broken only when the runtime proved it so", async (ctx) => {
    if (!db.available) return ctx.skip();
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const repository = new PgHostThreadRepository(db.pool);
    const thread = await repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    await repository.recordRunOutcome(thread.id, { lastRunId: randomUUID(), vendorSessionId: "vendor-live", sessionReset: false });
    const vendorSession = async () => (await db.pool.query<{ status: string; vendor_session_id: string | null }>(
      `SELECT status, vendor_session_id FROM host_threads WHERE id = $1`, [thread.id],
    )).rows[0];
    // Failed before the runtime tried: a launch that waited out its budget,
    // a person's stop. The session is still there.
    for (const run of [
      { id: randomUUID(), status: "failed", error_json: { error_code: "runtime_timeout" } },
      { id: randomUUID(), status: "cancelled", error_json: { error_code: "run_cancelled" } },
    ]) {
      await recordHostThreadOutcome(config, thread.id, run, true);
      expect(await vendorSession()).toMatchObject({ status: "active", vendor_session_id: "vendor-live" });
    }
    // The runtime refused the session.
    await recordHostThreadOutcome(config, thread.id, {
      id: randomUUID(), status: "failed", error_json: { error_code: "runtime_session_invalid" },
    }, true);
    expect(await vendorSession()).toMatchObject({ status: "session_reset", vendor_session_id: null });
  });

  it("gives every Agent × container its own runtime profile, and the machine's own to none of them", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The leak this closes: `profiles/<adapter>/<provider>` was shared by every
    // run with that adapter and provider on a machine, and an unbound run had
    // no profile at all, so it read the machine's own `~/.claude`. Two Agents
    // in one Room and one Agent in two Rooms are the two ways that mixed what
    // a vendor CLI remembers.
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const otherVersion = "99999999-9999-4999-8999-999999999999";
    const otherConversation = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    await seedAgentWithVersion(db.pool, {
      agent: otherAgent, version: otherVersion, space: SPACE, owner: OWNER, name: "Second Agent",
    });
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [otherConversation, SPACE, PROJECT, roomId],
    );
    const repository = new PgHostThreadRepository(db.pool);
    const threads = [] as Array<{ id: string; agentId: string }>;
    for (const [agentId, sessionId] of [
      [AGENT, CONVERSATION], [otherAgent, CONVERSATION],
      [AGENT, otherConversation], [otherAgent, otherConversation],
    ] as const) {
      const thread = await repository.getOrCreateForConversationAgent({
        executionHostId: HOST,
        workspaceMode: "managed",
        spaceId: SPACE,
        sessionId,
        agentId,
        runtimeKey: "claude_code",
        runtimeInstallation: "own",
        createdByUserId: OWNER,
      });
      threads.push({ id: thread.id, agentId });
    }
    const keys = new Set<string>();
    for (const thread of threads) {
      const scope = await resolveRuntimeProfileScope(
        db.pool,
        { agent_id: thread.agentId, host_task_thread_id: thread.id },
        LOCATION,
      );
      expect(scope.container_kind).toBe("conversation");
      keys.add(runtimeProfileKey(scope, "claude_code", null));
    }
    // Two Agents × two Conversations: four directories, no overlap.
    expect(keys.size).toBe(4);
    for (const key of keys) expect(key).toMatch(/^agents\/[^/]+\/conversation\/[^/]+\/claude_code\/ambient$/);

    // Direct chat is keyed by the owner; a run with no thread falls back to the
    // Location, which is what its vendor session already belongs to.
    const direct = await repository.getOrCreateForDirect({
      executionHostId: HOST,
      workspaceMode: "managed",
      agentId: AGENT,
      userId: OWNER,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    await expect(resolveRuntimeProfileScope(db.pool, { agent_id: AGENT, host_task_thread_id: direct.id }, LOCATION))
      .resolves.toEqual({ agent_id: AGENT, container_kind: "direct", container_id: OWNER });
    await expect(resolveRuntimeProfileScope(db.pool, { agent_id: AGENT, host_task_thread_id: null }, LOCATION))
      .resolves.toEqual({ agent_id: AGENT, container_kind: "location", container_id: LOCATION });
    // An ordinary Server Agent Run with no Conversation or Location has a
    // durable Agent-scoped profile rather than borrowing the host-global login.
    await expect(resolveRuntimeProfileScope(db.pool, { agent_id: AGENT, host_task_thread_id: null }, null))
      .resolves.toEqual({ agent_id: AGENT, container_kind: "agent", container_id: AGENT });
    expect(runtimeProfileKey({ agent_id: AGENT, container_kind: "agent", container_id: AGENT }, "claude_code", null))
      .toBe(`agents/${AGENT}/agent/${AGENT}/claude_code/ambient`);
    await expect(resolveRuntimeProfileScope(db.pool, { agent_id: AGENT, host_task_thread_id: randomUUID() }, null))
      .rejects.toThrow(/Host thread has no valid runtime profile container/);

    // A Run whose Agent is not the thread's would write into another Agent's
    // profile and archive the wrong one. The two are the same on every path
    // that creates a thread, so this fails loudly rather than failing open —
    // the boundary is the whole point.
    await expect(resolveRuntimeProfileScope(db.pool, { agent_id: otherAgent, host_task_thread_id: direct.id }, LOCATION))
      .rejects.toThrow(/belongs to Agent/);
  });

  it("archives a departing Agent's profile while the Conversation cwd another Agent uses stays", async (ctx) => {
    if (!db.available) return ctx.skip();
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const otherVersion = "99999999-9999-4999-8999-999999999999";
    await seedAgentWithVersion(db.pool, {
      agent: otherAgent, version: otherVersion, space: SPACE, owner: OWNER, name: "Second Agent",
    });
    const repository = new PgHostThreadRepository(db.pool);
    for (const agentId of [AGENT, otherAgent]) {
      await repository.getOrCreateForConversationAgent({
        executionHostId: HOST,
        workspaceMode: "managed",
        spaceId: SPACE,
        sessionId: CONVERSATION,
        agentId,
        runtimeKey: "claude_code",
        runtimeInstallation: "own",
        createdByUserId: OWNER,
      });
    }

    // One Agent leaves while the other stays: its own CLI state has to go —
    // otherwise it walks into the next Room — but the shared cwd belongs to
    // the Agent still in the Room.
    const first = await repository.closeConversationAgentForRoom(SPACE, roomId, AGENT);
    expect(first).toHaveLength(1);
    expect(first[0]?.pending_archive_at).toEqual(expect.any(String));
    expect(first[0]?.include_workspace).toBe(false);
    await expect(repository.listPendingManagedWorkspaceArchives(HOST))
      .resolves.toEqual([expect.objectContaining({ agent_id: AGENT, include_workspace: false })]);

    // The last one out takes the workspace with it.
    const second = await repository.closeConversationAgentForRoom(SPACE, roomId, otherAgent);
    expect(second[0]?.include_workspace).toBe(true);

    const pending = await repository.listPendingManagedWorkspaceArchives(HOST);
    expect(pending).toHaveLength(2);
    for (const item of pending) await repository.acknowledgeManagedWorkspaceArchive(item.id);
    await expect(repository.listPendingManagedWorkspaceArchives(HOST)).resolves.toEqual([]);
  });

  it("retires every vendor session an Agent has on one host when its profiles are cleared", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The other half of `host-state/reset`: the profiles that held those
    // sessions are gone from the machine, so a thread still believing it can
    // resume one would fail on its next turn.
    const repository = new PgHostThreadRepository(db.pool);
    const conversation = await repository.getOrCreateForConversationAgent({
      executionHostId: HOST,
      workspaceMode: "managed",
      spaceId: SPACE,
      sessionId: CONVERSATION,
      agentId: AGENT,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    await db.pool.query(
      `UPDATE host_threads SET vendor_session_id = 'vendor-1' WHERE id = $1`,
      [conversation.id],
    );

    expect(await repository.retireAgentSessionsOnHost(AGENT, HOST)).toBe(1);

    const after = await db.pool.query<{ status: string; vendor_session_id: string | null; retired: string[] }>(
      `SELECT status, vendor_session_id, retired_vendor_session_ids AS retired FROM host_threads WHERE id = $1`,
      [conversation.id],
    );
    expect(after.rows[0]).toMatchObject({ status: "session_reset", vendor_session_id: null });
    // Kept, so ambient import can still tell the Agent's old sessions from the
    // owner's own history on the same machine.
    expect(after.rows[0]?.retired).toEqual(["vendor-1"]);
  });

  it("retires a Task thread's session too, though the thread carries no Agent", async (ctx) => {
    if (!db.available) return ctx.skip();
    // `ck_host_threads_owner` forces a Location-bound thread's `agent_id`
    // null, but the profile its session lived in is keyed by the Agent that
    // ran there and `host-state/reset` archives it. Matching only on the
    // column would leave that thread resuming into nothing.
    const repository = new PgHostThreadRepository(db.pool);
    const taskThread = await repository.create({
      workspaceLocationId: LOCATION,
      taskId: TASK,
      runtimeKey: "claude_code",
      createdByUserId: OWNER,
    });
    await db.pool.query(
      `UPDATE host_threads SET execution_host_id = $2, vendor_session_id = 'vendor-task' WHERE id = $1`,
      [taskThread.id, HOST],
    );
    await db.pool.query(
      `INSERT INTO runs (
         id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
         owner_user_id, visibility, host_task_thread_id, created_at, updated_at, execution_kind
       ) VALUES (
         $1,$2,$3,$4,'agent','manual','succeeded','live',
         (SELECT id FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
         'default',
         (SELECT runtime_key FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
         (SELECT jsonb_build_object('id',id,'runtime_key',runtime_key,'backend_mode',backend_mode,
             'model_provider_id',model_provider_id,'model_name',model_name,
             'runtime_config_json',runtime_config_json,'runtime_policy_json',runtime_policy_json)
            FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
         $5,'space_shared',$6,now(),now(),'agent'
       )`,
      [randomUUID(), SPACE, AGENT, VERSION, OWNER, taskThread.id],
    );

    expect(await repository.retireAgentSessionsOnHost(AGENT, HOST)).toBe(1);

    await expect(db.pool.query<{ status: string; vendor_session_id: string | null }>(
      `SELECT status, vendor_session_id FROM host_threads WHERE id = $1`, [taskThread.id],
    )).resolves.toMatchObject({ rows: [{ status: "session_reset", vendor_session_id: null }] });

    // Another Agent's Task thread on the same machine is not this Agent's to
    // reset.
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const otherVersion = "99999999-9999-4999-8999-999999999999";
    await seedAgentWithVersion(db.pool, {
      agent: otherAgent, version: otherVersion, space: SPACE, owner: OWNER, name: "Second Agent",
    });
    expect(await repository.retireAgentSessionsOnHost(otherAgent, HOST)).toBe(0);
  });

  it("retires a Task thread's session for the Agent that ran there last, not any Agent that ever did", async (ctx) => {
    if (!db.available) return ctx.skip();
    // The session lives in the profile of the Agent whose Run last used the
    // thread (`resolveRuntimeProfileScope` keys a `location` container by the
    // Run's Agent). Resetting an earlier Agent must not retire a session that
    // now lives in another Agent's untouched profile.
    const repository = new PgHostThreadRepository(db.pool);
    const taskThread = await repository.create({
      workspaceLocationId: LOCATION, taskId: TASK, runtimeKey: "claude_code", createdByUserId: OWNER,
    });
    await db.pool.query(
      `UPDATE host_threads SET execution_host_id = $2, vendor_session_id = 'vendor-task' WHERE id = $1`,
      [taskThread.id, HOST],
    );
    const otherAgent = "77777777-7777-4777-8777-777777777777";
    const otherVersion = "99999999-9999-4999-8999-999999999999";
    await seedAgentWithVersion(db.pool, {
      agent: otherAgent, version: otherVersion, space: SPACE, owner: OWNER, name: "Second Agent",
    });
    for (const [agent, version, when] of [[AGENT, VERSION, "now() - interval '1 hour'"], [otherAgent, otherVersion, "now()"]] as const) {
      await db.pool.query(
        `INSERT INTO runs (
           id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
           runtime_profile_id, runtime_profile_selection_source, runtime_key, runtime_profile_snapshot_json,
           owner_user_id, visibility, host_task_thread_id, created_at, updated_at, execution_kind
         ) VALUES (
           $1,$2,$3,$4,'agent','manual','succeeded','live',
           (SELECT id FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
           'default',
           (SELECT runtime_key FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
           (SELECT jsonb_build_object('id',id,'runtime_key',runtime_key,'backend_mode',backend_mode,
               'model_provider_id',model_provider_id,'model_name',model_name,
               'runtime_config_json',runtime_config_json,'runtime_policy_json',runtime_policy_json)
              FROM agent_runtime_profiles WHERE space_id=$2::varchar(36) AND agent_id=$3::varchar(36) AND is_default=TRUE),
           $5,'space_shared',$6,${when},${when},'agent'
         )`,
        [randomUUID(), SPACE, agent, version, OWNER, taskThread.id],
      );
    }

    expect(await repository.retireAgentSessionsOnHost(AGENT, HOST)).toBe(0);
    await expect(db.pool.query<{ vendor_session_id: string | null }>(
      `SELECT vendor_session_id FROM host_threads WHERE id = $1`, [taskThread.id],
    )).resolves.toMatchObject({ rows: [{ vendor_session_id: "vendor-task" }] });
    expect(await repository.retireAgentSessionsOnHost(otherAgent, HOST)).toBe(1);
  });

  it("resets a Location thread's session for a different execution identity, and nothing else's", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A Task dispatch resets the session when its selected Agent or Runtime
    // Profile differs from the execution identity that last used the thread.
    const repository = new PgHostThreadRepository(db.pool);
    const taskThread = await repository.create({
      workspaceLocationId: LOCATION, taskId: TASK, runtimeKey: "claude_code", createdByUserId: OWNER,
    });
    await db.pool.query(`UPDATE host_threads SET vendor_session_id = 'vendor-task' WHERE id = $1`, [taskThread.id]);

    expect(await repository.resetLocationSession(taskThread.id)).toBe(true);
    await expect(db.pool.query<{ status: string; vendor_session_id: string | null; retired_vendor_session_ids: string[] }>(
      `SELECT status, vendor_session_id, retired_vendor_session_ids FROM host_threads WHERE id = $1`, [taskThread.id],
    )).resolves.toMatchObject({
      rows: [{ status: "session_reset", vendor_session_id: null, retired_vendor_session_ids: ["vendor-task"] }],
    });

    // A Conversation thread is an Agent's own and never changes Agent.
    const conversation = await repository.createForConversationAgent({
      spaceId: SPACE, sessionId: CONVERSATION, agentId: AGENT, executionHostId: HOST, workspaceMode: "location",
      workspaceLocationId: LOCATION, runtimeKey: "claude_code", createdByUserId: OWNER,
    });
    expect(await repository.resetLocationSession(conversation.id)).toBe(false);
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
      runtimeKey: "claude_code",
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
       id,
       space_id,
       agent_id,
       name,
       runtime_key,
       backend_mode,
       execution_host_id,
       runtime_installation,
       runtime_config_json,
       runtime_policy_json,
       enabled,
       is_default,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, 'Partial binding', 'claude_code', 'runtime_native', $4, 'own', '{}', '{}', true, false, now(), now())`,
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
        // Lifecycle comes from hosts.kind, never from the display label.
        host_kind: "remote",
        host_online: true,
        locations: [expect.objectContaining({
          id: LOCATION,
          project_folder_id: FOLDER,
          execution_ready: true,
        })],
        runtimes: [expect.objectContaining({
          runtime_key: "claude_code",
          installations: [expect.objectContaining({ id: "own", logged_in: true })],
        })],
      }),
    ]);
    await expect(repository.listHostExecutionTargets(SPACE, PROJECT, "not-the-owner")).resolves.toEqual([]);
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '2 minutes' WHERE id = $1`, [HOST]);
    await expect(repository.listHostExecutionTargets(SPACE, PROJECT, OWNER)).resolves.toEqual([]);
  });

  it("counts an online paired host with a logged-in CLI as an eligible Assistant backend", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { SpaceAssistantService } = await import("../src/modules/agents/spaceAssistantService.js");
    const identity = { spaceId: SPACE, userId: OWNER };
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1`, [HOST]);
    const fresh = await SpaceAssistantService.prepareForRoomCreator(db.pool, loadConfig({}), identity);
    expect(fresh.hostBackends).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: HOST, runtimeKey: "claude_code", installation: "own" }),
    ]));
    // A stale heartbeat means the host cannot answer a first message; it must
    // not admit the Room only to strand it.
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [HOST]);
    const stale = await SpaceAssistantService.prepareForRoomCreator(db.pool, loadConfig({}), identity);
    expect(stale.hostBackends.find((backend) => backend.hostId === HOST)).toBeUndefined();

    // A Host's installation inventory cannot select an Agent runtime; the
    // registry's stable order is used only for initial presentation.
    await db.pool.query(
      `UPDATE hosts
          SET last_heartbeat_at = now(),
              capabilities_json = '{"installations":{"opencode":[{"id":"own","version":"1.0.0","logged_in":true}],"claude_code":[{"id":"own","version":"1.0.0","logged_in":true}]}}'::jsonb
        WHERE id = $1`,
      [HOST],
    );
    const chosen = await SpaceAssistantService.prepareForRoomCreator(db.pool, loadConfig({}), identity);
    expect(chosen.hostBackends[0]).toMatchObject({ hostId: HOST, runtimeKey: "opencode" });
  });

  it("offers a session-ready CLI without a native login, but not one whose ACP session requires auth", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { SpaceAssistantService } = await import("../src/modules/agents/spaceAssistantService.js");
    const identity = { spaceId: SPACE, userId: OWNER };
    const report = async (sessionAvailable: boolean) => db.pool.query(
      `UPDATE hosts SET last_heartbeat_at = now(), capabilities_json = $2::jsonb WHERE id = $1`,
      [HOST, JSON.stringify({ installations: { opencode: [{
        id: "own", version: "1.0.0", logged_in: false,
        options: { session_available: sessionAvailable, config_options: [{
          id: "model", name: "Model", category: "model", type: "select", current_value: "free",
          options: [{ value: "free", name: "Free", description: null, group: null }],
        }] },
      }] } })],
    );
    await report(true);
    const ready = await SpaceAssistantService.prepareForRoomCreator(db.pool, loadConfig({}), identity);
    expect(ready.hostBackends).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: HOST, runtimeKey: "opencode", installation: "own" }),
    ]));
    await report(false);
    const authRequired = await SpaceAssistantService.prepareForRoomCreator(db.pool, loadConfig({}), identity);
    expect(authRequired.hostBackends.find((backend) => backend.hostId === HOST)).toBeUndefined();
  });

  it("records thread events for a managed direct thread that has no Project", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threads = new PgHostThreadRepository(db.pool);
    const thread = await threads.getOrCreateForDirect({
      executionHostId: HOST,
      workspaceLocationId: null,
      workspaceMode: "managed",
      agentId: AGENT,
      userId: OWNER,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    const runId = randomUUID();
    await db.pool.query(
      `INSERT INTO runs (id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
         model_override_json, owner_user_id, created_at, updated_at, execution_kind)
       VALUES ($1,$2,$3::varchar,(SELECT current_version_id FROM agents WHERE id=$3::varchar),'agent','manual','queued','live',
         '{}'::jsonb,$4,now(),now(), 'agent')`,
      [runId, SPACE, AGENT, OWNER],
    );
    const events = await new PgHostThreadEventRepository(db.pool).append(thread.id, runId, [
      { event_type: "status", status: "run_started" },
    ]);
    expect(events[0]).toMatchObject({ project_id: null, event_type: "status", status: "run_started" });
  });

  it("rejects a host binding when the caller or installation is not authorized", async (ctx) => {
    if (!db.available) return ctx.skip();

    await db.pool.query(`UPDATE agents SET project_id = $2 WHERE space_id = $1 AND id = $3`, [SPACE, PROJECT, AGENT]);
    const repository = new PgAgentRepository(db.pool);
    await expect(repository.createRuntimeProfile(SPACE, AGENT, {
      name: "Wrong owner",
      runtimeKey: "claude_code",
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      runtimeInstallation: "own",
      actorUserId: "another-user",
    })).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository.createRuntimeProfile(SPACE, AGENT, {
      name: "Unknown installation",
      runtimeKey: "claude_code",
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      runtimeInstallation: "managed:9.9.9",
    })).rejects.toMatchObject({ statusCode: 422 });
  });
});


/**
 * Task-thread dispatch admission.
 *
 * A Task thread has exactly one vendor session, so the control plane decides
 * at admission who may resume it. `prepareRemoteTaskRun` is where that is
 * decided, and everything below asserts on the durable result — the Runs the
 * Task ends up with — rather than on how admission reached it.
 */
describe("admitting a Run onto a Task thread", () => {
  /**
   * The Profile a remote Task dispatch must select: this Host, this Location,
   * and an installation the Host reports. Not the Agent's default (an
   * unbound `opencode` Profile), which admission correctly refuses.
   */
  async function seedDispatchableThread(): Promise<string> {
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at = now() WHERE id = $1`, [HOST]);
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id, space_id, agent_id, name, runtime_key, backend_mode, execution_host_id,
         workspace_location_id, workspace_mode, runtime_installation,
         runtime_config_json, runtime_policy_json, enabled, is_default, created_at, updated_at
       ) VALUES ($1,$2,$3,'Task dispatch','claude_code','runtime_native',$4,$5,'location','own',
         '{}'::jsonb,'{}'::jsonb,true,false,now(),now())`,
      [DISPATCH_PROFILE, SPACE, AGENT, HOST, LOCATION],
    );
    const thread = await new PgHostThreadRepository(db.pool).create({
      executionHostId: HOST,
      workspaceLocationId: LOCATION,
      taskId: TASK,
      runtimeKey: "claude_code",
      runtimeInstallation: "own",
      createdByUserId: OWNER,
    });
    return thread.id;
  }

  /** A remote Task dispatch onto the seeded thread, as the route admits one. */
  function dispatch(threadId: string, taskId = TASK) {
    return new PgTaskRepository(db.pool).createTaskRun({ spaceId: SPACE, userId: OWNER }, taskId, {
      workspace_location_id: LOCATION,
      prompt: "go",
      thread_id: threadId,
      agent_id: AGENT,
      runtime_profile_id: DISPATCH_PROFILE,
    });
  }

  function runsOnThread(threadId: string) {
    return db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM runs WHERE host_task_thread_id = $1`,
      [threadId],
    ).then((result) => result.rows[0]?.count);
  }

  it("refuses a second Run while one is in flight on the same thread", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threadId = await seedDispatchableThread();

    await dispatch(threadId);
    // Still running. Two Runs on one thread would both resume the same vendor
    // session — the thread's whole reason to exist — and the second would
    // corrupt what the first is holding.
    await expect(dispatch(threadId)).rejects.toMatchObject({ statusCode: 409 });

    expect(await runsOnThread(threadId)).toBe("1");
  });

  it("does not let one Task borrow another Task's host thread", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threadId = await seedDispatchableThread();
    await db.pool.query(
      `INSERT INTO tasks (id, space_id, project_id, project_folder_id, title, status,
         created_by_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Another task','ready',$5,now(),now())`,
      [OTHER_TASK, SPACE, PROJECT, FOLDER, OWNER],
    );

    // The thread is the other Task's vendor session; a Task that could name it
    // would resume a conversation about work it does not own. Hidden rather
    // than refused, like every other cross-owner read.
    await expect(dispatch(threadId, OTHER_TASK)).rejects.toMatchObject({ statusCode: 404 });

    expect(await runsOnThread(threadId)).toBe("0");
  });

  it("serializes concurrent admissions for the same Task thread", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threadId = await seedDispatchableThread();

    const results = await Promise.allSettled([dispatch(threadId), dispatch(threadId)]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({ statusCode: 409 });
    expect(await runsOnThread(threadId)).toBe("1");
  });

  it("does not deadlock a thread whose Run stopped for review", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threadId = await seedDispatchableThread();

    await dispatch(threadId);
    // `waiting_for_review` is terminal for this purpose: the Run stopped and
    // is waiting on a person. A hand-rolled status list here once missed it
    // and deadlocked the thread forever after any Run that landed in review.
    // A Run that reached review has started and carries the Profile snapshot
    // the router stamps on it; `ck_runs_execution_shape` refuses the state
    // without them, so the fixture writes what production would have.
    await db.pool.query(
      `UPDATE runs
          SET status = 'waiting_for_review',
              started_at = now(),
              runtime_profile_id = profile.id,
              runtime_key = profile.runtime_key,
              runtime_profile_snapshot_json = jsonb_build_object(
                'id', profile.id,
                'runtime_key', profile.runtime_key,
                'backend_mode', profile.backend_mode,
                'model_provider_id', profile.model_provider_id,
                'model_name', profile.model_name,
                'runtime_config_json', profile.runtime_config_json,
                'runtime_policy_json', profile.runtime_policy_json)
         FROM agent_runtime_profiles profile
        WHERE profile.id = $2 AND runs.host_task_thread_id = $1`,
      [threadId, DISPATCH_PROFILE],
    );

    await dispatch(threadId);
    expect(await runsOnThread(threadId)).toBe("2");
  });

  it("counts waiting_for_review among the statuses that free a thread's session", () => {
    // The one list both the admission check above and the session-reset guard
    // read (`TERMINAL_RUN_STATUSES`), so they cannot disagree about which
    // Runs still hold the vendor session.
    for (const status of ["succeeded", "failed", "degraded", "cancelled", "orphaned", "waiting_for_review"]) {
      expect(isTerminalRunStatus(status), status).toBe(true);
    }
    for (const status of ["queued", "running", "cancelling"]) {
      expect(isTerminalRunStatus(status), status).toBe(false);
    }
  });
});
