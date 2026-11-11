import {canonicalRunOutput} from '../src/modules/runs/orchestrationResults.js';
import type {LaunchWorkspace,HostLaunchWorkspaceAccess} from '@rainver/protocol';
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedRun, seedSpaceOwnerProject, seedSpaceMember } from "./support/domainSeeds.js";
import { PgAgentRepository } from "../src/modules/agents/repository.js";
import { loadConfig } from "../src/config.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { recordHostThreadOutcome } from "../src/modules/hosts/threadOutcome.js";
import { resolveRuntimeProfileScope, runtimeProfileKey } from "../src/modules/runs/remoteProviderBinding.js";
import { PgHostThreadEventRepository } from "../src/modules/hosts/threadEventRepository.js";
import { PgRunRepository,type RunRecord } from "../src/modules/runs/repository.js";
import { PgRoomRepository } from "../src/modules/rooms/repository.js";
import { PgWorkspaceLocationRepository } from "../src/modules/projectFolders/workspaceLocations.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { isTerminalRunStatus } from "../src/modules/runs/orchestrationResults.js";
import { buildRunOrchestration } from "../src/modules/runs/orchestrationFactory.js";
import { PostRunFinalizationService } from "../src/modules/runs/finalizationService.js";
import { runSettlement } from "../src/modules/runs/runSettlement.js";
import { PgRunSupervisor } from "../src/modules/runs/supervisor.js";
import { HostThreadClaimHeldError } from "../src/modules/runs/runSettlement.js";
import { resumeUnsettledRuns } from "../src/modules/runs/recovery.js";
import { RunMaterializationService } from "../src/modules/runs/materializationService.js";
import { enqueueWhenTurnFree, holdInterruptedRun } from "../src/modules/rooms/quotaGate.js";
import { withDbTransaction } from "../src/modules/routeUtils/common.js";

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

let endedRuns = 0;
/** A Run that ended on the thread, as settlement sees it: a real row, on this thread, hard terminal. Created in order. */
async function endedRunOnThread(threadId: string, run: { status: string; error_json?: unknown }) {
  const id = randomUUID();
  endedRuns += 1;
  await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, existingAgent: true,
    now: new Date(Date.UTC(2026, 9, 1, 0, 0, endedRuns)).toISOString() });
  await db.pool.query("UPDATE runs SET status=$2, error_json=$3, host_task_thread_id=$4, ended_at=now() WHERE id=$1",
    [id, run.status, JSON.stringify(run.error_json ?? null), threadId]);
  return { id, ...run };
}
async function frozenWorkspaceLayout(runId:string,primary:LaunchWorkspace,attachments:HostLaunchWorkspaceAccess[]=[]){
 await db.pool.query('UPDATE runs SET output_json=$2::jsonb WHERE id=$1',[runId,JSON.stringify(canonicalRunOutput({success:true,outputText:'',outputJson:{execution_workspace_location:primary,execution_workspace_access:attachments}}))]);
}
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

    // The Gateway's standing items follow the same rule: recorded only when
    // delivered by a Run that landed, kept while a later turn omits them.
    const standingRun = randomUUID();
    await repository.recordRunOutcome(thread.id, {
      lastRunId: standingRun,
      vendorSessionId: "vendor-1",
      sessionReset: false,
      landed: true,
      identity: { digest: "digest-1", sent: false },
      standing: { digest: "standing-1", sent: true },
    });
    await repository.recordRunOutcome(thread.id, {
      lastRunId: randomUUID(),
      vendorSessionId: "vendor-1",
      sessionReset: false,
      landed: true,
      standing: { digest: "standing-1", sent: false },
    });
    expect((await db.pool.query<{ standing_digest: string | null; standing_digest_run_id: string | null }>(
      `SELECT standing_digest, standing_digest_run_id FROM host_threads WHERE id = $1`, [thread.id],
    )).rows[0]).toEqual({ standing_digest: "standing-1", standing_digest_run_id: standingRun });

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
    expect((await db.pool.query<{ standing_digest: string | null }>(
      `SELECT standing_digest FROM host_threads WHERE id = $1`, [thread.id],
    )).rows[0]).toEqual({ standing_digest: null });

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
    for (const ended of [
      { status: "failed", error_json: { error_code: "runtime_timeout" } },
      { status: "cancelled", error_json: { error_code: "run_cancelled" } },
    ]) {
      await recordHostThreadOutcome(config, thread.id, await endedRunOnThread(thread.id, ended), true);
      expect(await vendorSession()).toMatchObject({ status: "active", vendor_session_id: "vendor-live" });
    }
    // The runtime refused the session.
    await recordHostThreadOutcome(config, thread.id, await endedRunOnThread(thread.id, {
      status: "failed", error_json: { error_code: "runtime_session_invalid" },
    }), true);
    expect(await vendorSession()).toMatchObject({ status: "session_reset", vendor_session_id: null });
  });

  it("tells the Room about every context reset, not only the thread's first", async (ctx) => {
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
    await db.pool.query(`UPDATE host_threads SET last_session_id = $2 WHERE id = $1`, [thread.id, CONVERSATION]);
    const notices = async () => (await db.pool.query<{ run_id: string | null }>(
      `SELECT metadata_json->>'host_thread_run_id' AS run_id FROM messages
        WHERE session_id = $1 AND metadata_json->>'host_thread_event' = 'session_reset' ORDER BY created_at`,
      [CONVERSATION],
    )).rows.map((row) => row.run_id);
    // The thread keeps its id across resets, so each reset is a new fact.
    const invalid = { status: "failed", error_json: { error_code: "runtime_session_invalid" } };
    const first = await endedRunOnThread(thread.id, invalid);
    await recordHostThreadOutcome(config, thread.id, first, true);
    await repository.recordRunOutcome(thread.id, { lastRunId: randomUUID(), vendorSessionId: "vendor-again", sessionReset: false });
    const second = await endedRunOnThread(thread.id, invalid);
    await recordHostThreadOutcome(config, thread.id, second, true);
    // The same Run reported twice is still one reset.
    await recordHostThreadOutcome(config, thread.id, second, true);
    expect(await notices()).toEqual([first.id, second.id]);
  });

  it("gives every Agent × container its own runtime profile, and the machine's own to none of them", async (ctx) => {
    if (!db.available) return ctx.skip();
    // Do not share `profiles/<adapter>/<provider>` across runs. An unbound
    // run must not read the machine's own `~/.claude`. Two Agents in one
    // Room and one Agent in two Rooms are the two ways a shared profile
    // mixes what a vendor CLI remembers.
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
    // that creates a thread, so this fails loudly rather than failing open.
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
    // As production creates it: a Task thread carries no `execution_host_id`
    // of its own; the Location names the machine.
    await db.pool.query(`UPDATE host_threads SET vendor_session_id = 'vendor-task' WHERE id = $1`, [taskThread.id]);
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
    // As production creates it: a Task thread carries no `execution_host_id`
    // of its own; the Location names the machine.
    await db.pool.query(`UPDATE host_threads SET vendor_session_id = 'vendor-task' WHERE id = $1`, [taskThread.id]);
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
    const longCallId = `provider:${"call".repeat(100)}`;
    const longToolName = `command ${"x".repeat(300)}`;
    const events = await new PgHostThreadEventRepository(db.pool).append(thread.id, runId, [
      { event_type: "status", status: "run_started" },
      {
        event_type: "tool_activity_started",
        tool_call_id: longCallId,
        tool_name: longToolName,
        tool_details_json: { title: "Read project file", exit_code: 1, error: "file does not exist" },
        status: "pending",
      },
    ]);
    expect(events[0]).toMatchObject({ project_id: null, event_type: "status", status: "run_started" });
    expect(events[1]).toMatchObject({
      project_id: null,
      tool_call_id: longCallId,
      tool_name: longToolName,
      tool_details_json: { title: "Read project file", exit_code: 1, error: "file does not exist" },
    });
  });

  it("keeps a superseded attempt's late events out of the retried attempt's turn", async (ctx) => {
    if (!db.available) return ctx.skip();
    const thread = await new PgHostThreadRepository(db.pool).getOrCreateForDirect({
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
    for (const attempt of [1, 2]) {
      await db.pool.query(
        `INSERT INTO run_attempts (id, space_id, run_id, attempt_number, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,now(),now())`,
        [randomUUID(), SPACE, runId, attempt, attempt === 1 ? "failed" : "running"],
      );
    }
    const events = new PgHostThreadEventRepository(db.pool);
    // Attempt 1 is still unwinding after attempt 2 started: dropped.
    await expect(events.append(thread.id, runId, [{ event_type: "status", status: "timed_out" }], 1)).resolves.toEqual([]);
    const current = await events.append(thread.id, runId, [{ event_type: "status", status: "run_started" }], 2);
    expect(current).toEqual([expect.objectContaining({ attempt_number: 2, status: "run_started" })]);

    const runs = new PgRunRepository(db.pool);
    await expect(runs.appendRunEvent({ run_id: runId, space_id: SPACE, attempt_number: 1, event_type: "tool_call_started", status: "running" }))
      .resolves.toBeNull();
    await expect(runs.appendRunEvent({ run_id: runId, space_id: SPACE, attempt_number: 2, event_type: "tool_call_started", status: "running" }))
      .resolves.toMatchObject({ event_type: "tool_call_started" });
    const stored = await db.pool.query<{ attempt_number: number }>(`SELECT attempt_number FROM run_events WHERE run_id = $1`, [runId]);
    expect(stored.rows).toEqual([{ attempt_number: 2 }]);
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

  it("releases a cancelled Run's dispatch claim so the next conversation turn can start", async () => {
    const threadId = await seedDispatchableThread();
    await dispatch(threadId);
    const row = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1", [threadId])).rows[0]!;
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1", [threadId, row.id]);
    const { orchestration: service } = buildRunOrchestration(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }));
    await expect(service.cancelRun({ space_id: SPACE, run_id: row.id, requested_by_user_id: OWNER }))
      .resolves.toMatchObject({ status: "cancelled" });
    expect((await db.pool.query("SELECT dispatch_lock_id FROM host_threads WHERE id=$1", [threadId])).rows)
      .toEqual([{ dispatch_lock_id: null }]);
    await dispatch(threadId);
    expect(await runsOnThread(threadId)).toBe("2");
  });

  it("recovers a legacy settled Run's dispatch claim even after chat completion", async () => {
    const threadId = await seedDispatchableThread();
    await dispatch(threadId);
    const repository = new PgRunRepository(db.pool);
    const row = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1", [threadId])).rows[0]!;
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1", [threadId, row.id]);
    await repository.markRunTerminal({ run_id: row.id, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    // Old finalizers completed evaluation/chat without durably tracking release.
    await new PostRunFinalizationService(repository).finalize(row.id, SPACE);
    expect((await repository.getLatestRunFinalization(SPACE, row.id))?.settled_at).toBeTruthy();
    await repository.appendRunEvent({ space_id: SPACE, run_id: row.id, event_type: "chat_completed", status: "succeeded" });
    expect(await repository.listUnsettledFinalizations()).toContainEqual({ run_id: row.id, space_id: SPACE });

    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    await new PostRunFinalizationService(repository, undefined, undefined, undefined, runSettlement(config, db.pool)).finalize(row.id, SPACE);
    expect((await repository.getLatestRunFinalization(SPACE, row.id))?.settlement_json).toMatchObject({ completed: expect.arrayContaining(["host_thread"]) });
    expect(await repository.listUnsettledFinalizations()).toEqual([]);
    await dispatch(threadId);
    expect(await runsOnThread(threadId)).toBe("2");
  });

  it("retries a failed Host release without replaying completed settlement steps", async () => {
    const threadId = await seedDispatchableThread();
    await dispatch(threadId);
    const repository = new PgRunRepository(db.pool);
    const row = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1", [threadId])).rows[0]!;
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1", [threadId, row.id]);
    await repository.markRunTerminal({ run_id: row.id, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    // A new required step can also be owed by a legacy completed record.
    await new PostRunFinalizationService(repository).finalize(row.id, SPACE);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const release = runSettlement(config, db.pool).reconcilers((await repository.getRun(SPACE, row.id))!)[0]!;
    let unavailable = true;
    let projections = 0;
    const finalizer = new PostRunFinalizationService(repository, undefined, undefined, undefined, {
      reconcilers: () => [
        { key: release.key, settle: async run => {
          if (unavailable) throw new Error("Host thread store temporarily unavailable");
          await release.settle(run);
        } },
        { key: "independent_projection", settle: async () => { projections += 1; } },
      ],
    });
    await expect(finalizer.finalize(row.id, SPACE)).rejects.toMatchObject({ code: "settlement_pending", reconcilerKey: "host_thread" });
    expect((await repository.getLatestRunFinalization(SPACE, row.id))?.settled_at).toBeNull();
    expect((await db.pool.query("SELECT dispatch_lock_id FROM host_threads WHERE id=$1", [threadId])).rows[0].dispatch_lock_id).toBe(row.id);
    unavailable = false;
    await finalizer.finalize(row.id, SPACE);
    expect(projections).toBe(1);
    expect((await repository.getLatestRunFinalization(SPACE, row.id))?.settled_at).toBeTruthy();
    await dispatch(threadId);
  });

  it("adds Host release when a previously settled review hold is cancelled", async () => {
    const threadId = await seedDispatchableThread();
    await dispatch(threadId);
    const repository = new PgRunRepository(db.pool);
    const row = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1", [threadId])).rows[0]!;
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1", [threadId, row.id]);
    await db.pool.query(`UPDATE runs SET status='running',started_at=now(),
      runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=to_jsonb(p)
      FROM agent_runtime_profiles p WHERE runs.id=$1 AND p.id=$2`, [row.id, DISPATCH_PROFILE]);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    await repository.markRunTerminal({ run_id: row.id, space_id: SPACE, status: "failed",
      error_json: { error_code: "credentials_missing" }, completed_at: new Date().toISOString() });
    const before = await new PostRunFinalizationService(repository, undefined, undefined, undefined,
      runSettlement(config, db.pool), new PgRunSupervisor(db.pool)).finalize(row.id, SPACE);
    expect((await repository.getRun(SPACE, row.id))?.status).toBe("waiting_for_review");
    expect((await repository.getLatestRunFinalization(SPACE, row.id))?.settlement_json).toMatchObject({ completed: expect.not.arrayContaining(["host_thread"]) });
    const { orchestration } = buildRunOrchestration(config);
    await expect(orchestration.cancelRun({ space_id: SPACE, run_id: row.id, requested_by_user_id: OWNER })).resolves.toMatchObject({ status: "cancelled" });
    expect(await repository.getLatestRunFinalization(SPACE, row.id)).toMatchObject({ id: before.id,
      settlement_json: { completed: expect.arrayContaining(["host_thread"]) } });
    expect((await new PgHostThreadRepository(db.pool).getById(threadId))?.dispatch_lock_id).toBeNull();
  });

  it("keeps a newer turn's claim and session when an old settlement is replayed", async () => {
    const threadId = await seedDispatchableThread();
    await dispatch(threadId);
    const repository = new PgRunRepository(db.pool);
    const first = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1", [threadId])).rows[0]!.id;
    await repository.markRunTerminal({ run_id: first, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    await dispatch(threadId);
    const second = (await db.pool.query<{ id: string }>("SELECT id FROM runs WHERE host_task_thread_id=$1 AND id<>$2", [threadId, first])).rows[0]!.id;
    await db.pool.query("UPDATE host_threads SET last_run_id=$2,dispatch_lock_id=$2,vendor_session_id='new-session' WHERE id=$1", [threadId, second]);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const old = { id: first, status: "succeeded", output_json: { schema_version: "run_output.v1", result: { external_session_id: "old-session" } } };
    await recordHostThreadOutcome(config, threadId, old, true);
    expect((await new PgHostThreadRepository(db.pool).getById(threadId))?.dispatch_lock_id).toBe(second);
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1", [threadId]);
    await recordHostThreadOutcome(config, threadId, old, true);
    expect(await new PgHostThreadRepository(db.pool).getById(threadId)).toMatchObject({ last_run_id: second, vendor_session_id: "new-session" });
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
    // is waiting on a person. Do not keep a second status list: a Run that
    // landed in review must not deadlock the thread.
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

/**
 * A Room Agent's older turn A is held for quota (releasing its claim), the
 * person's newer turn B claims the same Conversation × Agent thread and
 * finishes, then A is admitted again and ends last. A's settlement must
 * release A's own claim without replacing B's session, and never another
 * Run's claim.
 */
describe("host thread settlement after a held turn ends last", () => {
  const output = (session: string) => ({ schema_version: "run_output.v1", result: { external_session_id: session } });
  const job = { user_id: OWNER, agent_id: AGENT, project_folder_id: FOLDER, payload: {} as Record<string, unknown> };

  async function heldThenReadmitted(options: { finishNewer?: boolean } = {}) {
    const threads = new PgHostThreadRepository(db.pool);
    const runs = new PgRunRepository(db.pool);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const thread = await threads.createForConversationAgent({ executionHostId: HOST, workspaceMode: "location",
      workspaceLocationId: LOCATION, spaceId: SPACE, sessionId: CONVERSATION, agentId: AGENT,
      runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER });
    const older = randomUUID();
    const newer = randomUUID();
    for (const [id, now] of [[older, "2026-10-01T00:00:00.000Z"], [newer, "2026-10-01T00:00:01.000Z"]] as const) {
      await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, existingAgent: true, now });
      await db.pool.query("UPDATE runs SET host_task_thread_id=$2, session_id=$3 WHERE id=$1", [id, thread.id, CONVERSATION]);
    }
    await db.pool.query("UPDATE runs SET status='queued' WHERE id=$1", [older]);
    const claimA = randomUUID();
    expect(await threads.claimConversationDispatch(thread.id, claimA)).toBe(true);
    await threads.recordConversationDispatch(thread.id, { lastRunId: older, sessionId: CONVERSATION, dispatchLockId: claimA });
    const heldJob = { ...job, payload: { run_id: older } };
    await holdInterruptedRun(db.pool, SPACE, older, { window: "session", resets_at: null, utilization: 99,
      account_label: "fixture", login: { host_id: HOST, runtime_key: "claude_code", installation: "own" },
      held_at: new Date().toISOString(), job: heldJob });
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBeNull();
    const claimB = randomUUID();
    expect(await threads.claimConversationDispatch(thread.id, claimB)).toBe(true);
    await threads.recordConversationDispatch(thread.id, { lastRunId: newer, sessionId: CONVERSATION, dispatchLockId: claimB });
    if (options.finishNewer !== false) {
      await runs.markRunTerminal({ run_id: newer, space_id: SPACE, status: "succeeded", completed_at: new Date().toISOString() });
      await db.pool.query("UPDATE runs SET output_json=$2 WHERE id=$1", [newer, output("session-b")]);
      await recordHostThreadOutcome(config, thread.id, (await runs.getRun(SPACE, newer))!, false);
      expect(await threads.getById(thread.id)).toMatchObject({ dispatch_lock_id: null, last_run_id: newer, vendor_session_id: "session-b" });
      expect(await withDbTransaction(db.pool, tx => enqueueWhenTurnFree(tx, { spaceId: SPACE, runId: older, job: heldJob }))).toBe("admitted");
      expect((await threads.getById(thread.id))?.dispatch_lock_id).toBe(older);
    }
    const finalizer = () => new PostRunFinalizationService(runs, undefined, undefined, undefined, runSettlement(config, db.pool));
    return { threads, runs, config, thread, older, newer, finalizer };
  }

  it("releases the older turn's own claim while keeping the newer turn's session and identity", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { threads, runs, thread, older, newer, finalizer } = await heldThenReadmitted();
    await db.pool.query("UPDATE host_threads SET identity_digest='identity-b', identity_digest_run_id=$2 WHERE id=$1", [thread.id, newer]);
    await runs.markRunTerminal({ run_id: older, space_id: SPACE, status: "failed",
      error_json: { error_code: "runtime_timeout" }, completed_at: new Date().toISOString() });
    // A came back with its own session: it must not replace the newer turn's.
    await db.pool.query("UPDATE runs SET output_json=$2 WHERE id=$1", [older, output("session-a")]);
    await finalizer().finalize(older, SPACE);
    expect(await threads.getById(thread.id)).toMatchObject({ dispatch_lock_id: null, last_run_id: newer,
      vendor_session_id: "session-b", identity_digest: "identity-b", identity_digest_run_id: newer });
    const ledger = await runs.getLatestRunFinalization(SPACE, older);
    expect(ledger?.settled_at).toBeTruthy();
    expect(ledger?.settlement_json).toMatchObject({ completed: expect.arrayContaining(["host_thread"]) });
    expect((await runs.listUnsettledFinalizations()).some(row => row.run_id === older)).toBe(false);
    // The Agent takes the next turn.
    expect(await threads.claimConversationDispatch(thread.id, randomUUID())).toBe(true);
  });

  it("never releases a newer turn's claim or a pending admission nonce when an older result is refused", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { threads, runs, thread, older, newer, finalizer } = await heldThenReadmitted({ finishNewer: false });
    // B is running and holds the thread; A is cancelled while held.
    await runs.markRunTerminal({ run_id: older, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    await finalizer().finalize(older, SPACE);
    expect(await threads.getById(thread.id)).toMatchObject({ dispatch_lock_id: newer, last_run_id: newer });
    // An admission in progress holds a nonce, not a Run id: untouched as well.
    const nonce = randomUUID();
    await db.pool.query("UPDATE host_threads SET dispatch_lock_id=$2 WHERE id=$1", [thread.id, nonce]);
    expect(await withDbTransaction(db.pool, tx => new PgHostThreadRepository(tx).settleRunOutcome(thread.id,
      { lastRunId: older, vendorSessionId: null, sessionReset: false }))).toEqual({ outcome_recorded: false, claim: "not_held" });
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBe(nonce);
  });

  it("keeps a claim its Run holds while not ended, and leaves that settlement owed", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { threads, runs, config, thread, older } = await heldThenReadmitted();
    // Re-admitted A is queued again (as a Supervisor successor attempt leaves it): its claim is live.
    expect(await withDbTransaction(db.pool, tx => new PgHostThreadRepository(tx).settleRunOutcome(thread.id,
      { lastRunId: older, vendorSessionId: null, sessionReset: false }))).toMatchObject({ claim: "run_not_terminal" });
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBe(older);
    // A settlement pass holding a stale terminal view of the Run does not complete the step.
    const stale = { ...(await runs.getRun(SPACE, older))!, status: "failed" as const };
    const step = runSettlement(config, db.pool).reconcilers(stale).find(entry => entry.key === "host_thread")!;
    await expect(step.settle(stale)).rejects.toBeInstanceOf(HostThreadClaimHeldError);
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBe(older);
  });

  it("writes nothing for a terminal snapshot once the same Run's successor attempt is queued", async (ctx) => {
    if (!db.available) return ctx.skip();
    const threads = new PgHostThreadRepository(db.pool);
    const runs = new PgRunRepository(db.pool);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const thread = await threads.createForConversationAgent({ executionHostId: HOST, workspaceMode: "location",
      workspaceLocationId: LOCATION, spaceId: SPACE, sessionId: CONVERSATION, agentId: AGENT,
      runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER });
    const id = randomUUID();
    await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, existingAgent: true });
    await db.pool.query("UPDATE runs SET status='failed', host_task_thread_id=$2, session_id=$3, output_json=$4 WHERE id=$1",
      [id, thread.id, CONVERSATION, output("stale-session")]);
    const nonce = randomUUID();
    expect(await threads.claimConversationDispatch(thread.id, nonce)).toBe(true);
    await threads.recordConversationDispatch(thread.id, { lastRunId: id, sessionId: CONVERSATION, dispatchLockId: nonce });
    const stale = (await runs.getRun(SPACE, id))!;
    // The Supervisor retry writer queues attempt 2 while a terminal snapshot is still in hand.
    expect((await runs.requeueRunForRetry({ run_id: id, space_id: SPACE, updated_at: new Date().toISOString(),
      reason_code: "runtime_timeout", attempt_number: 2 }))?.status).toBe("queued");
    await db.pool.query(`UPDATE host_threads SET vendor_session_id='current-session', identity_digest='current-identity',
      identity_digest_run_id=$2, context_tokens=1200, context_window_tokens=200000 WHERE id=$1`, [thread.id, id]);
    const before = await threads.getById(thread.id);
    const step = runSettlement(config, db.pool).reconcilers(stale).find(entry => entry.key === "host_thread")!;
    await expect(step.settle(stale)).rejects.toBeInstanceOf(HostThreadClaimHeldError);
    expect((await runs.getRun(SPACE, id))?.status).toBe("queued");
    const after = await threads.getById(thread.id);
    for (const field of ["dispatch_lock_id", "last_run_id", "vendor_session_id", "identity_digest", "identity_digest_run_id",
      "context_tokens", "context_window_tokens", "status", "retired_vendor_session_ids", "updated_at"] as const) {
      expect(after?.[field], field).toEqual(before?.[field]);
    }
    expect(after).toMatchObject({ dispatch_lock_id: id, vendor_session_id: "current-session", identity_digest: "current-identity" });
  });

  it("converges once under repeated and concurrent settlement", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { threads, runs, thread, older, newer, finalizer } = await heldThenReadmitted();
    await runs.markRunTerminal({ run_id: older, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    const results = await Promise.allSettled([finalizer().finalize(older, SPACE), finalizer().finalize(older, SPACE), finalizer().finalize(older, SPACE)]);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "finalization_in_progress" });
    }
    await finalizer().finalize(older, SPACE);
    await finalizer().finalize(older, SPACE);
    expect(await threads.getById(thread.id)).toMatchObject({ dispatch_lock_id: null, last_run_id: newer, vendor_session_id: "session-b" });
    const ledgers = await runs.listRunFinalizations(SPACE, older);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]?.settled_at).toBeTruthy();
  });

  it("repairs a ledger that recorded the step done while the claim is still held", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { threads, runs, config, thread, older } = await heldThenReadmitted();
    await runs.markRunTerminal({ run_id: older, space_id: SPACE, status: "cancelled", completed_at: new Date().toISOString() });
    // As the previous step left it: the outcome was refused and the step recorded done.
    await new PostRunFinalizationService(runs, undefined, undefined, undefined, {
      reconcilers: () => [{ key: "host_thread", settle: async () => {} }],
    }).finalize(older, SPACE);
    expect((await runs.getLatestRunFinalization(SPACE, older))).toMatchObject({ settled_at: expect.anything(),
      settlement_json: { completed: ["host_thread"] } });
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBe(older);
    expect((await runs.listUnsettledFinalizations()).some(row => row.run_id === older)).toBe(true);
    // The recovery sweep through the canonical finalization entry, twice.
    const materializer = RunMaterializationService.fromConfig(config);
    await resumeUnsettledRuns(config, runs, undefined, materializer);
    await resumeUnsettledRuns(config, runs, undefined, materializer);
    expect((await threads.getById(thread.id))?.dispatch_lock_id).toBeNull();
    expect((await runs.getLatestRunFinalization(SPACE, older))?.settled_at).toBeTruthy();
    expect((await runs.listUnsettledFinalizations()).some(row => row.run_id === older)).toBe(false);
    expect(await threads.claimConversationDispatch(thread.id, randomUUID())).toBe(true);
  });
});


describe('execution workspace durable identity',()=>{
 const insert=(id:string,ownerKind='conversation',taskId:string|null=null)=>db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,session_id,task_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,SPACE,PROJECT,LOCATION,HOST,ownerKind,CONVERSATION,taskId]);
 it('keeps one workspace per conversation Location generation and rejects mixed owners',async(ctx)=>{
  if(!db.available)return ctx.skip();
  await insert(randomUUID());
  await expect(insert(randomUUID())).rejects.toMatchObject({code:'23505'});
  await expect(insert(randomUUID(),'conversation',TASK)).rejects.toMatchObject({code:'23514'});
 });
 it('fences change-set scope and keeps only one writable open change set',async(ctx)=>{
  if(!db.available)return ctx.skip();
  const workspace=randomUUID();await insert(workspace);
  const change=(id:string,space=SPACE,sequence=1)=>db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id) VALUES($1,$2,$3,1,$4,$5,$5)`,[id,workspace,space,sequence,randomUUID()]);
  await change(randomUUID());
  await expect(change(randomUUID(),SPACE,2)).rejects.toMatchObject({code:'23505'});
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE workspace_id=$1",[workspace]);
  await expect(change(randomUUID(),randomUUID(),3)).rejects.toMatchObject({code:'23503'});
 });
});

describe('isolated conversation workspaces', () => {
  async function isolatedRun(sessionId = CONVERSATION) {
    const id = randomUUID();
    await seedRun(db.pool, { id, space: SPACE, owner: OWNER, agent: AGENT, version: VERSION, existingAgent: true });
    await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,
      instructed_by_user_id=$5,status='running',contract_snapshot_json='{"execution_workspace_version":1}',
      permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.change.complete"}]}' WHERE id=$1`,
      [id, PROJECT, sessionId, LOCATION, OWNER]);
    return (await new PgRunRepository(db.pool).getRun(SPACE, id))!;
  }
  async function capable() {
    await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2}}'::jsonb WHERE id=$1`, [HOST]);
  }
  it('separates conversations, reuses their run binding, and refuses an old Host', async ctx => {
    if (!db.available) return ctx.skip();
    const { ensureExecutionWorkspace } = await import('../src/modules/projectFolders/executionWorkspaces.js');
    const run = await isolatedRun();
    await expect(ensureExecutionWorkspace(db.pool, run, HOST, LOCATION)).rejects.toThrow('execution_workspace_host_upgrade_required');
    await capable();
    const one = await ensureExecutionWorkspace(db.pool, run, HOST, LOCATION);
    expect((await ensureExecutionWorkspace(db.pool, run, HOST, LOCATION)).ref).toEqual(one.ref);
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`, [session, SPACE, PROJECT, roomId]);
    const other = await ensureExecutionWorkspace(db.pool, await isolatedRun(session), HOST, LOCATION);
    expect(other.workspace.id).not.toBe(one.workspace.id);
    expect(other.workspace.task_id).toBeNull();
  });
  it('starts a retired owner with a fresh UUID and incremented generation',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const first=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[first.workspace.id]);
    const next=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    expect(next.workspace.id).not.toBe(first.workspace.id);expect(next.ref.generation).toBe(2);
  });
  it.for(['receipt','modified'] as const)('continues a new turn after a blocked %s workspace without changing its evidence',async(kind,ctx)=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const firstRun=await isolatedRun(),first=await ensureExecutionWorkspace(db.pool,firstRun,HOST,LOCATION);
    await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[firstRun.id]);
    await db.pool.query("UPDATE execution_workspaces SET state='blocked',head_commit=$2 WHERE id=$1",[first.workspace.id,kind==='modified'?'b'.repeat(40):null]);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',checkpoint_commit=$2 WHERE workspace_id=$1",[first.workspace.id,kind==='modified'?'b'.repeat(40):null]);
    await db.pool.query("UPDATE workspace_change_sets SET state='blocked',verification_json=$2::jsonb WHERE id=$1",[first.changeSetId,JSON.stringify({error:kind==='modified'?'read_only_workspace_modified':'workspace_launch_identity_missing'})]);
    const evidence=(await db.pool.query('SELECT to_jsonb(w) AS value FROM execution_workspaces w WHERE id=$1',[first.workspace.id])).rows[0].value;
    const nextRun=await isolatedRun(),parallelRun=await isolatedRun();
    const [next,parallel]=await Promise.all([ensureExecutionWorkspace(db.pool,nextRun,HOST,LOCATION),ensureExecutionWorkspace(db.pool,parallelRun,HOST,LOCATION)]);
    expect(next.workspace.id).not.toBe(first.workspace.id);expect(next.ref.generation).toBe(2);
    expect(parallel.workspace.id).toBe(next.workspace.id);expect(next.retainedWorkspaceId).toBe(first.workspace.id);
    expect(next.ref.base_commit).toBeUndefined();
    expect((await ensureExecutionWorkspace(db.pool,nextRun,HOST,LOCATION)).ref).toEqual(next.ref);
    await expect(ensureExecutionWorkspace(db.pool,firstRun,HOST,LOCATION)).rejects.toThrow('workspace_permission_violation_needs_review');
    await expect(recordWorkspaceLaunch(db.pool,firstRun,{...first.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev'})).rejects.toThrow('workspace_permission_violation_needs_review');
    await recordWorkspaceLaunch(db.pool,nextRun,{...next.ref,start_commit:'c'.repeat(40),target_ref:'refs/heads/dev'});
    expect((await db.pool.query('SELECT to_jsonb(w) AS value FROM execution_workspaces w WHERE id=$1',[first.workspace.id])).rows[0].value).toEqual(evidence);
    const {workspaceChangesForRun,workspaceChangesForConversation}=await import('../src/modules/projectFolders/workspaceReadModel.js');
    // The new turn reads only its own batch; the retained generation stays
    // reachable once, through the conversation's pending work.
    expect(await workspaceChangesForRun(db.pool,nextRun,OWNER)).toEqual([expect.objectContaining({workspace_id:next.workspace.id,workspace_state:'ready'})]);
    expect((await workspaceChangesForConversation(db.pool,{spaceId:SPACE,sessionId:CONVERSATION,projectId:PROJECT},OWNER)).entries.map(entry=>entry.change)).toEqual(expect.arrayContaining([
      expect.objectContaining({workspace_id:first.workspace.id,workspace_state:'blocked',can_manage:true}),
      expect.objectContaining({workspace_id:next.workspace.id,workspace_state:'ready'}),
    ]));
  });
  it.for(['failed','cancelled','degraded','orphaned'] as const)('preserves saved conversation changes after a later %s turn never launches',async(status,ctx)=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const firstRun=await isolatedRun(),first=await ensureExecutionWorkspace(db.pool,firstRun,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,firstRun,{...first.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev'});
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[firstRun.id]);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[firstRun.id,'b'.repeat(40)]);
    await db.pool.query('UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1',[first.workspace.id,'b'.repeat(40)]);
    const failedRun=await isolatedRun(),failed=await ensureExecutionWorkspace(db.pool,failedRun,HOST,LOCATION);
    expect(failed.workspace.id).toBe(first.workspace.id);
    await db.pool.query('UPDATE runs SET status=$2 WHERE id=$1',[failedRun.id,status]);
    const next=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    expect(next.workspace.id).toBe(first.workspace.id);
    expect(next.changeSetId).toBe(first.changeSetId);
    expect(next.changeRevision).toBe(first.changeRevision);
    expect((await db.pool.query('SELECT verification_json FROM workspace_change_sets WHERE id=$1',[next.changeSetId])).rows[0].verification_json).not.toHaveProperty('continuation_from_workspace_id');
    expect(next.workspace.head_commit).toBe('b'.repeat(40));
    expect(next.ref.generation).toBe(1);
    expect(next.retainedWorkspaceId).toBeUndefined();
  });
  it('keeps an unlaunched generation while another bound turn is still in flight',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const failedRun=await isolatedRun(),first=await ensureExecutionWorkspace(db.pool,failedRun,HOST,LOCATION);
    const activeRun=await isolatedRun(),active=await ensureExecutionWorkspace(db.pool,activeRun,HOST,LOCATION);
    await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[failedRun.id]);
    const next=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    expect(next.workspace.id).toBe(first.workspace.id);
    expect(next.changeSetId).toBe(first.changeSetId);
    await recordWorkspaceLaunch(db.pool,activeRun,{...active.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev'});
    expect((await db.pool.query('SELECT state,base_commit FROM execution_workspaces WHERE id=$1',[first.workspace.id])).rows[0]).toEqual({state:'ready',base_commit:'a'.repeat(40)});
  });
  it('keeps retained changes reachable from a failed turn without its own workspace binding',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {workspaceChangesForRun,conversationWorkspaceChangesForViewer}=await import('../src/modules/projectFolders/workspaceReadModel.js');
    const first=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    await db.pool.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1",[first.workspace.id]);
    await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[first.changeSetId]);
    const next=await isolatedRun();await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[next.id]);
    // A failed turn without a binding owns no batch; the retained one is the
    // conversation's pending work, not a copy under every later Run.
    expect(await workspaceChangesForRun(db.pool,next,OWNER)).toEqual([]);
    expect((await conversationWorkspaceChangesForViewer(db.pool,SPACE,CONVERSATION,OWNER))?.entries.map(entry=>entry.change)).toEqual([expect.objectContaining({change_set_id:first.changeSetId,can_manage:true})]);
    const session=randomUUID();await db.pool.query("INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())",[session,SPACE,PROJECT,roomId]);
    expect(await conversationWorkspaceChangesForViewer(db.pool,SPACE,session,OWNER)).toEqual({entries:[],next_cursor:null});
    expect(await workspaceChangesForRun(db.pool,await isolatedRun(session),OWNER)).toEqual([]);
  });
  it.for(['pending','exhausted'] as const)('retries missing launch receipts without marking a permission breach and continues after %s recovery',async(phase,ctx)=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
    const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
    const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
    const firstRun=await isolatedRun(),first=await ensureExecutionWorkspace(db.pool,firstRun,HOST,LOCATION);
    await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[firstRun.id]);
    const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:null,launch_info:null});
    const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts);
    for(const attempts of phase==='pending'?[1]:[1,8]){
      await expect(registry.dispatch({job_type:'execution_workspace_checkpoint',job_id:randomUUID(),space_id:SPACE,user_id:OWNER,attempts,max_attempts:8,worker_id:'test',payload:{run_id:firstRun.id}})).rejects.toThrow('workspace_launch_identity_missing');
      expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[first.workspace.id])).rows[0].state).toBe('requested');
      expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[firstRun.id])).rows[0].checkpoint_state).toBe('pending');
    }
    expect((await db.pool.query('SELECT verification_json FROM workspace_change_sets WHERE id=$1',[first.changeSetId])).rows[0].verification_json).toMatchObject({checkpoint_recovery:{state:phase==='pending'?'retrying':'exhausted',error:'workspace_launch_identity_missing'}});
    const next=await ensureExecutionWorkspace(db.pool,await isolatedRun(),HOST,LOCATION);
    expect(next.workspace.id).not.toBe(first.workspace.id);expect(next.ref.generation).toBe(2);
  });
  it('retains an exhausted launched workspace while a fresh turn still checks current Host authority',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const firstRun=await isolatedRun(),first=await ensureExecutionWorkspace(db.pool,firstRun,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,firstRun,{...first.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev'});
    await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[firstRun.id]);
    await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[first.workspace.id,'b'.repeat(40)]);
    await db.pool.query(`UPDATE workspace_change_sets SET state='blocked',verification_json='{"checkpoint_recovery":{"state":"exhausted"}}' WHERE id=$1`,[first.changeSetId]);
    const nextRun=await isolatedRun();
    await seedSpaceMember(db.pool,{space:SPACE,user:OTHER_TASK});
    await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OTHER_TASK]);
    await expect(ensureExecutionWorkspace(db.pool,nextRun,HOST,LOCATION)).rejects.toMatchObject({statusCode:404});
    expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(1);
    await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OWNER]);
    const next=await ensureExecutionWorkspace(db.pool,nextRun,HOST,LOCATION);
    expect(next.ref.generation).toBe(2);expect(next.ref.base_commit).toBeUndefined();
    expect((await db.pool.query('SELECT state,head_commit FROM execution_workspaces WHERE id=$1',[first.workspace.id])).rows[0]).toEqual({state:'ready',head_commit:'b'.repeat(40)});
  });
  it('records actual launch identity and checkpoints through the same Host command without moving the source', async ctx => {
    if (!db.available) return ctx.skip();
    await capable();
    const { ensureExecutionWorkspace, recordWorkspaceLaunch } = await import('../src/modules/projectFolders/executionWorkspaces.js');
    const { checkpointWorkspaceRun } = await import('../src/modules/hosts/executionWorkspaceJobs.js');
    const { HostConnectionRegistry } = await import('../src/modules/hosts/connectionRegistry.js');
    const run = await isolatedRun(), w = await ensureExecutionWorkspace(db.pool, run, HOST, LOCATION);
    await expect(recordWorkspaceLaunch(db.pool, run, { id: randomUUID(), generation: 1, start_commit: 'a'.repeat(40), target_ref: 'refs/heads/dev' })).rejects.toThrow('generation_mismatch');
    await recordWorkspaceLaunch(db.pool, run, { ...w.ref, start_commit: 'a'.repeat(40), target_ref: 'refs/heads/dev' });
    const hosts = new HostConnectionRegistry();
    // Mock only the external Host boundary; all identity and state transitions use real PG.
    hosts.requestTaskBranch = async (_host, command, frame): Promise<any> => {
      expect(command).toBe('execution_workspace_command');
      expect(frame).toMatchObject({ action: 'checkpoint', workspace: { execution_workspace: w.ref } });
      return { ok: true, commit: 'b'.repeat(40), branch: 'rainver/workspace', error: null };
    };
    await checkpointWorkspaceRun(db.pool, run.id, SPACE, hosts);
    expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0]).toEqual({ checkpoint_state: 'saved', checkpoint_commit: 'b'.repeat(40) });
  });
  it('keeps the newest physical checkpoint when Host replies arrive out of order',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {checkpointWorkspaceRun}=await import('../src/modules/hosts/executionWorkspaceJobs.js');const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
    const first=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,first,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,first,{...w.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev',launch_sequence:1});
    const second=await isolatedRun();await ensureExecutionWorkspace(db.pool,second,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,second,{...w.ref,start_commit:'b'.repeat(40),target_ref:'refs/heads/dev',launch_sequence:2});
    const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async(_host,_command,frame):Promise<any>=>({ok:true,branch:'owned',commit:(frame as any).run_id===first.id?'b'.repeat(40):'c'.repeat(40),error:null});
    await checkpointWorkspaceRun(db.pool,second.id,SPACE,hosts);await checkpointWorkspaceRun(db.pool,first.id,SPACE,hosts);
    expect((await db.pool.query('SELECT head_commit,head_sequence FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0]).toEqual({head_commit:'c'.repeat(40),head_sequence:2});
    expect((await db.pool.query('SELECT base_commit,source_commit,source_sequence FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toEqual({base_commit:'a'.repeat(40),source_commit:'c'.repeat(40),source_sequence:2});
  });
  it('makes completion a replayable intent and rechecks current grants', async ctx => {
    if (!db.available) return ctx.skip();
    await capable();
    const { ensureExecutionWorkspace } = await import('../src/modules/projectFolders/executionWorkspaces.js');
    const { operationRuntime } = await import('../src/modules/systemActions/operations/runtime.js');
    const { runActor } = await import('../src/modules/systemActions/operations/actor.js');
    const run = await isolatedRun(), w = await ensureExecutionWorkspace(db.pool, run, HOST, LOCATION);
    const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
    const engine = await operationRuntime(config), actor = await runActor(db.pool, run), key = randomUUID();
    const input = { change_set_id: w.changeSetId, expected_revision: 1, summary: 'Requested edit complete' };
    const first = await engine.execute('workspace.change.complete', input, actor, randomUUID(), key);
    expect(first.http_status, JSON.stringify(first.body)).toBe(200);
    expect((await engine.execute('workspace.change.complete', input, actor, randomUUID(), key)).replayed).toBe(true);
    expect((await db.pool.query("SELECT status FROM jobs WHERE job_type='execution_workspace_complete'")).rows).toHaveLength(1);
    await db.pool.query("UPDATE runs SET permission_snapshot_json='{}' WHERE id=$1", [run.id]);
    expect((await engine.execute('workspace.change.complete', input, actor, randomUUID(), key)).http_status).toBe(404);
  });
  it('reads only the immutable checkpoint through the visible Run and never falls back to the source',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {readRunFilePreview}=await import('../src/modules/runs/filePreview.js');
    const {sharedHostConnectionRegistry:hosts}=await import('../src/modules/hosts/connectionRegistry.js');
    const run=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
    await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:LOCATION,execution_workspace:w.ref});
    const identity={spaceId:SPACE,userId:OWNER,role:'owner' as const};
    await expect(readRunFilePreview(db.pool,config,identity,run.id,'result.md')).rejects.toMatchObject({statusCode:409});
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[run.id,'b'.repeat(40)]);
    const original=hosts.requestTaskBranch;let requests=0;
    try{
      hosts.requestTaskBranch=async(_host,command,frame):Promise<any>=>{requests++;expect(command).toBe('execution_workspace_command');expect(frame).toMatchObject({action:'read',expected_commit:'b'.repeat(40),workspace:{execution_workspace:{id:w.workspace.id}}});return {ok:true,branch:'owned',commit:'b'.repeat(40),file:{path:'result.md',content_base64:Buffer.from('saved bytes').toString('base64')},error:null};};
      expect(await readRunFilePreview(db.pool,config,identity,run.id,'result.md')).toEqual({kind:'text',name:'result.md',content:'saved bytes'});
      hosts.requestTaskBranch=async():Promise<any>=>({ok:false,branch:null,commit:null,error:'host_offline'});
      await expect(readRunFilePreview(db.pool,config,identity,run.id,'result.md')).rejects.toMatchObject({statusCode:404});
      await db.pool.query("INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active','workspace-other@test.invalid','system',now(),now())",[OTHER_TASK]);
      await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OTHER_TASK]);
      await expect(readRunFilePreview(db.pool,config,identity,run.id,'result.md')).rejects.toMatchObject({statusCode:404});
      expect(requests).toBe(1);
    }finally{hosts.requestTaskBranch=original;}
  });
  it('keeps initialized conversations on a stale pinned Location without allowing a new unpinned selection',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    await db.pool.query(`INSERT INTO conversation_execution_contexts(id,space_id,session_id,execution_host_id,primary_workspace_mode,primary_project_folder_id,primary_workspace_location_id,state,initialized_at,initialized_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'location',$5,$6,'initialized',now(),$7,now(),now())`,[randomUUID(),SPACE,CONVERSATION,HOST,FOLDER,LOCATION,OWNER]);
    await db.pool.query("UPDATE workspace_locations SET status='stale' WHERE id=$1",[LOCATION]);
    const pinned=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,pinned,HOST,LOCATION);expect(w.workspace.workspace_location_id).toBe(LOCATION);
    expect((await ensureExecutionWorkspace(db.pool,pinned,HOST,LOCATION)).workspace.id).toBe(w.workspace.id);
    const other=randomUUID();await db.pool.query("INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())",[other,SPACE,PROJECT,roomId]);
    await expect(ensureExecutionWorkspace(db.pool,await isolatedRun(other),HOST,LOCATION)).rejects.toMatchObject({statusCode:404});
  });
  it('does not use a Git attachment as the managed Primary for relative output links',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');const {readRunFilePreview}=await import('../src/modules/runs/filePreview.js');
    const run=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
    await frozenWorkspaceLayout(run.id,{kind:'managed',agent_id:AGENT,container:{kind:'conversation',conversation_id:CONVERSATION}},[{workspace_location_id:LOCATION,execution_workspace:w.ref,access_mode:'read'}]);
    await db.pool.query("UPDATE runs SET workspace_location_id=NULL WHERE id=$1",[run.id]);await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[run.id,'b'.repeat(40)]);
    await expect(readRunFilePreview(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),{spaceId:SPACE,userId:OWNER},run.id,'report.md')).rejects.toMatchObject({statusCode:404});
  });
  it('recovers missing checkpoint delivery idempotently, without declaring an open change complete',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
    const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
    const run=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);
    await db.pool.query("DELETE FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[run.id]);
    const hosts=new HostConnectionRegistry();
    const first=await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});expect(first.recovered).toBe(1);
    expect((await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts})).recovered).toBe(0);
    expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('open');
  });
  it('blocks a modified read-only checkpoint and never adopts it as a writable workspace head',async ctx=>{
    if(!db.available)return ctx.skip();await capable();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {checkpointWorkspaceRun}=await import('../src/modules/hosts/executionWorkspaceJobs.js');const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
    const run=await isolatedRun(),w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION,'read');
    await recordWorkspaceLaunch(db.pool,run,{...w.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev',launch_sequence:1});
    const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async():Promise<any>=>({ok:true,branch:'owned',commit:'b'.repeat(40),error:null});
    await checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts);
    expect((await db.pool.query('SELECT state,head_commit FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0]).toEqual({state:'blocked',head_commit:null});
    expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0].checkpoint_state).toBe('blocked');
    await expect(ensureExecutionWorkspace(db.pool,run,HOST,LOCATION)).rejects.toThrow('workspace_permission_violation_needs_review');
    await expect(recordWorkspaceLaunch(db.pool,run,{...w.ref,start_commit:'b'.repeat(40),target_ref:'refs/heads/dev',launch_sequence:2})).rejects.toThrow('workspace_permission_violation_needs_review');
    expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].state).toBe('blocked');
  });

});

describe('isolated manager delegation', () => {
  async function family() {
    await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2}}'::jsonb WHERE id=$1`,[HOST]);
    const parent=randomUUID(),group=randomUUID();
    await seedRun(db.pool,{id:parent,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
    const message=randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Implement two changes',0,'/',now())`,[message,SPACE,CONVERSATION,OWNER]);
    await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Isolated fan-out','Two changes','active',now(),now())`,[group,SPACE,OWNER,roomId,CONVERSATION,message,PROJECT]);
    await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,project_folder_id=$5,run_group_id=$6,status='waiting_for_dependency',contract_snapshot_json='{"execution_workspace_version":1}' WHERE id=$1`,[parent,PROJECT,CONVERSATION,LOCATION,FOLDER,group]);
    const children=[];
    for(let i=0;i<2;i++){
      const child=randomUUID(),delegation=randomUUID();
      await seedRun(db.pool,{id:child,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
      await db.pool.query(`INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,requesting_agent_id,target_agent_id,status,instruction,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,'queued','Implement a change',now(),now())`,[delegation,SPACE,group,parent,child,AGENT]);
      await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,project_folder_id=$5,run_group_id=$6,parent_run_id=$7,root_run_id=$7,delegation_id=$8,status='queued',contract_snapshot_json='{"execution_workspace_version":1,"workspace_access":"write"}',model_override_json='{"chat_turn":{"schema_version":"chat_turn.v1"}}' WHERE id=$1`,[child,PROJECT,CONVERSATION,LOCATION,FOLDER,group,parent,delegation]);
      children.push((await new PgRunRepository(db.pool).getRun(SPACE,child))!);
    }
    return {parent:(await new PgRunRepository(db.pool).getRun(SPACE,parent))!,children};
  }
  it('admits isolated sibling writers together only after the parent checkpoint',async ctx=>{
    if(!db.available)return ctx.skip();
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {AgentGroupRunLifecycleProjector}=await import('../src/modules/agentGroups/lifecycleProjector.js');
    const {parent,children}=await family(),w=await ensureExecutionWorkspace(db.pool,parent,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,parent,{...w.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev'});
    const projector=new AgentGroupRunLifecycleProjector(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
    await projector.queueDelegatedChildren(parent);
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(0);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[parent.id,'b'.repeat(40)]);
    await projector.queueDelegatedChildren(parent);
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(2);
    const first=await ensureExecutionWorkspace(db.pool,children[0]!,HOST,LOCATION),second=await ensureExecutionWorkspace(db.pool,children[1]!,HOST,LOCATION);
    expect(first.workspace.base_commit).toBe('b'.repeat(40));
    expect(second.workspace.id).not.toBe(first.workspace.id);
    expect(first.workspace.parent_workspace_id).toBe(w.workspace.id);
    expect(first.workspace.target_ref).toContain(w.workspace.id);
  });

  it.for(['host','location'] as const)('recovers a frozen yielded manager after bounded %s failure without completing its turn',async(kind)=>{
    const {ensureExecutionWorkspace,recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
    const {AgentGroupRunLifecycleProjector}=await import('../src/modules/agentGroups/lifecycleProjector.js');
    const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
    const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
    const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
    const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
    const {JobWorker}=await import('../src/modules/jobs/worker.js');
    const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
    const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
    const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
    const {parent,children}=await family(),runs=new PgRunRepository(db.pool);
    await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[parent.id]);
    await db.pool.query("INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES($1,$2,$3,1,'running',now(),now()) ON CONFLICT(space_id,run_id,attempt_number) DO UPDATE SET status='running'",[randomUUID(),SPACE,parent.id]);
    const current=(await runs.getRun(SPACE,parent.id))!,w=await ensureExecutionWorkspace(db.pool,current,HOST,LOCATION);
    await recordWorkspaceLaunch(db.pool,current,{...w.ref,start_commit:'a'.repeat(40),target_ref:'refs/heads/dev',launch_sequence:1});
    await runs.tryAcquireExecutionLock({run_id:parent.id,worker_id:'manager'});
    expect(await runs.parkRunForDependencyResults({run_id:parent.id,space_id:SPACE,run_group_id:parent.run_group_id!,scope:'own_delegations',reason:'Wait for frozen children',resume_instruction:'Review their changes',depends_on_run_ids:children.map(c=>c.id),paused_at:new Date().toISOString()})).toMatchObject({status:'waiting'});
    await runs.releaseExecutionLock(parent.id,'manager'); // Adapter exited; the parked turn no longer writes.
    const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts=new HostConnectionRegistry(),registry=new JobHandlerRegistry();
    registerExecutionWorkspaceJobs(registry,config,hosts);
    if(kind==='location')await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[LOCATION]);
    hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error:'workspace_host_operation_failed',commit:null});
    const queue=new PgJobQueueRepository(db.pool),worker=new JobWorker(queue,registry,'checkpoint',['execution_workspace_checkpoint']);
    const job=(await db.pool.query("SELECT id,max_attempts FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[parent.id])).rows[0];
    for(let n=0;n<job.max_attempts;n++){
      await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[job.id]);
      expect(await worker.processOne()).toMatchObject({status:'failed'});
    }
    let c=(await db.pool.query('SELECT * FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
    expect(c).toMatchObject({state:'blocked',verification_json:{checkpoint_recovery:{state:'exhausted'}}});
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(0);
    const engine=await operationRuntime(config),actor=sessionActor({spaceId:SPACE,userId:OWNER});
    const recover=()=>engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:c.revision,summary:'Retry the frozen manager checkpoint'},actor,randomUUID(),randomUUID());
    await runs.tryAcquireExecutionLock({run_id:parent.id,worker_id:'not-yet-released'});
    expect((await recover()).http_status).toBe(409);
    await runs.releaseExecutionLock(parent.id,'not-yet-released');
    for(const status of ['queued','running','cancelling']){
      await db.pool.query('UPDATE runs SET status=$2 WHERE id=$1',[parent.id,status]);
      expect((await recover()).http_status).toBe(409);
    }
    await db.pool.query("UPDATE runs SET status='waiting_for_dependency',output_json=jsonb_set(output_json,'{waiting_for_results,status}',to_jsonb('resumed'::text)) WHERE id=$1",[parent.id]);
    expect((await recover()).http_status).toBe(409);
    await db.pool.query("UPDATE runs SET output_json=jsonb_set(output_json,'{waiting_for_results,status}',to_jsonb('waiting'::text)) WHERE id=$1",[parent.id]);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[parent.id]);
    expect((await recover()).http_status).toBe(409);
    await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[parent.id]);
    await db.pool.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1",[w.workspace.id]);
    expect((await recover()).http_status).toBe(409);
    await db.pool.query("UPDATE execution_workspaces SET state='ready' WHERE id=$1",[w.workspace.id]);
    const receipt=await recover();expect(receipt.http_status,JSON.stringify(receipt.body)).toBe(200);
    expect(receipt.body).toMatchObject({data:{state:'open'}});
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='execution_workspace_complete'")).rows).toHaveLength(0);
    const requested=(await db.pool.query("SELECT id,payload_json FROM jobs WHERE job_type='execution_workspace_checkpoint' AND status='pending' AND payload_json->>'run_id'=$1",[parent.id])).rows[0];
    await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1",[requested.id]); // Lost delivery after the explicit request.
    hosts.isOnline=()=>false;
    await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
    const restored=(await db.pool.query("SELECT id,payload_json FROM jobs WHERE job_type='execution_workspace_checkpoint' AND status='pending' AND payload_json->>'run_id'=$1",[parent.id])).rows[0];
    expect(restored?.payload_json).toMatchObject({checkpoint_recovery_id:requested.payload_json.checkpoint_recovery_id});
    if(kind==='location')await db.pool.query("UPDATE workspace_locations SET status='active' WHERE id=$1",[LOCATION]);
    hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:'b'.repeat(40),branch:'owned',error:null});
    expect(await worker.processOne()).toMatchObject({status:'completed'});
    expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[parent.id])).rows[0]).toMatchObject({checkpoint_state:'saved',checkpoint_commit:'b'.repeat(40)});
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='agent_run'")).rows).toHaveLength(2);
    expect((await runs.getRun(SPACE,parent.id))?.status).toBe('waiting_for_dependency');
    c=(await db.pool.query('SELECT * FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
    expect(c).toMatchObject({state:'open',completion_basis:null,source_commit:'b'.repeat(40)});
    expect((await db.pool.query('SELECT 1 FROM task_merges WHERE change_set_id=$1',[w.changeSetId])).rowCount).toBe(0);
    const projector=new AgentGroupRunLifecycleProjector(db.pool,config);
    await projector.reconcileWaitingRun((await runs.getRun(SPACE,parent.id))!);
    expect((await runs.getRun(SPACE,parent.id))?.status).toBe('waiting_for_dependency');
    for(const child of children){
      const adopted=await ensureExecutionWorkspace(db.pool,child,HOST,LOCATION);
      expect(adopted.workspace).toMatchObject({parent_workspace_id:w.workspace.id,base_commit:'b'.repeat(40)});
      await db.pool.query("UPDATE workspace_change_sets SET state='no_changes' WHERE id=$1",[adopted.changeSetId]);
      await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[child.id]);
    }
    await projector.reconcileWaitingRun((await runs.getRun(SPACE,parent.id))!);
    const resumed=(await runs.getRun(SPACE,parent.id))!;
    expect(resumed.status).toBe('queued');
    expect(resumed.output_json).toMatchObject({waiting_for_results:{status:'resumed'}});
    expect((await db.pool.query('SELECT state,completion_basis FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toEqual({state:'open',completion_basis:null});
  });
  it('gives repeated delegation to the same Agent independent thread claims and vendor sessions',async ctx=>{
    if(!db.available)return ctx.skip();
    const {children}=await family(),repo=new PgHostThreadRepository(db.pool);
    const ordinary=await repo.getOrCreateForConversationAgent({executionHostId:HOST,workspaceMode:'location',workspaceLocationId:LOCATION,spaceId:SPACE,sessionId:CONVERSATION,agentId:AGENT,runtimeKey:'claude_code',createdByUserId:OWNER});
    const scopes=[];
    for(const child of children){
      const input={delegationId:child.delegation_id!,executionHostId:HOST,workspaceLocationId:LOCATION,spaceId:SPACE,sessionId:CONVERSATION,agentId:AGENT,runtimeKey:'claude_code',createdByUserId:OWNER};
      const thread=await repo.getOrCreateForDelegation(input);
      expect((await repo.getOrCreateForDelegation(input)).id).toBe(thread.id);
      expect(await repo.claimConversationDispatch(thread.id,randomUUID())).toBe(true);
      scopes.push(thread.id);
    }
    expect(new Set([...scopes,ordinary.id]).size).toBe(3);
    expect((await repo.getForConversationAgent(SPACE,CONVERSATION,AGENT))!.id).toBe(ordinary.id);
  });
});

describe('durable workspace integration',()=>{
 async function integration(){
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2}}'::jsonb WHERE id=$1`,[HOST]);
  const id=randomUUID();await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,contract_snapshot_json='{"execution_workspace_version":1}',permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.integration.retry"},{"action_id":"workspace.change.abandon"}]}' WHERE id=$1`,[id,PROJECT,CONVERSATION,LOCATION,OWNER]);
  const run=(await new PgRunRepository(db.pool).getRun(SPACE,id))!,w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
  await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2,base_commit=$3,target_ref='refs/heads/dev' WHERE id=$1",[w.workspace.id,'b'.repeat(40),'a'.repeat(40)]);
  await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state='saved' WHERE run_id=$1",[id,'a'.repeat(40),'b'.repeat(40)]);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready',base_commit=$2,source_commit=$3,completion_basis=$4 WHERE id=$1",[w.changeSetId,'a'.repeat(40),'b'.repeat(40),id]);
  await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:LOCATION,execution_workspace:w.ref});
  run.output_json=(await new PgRunRepository(db.pool).getRun(SPACE,id))!.output_json;
  const mergeId=(await enqueueWorkspaceIntegration(db.pool,w.changeSetId,SPACE,OWNER))!;
  return {run,w,mergeId};
 }
 async function row(id:string){return (await db.pool.query('SELECT * FROM task_merges WHERE id=$1',[id])).rows[0];}
 async function host(){const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');return new HostConnectionRegistry();}

 it.for(['own','foreign','grant','unknown','malformed','unrelated'] as const)('scopes publication context to the change set and preserves %s privacy rules',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {run,w,mergeId}=await integration(),hosts=await host(),actions:string[]=[];
  const taint={schema_version:1,narrowest_visibility:'private',input_owner_user_ids:[OWNER],non_instructing_owner_user_ids:kind==='foreign'?[OTHER_TASK]:[],personal_memory_grant_ids:kind==='grant'?[randomUUID()]:[]};
  if(kind==='unrelated'){
   const prior=randomUUID(),change=randomUUID();await seedRun(db.pool,{id:prior,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
   await db.pool.query('UPDATE runs SET has_context_taint=true WHERE id=$1',[prior]);
   await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state) VALUES($1,$2,$3,1,2,$4,$4,'integrated')`,[change,w.workspace.id,SPACE,prior]);
   await db.pool.query("INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'saved')",[prior,w.workspace.id,SPACE,change]);
  }else await db.pool.query('UPDATE runs SET has_context_taint=true,context_taint_json=$2::jsonb WHERE id=$1',[run.id,kind==='unknown'?null:JSON.stringify(kind==='malformed'?{...taint,personal_memory_grant_ids:null}:taint)]);
  hosts.requestTaskBranch=async(_host,_command,frame):Promise<any>=>{const f=frame as any;actions.push(f.action);expect(f.base_commit).toBe('a'.repeat(40));expect(f.source_commit).toBe('b'.repeat(40));return {ok:true,outcome:f.action==='prepare'?'rebased':f.action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
  const result=await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>({status:'passed',checks:[]})});
  if(kind==='own'||kind==='unrelated'){
   expect(result).toEqual({status:'integrated'});expect(actions).toEqual(['prepare','seal','finish']);
   if(kind==='own')expect((await db.pool.query('SELECT has_context_taint FROM runs WHERE id=$1',[run.id])).rows[0].has_context_taint).toBe(true);
  }else{expect(result).toEqual({status:'failed'});expect(actions).not.toContain('prepare');expect((await row(mergeId)).detail_json.error).toBe('workspace_egress_review_required');}
 });

 it.for(['adopted','unadopted','legacy'] as const)('includes %s child provenance when assessing publication',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {w}=await integration(),child=randomUUID(),change=randomUUID(),childRun=randomUUID();
  await seedRun(db.pool,{id:childRun,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query('UPDATE runs SET has_context_taint=true WHERE id=$1',[childRun]);
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,task_id,parent_workspace_id) VALUES($1,$2,$3,$4,$5,'task',$6,$7)`,[child,SPACE,PROJECT,LOCATION,HOST,TASK,w.workspace.id]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state) VALUES($1,$2,$3,1,1,$4,$4,'integrated')`,[change,child,SPACE,childRun]);
  await db.pool.query("INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'saved')",[childRun,child,SPACE,change]);
  await db.pool.query('UPDATE workspace_change_sets SET verification_json=$2::jsonb WHERE id=$1',[w.changeSetId,JSON.stringify(kind==='legacy'?{}:{adopted_child_change_ids:kind==='adopted'?[change]:[]})]);
  const {workspacePublicationNeedsReview}=await import('../src/modules/projectFolders/workspacePublication.js');
  expect(await workspacePublicationNeedsReview(db.pool,{spaceId:SPACE,changeSetId:w.changeSetId,requesterId:OWNER,repairRunId:null})).toBe(kind!=='unadopted');
 });

 it.for(['tracked','legacy','moved'] as const)('preserves %s parent provenance when adopting a child candidate',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),parent=randomUUID(),change=randomUUID(),hosts=await host();
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,task_id,head_commit) VALUES($1,$2,$3,$4,$5,'task',$6,$7)`,[parent,SPACE,PROJECT,LOCATION,HOST,TASK,(kind==='moved'?'d':'a').repeat(40)]);
  await db.pool.query('UPDATE execution_workspaces SET parent_workspace_id=$2 WHERE id=$1',[w.workspace.id,parent]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,verification_json) VALUES($1,$2,$3,1,1,$4,$4,$5::jsonb)`,[change,parent,SPACE,run.id,JSON.stringify(kind==='legacy'?{}:{adopted_child_change_ids:[]})]);
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>({ok:true,outcome:(frame as any).action==='prepare'?'rebased':(frame as any).action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null});
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>({status:'passed',checks:[]})})).toEqual({status:'integrated'});
  const parentChange=(await db.pool.query('SELECT verification_json FROM workspace_change_sets WHERE id=$1',[change])).rows[0];
  expect(parentChange.verification_json).toEqual(kind==='tracked'?{adopted_child_change_ids:[w.changeSetId]}:{});
  expect((await db.pool.query('SELECT verification_json FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].verification_json).toMatchObject({adopted_child_change_ids:[]});
  // Progress surfaces read adoption from the lineage the real integration
  // wrote: only a tracked parent proves it; legacy or moved stays unverified.
  const {readVisibleWorkspaceChanges}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const {listAgentWorkspaces}=await import('../src/modules/projectFolders/workspaceOverview.js');
  const child=(await readVisibleWorkspaceChanges(db.pool,SPACE,OWNER,{where:'c.id=$2',params:[w.changeSetId]})).entries[0]?.change;
  expect([child?.state,child?.landing]).toEqual(['integrated',kind==='tracked'?'parent':'parent_unverified']);
  const views=await Promise.all((['current','history'] as const).map(view=>listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view,limit:50})));
  expect(views.flatMap(page=>page.items).find(item=>item.workspace_id===w.workspace.id)?.work_state).toBe(kind==='tracked'?'adopted':'adoption_unverified');
 });

 it.for(['retry','repair'] as const)('lets a later writable Run request %s of a frozen integration without adopting its old binding',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {w,mergeId}=await integration();
  await db.pool.query("UPDATE task_merges SET status=$2,detail_json=$3::jsonb WHERE id=$1",[mergeId,kind==='repair'?'conflict':'failed',JSON.stringify(kind==='repair'?{conflicted_files:['plan.md']}:{})]);await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const nextId=randomUUID();await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query(`UPDATE runs SET status='running',project_id=$2,session_id=$3,instructed_by_user_id=$4,permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.integration.retry"}]}' WHERE id=$1`,[nextId,PROJECT,CONVERSATION,OWNER]);
  const next=(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!;
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');const binding=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  expect(binding.changeSetId).not.toBe(w.changeSetId);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');const {runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=await runActor(db.pool,next),revision=(await row(mergeId)).revision;
  const retry=()=>engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:revision,...(kind==='repair'?{repair_instruction:'Preserve the current plan and resolve the conflict.'}:{})},actor,randomUUID(),randomUUID());
  await db.pool.query("UPDATE execution_workspace_runs SET access_mode='read' WHERE run_id=$1",[nextId]);expect((await retry()).http_status).toBe(404);
  await db.pool.query("UPDATE execution_workspace_runs SET access_mode='write' WHERE run_id=$1",[nextId]);
  await db.pool.query('UPDATE runs SET session_id=NULL WHERE id=$1',[nextId]);expect((await retry()).http_status).toBe(404);
  await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[nextId,CONVERSATION]);
  const {authorizedWorkspaceChange}=await import('../src/modules/projectFolders/workspaceOperations.js');await expect(authorizedWorkspaceChange(db.pool,w.changeSetId,actor)).rejects.toThrow();
  const {workspaceIntegrationRecoveryHints}=await import('../src/modules/projectFolders/workspaceRecovery.js');
  await expect(workspaceIntegrationRecoveryHints({query:async()=>{throw new Error('injected advisory read failure');}},next,OWNER,w.workspace.id)).resolves.toEqual([]);
  expect(await workspaceIntegrationRecoveryHints(db.pool,next,OWNER,w.workspace.id)).toEqual([expect.objectContaining({integration_id:mergeId,expected_revision:revision,change_set_id:w.changeSetId})]);
  const result=await retry();expect(result.http_status,JSON.stringify(result.body)).toBe(200);
  expect(await row(mergeId)).toMatchObject({status:'queued',source_commit:'b'.repeat(40),base_commit:'a'.repeat(40)});
  expect((await db.pool.query('SELECT change_set_id FROM execution_workspace_runs WHERE run_id=$1',[nextId])).rows[0].change_set_id).toBe(binding.changeSetId);
 });

 it.for(['modified','receipt'] as const)('rejects completion with a permanently blocked %s binding and permits evidence-preserving abandonment',async(kind)=>{
  const {run,w,mergeId}=await integration();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[run.id]);
  await db.pool.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1",[w.workspace.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=sessionActor({spaceId:SPACE,userId:OWNER});
  const c=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
  expect((await engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:c.revision,summary:'done'},actor,randomUUID(),randomUUID())).http_status).toBe(409);
  const abandon=()=>engine.execute('workspace.change.abandon',{change_set_id:w.changeSetId,expected_revision:c.revision,reason:'retain evidence'},actor,randomUUID(),randomUUID());
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[run.id]);
  expect((await abandon()).http_status).toBe(409);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',start_commit=CASE WHEN $2::text='receipt' THEN NULL ELSE start_commit END,checkpoint_commit=CASE WHEN $2::text='receipt' THEN NULL ELSE checkpoint_commit END WHERE run_id=$1",[run.id,kind]);
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[run.id]);
  expect((await abandon()).http_status).toBe(409);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);
  expect((await abandon()).http_status).toBe(200);
  expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0]).toMatchObject({checkpoint_state:'blocked',checkpoint_commit:kind==='receipt'?null:'b'.repeat(40)});
  const next=await integration();
  expect(next.w.workspace.id).not.toBe(w.workspace.id);
  expect(next.w.workspace.generation).toBe(2);
 });


 it('refuses integration retry when a permanent checkpoint violation remains',async()=>{
  const {run,w,mergeId}=await integration();
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[run.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  expect((await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:(await row(mergeId)).revision},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID())).http_status).toBe(409);
  expect((await row(mergeId)).status).toBe('failed');
 });

 it('refuses a frozen chain plan without recorded chain evidence on both person retry and worker paths',async()=>{
  const {w,mergeId}=await integration(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  const plan={publication_plan:{strategy:'fast_forward',target_ref:null}};
  await db.pool.query("UPDATE task_merges SET status='conflict',detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({native_integration:true,conflicted_files:['README.md'],...plan})]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(config),before=await row(mergeId);
  const queued=(await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE job_type='task_merge' AND payload_json->>'merge_id'=$1",[mergeId])).rows[0].n;
  // A missing recorded chain must never turn a fast-forward plan into a squash.
  const refused=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:before.revision,resolution:'Keep both sides of README.md.'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(refused.http_status).toBe(409);expect((refused.body as any).error.metadata).toEqual({code:'native_publication_chain_unrecorded'});
  expect(await row(mergeId)).toMatchObject({status:'conflict',revision:before.revision,detail_json:{native_integration:true,...plan}});
  expect((await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE job_type='task_merge' AND payload_json->>'merge_id'=$1",[mergeId])).rows[0].n).toBe(queued);
  // A row that reaches the legacy worker anyway (re-enqueued by reconciliation) is blocked with its plan kept, never published.
  await db.pool.query("UPDATE task_merges SET status='queued',detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({previous_attempt:randomUUID(),previous_detail:{native_integration:true},...plan})]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrating' WHERE id=$1",[w.changeSetId]);
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const hosts=await host(),actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{actions.push((frame as any).action);return {ok:true,outcome:'sealed',candidate_commit:'b'.repeat(40),onto_commit:null,conflicted_files:[],error:null};};
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts,verify:async()=>({status:'passed',checks:[]})})).toMatchObject({status:'failed'});
  expect(actions).toEqual(['preserve']);
  expect(await row(mergeId)).toMatchObject({status:'failed',detail_json:{error:'native_publication_chain_unrecorded',...plan}});
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('blocked');
  // A squash plan to an explicit branch may take the person's route; its frozen plan stays top-level, not only in previous_detail.
  const squash={publication_plan:{strategy:'squash',target_ref:'refs/heads/release'}};
  await db.pool.query("UPDATE task_merges SET status='conflict',detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({conflicted_files:['README.md'],...squash})]);
  const retried=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:(await row(mergeId)).revision,resolution:'Keep both sides of README.md.'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(retried.http_status,JSON.stringify(retried.body)).toBe(200);
  expect((await row(mergeId)).detail_json).toMatchObject({...squash,previous_detail:{...squash}});
 });

 it.for(['host','server','location'] as const)('recovers the same change after bounded %s checkpoint failures without discarding saved work',async(kind)=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending',launch_sequence=1 WHERE run_id=$1",[run.id]);
  const {checkpointWorkspaceRun,registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const registry=new JobHandlerRegistry(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  registerExecutionWorkspaceJobs(registry,config,hosts);
  const initialRevision=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].revision;
  const failure=kind==='location'?'execution_workspace_location_unavailable':kind==='server'?'transient IO failure':'workspace_host_operation_failed';
  if(kind==='location')await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[LOCATION]);
  hosts.requestTaskBranch=async():Promise<any>=>{if(kind==='server')throw new Error(failure);return {ok:false,error:failure,commit:null};};
  await expect(checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts)).rejects.toThrow(failure);
  expect((await db.pool.query('SELECT state,head_commit FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0]).toMatchObject({state:'ready',head_commit:'b'.repeat(40)});
  const envelope={job_id:randomUUID(),job_type:'execution_workspace_checkpoint',space_id:SPACE,user_id:OWNER,attempts:3,max_attempts:3,worker_id:'test',payload:{run_id:run.id,workspace_id:w.workspace.id}};
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const {JobWorker}=await import('../src/modules/jobs/worker.js');
  await db.pool.query("DELETE FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[run.id]);
  const queue=new PgJobQueueRepository(db.pool);
  const failedJob=await queue.enqueue({job_type:envelope.job_type,space_id:SPACE,user_id:OWNER,payload:envelope.payload,max_attempts:3});
  const worker=new JobWorker(queue,registry,'test',[envelope.job_type]);
  for(let i=1;i<=3;i++){
   expect(await worker.processOne()).toMatchObject({status:'failed'});
   expect((await db.pool.query('SELECT attempts,status FROM jobs WHERE id=$1',[failedJob.id])).rows[0]).toEqual({attempts:i,status:i===3?'failed':'pending'});
   expect((await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].revision).toBe(initialRevision+(i===3?1:0));
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[failedJob.id]);
  }
  const c=(await db.pool.query('SELECT * FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
  expect(c).toMatchObject({state:'blocked',source_commit:'b'.repeat(40),verification_json:{checkpoint_recovery:{state:'exhausted'}}});
  expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0].checkpoint_state).toBe('pending');
  const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
  hosts.isOnline=()=>false;await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await db.pool.query("SELECT id,status,attempts FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[run.id])).rows).toEqual([{id:failedJob.id,status:'failed',attempts:3}]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(config),actor=sessionActor({spaceId:SPACE,userId:OWNER});
  const receipt=await engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:c.revision,summary:'retry checkpoint after fixing disk'},actor,randomUUID(),randomUUID());
  expect(receipt.http_status,JSON.stringify(receipt.body)).toBe(200);
  const jobs=(await db.pool.query("SELECT payload_json FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1 ORDER BY created_at DESC",[run.id])).rows;
  expect(jobs.length).toBeGreaterThan(0);
  await registry.dispatch(envelope);
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('ready');
  if(kind==='location')await db.pool.query("UPDATE workspace_locations SET status='active' WHERE id=$1",[LOCATION]);
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:'c'.repeat(40),branch:'owned',error:null});
  expect(await worker.processOne()).toMatchObject({status:'completed'});
  expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0]).toEqual({checkpoint_state:'saved',checkpoint_commit:'c'.repeat(40)});
  expect((await db.pool.query('SELECT state,head_commit FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0]).toMatchObject({state:'ready',head_commit:'c'.repeat(40)});
  expect(await registry.dispatch({...envelope,job_type:'execution_workspace_complete',payload:{change_set_id:w.changeSetId}})).toMatchObject({state:'integrating'});
 });
 it('does not let a late successful checkpoint or complete clear a concurrent safety violation',async()=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending',access_mode='read',launch_sequence=1 WHERE run_id=$1",[run.id]);
  const {checkpointWorkspaceRun}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  let release!:(reply:any)=>void,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  let calls=0;
  hosts.requestTaskBranch=async():Promise<any>=>{
   if(++calls===1){entered();return new Promise(resolve=>{release=resolve;});}
   return {ok:true,commit:'c'.repeat(40),branch:'owned',error:null};
  };
  const late=checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts);await started;
  await checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts);
  release({ok:true,commit:'a'.repeat(40),branch:'owned',error:null});await late;
  expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0]).toMatchObject({checkpoint_state:'blocked',checkpoint_commit:'c'.repeat(40)});
  expect((await db.pool.query('SELECT head_commit FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].head_commit).toBe('b'.repeat(40));
  // Workspace safety state is an independent fence, even for an old saved binding.
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[run.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const c=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  expect((await engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:c.revision,summary:'unsafe'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID())).http_status).toBe(409);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[w.changeSetId]);
  const {enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  expect(await enqueueWorkspaceIntegration(db.pool,w.changeSetId,SPACE,OWNER)).toBeNull();
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts);
  expect(await registry.dispatch({job_id:randomUUID(),job_type:'execution_workspace_complete',space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:8,worker_id:'test',payload:{change_set_id:w.changeSetId}})).toEqual({state:'blocked'});
 });
 it.for(['observe','cleanup'] as const)('preserves cleanup budget through repeated offline %s and reconnects at the same tip',async(stage)=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE runs SET updated_at=now()-interval '25 hours' WHERE id=$1",[run.id]);
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const workspace=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  await enqueueWorkspaceCleanup(db.pool,workspace,w.ref,'b'.repeat(40),true,OWNER);
  const resource=()=>db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id]).then(r=>r.rows[0].cleanup_json['source-g1']);
  const first=await resource(),inventory={branch:true,worktree:false,registration:false,run_record:false,merge_record:false,quarantined_whole:0,active:false};
  let offline=true,transport='host_offline';
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const action=(frame as any).action;
   if(offline&&(stage==='observe'||action==='cleanup'))return {ok:false,error:transport,commit:null};
   return {ok:true,commit:'b'.repeat(40),inventory,cleanup_state:'cleaned',error:null};
  };
  for(let i=0;i<10;i++){transport=['host_offline','host_timeout','location_busy'][i%3]!;await expect(advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});}
  expect(await resource()).toMatchObject({attempts:0,state:'retry_wait',operation_id:first.operation_id,expected_commit:'b'.repeat(40)});
  offline=false;
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
 });

 it.for([false,true])('reconciles an old offline-blocked source at an unchanged tip including retired=%s',async(retired)=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE runs SET updated_at=now()-interval '25 hours' WHERE id=$1",[run.id]);
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
  const workspace=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  await enqueueWorkspaceCleanup(db.pool,workspace,w.ref,'b'.repeat(40),true,OWNER);
  const first=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0].cleanup_json['source-g1'];
  await db.pool.query("UPDATE execution_workspaces SET cleanup_state='blocked',cleanup_json=jsonb_set(cleanup_json,'{source-g1}',$2::jsonb) WHERE id=$1",[workspace.id,JSON.stringify({...first,state:'blocked',attempts:8,error:'Error: host_offline'})]);
  if(retired)await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[workspace.id]);
  const inventory={branch:true,worktree:false,registration:false,run_record:false,merge_record:false,quarantined_whole:0,active:false};
  const checkpointJobsBefore=(await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'workspace_id'=$1",[workspace.id])).rowCount;
  hosts.isOnline=()=>true;
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:'b'.repeat(40),inventory,cleanup_state:'cleaned',error:null});
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  const restored=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0].cleanup_json['source-g1'];
  expect(restored).toMatchObject({state:'pending',attempts:0,expected_commit:first.expected_commit,workspace:first.workspace});
  expect(restored.operation_id).not.toBe(first.operation_id);
  if(retired){
   expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0].state).toBe('retired');
   expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'workspace_id'=$1",[workspace.id])).rowCount).toBe(checkpointJobsBefore);
  }
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({skipped:true});
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',restored.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
 });
 it('bounds permanent source inspection failures instead of deferring forever',async()=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE runs SET updated_at=now()-interval '25 hours' WHERE id=$1",[run.id]);
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const workspace=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  await enqueueWorkspaceCleanup(db.pool,workspace,w.ref,'b'.repeat(40),true,OWNER);
  const first=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0].cleanup_json['source-g1'];
  hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error:'execution_workspace_location_unavailable',commit:null});
  for(let i=0;i<7;i++)await expect(advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  expect((await db.pool.query('SELECT cleanup_state,cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0]).toMatchObject({cleanup_state:'blocked',cleanup_json:{'source-g1':{attempts:8}}});
 });

 it('reports blocked immediately when the owner changes before integration enqueue',async()=>{
  const {w,mergeId}=await integration();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[w.changeSetId]);
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const {waitForLockWaiter}=await import('./support/lockWait.js');
  const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),await host());
  const lock=await db.pool.connect();
  let advance:Promise<unknown>|undefined;
  try{
   await lock.query('BEGIN');await lock.query('SELECT id FROM execution_workspaces WHERE id=$1 FOR UPDATE',[w.workspace.id]);
   advance=registry.dispatch({job_id:randomUUID(),job_type:'execution_workspace_complete',space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:3,worker_id:'test',payload:{change_set_id:w.changeSetId}});
   const outcome=advance.then(result=>({result}),error=>({error}));
   await waitForLockWaiter(db.pool);
   await lock.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1",[w.workspace.id]);
   await lock.query('COMMIT');
   expect(await outcome).toEqual({result:{state:'blocked'}});
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('blocked');
   expect((await db.pool.query('SELECT 1 FROM task_merges WHERE change_set_id=$1',[w.changeSetId])).rowCount).toBe(0);
  }finally{await lock.query('ROLLBACK');lock.release();await advance?.catch(()=>{});}
 });
 it('turns an already-ready change with a blocked binding into visible attention',async()=>{
  const {w,mergeId}=await integration();await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',start_commit=NULL,checkpoint_commit=NULL WHERE workspace_id=$1",[w.workspace.id]);
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),await host());
  expect(await registry.dispatch({job_id:randomUUID(),job_type:'execution_workspace_complete',space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:8,worker_id:'test',payload:{change_set_id:w.changeSetId}})).toEqual({state:'blocked'});
 });
 it.for(['host','visibility','location'] as const)('keeps candidate capture intent after retries exhaust under lost %s authority',async(reason)=>{
  const {w,mergeId}=await integration(),m=await row(mergeId);
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {registerTaskMergeHandler}=await import('../src/modules/hosts/taskMerges.js');
  const hosts=await host();hosts.requestTaskBranch=async():Promise<any>=>{throw new Error('must not execute under revoked authority');};
  await db.pool.query("UPDATE task_merges SET status='verifying',task_commit=$2 WHERE id=$1",[mergeId,'c'.repeat(40)]);
  if(reason==='location')await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[LOCATION]);
  else{
   const user=randomUUID();
   await db.pool.query("INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())",[user,user+'@test.invalid']);
   if(reason==='host')await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,user]);
   else await db.pool.query("UPDATE runs SET visibility='private',owner_user_id=$2,instructed_by_user_id=$2 WHERE id=$1",[ (await db.pool.query('SELECT originating_run_id FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].originating_run_id,user]);
  }
  const registry=new JobHandlerRegistry();registerTaskMergeHandler(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),{hosts});
  await expect(registry.dispatch({job_id:randomUUID(),job_type:'task_merge',space_id:SPACE,user_id:OWNER,attempts:8,max_attempts:8,worker_id:'test',payload:{merge_id:mergeId}})).rejects.toThrow();
  expect((await row(mergeId)).status).toBe('failed');
  const manifest=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  expect(manifest).toMatchObject({state:'pending',retain_branch:true,capture:{source_commit:'b'.repeat(40)},workspace:{id:w.workspace.id,generation:1,integration_id:m.attempt_id}});
 });
 it.for(['host_offline','execution_workspace_location_unavailable','workspace_mirror_checkpoint_moved'])('classifies checkpoint failure %s without losing evidence',async(error)=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[w.changeSetId]);
  const {checkpointWorkspaceRun}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[run.id]);
  hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error,commit:null});
  if(error==='host_offline')await expect(checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  else if(error==='execution_workspace_location_unavailable')await expect(checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts)).rejects.toThrow(error);
  else await expect(checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts)).rejects.toThrow(error);
  expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0].checkpoint_state).toBe(error==='workspace_mirror_checkpoint_moved'?'blocked':'pending');
  if(error==='workspace_mirror_checkpoint_moved')expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('blocked');
 });
 it('defers ordinary source cleanup for idle time and supersedes a stale tip without deletion',async()=>{
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='merged' WHERE id=$1",[mergeId]);
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const workspace=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  await enqueueWorkspaceCleanup(db.pool,workspace,w.ref,'b'.repeat(40),true,OWNER);
  const resource=()=>db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id]).then(r=>r.rows[0].cleanup_json['source-g1']);
  const first=await resource();let calls=0;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{calls++;expect((frame as any).action).toBe('inspect');return {ok:true,commit:'c'.repeat(40),inventory:{active:false}};};
  await expect(advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({message:'workspace_cleanup_idle_period'});
  expect(calls).toBe(0);
  await db.pool.query("UPDATE runs SET updated_at=now()-interval '25 hours' WHERE id=$1",[run.id]);
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({superseded:true});
  expect(await resource()).toMatchObject({expected_commit:'c'.repeat(40),workspace:w.ref,state:'pending'});
  expect((await resource()).operation_id).not.toBe(first.operation_id);
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({skipped:true});
 });
 it('blocks local overlaps instead of leaving completion intent in integrating',async()=>{
  const {w,mergeId}=await integration(),hosts=await host();
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const action=(frame as any).action;
   return {ok:action!=='finish',outcome:action==='prepare'?'rebased':action==='finish'?'waiting_local_changes':'sealed',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:['local.txt'],error:null};
  };
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>({status:'passed',checks:[]})})).toEqual({status:'failed'});
  expect((await row(mergeId)).detail_json).toMatchObject({error:'integration_waiting_local_changes',overlapping_files:['local.txt']});
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('blocked');
 });
 it('uses the existing merge queue, pins the source, and records successful integration and cleanup independently',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration,enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {run,w,mergeId}=await integration(),hosts=await host(),actions:string[]=[];
  expect(await enqueueWorkspaceIntegration(db.pool,w.changeSetId,SPACE,OWNER)).toBeNull();
  expect(await row(mergeId)).toMatchObject({task_id:null,workspace_id:w.workspace.id,source_commit:'b'.repeat(40)});
  hosts.requestTaskBranch=async(_host,command,frame):Promise<any>=>{
   expect(command).toBe('workspace_integration');const f=frame as any;actions.push(f.action);
   expect(f.source_commit).toBe('b'.repeat(40));
   return {ok:true,outcome:f.action==='prepare'?'rebased':f.action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};
  };
  const result=await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async input=>{
   expect(input.target.workspace).toMatchObject({execution_workspace:{id:w.workspace.id,integration_id:(await row(mergeId)).attempt_id}});
   return {status:'passed',checks:[{key:'test',verifier_type:'test',status:'passed',summary:'Passed'}]};
  }});
  expect(result).toEqual({status:'integrated'});expect(actions).toEqual(['prepare','seal','finish']);
  expect((await row(mergeId)).status).toBe('merged');
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('integrated');
  const ws=(await db.pool.query('SELECT head_commit,cleanup_state,cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  expect(ws.head_commit).toBe('b'.repeat(40));expect(ws.cleanup_state).toBe('pending');expect(Object.keys(ws.cleanup_json)).toHaveLength(2);
  expect((await new PgRunRepository(db.pool).getRun(SPACE,run.id))!.status).toBe('succeeded');
 });
 it.for(['room','direct'] as const)('posts the precise integration result to its %s conversation once, including after a Job replay',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),hosts=await host();
  if(kind==='direct')await db.pool.query('UPDATE sessions SET room_id=NULL,user_id=$2 WHERE id=$1',[CONVERSATION,OWNER]);
  const repairId=randomUUID();await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET status='succeeded',visibility='private',prompt='PRIVATE REPAIR INSTRUCTION' WHERE id=$1",[repairId]);
  await db.pool.query('UPDATE task_merges SET resolution_run_id=$2 WHERE id=$1',[mergeId,repairId]);
  hosts.requestTaskBranch=async(_host,_type,f):Promise<any>=>({ok:true,outcome:(f as any).action==='prepare'?'rebased':'sealed',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null});
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),deps={hosts,verify:async()=>({status:'not_required' as const,checks:[]})};
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'verification_failed'});
  await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps);
  const notices=(await db.pool.query("SELECT content,metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'execution_event'='workspace_integration'",[CONVERSATION])).rows;
  expect(notices).toHaveLength(1);expect(notices[0].content).toContain('Integration stopped before publication');expect(notices[0].content).toContain('not been integrated into dev');
  expect(notices[0].metadata_json.execution_details).toMatchObject({schema_version:'workspace_integration_notice.v1',run_id:run.id,integration_id:mergeId,change_set_id:w.changeSetId,outcome:'verification_failed',reason:'integration_agent_verification_unavailable',candidate_ready:true,repair_status:'succeeded',verification_status:'not_run'});
  expect(JSON.stringify(notices)).not.toContain('PRIVATE REPAIR INSTRUCTION');
 });
 it('reports exhausted integration work without copying private Host diagnostics into the conversation',async ctx=>{
  if(!db.available)return ctx.skip();const {mergeId}=await integration();
  const {failWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  await failWorkspaceIntegration(db.pool,mergeId,SPACE,'spawn failed at /private/secret-token');
  const notices=(await db.pool.query("SELECT content,metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'execution_event'='workspace_integration'",[CONVERSATION])).rows;
  expect(notices).toHaveLength(1);expect(notices[0].metadata_json.execution_details).toMatchObject({outcome:'failed',reason:null,preserved:true});
  expect(JSON.stringify(notices)).not.toContain('secret-token');expect(JSON.stringify(notices)).not.toContain('/private');
 });
 it('reconstructs a missing final notice on terminal Job replay without running Host steps or changing publication state',async ctx=>{
  if(!db.available)return ctx.skip();const {mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='merged',task_commit=$2,merged_commit=$2,detail_json=$3::jsonb WHERE id=$1",[mergeId,'c'.repeat(40),JSON.stringify({verification:{status:'passed',checks:[{status:'passed'}]},checks:[{status:'failed'}]})]);
  hosts.requestTaskBranch=async()=>{throw new Error('terminal delivery must not call Host');};
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts});
  await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts});
  const notices=(await db.pool.query("SELECT metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'execution_event'='workspace_integration'",[CONVERSATION])).rows;
  expect(notices).toHaveLength(1);expect(notices[0].metadata_json.execution_details).toMatchObject({outcome:'integrated',verification_status:'passed',checks_passed:1,checks_failed:0});
 });
 it.for(['queued','rebasing','verifying','resolving','other_run','user','readonly'] as const)('allows verification setup after retry only for its current Run owner: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await db.pool.query("UPDATE task_merges SET status='verification_failed',detail_json='{\"error\":\"verification_unconfigured\"}' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const grants={tool_grants:['workspace.integration.retry','workspace.integration.verification.get','workspace.integration.verification.configure'].map(action_id=>({action_id}))};
  await db.pool.query("UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1",[run.id,JSON.stringify(grants)]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor,sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(config),live=(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,owner=await runActor(db.pool,live);
  const retry=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:(await row(mergeId)).revision},owner,randomUUID(),randomUUID());expect(retry.http_status).toBe(200);
  expect((await row(mergeId)).detail_json.reply_owner_run_id).toBe(run.id);
  if(['rebasing','verifying','resolving'].includes(mode))await db.pool.query('UPDATE task_merges SET status=$2 WHERE id=$1',[mergeId,mode]);
  let actor=owner;
  if(mode==='user')actor=sessionActor({spaceId:SPACE,userId:OWNER});
  if(mode==='readonly')await db.pool.query("UPDATE execution_workspace_runs SET access_mode='read' WHERE run_id=$1",[run.id]);
  if(mode==='other_run'){
   const id=randomUUID();await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
   await db.pool.query("UPDATE runs SET status='running',contract_snapshot_json='{\"execution_workspace_version\":1}',project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,permission_snapshot_json=$6::jsonb WHERE id=$1",[id,PROJECT,CONVERSATION,LOCATION,OWNER,JSON.stringify(grants)]);
   const another=(await new PgRunRepository(db.pool).getRun(SPACE,id))!;
   await (await import('../src/modules/projectFolders/executionWorkspaces.js')).ensureExecutionWorkspace(db.pool,another,HOST,LOCATION);
   actor=await runActor(db.pool,another);
  }
  const read=await engine.execute('workspace.integration.verification.get',{integration_id:mergeId},actor,randomUUID(),undefined);
  if(mode!=='readonly')expect(read.http_status).toBe(200);
  const quotedCode='import {spawnSync} from "node:child_process"; for(const value of [1,2]){if(value < 0 || value > 2) process.exit(1);}';
  const testCommand=mode==='queued'?"node --input-type=module -e '"+quotedCode+"'":'pnpm test';
  if(mode==='queued'){
   for(const command of ['pnpm test && pnpm run build','node -e "unfinished']){
    const invalid=await engine.execute('workspace.integration.verification.configure',{integration_id:mergeId,expected_config_version:null,test_commands:[command],build_commands:[]},actor,randomUUID(),randomUUID());
    expect(invalid.http_status,JSON.stringify(invalid.body)).toBe(422);
    expect((await db.pool.query('SELECT id FROM project_folder_execution_configs')).rowCount).toBe(0);
   }
  }
  const configured=await engine.execute('workspace.integration.verification.configure',{integration_id:mergeId,expected_config_version:null,test_commands:[testCommand],build_commands:['pnpm run build']},actor,randomUUID(),randomUUID());
  if(['other_run','user','readonly'].includes(mode)){expect(configured.http_status).not.toBe(200);expect((await db.pool.query('SELECT id FROM project_folder_execution_configs')).rowCount).toBe(0);return;}
  expect(configured.http_status,JSON.stringify(configured.body)).toBe(200);expect(configured.body).toMatchObject({data:{test_commands:[testCommand],build_commands:['pnpm run build']}});
  if(mode!=='queued')return;
  const {sharedHostConnectionRegistry:hosts}=await import('../src/modules/hosts/connectionRegistry.js');const beforeRequest=hosts.requestTaskBranch,beforeCommand=hosts.runHostCommand,commands:string[][]=[];
  try{
   hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const f=frame as any;if(f.action==='finish')expect(commands).toHaveLength(2);return {ok:true,outcome:f.action==='prepare'?'rebased':f.action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
   hosts.runHostCommand=async(_host,frame)=>{commands.push(frame.command);return {ok:true,exit_code:0,timed_out:false,stdout:'passed',stderr:'',error:null};};
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[live.id]);
   await db.pool.query("UPDATE task_merges SET detail_json=detail_json-'reply_owner_run_id' WHERE id=$1",[mergeId]);
   await (await import('../src/modules/hosts/workspaceIntegrations.js')).advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts});
   expect((await row(mergeId)).status).toBe('merged');expect(commands).toEqual([['node','--input-type=module','-e',quotedCode],['pnpm','run','build']]);
  }finally{hosts.requestTaskBranch=beforeRequest;hosts.runHostCommand=beforeCommand;}
 });
 it.for(['user','agent'] as const)('lets a %s configure real verification and retry the same frozen integration without changing other Folder settings',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration();
  await db.pool.query("UPDATE task_merges SET status='verification_failed',detail_json='{\"error\":\"verification_unconfigured\"}' WHERE id=$1",[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor,runActor}=await import('../src/modules/systemActions/operations/actor.js');
  await db.pool.query(`UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1`,[run.id,JSON.stringify({tool_grants:['workspace.integration.verification.get','workspace.integration.verification.configure','workspace.integration.retry'].map(action_id=>({action_id}))})]);
  const actor=kind==='user'?sessionActor({spaceId:SPACE,userId:OWNER}):await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!);
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const read=await engine.execute('workspace.integration.verification.get',{integration_id:mergeId},actor,randomUUID(),undefined);
  expect(read.http_status,JSON.stringify(read.body)).toBe(200);expect(read.body).toMatchObject({status:'succeeded',data:{folder_id:FOLDER,config_version:null,test_commands:[],build_commands:[],can_retry:true}});
  const input={integration_id:mergeId,expected_config_version:null,test_commands:['pnpm test'],build_commands:['pnpm run build']},key=randomUUID();
  if(kind==='agent'){
   await db.pool.query("UPDATE runs SET trigger_origin='automation' WHERE id=$1",[run.id]);
   const unattended=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!);
   expect((await engine.execute('workspace.integration.verification.get',{integration_id:mergeId},unattended,randomUUID(),undefined)).http_status).toBe(200);
   expect((await engine.execute('workspace.integration.verification.configure',input,unattended,randomUUID(),randomUUID())).http_status).not.toBe(200);
   expect((await db.pool.query('SELECT id FROM project_folder_execution_configs WHERE project_folder_id=$1',[FOLDER])).rows).toEqual([]);
   await db.pool.query('UPDATE runs SET trigger_origin=$2 WHERE id=$1',[run.id,run.trigger_origin]);
  }
  const save=await engine.execute('workspace.integration.verification.configure',input,actor,randomUUID(),key);
  expect(save.http_status,JSON.stringify(save.body)).toBe(200);expect(save.body).toMatchObject({status:'succeeded',data:{test_commands:['pnpm test'],build_commands:['pnpm run build']}});
  expect((await row(mergeId)).status).toBe('verification_failed');
  const saved=(save.body as any).data;
  await db.pool.query(`UPDATE project_folder_execution_configs SET forbidden_paths_json='["private"]',repo_type='git' WHERE project_folder_id=$1`,[FOLDER]);
  expect((await engine.execute('workspace.integration.verification.configure',input,actor,randomUUID(),key)).replayed).toBe(true);
  expect((await engine.execute('workspace.integration.verification.configure',{...input,expected_config_version:saved.config_version},actor,randomUUID(),randomUUID())).http_status).toBe(409);
  const latest=await engine.execute('workspace.integration.verification.get',{integration_id:mergeId},actor,randomUUID(),undefined);
  const current=(latest.body as any).data;
  expect((await engine.execute('workspace.integration.verification.configure',{...input,expected_config_version:current.config_version,test_commands:['pnpm test -- --run']},actor,randomUUID(),randomUUID())).http_status).toBe(200);
  expect((await db.pool.query('SELECT repo_type,forbidden_paths_json FROM project_folder_execution_configs WHERE project_folder_id=$1',[FOLDER])).rows[0]).toEqual({repo_type:'git',forbidden_paths_json:['private']});
  const {PgVerificationRepository}=await import('../src/modules/runs/verification/repository.js');
  const {verifyTaskWorkspace}=await import('../src/modules/runs/verification/engine.js');
  const commands:string[][]=[];
  const verified=await verifyTaskWorkspace(new PgVerificationRepository(db.pool),{run:async input=>{commands.push(input.command);return{returncode:0,stdout:'ok',stderr:'',timed_out:false};}}, {run:{...run,project_folder_id:FOLDER},target:{host_id:HOST,workspace_location_id:LOCATION},base_commit_sha:'a'.repeat(40)});
  expect(verified.status).toBe('passed');expect(commands).toEqual([['pnpm','test','--','--run'],['pnpm','run','build']]);
  const retry=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:current.integration_revision},actor,randomUUID(),randomUUID());
  expect(retry.http_status,JSON.stringify(retry.body)).toBe(200);expect(await row(mergeId)).toMatchObject({source_commit:'b'.repeat(40),base_commit:'a'.repeat(40),status:'queued'});
 });
 it('does not expose or change verification commands for another Host owner, another Space, or a read-only Agent binding',async ctx=>{
  if(!db.available)return ctx.skip();const {run,w,mergeId}=await integration();
  await db.pool.query("UPDATE task_merges SET status='verification_failed' WHERE id=$1",[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor,runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),user=sessionActor({spaceId:SPACE,userId:OWNER});
  await seedSpaceMember(db.pool,{space:SPACE,user:OTHER_TASK});
  for(const id of ['workspace.integration.verification.get','workspace.integration.verification.configure']){
   const input={integration_id:mergeId,...(id.endsWith('configure')?{expected_config_version:null,test_commands:['pnpm test'],build_commands:[]}:{})};
   await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OTHER_TASK]);
   expect((await engine.execute(id,input,user,randomUUID(),randomUUID())).http_status).toBe(404);
   await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OWNER]);
   expect((await engine.execute(id,input,{...user,space_id:randomUUID()},randomUUID(),randomUUID())).http_status).toBe(404);
   await db.pool.query(`UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1`,[run.id,JSON.stringify({tool_grants:[{action_id:id}]})]);
   await db.pool.query("UPDATE execution_workspace_runs SET access_mode='read' WHERE run_id=$1",[run.id]);
   const agent=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!);
   expect((await engine.execute(id,input,agent,randomUUID(),randomUUID())).http_status).toBe(404);
   await db.pool.query("UPDATE execution_workspace_runs SET access_mode='write' WHERE run_id=$1",[run.id]);
  }
  expect((await db.pool.query('SELECT id FROM project_folder_execution_configs WHERE project_folder_id=$1',[FOLDER])).rows).toEqual([]);
 });
 it('configures the frozen attachment Folder rather than the primary Run Folder',async ctx=>{
  if(!db.available)return ctx.skip();const {run,w,mergeId}=await integration(),otherFolder=randomUUID(),otherLocation=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'Primary','code','active',false,false,now(),now())`,[otherFolder,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/primary','active',now(),now())`,[otherLocation,SPACE,otherFolder,HOST]);
  await db.pool.query('UPDATE runs SET project_folder_id=$2,workspace_location_id=$3 WHERE id=$1',[run.id,otherFolder,otherLocation]);
  await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:otherLocation},[{workspace_location_id:LOCATION,mount_location_id:LOCATION,execution_workspace:w.ref,access_mode:'write'}]);
  await db.pool.query("UPDATE task_merges SET status='verification_failed' WHERE id=$1",[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const result=await engine.execute('workspace.integration.verification.configure',{integration_id:mergeId,expected_config_version:null,test_commands:['pnpm test'],build_commands:[]},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(result.http_status,JSON.stringify(result.body)).toBe(200);expect(result.body).toMatchObject({data:{folder_id:FOLDER}});
  expect((await db.pool.query('SELECT project_folder_id FROM project_folder_execution_configs')).rows).toEqual([{project_folder_id:FOLDER}]);
 });

 describe('workspace publication recovery',()=>{
  async function emptyBatch(){
   const x=await integration();await db.pool.query('DELETE FROM task_merges WHERE id=$1',[x.mergeId]);
   await db.pool.query("UPDATE workspace_change_sets SET state='open',base_commit=$2,source_commit=$2,completion_basis=NULL WHERE id=$1",[x.w.changeSetId,'a'.repeat(40)]);
   await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1",[x.run.id,'a'.repeat(40)]);
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[x.run.id]);
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
   return {...x,revision:(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[x.w.changeSetId])).rows[0].revision as number,engine:await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor:sessionActor({spaceId:SPACE,userId:OWNER})};
  }
  async function completeJob(hosts:Awaited<ReturnType<typeof host>>,changeId:string){
   const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js'),{JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
   const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts);
   return registry.get('execution_workspace_complete')!({job_id:randomUUID(),space_id:SPACE,user_id:OWNER,job_type:'execution_workspace_complete',attempts:1,max_attempts:3,worker_id:'test',payload:{change_set_id:changeId}});
  }
  it.for(['user','agent','closed','history'] as const)('admits a %s independent commit through completion and verifies its actual delta before publication',async(kind,ctx)=>{
   if(!db.available)return ctx.skip();const {w,run,engine,actor:user,revision}=await emptyBatch(),hosts=await host();
   if(kind==='closed')await db.pool.query("UPDATE workspace_change_sets SET state='no_changes' WHERE id=$1",[w.changeSetId]);
   if(kind==='history'){
    const prior=randomUUID();await seedRun(db.pool,{id:prior,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[prior]);
    await db.pool.query("INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,start_commit,checkpoint_commit,checkpoint_state,created_at) VALUES($1,$2,$3,$4,$5,$5,'saved',now()-interval '1 day')",[prior,w.workspace.id,SPACE,w.changeSetId,'a'.repeat(40)]);
   }

   let actor=user;
   if(kind==='agent'){
    await db.pool.query(`UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1`,[run.id,JSON.stringify({tool_grants:[{action_id:'workspace.change.complete'}]})]);
    actor=await (await import('../src/modules/systemActions/operations/actor.js')).runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!);
   }
   const input={change_set_id:w.changeSetId,expected_revision:revision,summary:'Publish reviewed Host fix',commit:'d'.repeat(40)},key=randomUUID();
   const accepted=await engine.execute('workspace.change.complete',input,actor,randomUUID(),key);expect(accepted.http_status,JSON.stringify(accepted.body)).toBe(200);
   expect((await engine.execute('workspace.change.complete',input,actor,randomUUID(),key)).replayed).toBe(true);
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);
   if(kind==='agent')await db.pool.query("UPDATE workspace_change_sets SET verification_json=verification_json-'reply_owner_run_id' WHERE id=$1",[w.changeSetId]);
   const reads:string[][]=[];hosts.runHostCommand=async(_host,frame)=>{reads.push(frame.command);expect(frame.workspace).not.toHaveProperty('execution_workspace');return{ok:true,exit_code:0,timed_out:false,stdout:frame.command[1]==='rev-list'?'d'.repeat(40)+' '+'c'.repeat(40):frame.command[1]==='diff'?'packages/host-daemon/src/execution.ts\0':'',stderr:'',error:null};};
   expect(await completeJob(hosts,w.changeSetId)).toMatchObject({state:'integrating'});
   // Parent, published-base and scope reads, then the independent pin before the submission takes effect.
   expect(reads).toHaveLength(4);
   expect(reads[3]).toEqual(['git','update-ref','-m','rainver: retain submitted workspace commit',`refs/rainver/sources/${'d'.repeat(40)}`,'d'.repeat(40),'0'.repeat(40)]);
   const merge=(await db.pool.query('SELECT * FROM task_merges WHERE change_set_id=$1',[w.changeSetId])).rows[0];
   expect(merge).toMatchObject({base_commit:'c'.repeat(40),source_commit:'d'.repeat(40),target_ref:'refs/heads/dev',status:'queued'});
   const actions:string[]=[];hosts.requestTaskBranch=async(_host,_command,frame):Promise<any>=>{const f=frame as any;actions.push(f.action);expect(f.source_commit??'d'.repeat(40)).toBe('d'.repeat(40));return{ok:true,outcome:f.action==='prepare'?'rebased':f.action==='finish'?'merged':'sealed',onto_commit:'e'.repeat(40),candidate_commit:'f'.repeat(40),conflicted_files:[],error:null};};
   const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
   expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),merge.id,SPACE,{hosts,verify:async input=>{expect(input.base_commit_sha).toBe('e'.repeat(40));return{status:'passed',checks:[]};}})).toEqual({status:'integrated'});
   expect(actions).toEqual(['prepare','seal','finish']);
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('integrated');
  });
  it.for(['dirty','merge','secret','offline'] as const)('preserves the workspace and refuses or defers %s independent commit intake',async(kind,ctx)=>{
   if(!db.available)return ctx.skip();const {w,engine,actor,revision}=await emptyBatch(),hosts=await host();
   if(kind==='dirty')await db.pool.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[w.changeSetId,'b'.repeat(40)]);
   expect((await engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:revision,summary:'Submit existing commit',commit:'d'.repeat(40)},actor,randomUUID(),randomUUID())).http_status).toBe(200);
   hosts.runHostCommand=async(_host,frame)=>({ok:kind!=='offline',exit_code:kind==='offline'?1:0,timed_out:false,stdout:frame.command[1]==='rev-list'?'d'.repeat(40)+' '+'c'.repeat(40)+(kind==='merge'?' '+'f'.repeat(40):''):frame.command[1]==='diff'?'.env\0':'',stderr:'',error:kind==='offline'?'host_offline':null});
   if(kind==='offline')await expect(completeJob(hosts,w.changeSetId)).rejects.toThrow('host_offline');
   else expect(await completeJob(hosts,w.changeSetId)).toMatchObject({state:'blocked',error:kind==='dirty'?'workspace_commit_requires_empty_change':kind==='merge'?'workspace_commit_requires_single_parent':'workspace_commit_scope_denied'});
   expect((await db.pool.query('SELECT source_commit,base_commit FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toEqual({source_commit:(kind==='dirty'?'b':'a').repeat(40),base_commit:'a'.repeat(40)});
   expect((await db.pool.query('SELECT id FROM task_merges WHERE change_set_id=$1',[w.changeSetId])).rows).toHaveLength(0);
  });
  it.for([true,false])('reconciles already-adopted=%s through retry without publishing or starting another repair',async(adopted,ctx)=>{
   if(!db.available)return ctx.skip();const {w,mergeId}=await integration(),hosts=await host();
   await db.pool.query("UPDATE task_merges SET status='conflict' WHERE id=$1",[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
   const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
   expect((await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:1,reconcile_only:true},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID())).http_status).toBe(200);
   const actions:string[]=[];hosts.requestTaskBranch=async(_host,_cmd,frame):Promise<any>=>{actions.push((frame as any).action);return{ok:true,outcome:(frame as any).action==='prepare'?(adopted?'no_changes':'conflict'):'sealed',onto_commit:'c'.repeat(40),candidate_commit:'d'.repeat(40),commit:'b'.repeat(40),conflicted_files:['plan.md'],error:null};};
   const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
   const outcome=await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>{throw new Error('Reconciliation must not run publication verification');},repair:async()=>{throw new Error('Reconciliation must not dispatch a repair');}});
   expect(outcome).toEqual({status:adopted?'no_changes':'conflict'});expect(actions).not.toContain('finish');expect(actions).not.toContain('repair');
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe(adopted?'no_changes':'blocked');
   const final=await row(mergeId);expect(adopted?final.detail_json.already_present_at:final.detail_json.error).toBe(adopted?'c'.repeat(40):'integration_not_yet_adopted');
  });
  it.for(['blocked','open'] as const)('lets a later authorized conversation Run close a superseded %s batch while preserving evidence and its own new work',async (batchState,ctx)=>{
   if(!db.available)return ctx.skip();const {run,w,mergeId}=await integration();await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);await db.pool.query("UPDATE task_merges SET status='conflict' WHERE id=$1",[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state=$2 WHERE id=$1",[w.changeSetId,batchState]);
   if(batchState==='open')await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[w.workspace.id]);
   const nextId=randomUUID();await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});await db.pool.query(`UPDATE runs SET status='running',project_id=$2,session_id=$3,instructed_by_user_id=$4,permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.change.abandon"}]}' WHERE id=$1`,[nextId,PROJECT,CONVERSATION,OWNER]);
   const quote='检查后关闭过时工作区，保留原成果';
   await db.pool.query("UPDATE runs SET trigger_origin='manual',instruction=$2 WHERE id=$1",[nextId,quote]);
   const next=(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!,{ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
   const current=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor}=await import('../src/modules/systemActions/operations/actor.js');
   const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=await runActor(db.pool,next),revision=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].revision;
   const result=await engine.execute('workspace.change.abandon',{change_set_id:w.changeSetId,expected_revision:revision,reason:'The obsolete plan was explicitly retired; keep its source.',...(batchState==='open'?{review:{source_commit:'b'.repeat(40),user_request_quote:quote,findings:'Reviewed obsolete version; retain source without asserting adoption.'}}:{})},actor,randomUUID(),randomUUID());
   expect(result.http_status,JSON.stringify(result.body)).toBe(200);expect((await row(mergeId)).status).toBe('superseded');
   expect((await db.pool.query('SELECT state,source_commit FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toEqual({state:'abandoned',source_commit:'b'.repeat(40)});
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[current.changeSetId])).rows[0].state).toBe('open');
  });
  it('allows a fresh generation to retain and close an exhausted old checkpoint without deleting unknown files',async ctx=>{
   if(!db.available)return ctx.skip();const {run,w}=await emptyBatch();
   await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[run.id]);await db.pool.query("UPDATE execution_workspace_runs SET start_commit=NULL,checkpoint_commit=NULL,checkpoint_state='pending' WHERE run_id=$1",[run.id]);
   await db.pool.query(`UPDATE workspace_change_sets SET state='blocked',source_commit=NULL,base_commit=NULL,verification_json='{"checkpoint_recovery":{"state":"exhausted"}}' WHERE id=$1`,[w.changeSetId]);
   await db.pool.query("UPDATE execution_workspaces SET state='requested',head_commit=NULL WHERE id=$1",[w.workspace.id]);
   const nextId=randomUUID();await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});await db.pool.query(`UPDATE runs SET status='running',project_id=$2,session_id=$3,instructed_by_user_id=$4,permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.change.abandon"}]}' WHERE id=$1`,[nextId,PROJECT,CONVERSATION,OWNER]);
   const next=(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!,{ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js'),fresh=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
   expect(fresh.workspace.id).not.toBe(w.workspace.id);
   const {workspaceClosureRecoveryHints}=await import('../src/modules/projectFolders/workspaceRecovery.js');
   expect(await workspaceClosureRecoveryHints(db.pool,next,OWNER,fresh.workspace.id)).toContainEqual({change_set_id:w.changeSetId,expected_revision:(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].revision,has_saved_result:false,checkpoint_recovery_exhausted:true});
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor}=await import('../src/modules/systemActions/operations/actor.js');
   const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=await runActor(db.pool,next),old=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
   const result=await engine.execute('workspace.change.abandon',{change_set_id:w.changeSetId,expected_revision:old.revision,reason:'Preserve unknown files; withdraw this failed old attempt.'},actor,randomUUID(),randomUUID());expect(result.http_status,JSON.stringify(result.body)).toBe(200);
   expect((await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toMatchObject({state:'abandoned',verification_json:{pending_checkpoint_retained:true}});
   expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[run.id])).rows[0].checkpoint_state).toBe('pending');
   expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].state).toBe('retired');
   expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'workspace_id'=$1",[w.workspace.id])).rows).toHaveLength(0);
  });
  it('closes an empty successful standalone batch and lets the next turn allocate a new one',async ctx=>{
   if(!db.available)return ctx.skip();const {w,run}=await emptyBatch(),hosts=await host();
   await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending',launch_sequence=1 WHERE run_id=$1",[run.id]);
   await db.pool.query('UPDATE workspace_change_sets SET source_sequence=0 WHERE id=$1',[w.changeSetId]);
   hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:'a'.repeat(40),error:null});
   const {checkpointWorkspaceRun}=await import('../src/modules/hosts/executionWorkspaceJobs.js');await checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts);
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('no_changes');
   const nextId=randomUUID();await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});await db.pool.query('UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5 WHERE id=$1',[nextId,PROJECT,CONVERSATION,LOCATION,OWNER]);
   const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
   const next=await ensureExecutionWorkspace(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!,HOST,LOCATION);expect(next.changeSetId).not.toBe(w.changeSetId);expect(next.workspace.id).toBe(w.workspace.id);
  });
 });
 it.for(['tool', 'plan'] as const)('streams workspace progress before execution ends while gating the final reply: %s', async (boundary, ctx) => {
  if (!db.available) return ctx.skip();
  const { run } = await integration();
  if (run.execution_kind !== 'agent') throw new Error('Expected an Agent Run');
  const thread = await new PgHostThreadRepository(db.pool).getOrCreateForConversationAgent({
   executionHostId: HOST, workspaceMode: 'location', workspaceLocationId: LOCATION,
   spaceId: SPACE, sessionId: CONVERSATION, agentId: AGENT, runtimeKey: 'claude_code', createdByUserId: OWNER,
  });
  await db.pool.query("UPDATE runs SET host_task_thread_id=$2,status='running' WHERE id=$1", [run.id, thread.id]);
  const { createSerializedThreadEventSink } = await import('../src/modules/hosts/threadEventRepository.js');
  const { createThreadEventNormalizer } = await import('../src/modules/hosts/threadEventNormalization.js');
  const { loadRunTurn } = await import('../src/modules/runs/turnReadModel.js');
  const { executeWorkspaceRunReply } = await import('../src/modules/runs/workspaceRunReply.js');
  const sink = createSerializedThreadEventSink(new PgHostThreadEventRepository(db.pool), thread.id, run.id, null);
  const read = () => loadRunTurn(db.pool, { spaceId: SPACE, runId: run.id });
  const prose = (turn: Awaited<ReturnType<typeof read>>) => turn!.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  let finish: Parameters<NonNullable<import('../src/modules/runs/remoteHostCliAdapter.js').RemoteHostCliAdapterInput['workspace_reply_sink']>>[0] | undefined;
  const normalizer = createThreadEventNormalizer();
  await executeWorkspaceRunReply({ run, prompt: '检查并合并', model: null, resume_session_id: null, thread_event_sink: sink,
   workspace_reply_sink: callback => { finish = callback; },
  }, HOST, LOCATION, { config: loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db: db.pool }, async input => {
   // Exercise actual ACP normalization too: this progress has no trailing newline.
   await input.thread_event_sink!(normalizer.pushAcpTextDelta('正在检查消息显示。'));
   const update = boundary === 'tool'
    ? { sessionUpdate: 'tool_call', toolCallId: 'check', title: 'read_file', status: 'in_progress' }
    : { sessionUpdate: 'plan', entries: [{ content: '检查显示', status: 'in_progress', priority: 'medium' }] };
   await input.thread_event_sink!(normalizer.pushAcpProtocolEvent({ method: 'session/update', params: { update } }));
   const live = await read();
   expect(live!.state).toBe('working');
   expect(prose(live)).toBe('正在检查消息显示。');
   expect(live!.parts.map(part => part.type)).toEqual(['text', boundary === 'tool' ? 'tool_call' : 'plan']);
   await input.thread_event_sink!(normalizer.pushAcpTextDelta('检查完成，最终结论。'));
   await input.thread_event_sink!(normalizer.finish());
   // A late tool result must not release the final candidate before validation.
   await input.thread_event_sink!([{ event_type: 'tool_activity_finished', tool_call_id: 'check', status: 'succeeded' }]);
   await input.thread_event_sink!([{ event_type: 'status', status: 'run_succeeded' }]);
   expect(prose(await read())).toBe('正在检查消息显示。');
   return { runtime_key: 'claude_code', adapter_kind: 'local_cli', success: true, output_text: '检查完成，最终结论。', exit_code: 0 };
  });
  // The adapter returned, but output validation/materialization has not released the reply.
  expect(prose(await read())).toBe('正在检查消息显示。');
  await finish!({ allowed: true });
  expect(prose(await read())).toBe('正在检查消息显示。检查完成，最终结论。');
 });

 it('defers workspace checks to the candidate while preserving output validation before publication',async ctx=>{
  if(!db.available)return ctx.skip();const {run}=await integration();
  const {PgVerificationEngine}=await import('../src/modules/runs/verification/engine.js');
  const engine=new PgVerificationEngine(db.pool,undefined,{run:async()=>{throw new Error('workspace command must run only on the integration candidate')}});
  const results=await engine.verify({run:{...run,contract_snapshot_json:{acceptance_criteria_json:{checks:[{type:'command',command:['pnpm','test']},{type:'output_schema',schema:{type:'object',required:['answer']}}]}}},execution_target:null,base_commit_sha:null,output_json:{},materialization_items:[],workspace_publication_pending:true});
  expect(results).toHaveLength(1);expect(results[0]).toMatchObject({verifier_type:'output_schema',status:'failed'});
 });

 it.for(['normal','conflict','target_moved','cancelled','tainted','old_retry','historical_retry','historical_superseded','ended_prepared','private_checkpoint','frozen_chain'] as const)('finishes native integration through unified operations in the active session: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2},"native_workspace_integration":true,"native_workspace_rebase":true}'::jsonb WHERE id=$1`,[HOST]);
  await db.pool.query("UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1",[run.id,JSON.stringify({tool_grants:['workspace.change.complete','workspace.change.get','workspace.integration.retry'].map(action_id=>({action_id}))})]);
  await db.pool.query("UPDATE execution_workspace_runs SET launch_sequence=1,checkpoint_state='pending' WHERE run_id=$1",[run.id]);
  // A historical batch of the same workspace: blocked, not bound to this Run,
  // with a recorded delta that this Run's own publication may or may not carry.
  const historical=mode.startsWith('historical')?{changeId:randomUUID(),mergeId:randomUUID(),source:(mode==='historical_superseded'?'b':'d').repeat(40)}:null;
  if(historical){
   await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,revision,state,originating_run_id,root_run_id,base_commit,source_commit,completion_basis,summary,source_sequence,verification_json,created_at,updated_at) SELECT $2,workspace_id,space_id,generation,sequence+1000,1,'blocked',originating_run_id,root_run_id,base_commit,$3,NULL,'Historical batch',source_sequence,'{}'::jsonb,now()-interval '1 hour',now() FROM workspace_change_sets WHERE id=$1`,[w.changeSetId,historical.changeId,historical.source]);
   await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,detail_json,created_at,updated_at) SELECT $2,space_id,workspace_id,$3,workspace_location_id,$3,generation,$4,$5,base_commit,target_ref,'failed',requested_by_user_id,'{"error":"verification_unconfigured"}'::jsonb,now(),now() FROM task_merges WHERE id=$1`,[mergeId,historical.mergeId,historical.changeId,randomUUID(),historical.source]);
  }
  if(mode==='old_retry'||mode==='frozen_chain'){await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);}
  else{await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='open',completion_basis=NULL WHERE id=$1",[w.changeSetId]);}
  // A fast-forward plan frozen at an earlier prepare, with the chain the Host reported.
  if(mode==='frozen_chain'){
   await db.pool.query("UPDATE task_merges SET detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({native_integration:true,error:'native_publication_fast_forward_target_moved',publication_plan:{strategy:'fast_forward',target_ref:null},publication:{strategy:'fast_forward',chain_tip:'c'.repeat(40),chain_length:9}})]);
  }
  if(mode==='tainted')await db.pool.query("UPDATE runs SET has_context_taint=true WHERE id=$1",[run.id]);
  const {sharedHostConnectionRegistry:hosts}=await import('../src/modules/hosts/connectionRegistry.js'),old=hosts.requestTaskBranch,oldCommand=hosts.runHostCommand,actions:string[]=[];
  let publishes=0;
  hosts.requestTaskBranch=async(_host,type,raw):Promise<any>=>{
   const f=raw as any;actions.push(f.action);
   if(type==='execution_workspace_command')return {ok:true,commit:'b'.repeat(40),error:null,launch_info:{...w.ref,branch:'rainver/workspace',start_commit:'a'.repeat(40),target_ref:'refs/heads/dev',workspace_location_id:LOCATION,launch_sequence:1}};
   expect(f.run_id).toBe(run.id);expect(f.workspace.execution_workspace.id).toBe(w.workspace.id);
   if(historical&&f.workspace.execution_workspace.integration_id===historical.mergeId){
    // Recorded delta into the bound batch's worktree, which still holds unsubmitted work.
    expect(f).toMatchObject({action:'native_prepare',submitted_commit:historical.source,submitted_base:'a'.repeat(40),base_commit:'a'.repeat(40)});
    return {ok:false,outcome:null,main_branch:'dev',candidate_commit:null,onto_commit:null,conflicted_files:[],error:'workspace_commit_requires_empty_change'};
   }
   // The bound batch is the worktree itself: never an explicit commit, legacy record or not.
   if(f.action!=='native_inspect')expect(f.submitted_commit).toBeUndefined();
   const outcome=f.action==='native_publish'?(mode==='target_moved'&&publishes++===0?'main_moved':'merged'):f.action==='native_checkpoint'?'sealed':mode==='conflict'?'conflict':'rebased';
   // Every native step of a frozen chain carries its strategy; the publish names the recorded chain tip.
   if(mode==='frozen_chain'&&['native_prepare','native_checkpoint','native_publish'].includes(f.action)){
    expect(f.publication_strategy).toBe('fast_forward');
    expect(f.publication_chain_tip).toBe(f.action==='native_publish'?'c'.repeat(40):undefined);
   }
   // A new integration rebases by default (a legacy one keeps its squash); like the daemon, a
   // completed rebase reports its replayed chain, which the publish then names.
   const strategy=mode==='frozen_chain'?'fast_forward':mode==='old_retry'?undefined:'rebase';
   if(['native_prepare','native_publish'].includes(f.action))expect(f.publication_strategy).toBe(strategy);
   const publication=strategy&&outcome!=='conflict'?{publication:{strategy,chain_tip:'c'.repeat(40),chain_length:strategy==='rebase'?1:9}}:{};
   return {ok:true,outcome,candidate_commit:'c'.repeat(40),onto_commit:'a'.repeat(40),conflicted_files:outcome==='conflict'?['README.md']:[],error:null,...(outcome==='rebased'&&strategy==='rebase'?{source_commit:'c'.repeat(40),base_commit:'a'.repeat(40)}:{}),...publication};
  };
  // Only the pin of an explicit commit runs as a Host command (before the Host uses it); checks never do.
  const pins:string[]=[];
  hosts.runHostCommand=async(_host,frame:any):Promise<any>=>{
   if(frame.command[1]==='update-ref'&&String(frame.command[4]).startsWith('refs/rainver/sources/')){pins.push(frame.command[5]);return {ok:true,exit_code:0,timed_out:false,stdout:'',stderr:'',error:null};}
   throw new Error('Native Agent checks must not move to another command environment');
  };
  try{
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor}=await import('../src/modules/systemActions/operations/actor.js');
   const engine=await operationRuntime(config),live=(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,actor=await runActor(db.pool,live);
   const read=async()=>{const r=await engine.execute('workspace.change.get',{change_set_id:w.changeSetId},actor,randomUUID(),undefined);expect(r.http_status,JSON.stringify(r.body)).toBe(200);return (r.body as any).data;};
   let current=await read();
   const complete=async(action:string)=>{const response=await engine.execute('workspace.change.complete',{change_set_id:w.changeSetId,expected_revision:current.revision,summary:'Agent completes and merges',action,...(action==='publish'?{verification:{commit:'c'.repeat(40),checks:[{command:'pnpm test',summary:'Passed in current Agent environment'}],note:'Checked this version'}}:{})},actor,randomUUID(),randomUUID());expect(response.http_status,JSON.stringify(response.body)).toBe(200);current=await read();};
   if(mode==='private_checkpoint'){
    await complete('checkpoint');expect(current).toMatchObject({state:'open',integration_id:null,progress:{status:'checkpointed'}});
    expect((await db.pool.query('SELECT id FROM task_merges WHERE change_set_id=$1',[w.changeSetId])).rowCount).toBe(0);expect(actions).not.toContain('native_publish');
    const {executeWorkspaceRunReply}=await import('../src/modules/runs/workspaceRunReply.js');
    const result=await executeWorkspaceRunReply({run:live as any,prompt:'只提交，不合并',model:null,resume_session_id:'same-session'},HOST,LOCATION,{config,db:db.pool},async()=>({runtime_key:'codex_cli',adapter_kind:'local_cli',success:true,output_text:'已保存，未合并。',exit_code:0}));
    expect(result).toMatchObject({success:true,output_text:'已保存，未合并。'});
    // A withheld reply names the orchestration reason instead of collapsing into adapter_failed.
    let finish:((gate:{allowed:boolean;reason?:string})=>Promise<any>)|undefined;
    await executeWorkspaceRunReply({run:live as any,prompt:'只提交，不合并',model:null,resume_session_id:'same-session',workspace_reply_sink:f=>{finish=f}},HOST,LOCATION,{config,db:db.pool},async()=>({runtime_key:'codex_cli',adapter_kind:'local_cli',success:true,output_text:'已保存，未合并。',exit_code:0}));
    await expect(finish!({allowed:false,reason:'usage_recording_failed'})).resolves.toMatchObject({success:false,output_text:'已保存，未合并。',error_code:'usage_recording_failed',error_message:'Workspace reply withheld: usage_recording_failed'});
    return;
   }
   if(mode==='old_retry'||mode==='frozen_chain'){const m=await row(mergeId),r=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:m.revision},actor,randomUUID(),randomUUID());expect(r.http_status,JSON.stringify(r.body)).toBe(200);current=await read();}
   else{
    if(historical){
     const m=await row(historical.mergeId),r=await engine.execute('workspace.integration.retry',{integration_id:historical.mergeId,expected_revision:m.revision},actor,randomUUID(),randomUUID());expect(r.http_status,JSON.stringify(r.body)).toBe(200);
     const h=await engine.execute('workspace.change.get',{change_set_id:historical.changeId},actor,randomUUID(),undefined);expect((h.body as any).data,JSON.stringify(h.body)).toMatchObject({state:'blocked',progress:{status:'failed',error:'workspace_commit_requires_empty_change'}});
     expect(pins).toEqual([historical.source]);
     current=await read();
    }
    await complete('prepare');
   }
   if(mode==='tainted'){expect(current.progress).toMatchObject({status:'failed',error:'workspace_egress_review_required'});expect(actions).toEqual([]);return;}
   expect(current.progress.status,JSON.stringify(current)).toBe(mode==='conflict'?'conflict':'prepared');await complete('checkpoint');expect(current.progress.status).toBe('checkpointed');
   if(mode==='cancelled'){
    await db.pool.query("UPDATE runs SET status='cancelling' WHERE id=$1",[run.id]);const requestId=randomUUID();
    await db.pool.query("UPDATE workspace_change_sets SET verification_json=verification_json||$2::jsonb WHERE id=$1",[w.changeSetId,JSON.stringify({native_request:{id:requestId,action:'publish',run_id:run.id,user_id:OWNER,verification:null},native_progress:{request_id:requestId,action:'publish',status:'pending',commit:null,onto_commit:null,conflicted_files:[],error:null}})]);
    await (await import('../src/modules/hosts/workspaceNativeIntegration.js')).processNativeWorkspaceRequest(db.pool,config,w.changeSetId,SPACE,requestId,hosts);
    expect((await db.pool.query("SELECT verification_json->'native_progress' AS progress FROM workspace_change_sets WHERE id=$1",[w.changeSetId])).rows[0].progress).toMatchObject({status:'failed',error:'integration_current_run_ended'});expect(actions).not.toContain('native_publish');return;
   }
   if(mode==='ended_prepared'){
    await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[run.id]);
    const {closeEndedNativeWorkspaceRequests}=await import('../src/modules/hosts/workspaceNativeIntegration.js');
    expect(await closeEndedNativeWorkspaceRequests(db.pool,w.workspace.id)).toBe(1);expect(await closeEndedNativeWorkspaceRequests(db.pool,w.workspace.id)).toBe(0);
    expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('blocked');return;
   }
   await complete('publish');if(mode==='target_moved'){expect(current.progress.status).toBe('target_moved');await complete('prepare');await complete('checkpoint');await complete('publish');}
   expect(current).toMatchObject({state:'integrated',progress:{status:'merged'}});expect((await db.pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n).toBe(1);
   if(historical){
    // The same recorded delta published by the bound batch adopts the historical one; a different one stays a reported failure.
    const adopted=mode==='historical_superseded';
    expect((await row(historical.mergeId)).status).toBe(adopted?'no_changes':'failed');
    expect((await db.pool.query("SELECT state,verification_json->'native_progress'->>'status' AS status FROM workspace_change_sets WHERE id=$1",[historical.changeId])).rows[0]).toEqual(adopted?{state:'no_changes',status:'no_changes'}:{state:'blocked',status:'failed'});
   }expect((await db.pool.query('SELECT id FROM project_folder_execution_configs')).rowCount).toBe(0);
   expect(await new PgRunRepository(db.pool).listVerificationResults(SPACE,run.id)).toEqual(expect.arrayContaining([expect.objectContaining({verifier_type:'workspace_native',status:'passed'})]));
   const {executeWorkspaceRunReply}=await import('../src/modules/runs/workspaceRunReply.js');let invocations=0;const events:any[]=[];
   const final=await executeWorkspaceRunReply({run:live as any,prompt:'merge',model:null,resume_session_id:'same-session',thread_event_sink:d=>{events.push(...d)}},HOST,LOCATION,{config,db:db.pool},async input=>{invocations++;expect(input.resume_session_id).toBe('same-session');await input.thread_event_sink?.([{event_type:'assistant_text',text:'已合入 dev。'}]);return {runtime_key:'codex_cli',adapter_kind:'local_cli',success:true,output_text:'已合入 dev。',exit_code:0};});
   expect(invocations).toBe(1);expect(final).toMatchObject({success:true,output_text:'已合入 dev。'});expect(events.filter(e=>e.event_type==='assistant_text')).toHaveLength(1);
  }finally{hosts.requestTaskBranch=old;hosts.runHostCommand=oldCommand;}
 });

 it('rebases a historical merge batch whose chain the Host refused, never squashing it without the person, and moves the empty bound batch along',async ctx=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  const base='a'.repeat(40),source='d'.repeat(40),replayed='e'.repeat(40),onto='f'.repeat(40),historical={changeId:randomUUID(),mergeId:randomUUID()};
  await db.pool.query(`UPDATE hosts SET capabilities_json=capabilities_json || '{"execution_workspaces":{"version":2},"native_workspace_integration":true,"native_workspace_rebase":true}'::jsonb WHERE id=$1`,[HOST]);
  await db.pool.query("UPDATE runs SET status='running',permission_snapshot_json=$2::jsonb WHERE id=$1",[run.id,JSON.stringify({tool_grants:['workspace.change.complete','workspace.change.get','workspace.integration.retry'].map(action_id=>({action_id}))})]);
  await db.pool.query("UPDATE execution_workspace_runs SET launch_sequence=1,checkpoint_state='pending' WHERE run_id=$1",[run.id]);
  // This Run's bound batch is empty at the historical source the worktree holds.
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open',completion_basis=NULL,base_commit=$2,source_commit=$2 WHERE id=$1",[w.changeSetId,source]);
  // The historical batch froze a merge plan whose chain the Host refused (private baseline): no chain was recorded.
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,revision,state,originating_run_id,root_run_id,base_commit,source_commit,completion_basis,summary,source_sequence,verification_json,created_at,updated_at) SELECT $2,workspace_id,space_id,generation,sequence+1000,1,'blocked',originating_run_id,root_run_id,$3,$4,NULL,'Historical batch',source_sequence,'{}'::jsonb,now()-interval '1 hour',now() FROM workspace_change_sets WHERE id=$1`,[w.changeSetId,historical.changeId,base,source]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,detail_json,created_at,updated_at) SELECT $1,space_id,id,$2,workspace_location_id,$2,generation,$3,$4,$5,target_ref,'failed',$6,$7::jsonb,now(),now() FROM execution_workspaces WHERE id=$8`,
   [historical.mergeId,historical.changeId,randomUUID(),source,base,OWNER,JSON.stringify({native_integration:true,error:'native_publication_chain_base_not_target_history',publication_plan:{strategy:'merge',target_ref:null,requested_by_user_id:OWNER,requested_by_run_id:run.id}}),w.workspace.id]);
  const {sharedHostConnectionRegistry:hosts}=await import('../src/modules/hosts/connectionRegistry.js'),old=hosts.requestTaskBranch,oldCommand=hosts.runHostCommand,frames:any[]=[];
  hosts.requestTaskBranch=async(_host,type,raw):Promise<any>=>{
   const f=raw as any;
   if(type==='execution_workspace_command')return {ok:true,commit:source,error:null,launch_info:{...w.ref,branch:'rainver/workspace',start_commit:source,target_ref:'refs/heads/dev',workspace_location_id:LOCATION,launch_sequence:1}};
   frames.push(f);
   // The Host replays the recorded delta onto the target and reports the replayed chain.
   return {ok:true,outcome:'rebased',main_branch:'dev',candidate_commit:replayed,onto_commit:onto,conflicted_files:[],error:null,source_commit:replayed,base_commit:onto,publication:{strategy:'rebase',chain_tip:replayed,chain_length:2}};
  };
  hosts.runHostCommand=async():Promise<any>=>({ok:true,exit_code:0,timed_out:false,stdout:'',stderr:'',error:null});
  try{
   const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor}=await import('../src/modules/systemActions/operations/actor.js');
   const engine=await operationRuntime(config),actor=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!);
   const retry=async(publication:Record<string,unknown>)=>engine.execute('workspace.integration.retry',{integration_id:historical.mergeId,expected_revision:(await row(historical.mergeId)).revision,publication},actor,randomUUID(),randomUUID());
   // The Agent cannot choose squash on its own.
   const squash=await retry({strategy:'squash'});
   expect(squash.http_status).toBe(409);expect((squash.body as any).error.metadata).toEqual({code:'workspace_squash_requires_person_request'});
   const rebased=await retry({strategy:'rebase'});expect(rebased.http_status,JSON.stringify(rebased.body)).toBe(200);
   expect(frames).toHaveLength(1);expect(frames[0]).toMatchObject({action:'native_prepare',publication_strategy:'rebase',submitted_commit:source,submitted_base:base,base_commit:source});
   const merge=await row(historical.mergeId);
   expect(merge).toMatchObject({status:'verifying',base_commit:onto,source_commit:replayed});
   expect(merge.detail_json).toMatchObject({publication_plan:{strategy:'rebase',target_ref:null,requested_by_run_id:run.id,replaced_plan:{strategy:'merge',error:'native_publication_chain_base_not_target_history'}},publication:{strategy:'rebase',chain_tip:replayed},replayed_from:{base,source}});
   const sets=async(id:string)=>(await db.pool.query('SELECT state,base_commit,source_commit FROM workspace_change_sets WHERE id=$1',[id])).rows[0];
   // The batch is now its replayed commits on the target; the empty bound batch moved with the rewritten branch.
   expect(await sets(historical.changeId)).toEqual({state:'integrating',base_commit:onto,source_commit:replayed});
   expect(await sets(w.changeSetId)).toEqual({state:'open',base_commit:replayed,source_commit:replayed});
  }finally{hosts.requestTaskBranch=old;hosts.runHostCommand=oldCommand;}
 });

 it.for(['commands','repair','basic','failed_basic','stale','foreign','tainted','late_taint'] as const)('lets the same Agent own missing verification: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),hosts=await host(),config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key='claude_code',backend_mode='runtime_native',model_provider_id=NULL,model_name=NULL,execution_host_id=$2,workspace_mode='location',workspace_location_id=$3,runtime_installation='own' WHERE id=$1`,[run.runtime_profile_id,HOST,LOCATION]);
  await db.pool.query("UPDATE runs SET runtime_key='claude_code' WHERE id=$1",[run.id]);
  const actions:string[]=[],commands:string[][]=[];let checkCount=0;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const f=frame as any;actions.push(f.action);return {ok:true,outcome:f.action==='prepare'||f.action==='continue'?'rebased':f.action==='repair'?'conflict':f.action==='seal'?'sealed':f.action==='finish'?'merged':'preserved',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:f.action==='repair'?['src/index.ts']:[],automatic_repair_allowed:true,error:null};};
  hosts.runHostCommand=async(host,frame)=>{expect(host).toBe(HOST);expect((frame.workspace?.kind==='location'?frame.workspace.execution_workspace:undefined)).toMatchObject({id:w.workspace.id,integration_id:(await row(mergeId)).attempt_id});commands.push(frame.command);if(mode==='late_taint')await db.pool.query("UPDATE runs SET has_context_taint=true WHERE id=ANY($1::varchar[])",[(await row(mergeId)).detail_json.completed_repair_runs]);return {ok:true,exit_code:mode==='failed_basic'?1:0,stdout:'',stderr:'',timed_out:false,error:null};};
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {PgVerificationRepository}=await import('../src/modules/runs/verification/repository.js');
  const {verifyTaskWorkspace}=await import('../src/modules/runs/verification/engine.js');
  const verify=(input:Parameters<typeof verifyTaskWorkspace>[2])=>verifyTaskWorkspace(new PgVerificationRepository(db.pool),{run:async check=>{expect((check.target.workspace?.kind==='location'?check.target.workspace.execution_workspace?.integration_id:undefined)).toBeDefined();commands.push(check.command);return {returncode:mode==='repair'&&++checkCount===1?1:0,stdout:'passed',stderr:'',timed_out:false};}},input);
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts,verify})).rejects.toThrow('integration_agent_verification_dispatched');
  const m=await row(mergeId),assigned=(await new PgRunRepository(db.pool).getRun(SPACE,m.resolution_run_id))!;
  expect(assigned).toMatchObject({agent_id:run.agent_id,requested_runtime_profile_id:run.runtime_profile_id,parent_run_id:run.id,status:'queued'});
  expect(assigned.contract_snapshot_json).toMatchObject({workspace_integration_id:mergeId,workspace_integration_attempt_id:m.attempt_id});
  expect(assigned.permission_snapshot_json).toMatchObject({tool_grants:expect.arrayContaining([expect.objectContaining({action_id:'workspace.integration.verification.get'}),expect.objectContaining({action_id:'workspace.integration.verification.configure'})])});
  expect(actions).not.toContain('finish');expect(commands).toEqual([]);
  const {PgRouteDecisionRepository}=await import('../src/modules/routing/repository.js');
  await new PgRouteDecisionRepository(db.pool).routeRun({...assigned,execution_kind:'agent',agent_id:AGENT,agent_version_id:VERSION});
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[assigned.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor,sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const operations=await operationRuntime(config),actor=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,assigned.id))!);
  if(mode==='stale')await db.pool.query('UPDATE task_merges SET attempt_id=$2 WHERE id=$1',[mergeId,randomUUID()]);
  if(mode==='foreign'){
   const another=randomUUID();await seedRun(db.pool,{id:another,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
   await db.pool.query('UPDATE task_merges SET resolution_run_id=$2 WHERE id=$1',[mergeId,another]);
  }
  const get=await operations.execute('workspace.integration.verification.get',{integration_id:mergeId},actor,randomUUID(),undefined);
  if(mode==='stale'||mode==='foreign'){expect(get.http_status).toBe(404);return;}
  expect(get.http_status,JSON.stringify(get.body)).toBe(200);
  const configured=mode==='commands'||mode==='repair';
  const input={integration_id:mergeId,expected_config_version:null,test_commands:configured?['pnpm test']:[],build_commands:[],...(configured?{}:{no_project_checks:true,note:'Inspected manifests and README; this repository has no executable project checks.'})};
  if(!configured){
   const human=await operations.execute('workspace.integration.verification.configure',input,sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());expect(human.http_status).not.toBe(200);
  }
  const receipt=await operations.execute('workspace.integration.verification.configure',input,actor,randomUUID(),randomUUID());
  expect(receipt.http_status,JSON.stringify(receipt.body)).toBe(200);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[assigned.id]);
  if(mode==='tainted')await db.pool.query('UPDATE runs SET has_context_taint=true,context_taint_json=$2::jsonb WHERE id=$1',[assigned.id,JSON.stringify({schema_version:'run_context_taint.v1',input_owner_user_ids:[OWNER,OTHER_TASK],non_instructing_owner_user_ids:[OTHER_TASK],personal_memory_grant_ids:[]})]);
  if(mode==='repair'){
   await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts,verify})).rejects.toThrow('integration_verification_repair_dispatched');
   const repairing=(await new PgRunRepository(db.pool).getRun(SPACE,(await row(mergeId)).resolution_run_id))!;
   expect(repairing.agent_id).toBe(run.agent_id);
   expect(repairing.permission_snapshot_json).toMatchObject({tool_grants:expect.arrayContaining([expect.objectContaining({action_id:'workspace.integration.verification.configure'})])});
   await new PgRouteDecisionRepository(db.pool).routeRun({...repairing,execution_kind:'agent',agent_id:AGENT,agent_version_id:VERSION});
   await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[repairing.id]);
   const repairActor=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,repairing.id))!);
   const observed=await operations.execute('workspace.integration.verification.get',{integration_id:mergeId},repairActor,randomUUID(),undefined);
   expect(observed.http_status,JSON.stringify(observed.body)).toBe(200);
   const correction={integration_id:mergeId,expected_config_version:(observed.body as any).data.config_version,test_commands:['pnpm test --maxWorkers=1'],build_commands:[]};
   const attestation=await operations.execute('workspace.integration.verification.configure',{...correction,test_commands:[],no_project_checks:true,note:'Existing project checks must not be waived.'},repairActor,randomUUID(),randomUUID());expect(attestation.http_status).toBe(422);
   const currentAttempt=(await row(mergeId)).attempt_id;
   await db.pool.query('UPDATE task_merges SET attempt_id=$2 WHERE id=$1',[mergeId,randomUUID()]);
   expect((await operations.execute('workspace.integration.verification.configure',correction,repairActor,randomUUID(),randomUUID())).http_status).toBe(404);
   await db.pool.query('UPDATE task_merges SET attempt_id=$2 WHERE id=$1',[mergeId,currentAttempt]);
   const corrected=await operations.execute('workspace.integration.verification.configure',correction,repairActor,randomUUID(),randomUUID());
   expect(corrected.http_status,JSON.stringify(corrected.body)).toBe(200);
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[repairing.id]);
  }
  const result=await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts,verify,repair:async()=>null});
  expect(result).toEqual({status:mode==='failed_basic'?'verification_failed':mode==='tainted'||mode==='late_taint'?'failed':'integrated'});
  const done=await row(mergeId);
  if(mode==='tainted'||mode==='late_taint'){expect(done.detail_json.error).toBe('workspace_egress_review_required');expect(actions).not.toContain('finish');return;}
  expect(done.resolution_run_id).toBeNull();expect(done.detail_json.completed_repair_runs).toContain(assigned.id);
  expect(commands).toEqual(mode==='repair'?[['pnpm','test'],['pnpm','test','--maxWorkers=1']]:[configured?['pnpm','test']:['git','diff','--check','a'.repeat(40),'c'.repeat(40),'--']]);
  if(mode==='failed_basic'){expect(actions).not.toContain('finish');return;}
  const notice=(await db.pool.query("SELECT metadata_json FROM messages WHERE metadata_json->>'execution_event_key'=$1",[`${mergeId}:${m.attempt_id}:integrated`])).rows[0];
  expect(notice.metadata_json.execution_details).toMatchObject({outcome:'integrated',verification_status:'passed',...(!configured?{verification_level:'basic'}:{})});
  const cleanup=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  expect(cleanup.profile_run_ids).toContain(assigned.id);
  if(mode==='repair'){expect(cleanup.profile_run_ids).toHaveLength(2);expect(done.detail_json.verification_repairs).toBe(1);}
 });
 it('repairs semantic conflicts with the same Agent before project verification and publication',async ctx=>{
  if(!db.available)return ctx.skip();const {run,mergeId}=await integration(),hosts=await host(),actions:string[]=[],repairId=randomUUID();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  let verified=false;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const f=frame as any;actions.push(f.action);if(f.action==='repair')expect(f.repair_mode).toBe('agent_resolution');if(f.action==='finish')expect(verified).toBe(true);return {ok:true,outcome:['prepare','repair'].includes(f.action)?'conflict':f.action==='continue'?'rebased':f.action==='seal'?'sealed':'merged',automatic_repair_allowed:false,conflicted_files:['deleted.md'],onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),error:null};};
  const deps={hosts,verify:async()=>{verified=true;return {status:'passed' as const,checks:[]};},repair:async(_db:unknown,_pool:unknown,_config:unknown,_m:unknown,_w:unknown,origin:RunRecord)=>{expect(origin.agent_id).toBe(run.agent_id);await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});return repairId;}};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_repair_dispatched');
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'integrated'});
  expect(actions).toEqual(['prepare','repair','continue','seal','finish']);
 });
 it('blocks unconfigured verification, replays a revision-fenced retry, and gives the retry a new candidate identity',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {w,mergeId}=await integration(),hosts=await host(),actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_command,frame):Promise<any>=>{const action=(frame as any).action;actions.push(action);return {ok:true,outcome:action==='prepare'?'rebased':'sealed',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts,verify:async()=>({status:'not_required',checks:[]})})).toEqual({status:'verification_failed'});
  expect(actions).not.toContain('finish');const before=await row(mergeId);expect(before.detail_json.error).toBe('integration_agent_verification_unavailable');
  const engine=await operationRuntime(config),actor=sessionActor({spaceId:SPACE,userId:OWNER}),key=randomUUID(),input={integration_id:mergeId,expected_revision:before.revision};
  const receipt=await engine.execute('workspace.integration.retry',input,actor,randomUUID(),key);expect(receipt.http_status,JSON.stringify(receipt.body)).toBe(200);
  expect((await engine.execute('workspace.integration.retry',input,actor,randomUUID(),key)).replayed).toBe(true);
  expect((await row(mergeId)).attempt_id).not.toBe(before.attempt_id);
  expect((await row(mergeId)).source_commit).toBe(before.source_commit);
  expect((await engine.execute('workspace.integration.retry',input,actor,randomUUID(),randomUUID())).http_status).toBe(409);
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('integrating');
 });
 it.for(['user','agent','changed_scope','agent_repair','agent_scope_changed'] as const)('records a %s conflict resolution through the existing retry, without bypassing verification',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("UPDATE task_merges SET status='conflict',detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({error:'integration_requires_semantic_decision',conflicted_files:['plan.md']})]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor,runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {workspaceIntegrationRecoveryHints}=await import('../src/modules/projectFolders/workspaceRecovery.js');
  expect(await workspaceIntegrationRecoveryHints(db.pool,run,OWNER,w.workspace.id)).toEqual([expect.objectContaining({integration_id:mergeId,can_request_repair:true})]);
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[run.id]);
  const agentRepair=kind.startsWith('agent_'),changedScope=kind.endsWith('scope')||kind==='agent_scope_changed';
  const actor=kind.startsWith('agent')?await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!):sessionActor({spaceId:SPACE,userId:OWNER});
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),engine=await operationRuntime(config),before=await row(mergeId);
  const result=await engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:before.revision,...(agentRepair?{repair_instruction:'Keep the target plan.'}:{resolution:'Keep the target plan.'})},actor,randomUUID(),randomUUID());
  if(kind==='agent'){expect(result.http_status).toBe(404);expect((await row(mergeId)).status).toBe('conflict');return;}
  expect(result.http_status,JSON.stringify(result.body)).toBe(200);
  expect((await row(mergeId)).detail_json[agentRepair?'agent_repair':'human_resolution']).toEqual({instruction:'Keep the target plan.',user_id:OWNER,paths:['plan.md'],...(agentRepair?{run_id:run.id}:{})});
  if(agentRepair)expect((await row(mergeId)).detail_json.human_resolution).toBeUndefined();
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run.id]);
  if(agentRepair)await db.pool.query("UPDATE task_merges SET detail_json=detail_json-'reply_owner_run_id' WHERE id=$1",[mergeId]);
  const actions:string[]=[],repairId=randomUUID();let verified=false;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const f=frame as any;actions.push(f.action);if(f.action==='repair')expect(f.repair_mode).toBe(agentRepair?'agent_resolution':'user_resolution');if(f.action==='finish')expect(verified).toBe(true);return {ok:true,outcome:f.action==='prepare'||f.action==='repair'?'conflict':f.action==='continue'?'rebased':f.action==='seal'?'sealed':'merged',automatic_repair_allowed:false,onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:f.action==='prepare'||f.action==='repair'?[changedScope?'other.md':'plan.md']:[],error:null};};
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const deps={hosts,verify:async()=>{verified=true;return {status:'passed' as const,checks:[]};},repair:async(_db:unknown,_pool:unknown,_config:unknown,m:any)=>{expect(m.detail_json[agentRepair?'agent_repair':'human_resolution'].instruction).toBe('Keep the target plan.');await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});return repairId;}};
  if(changedScope){expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'conflict'});expect(actions).not.toContain('repair');expect((await row(mergeId)).detail_json.error).toBe('integration_resolution_scope_changed');return;}
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_repair_dispatched');
  const {workspaceChangesForRun}=await import('../src/modules/projectFolders/workspaceReadModel.js');expect((await workspaceChangesForRun(db.pool,run,OWNER)).find(c=>c.change_set_id===w.changeSetId)?.resolution_run_id).toBe(repairId);
  await seedSpaceMember(db.pool,{space:SPACE,user:OTHER_TASK});
  await db.pool.query("UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2,visibility='private' WHERE id=$1",[repairId,OTHER_TASK]);
  expect((await workspaceChangesForRun(db.pool,run,OWNER)).find(c=>c.change_set_id===w.changeSetId)?.resolution_run_id).toBeNull();
  await db.pool.query('UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2 WHERE id=$1',[repairId,OWNER]);
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'integrated'});
  expect(actions).toEqual(['prepare','repair','continue','seal','finish']);
 });

 it('holds a conflict for one normal repair Run, then verifies its candidate',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');const {JobDeferredError}=await import('../src/modules/jobs/handlerRegistry.js');
  const {mergeId}=await integration(),hosts=await host(),repairId=randomUUID();let repairs=0;
  hosts.requestTaskBranch=async(_host,_command,frame):Promise<any>=>{const action=(frame as any).action;return {ok:true,automatic_repair_allowed:true,outcome:action==='prepare'?'conflict':action==='continue'?'rebased':action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:['README.md'],error:null};};
  const deps={hosts,verify:async()=>({status:'passed' as const,checks:[]}),repair:async()=>{repairs++;await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});return repairId;}};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toBeInstanceOf(JobDeferredError);
  expect((await row(mergeId)).status).toBe('resolving');
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'integrated'});expect(repairs).toBe(1);
 });
 it.for([false,true])('creates automatic repair through canonical admission, including attachment Location=%s',async (attachmentTarget,ctx)=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {integrationWorkspaceForRun}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  let {run,w,mergeId}=await integration();const hosts=await host();
  if(attachmentTarget){
   const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
   const {enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
   const folder=randomUUID(),location=randomUUID(),primary=w;
   await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repair attachment','code','active',false,false,now(),now())`,[folder,SPACE,PROJECT]);
   await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'active',now(),now())`,[location,SPACE,folder,HOST]);
   w=await ensureExecutionWorkspace(db.pool,run,HOST,location,'write');
   await db.pool.query("UPDATE execution_workspaces SET head_commit=$2,base_commit=$3,target_ref='refs/heads/dev',state='ready' WHERE id=$1",[w.workspace.id,'b'.repeat(40),'a'.repeat(40)]);
   await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$3,checkpoint_commit=$4,checkpoint_state='saved' WHERE run_id=$1 AND workspace_id=$2",[run.id,w.workspace.id,'a'.repeat(40),'b'.repeat(40)]);
   await db.pool.query("UPDATE workspace_change_sets SET state='ready',base_commit=$2,source_commit=$3,completion_basis=$4 WHERE id=$1",[w.changeSetId,'a'.repeat(40),'b'.repeat(40),run.id]);
   await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:LOCATION,execution_workspace:primary.ref},[{workspace_location_id:location,execution_workspace:w.ref,access_mode:'write'}]);
   mergeId=(await enqueueWorkspaceIntegration(db.pool,w.changeSetId,SPACE,OWNER))!;
  }
  await db.pool.query(`UPDATE agent_runtime_profiles SET runtime_key='claude_code',backend_mode='runtime_native',model_provider_id=NULL,model_name=NULL,execution_host_id=$2,workspace_mode='location',workspace_location_id=$3,runtime_installation='own' WHERE id=$1`,[run.runtime_profile_id,HOST,LOCATION]);
  await db.pool.query("UPDATE runs SET runtime_key='claude_code' WHERE id=$1",[run.id]);
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,outcome:'conflict',onto_commit:'a'.repeat(40),candidate_commit:null,automatic_repair_allowed:true,conflicted_files:['README.md'],error:null});
  await expect(advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts})).rejects.toThrow('integration_repair_dispatched');
  const m=await row(mergeId),repair=(await new PgRunRepository(db.pool).getRun(SPACE,m.resolution_run_id))!;
  expect(repair).toMatchObject({parent_run_id:run.id,root_run_id:run.id,trigger_origin:'system',status:'queued'});
  expect(repair.contract_snapshot_json).toMatchObject({workspace_integration_id:mergeId,workspace_integration_attempt_id:m.attempt_id,max_attempts:1,max_cost:2,max_duration_seconds:300});
  expect(repair.host_task_thread_id).not.toBe(run.host_task_thread_id);
  const binding=await integrationWorkspaceForRun(db.pool,repair,HOST,w.workspace.workspace_location_id);
  expect(binding.ref).toEqual({id:w.workspace.id,generation:1,integration_id:m.attempt_id});
  const {PgRouteDecisionRepository}=await import('../src/modules/routing/repository.js');
  const routed=await new PgRouteDecisionRepository(db.pool).routeRun({...repair,execution_kind:'agent',agent_id:AGENT,agent_version_id:VERSION});
  expect(routed.runtime_profile_snapshot_json).toMatchObject({execution_host_id:HOST,workspace_location_id:w.workspace.workspace_location_id});
  const {executeRemoteHostCliAdapter,NO_PROVIDER_BINDINGS}=await import('../src/modules/runs/remoteHostCliAdapter.js');
  const {HostServerFrameSchema}=await import('@rainver/protocol');
  let launched:unknown;
  hosts.registerConnection(HOST,{send(frame){if(frame.type==='launch'){launched=frame;queueMicrotask(()=>hosts.receiveComplete(HOST,repair.id,{exit_code:1,timed_out:false,error:'synthetic process stop after validating launch'},String(frame.launch_id)));}},close(){}});
  const launchResult=await executeRemoteHostCliAdapter({run:{...repair,runtime_key:routed.runtime_key,runtime_profile_snapshot_json:routed.runtime_profile_snapshot_json} as any,prompt:repair.prompt,model:null,resume_session_id:null,...(attachmentTarget?{workspace:{execution_workspace:binding.ref} as any}:{})},HOST,w.workspace.workspace_location_id,{
   config:loadConfig({SERVER_DATABASE_URL:db.connectionUri}),db:db.pool,
   bindings:NO_PROVIDER_BINDINGS,
   connectionRegistry:hosts,
  });
  expect(launched,JSON.stringify(launchResult)).toBeDefined();
  expect(HostServerFrameSchema.parse(launched)).toMatchObject({type:'launch',workspace:{kind:'location',workspace_location_id:w.workspace.workspace_location_id,execution_workspace:{id:w.workspace.id,generation:1,integration_id:m.attempt_id}}});
  await db.pool.query('UPDATE task_merges SET attempt_id=$2 WHERE id=$1',[mergeId,randomUUID()]);
  await expect(integrationWorkspaceForRun(db.pool,repair,HOST,w.workspace.workspace_location_id)).rejects.toThrow('attempt_changed');
 });
 it.for(['repair','revoked','foreign_context','unverified','target_moved'] as const)('handles an explicit candidate repair with %s using the current Run runtime and frozen source',async(kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),hosts=await host(),nextId=randomUUID(),profile=randomUUID();
  await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query(`INSERT INTO agent_runtime_profiles(id,space_id,agent_id,name,runtime_key,backend_mode,execution_host_id,workspace_mode,workspace_location_id,runtime_installation,enabled,is_default,created_at,updated_at)
   VALUES($1,$2,$3,'Current repair runtime','claude_code','runtime_native',$4,'location',$5,'own',true,false,now(),now())`,[profile,SPACE,AGENT,HOST,LOCATION]);
  await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[run.runtime_profile_id]);
  await db.pool.query(`UPDATE runs SET status='running',project_id=$2,session_id=$3,instructed_by_user_id=$4,runtime_profile_id=$5,runtime_key='claude_code',contract_snapshot_json='{"execution_workspace_version":1}'::jsonb,permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.integration.retry"}]}'::jsonb WHERE id=$1`,[nextId,PROJECT,CONVERSATION,OWNER,profile]);
  const next=(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!;
  const {ensureExecutionWorkspace,integrationWorkspaceForRun}=await import('../src/modules/projectFolders/executionWorkspaces.js');await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  await db.pool.query("UPDATE task_merges SET status='conflict',detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({conflicted_files:['plan.md']})]);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),engine=await operationRuntime(config),key=randomUUID();
  const input={integration_id:mergeId,expected_revision:(await row(mergeId)).revision,repair_instruction:'Keep the dev plan and preserve the feature changes.'},actor=await runActor(db.pool,next);
  expect((await engine.execute('workspace.integration.retry',input,actor,randomUUID(),key)).http_status).toBe(200);
  expect((await engine.execute('workspace.integration.retry',input,actor,randomUUID(),key)).replayed).toBe(true);
  const {workspaceChangesForRun}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const progress=(await workspaceChangesForRun(db.pool,run,OWNER)).find(c=>c.change_set_id===w.changeSetId)!;
  expect(progress.integration_detail).not.toHaveProperty('agent_repair');
  expect(progress.integration_detail).not.toHaveProperty('previous_detail');
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[nextId]);
  if(kind==='revoked')await db.pool.query("UPDATE execution_workspace_runs SET access_mode='read' WHERE run_id=$1",[nextId]);
  if(kind==='foreign_context')await db.pool.query("UPDATE runs SET has_context_taint=true,context_taint_json=$2::jsonb WHERE id=$1",[nextId,JSON.stringify({input_owner_user_ids:[OTHER_TASK],non_instructing_owner_user_ids:[OTHER_TASK],personal_memory_grant_ids:[]})]);
  await db.pool.query("UPDATE task_merges SET detail_json=detail_json-'reply_owner_run_id' WHERE id=$1",[mergeId]);
  let verified=false;const actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,f):Promise<any>=>{const frame=f as any;actions.push(frame.action);if(frame.action==='repair'&&frame.repair_mode)expect(frame.repair_mode).toBe('agent_resolution');if(frame.action==='finish')expect(verified).toBe(true);return{ok:true,outcome:frame.action==='prepare'||frame.action==='repair'?'conflict':frame.action==='continue'?'rebased':frame.action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:frame.action==='repair'&&!frame.repair_mode?[]:['plan.md'],automatic_repair_allowed:false,error:null};};
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const deps={hosts,verify:async()=>{verified=true;return{status:kind==='unverified'?'not_required' as const:'passed' as const,checks:[]};}};
  if(kind==='revoked'){await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow();expect(actions).toEqual([]);return;}
  if(kind==='foreign_context'){expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'failed'});expect(actions).not.toContain('repair');expect((await row(mergeId)).detail_json.error).toBe('workspace_egress_review_required');return;}
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_repair_dispatched');
  const m=await row(mergeId),repair=(await new PgRunRepository(db.pool).getRun(SPACE,m.resolution_run_id))!;
  expect(repair).toMatchObject({parent_run_id:nextId,requested_runtime_profile_id:profile,visibility:'private',owner_user_id:OWNER});
  const {PgRouteDecisionRepository}=await import('../src/modules/routing/repository.js');
  const routed=await new PgRouteDecisionRepository(db.pool).routeRun({...repair,execution_kind:'agent',agent_id:AGENT,agent_version_id:VERSION});
  expect(routed).toMatchObject({runtime_key:'claude_code',runtime_profile_snapshot_json:{id:profile,execution_host_id:HOST,workspace_location_id:LOCATION}});
  expect(repair.contract_snapshot_json).toMatchObject({workspace_integration_id:mergeId,workspace_integration_attempt_id:m.attempt_id,max_attempts:1});
  expect(repair.prompt).toContain(input.repair_instruction);expect(repair.prompt).toContain('native file tools');
  expect((await integrationWorkspaceForRun(db.pool,repair,HOST,LOCATION)).ref).toMatchObject({id:w.workspace.id,integration_id:m.attempt_id});
  const {conversationTurnTaken}=await import('../src/modules/sessions/conversationRuntimeSessionRepository.js');expect(await conversationTurnTaken(db.pool,SPACE,CONVERSATION)).toBe(false);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[repair.id]);
  if(kind==='target_moved')hosts.requestTaskBranch=async(_host,_type,f):Promise<any>=>{const frame=f as any;return{ok:true,outcome:frame.action==='continue'?'rebased':frame.action==='seal'?'sealed':'main_moved',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
  if(kind==='target_moved')await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_target_moved');
  else expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:kind==='unverified'?'verification_failed':'integrated'});
  const after=await row(mergeId);expect(after).toMatchObject({base_commit:'a'.repeat(40),source_commit:'b'.repeat(40)});expect(after.detail_json.agent_repair).toEqual({instruction:input.repair_instruction,user_id:OWNER,run_id:nextId,paths:['plan.md']});
  if(kind==='unverified')expect(actions).not.toContain('finish');
 });

 it.for(['queued','running','waiting_for_review'] as const)('does not queue a human message behind a %s background repair, but still serializes actual chat turns',async(status,ctx)=>{
  if(!db.available)return ctx.skip();
  const {run,w,mergeId}=await integration(),repairId=randomUUID();
  await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query('UPDATE runs SET status=$2,session_id=$3,parent_run_id=$4 WHERE id=$1',[repairId,status,CONVERSATION,run.id]);
  await db.pool.query("UPDATE task_merges SET status='resolving',resolution_run_id=$2 WHERE id=$1",[mergeId,repairId]);
  const {conversationTurnTaken}=await import('../src/modules/sessions/conversationRuntimeSessionRepository.js');
  expect(await conversationTurnTaken(db.pool,SPACE,CONVERSATION)).toBe(false);
  const nextId=randomUUID();await seedRun(db.pool,{id:nextId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query('UPDATE runs SET session_id=$2,project_id=$3,instructed_by_user_id=$4 WHERE id=$1',[nextId,CONVERSATION,PROJECT,OWNER]);
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const next=await ensureExecutionWorkspace(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,nextId))!,HOST,LOCATION);
  expect(next.workspace.id).toBe(w.workspace.id);expect(next.changeSetId).not.toBe(w.changeSetId);
  expect((await db.pool.query('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[next.changeSetId])).rows[0].base_commit).toBe('b'.repeat(40));
  expect(await row(mergeId)).toMatchObject({base_commit:'a'.repeat(40),source_commit:'b'.repeat(40)});
  await db.pool.query(`UPDATE runs SET model_override_json='{"chat_turn":{"schema_version":"chat_turn.v1"}}'::jsonb WHERE id=$1`,[repairId]);
  expect(await conversationTurnTaken(db.pool,SPACE,CONVERSATION)).toBe(true);
 });

 it('lets the next human turn continue during frozen publication and never automatically publishes a failed completion',async ctx=>{
  if(!db.available)return ctx.skip();
  const {conversationTurnTaken}=await import('../src/modules/sessions/conversationRuntimeSessionRepository.js');
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {run,w,mergeId}=await integration(),hosts=await host();let requests=0;
  hosts.requestTaskBranch=async():Promise<any>=>{requests++;throw new Error('failed work must not publish');};
  expect(await conversationTurnTaken(db.pool,SPACE,CONVERSATION)).toBe(false);
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[run.id]);
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,config,hosts);
  expect(await registry.dispatch({job_type:'execution_workspace_complete',job_id:randomUUID(),space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:8,worker_id:'test',payload:{change_set_id:w.changeSetId}})).toEqual({state:'blocked'});
  expect(requests).toBe(0);expect(await conversationTurnTaken(db.pool,SPACE,CONVERSATION)).toBe(false);
  const c=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0];
  const result=await (await operationRuntime(config)).execute('workspace.change.abandon',{change_set_id:w.changeSetId,expected_revision:c.revision,reason:'Keep the partial result without publishing'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(result.http_status,JSON.stringify(result.body)).toBe(200);
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0].state).toBe('abandoned');
  expect((await db.pool.query('SELECT head_commit FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].head_commit).toBe('b'.repeat(40));
 });
 it('blocks a completion without a publication target instead of re-enqueueing ready forever',async ctx=>{
  if(!db.available)return ctx.skip();
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {w,mergeId}=await integration(),hosts=await host();
  await db.pool.query('DELETE FROM task_merges WHERE id=$1',[mergeId]);await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[w.changeSetId]);await db.pool.query('UPDATE execution_workspaces SET target_ref=NULL WHERE id=$1',[w.workspace.id]);
  const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts);
  expect(await registry.dispatch({job_type:'execution_workspace_complete',job_id:randomUUID(),space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:8,worker_id:'test',payload:{change_set_id:w.changeSetId}})).toEqual({state:'blocked'});
  expect((await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[w.changeSetId])).rows[0]).toMatchObject({state:'blocked',verification_json:{error:'workspace_publish_basis_unavailable'}});
  const {workspaceChangesForRun}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const run=(await db.pool.query<{run_id:string}>('SELECT run_id FROM execution_workspace_runs WHERE workspace_id=$1',[w.workspace.id])).rows[0]!;
  expect((await workspaceChangesForRun(db.pool,{id:run.run_id,space_id:SPACE},OWNER))[0]?.integration_detail).toMatchObject({error:'workspace_publish_basis_unavailable'});
 });
 it('defers source publication while the canonical code-patch Folder gate is held',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {tryWithDedicatedSessionAdvisoryLock}=await import('../src/db/advisoryLock.js');
  const {mergeId}=await integration(),hosts=await host(),actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;actions.push(action);return {ok:true,outcome:action==='prepare'?'rebased':action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),deps={hosts,verify:async()=>({status:'passed' as const,checks:[]})};
  const gate=await tryWithDedicatedSessionAdvisoryLock(db.pool,`code-patch-folder:${FOLDER}`,async()=>{
   await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_source_folder_busy');
   expect(actions).not.toContain('finish');
  });expect(gate.acquired).toBe(true);
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'integrated'});
 });
 it.for([null,'host_offline','workspace_mirror_checkpoint_moved'] as const)('verifies pinned mirrors or handles failure %s with durable cleanup intent',async (failure,ctx)=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {run,w,mergeId}=await integration(),hosts=await host(),folder=randomUUID(),location=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'attachment','code','active',false,false,now(),now())`,[folder,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'active',now(),now())`,[location,SPACE,folder,HOST]);
  const attachment=await ensureExecutionWorkspace(db.pool,run,HOST,location,'write');
  await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:LOCATION,execution_workspace:w.ref},[{workspace_location_id:location,mount_location_id:location,execution_workspace:attachment.ref,access_mode:'write'}]);
  await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$3,checkpoint_commit=$4,checkpoint_state='saved' WHERE run_id=$1 AND workspace_id=$2",[run.id,attachment.workspace.id,'d'.repeat(40),'e'.repeat(40)]);
  const calls:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const f=frame as any;calls.push(f.action);
   if(f.action==='mirror'){
    expect(f).toMatchObject({expected_commit:'e'.repeat(40),workspace:{execution_workspace:{id:attachment.workspace.id}}});
    const manifest=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[attachment.workspace.id])).rows[0].cleanup_json[f.workspace.execution_workspace.integration_id];
    expect(manifest).toMatchObject({owner_integration_id:mergeId,state:'pending'});
    return {ok:!failure,commit:failure?null:'e'.repeat(40),branch:'mirror',error:failure};
   }
   return {ok:true,outcome:f.action==='prepare'?'rebased':f.action==='seal'?'sealed':'merged',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};
  };
  const advance=()=>advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async input=>{expect(input.target.workspace_access).toMatchObject([{workspace_location_id:location,access_mode:'read',execution_workspace:{id:attachment.workspace.id}}]);return {status:'passed',checks:[]};}});
  if(failure==='host_offline')await expect(advance()).rejects.toMatchObject({name:'JobDeferredError'});
  else expect(await advance()).toEqual({status:failure?'verification_failed':'integrated'});
  if(failure)expect(calls).not.toContain('finish');
  expect(calls).toContain('mirror');
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[attachment.changeSetId])).rows[0].state).toBe('open');
 });
 it('publishes an attachment using its own recipe, candidate aliases and frozen original Primary',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration,enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {run,w}=await integration(),hosts=await host(),folder=randomUUID(),location=randomUUID(),rootAlias=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'attachment','code','active',false,false,now(),now())`,[folder,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'active',now(),now())`,[location,SPACE,folder,HOST]);
  const attachment=await ensureExecutionWorkspace(db.pool,run,HOST,location,'write');
  await frozenWorkspaceLayout(run.id,{kind:'location',workspace_location_id:LOCATION,execution_workspace:w.ref},[
   {workspace_location_id:location,mount_location_id:location,execution_workspace:{...attachment.ref,cwd_subpath:'app'},access_mode:'write'},
   {workspace_location_id:location,mount_location_id:rootAlias,execution_workspace:attachment.ref,access_mode:'write'},
  ]);
  await db.pool.query('UPDATE runs SET project_folder_id=$2,contract_snapshot_json=contract_snapshot_json || $3::jsonb WHERE id=$1',[run.id,FOLDER,JSON.stringify({acceptance_criteria_json:[{key:'primary-only',description:'Primary check'}]})]);
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2,base_commit=$3,target_ref='refs/heads/dev',state='ready' WHERE id=$1",[attachment.workspace.id,'e'.repeat(40),'d'.repeat(40)]);
  await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$3,checkpoint_commit=$4,checkpoint_state='saved' WHERE run_id=$1 AND workspace_id=$2",[run.id,attachment.workspace.id,'d'.repeat(40),'e'.repeat(40)]);
  await db.pool.query("UPDATE workspace_change_sets SET state='ready',base_commit=$2,source_commit=$3,completion_basis=$4 WHERE id=$1",[attachment.changeSetId,'d'.repeat(40),'e'.repeat(40),run.id]);
  const mergeId=(await enqueueWorkspaceIntegration(db.pool,attachment.changeSetId,SPACE,OWNER))!;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const f=frame as any;if(f.action==='mirror'){
    expect(f).toMatchObject({expected_commit:'b'.repeat(40),workspace:{execution_workspace:{id:w.workspace.id}}});
    return {ok:true,commit:'b'.repeat(40),branch:'mirror',error:null};
   }
   return {ok:true,outcome:f.action==='prepare'?'rebased':f.action==='seal'?'sealed':'merged',onto_commit:'d'.repeat(40),candidate_commit:'f'.repeat(40),conflicted_files:[],error:null};
  };
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async input=>{
   expect(input.run.project_folder_id).toBe(folder);
   expect(input.run.contract_snapshot_json).not.toHaveProperty('acceptance_criteria_json');
   expect(input.target.workspace).toMatchObject({execution_workspace:{id:attachment.workspace.id,cwd_subpath:'app'}});
   const mounts=input.target.workspace_access!;
   expect(mounts).toHaveLength(3);
   expect(mounts[0]).toMatchObject({mount_location_id:location,access_mode:'write',execution_workspace:{id:attachment.workspace.id,cwd_subpath:'app'}});
   expect(mounts[1]).toMatchObject({mount_location_id:rootAlias,access_mode:'write',execution_workspace:{id:attachment.workspace.id}});
   expect(mounts[1]!.execution_workspace).not.toHaveProperty('cwd_subpath');
   expect(mounts[2]).toMatchObject({mount_location_id:LOCATION,access_mode:'read',execution_workspace:{id:w.workspace.id}});
   return {status:'passed',checks:[]};
  }})).toEqual({status:'integrated'});
 });
 it('requires full origin content access for operations and background publication',async ctx=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {authorizedWorkspaceChange}=await import('../src/modules/projectFolders/workspaceOperations.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {run,w,mergeId}=await integration(),hosts=await host();
  await db.pool.query("INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active','summary-origin@test.invalid','system',now(),now())",[OTHER_TASK]);
  await db.pool.query("UPDATE spaces SET oversight_mode='none' WHERE id=$1",[SPACE]);
  await db.pool.query("UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2,visibility='space_shared',access_level='summary' WHERE id=$1",[run.id,OTHER_TASK]);
  expect((await new PgRunRepository(db.pool).getVisibleRun(SPACE,OWNER,run.id))?.effective_access_level).toBe('summary');
  await expect(authorizedWorkspaceChange(db.pool,w.changeSetId,sessionActor({spaceId:SPACE,userId:OWNER}))).rejects.toThrow();
  hosts.requestTaskBranch=async():Promise<any>=>{throw new Error('summary authority must never reach Host publication');};
  await expect(advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts})).rejects.toThrow('integration_origin_no_longer_visible');
 });
 it('never publishes a repair candidate that acquired private context taint',async ctx=>{
  if(!db.available)return ctx.skip();const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {mergeId}=await integration(),hosts=await host(),repairId=randomUUID(),actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;actions.push(action);return {ok:true,outcome:action==='prepare'?'conflict':'sealed',automatic_repair_allowed:true,onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:['README.md'],error:null};};
  const deps={hosts,verify:async()=>({status:'passed' as const,checks:[]}),repair:async()=>{await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});await db.pool.query('UPDATE runs SET has_context_taint=true WHERE id=$1',[repairId]);return repairId;}};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_repair_dispatched');
  expect(await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).toEqual({status:'failed'});
  expect(actions).not.toContain('continue');expect(actions).not.toContain('finish');expect((await row(mergeId)).detail_json.error).toBe('workspace_egress_review_required');
 });
 it('rechecks taint acquired during verification before sealing or publication',async ctx=>{
  if(!db.available)return ctx.skip();const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {run,mergeId}=await integration(),hosts=await host(),actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;actions.push(action);return {ok:true,outcome:action==='prepare'?'rebased':'sealed',onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:[],error:null};};
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>{await db.pool.query('UPDATE runs SET has_context_taint=true WHERE id=$1',[run.id]);return {status:'passed',checks:[]};}})).toEqual({status:'failed'});
  expect(actions).not.toContain('seal');expect(actions).not.toContain('finish');
 });
 it('keeps one automatic repair budget after target movement and refuses a second automatic repair',async ctx=>{
  if(!db.available)return ctx.skip();const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');const {dispatchWorkspaceRepair}=await import('../src/modules/projectFolders/workspaceRepair.js');
  const {run,w,mergeId}=await integration(),hosts=await host(),repairId=randomUUID();
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;return {ok:true,outcome:action==='prepare'?'conflict':action==='continue'?'rebased':action==='finish'?'main_moved':'sealed',automatic_repair_allowed:true,onto_commit:'a'.repeat(40),candidate_commit:'c'.repeat(40),conflicted_files:['README.md'],error:null};};
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),deps={hosts,verify:async()=>({status:'passed' as const,checks:[]}),repair:async()=>{await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});return repairId;}};
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_repair_dispatched');
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,deps)).rejects.toThrow('integration_target_moved');
  const moved=await row(mergeId);expect(moved.detail_json).toMatchObject({target_moves:1,automatic_repairs:1});expect(moved.resolution_run_id).toBeNull();
  expect(await dispatchWorkspaceRepair(db.pool,db.pool,config,moved,w.workspace,run,['README.md'])).toBeNull();
 });
 it('archives a logically authorized profile after Location archival while still refusing foreign Host ownership',async ctx=>{
  if(!db.available)return ctx.skip();const {workspaceProfileFrame,workspaceLocationFrame}=await import('../src/modules/hosts/workspaceLocation.js');
  const {w}=await integration();
  await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[LOCATION]);
  expect(await workspaceProfileFrame(db.pool,w.workspace,w.ref,OWNER)).toMatchObject({workspace_location_id:LOCATION,execution_workspace:{id:w.workspace.id,generation:1}});
  await expect(workspaceLocationFrame(db.pool,w.workspace,w.ref,'/tmp')).rejects.toThrow('execution_workspace_location_unavailable');
  await expect(workspaceProfileFrame(db.pool,w.workspace,{...w.ref,generation:2},OWNER)).rejects.toThrow('execution_workspace_profile_identity_mismatch');
  await db.pool.query("INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active','archive-host-owner@test.invalid','system',now(),now())",[OTHER_TASK]);
  await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[HOST,OTHER_TASK]);
  await expect(workspaceProfileFrame(db.pool,w.workspace,w.ref,OWNER)).rejects.toThrow('execution_workspace_host_authority_changed');
 });
 it('never creates a writable repair from a read-only origin contract',async ctx=>{
  if(!db.available)return ctx.skip();const {dispatchWorkspaceRepair}=await import('../src/modules/projectFolders/workspaceRepair.js');
  const {run,w,mergeId}=await integration(),before=(await db.pool.query('SELECT count(*) AS n FROM runs')).rows[0].n;
  expect(await dispatchWorkspaceRepair(db.pool,db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),await row(mergeId),w.workspace,{...run,contract_snapshot_json:{execution_workspace_version:1,workspace_access:'read'}},['README.md'])).toBeNull();
  expect((await db.pool.query('SELECT count(*) AS n FROM runs')).rows[0].n).toBe(before);
 });
 it('recovers pending cleanup for a retired owner without resurrecting its execution',async ctx=>{
  if(!db.available)return ctx.skip();const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');const {enqueueWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {w}=await integration(),hosts=await host();
  await enqueueWorkspaceCleanup(db.pool,w.workspace,{id:w.workspace.id,generation:1},'b'.repeat(40),true,OWNER);
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[w.workspace.id]);
  await db.pool.query("DELETE FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'workspace_id'=$1",[w.workspace.id]);
  hosts.isOnline=()=>true;hosts.requestTaskBranch=async():Promise<any>=>{throw new Error('retired recovery must not inspect or execute');};
  expect((await reconcileExecutionWorkspaces(db.pool,'/tmp',{hosts})).recovered).toBe(1);
  expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].state).toBe('retired');
  expect((await reconcileExecutionWorkspaces(db.pool,'/tmp',{hosts})).recovered).toBe(0);
 });
 it('continues reconciliation past an unavailable source and persists the failed owner separately',async ctx=>{
  if(!db.available)return ctx.skip();const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
  const {run,w}=await integration(),hosts=await host(),folder=randomUUID(),location=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'second','code','active',false,false,now(),now())`,[folder,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'active',now(),now())`,[location,SPACE,folder,HOST]);
  const other=await ensureExecutionWorkspace(db.pool,run,HOST,location,'write');
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',start_commit=$2,checkpoint_commit=$2 WHERE workspace_id=$1",[other.workspace.id,'b'.repeat(40)]);
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$3,state='ready',updated_at=now()-interval '25 hours' WHERE id=ANY($1::varchar[]) AND space_id=$2",[[w.workspace.id,other.workspace.id],SPACE,'b'.repeat(40)]);
  const [bad,good]=[w.workspace,other.workspace].sort((a,b)=>a.id.localeCompare(b.id));
  await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[bad!.workspace_location_id]);
  hosts.isOnline=()=>true;hosts.requestTaskBranch=async():Promise<any>=>({ok:true,branch:'owned',commit:'b'.repeat(40),inventory:{worktree:true,registration:true,branch:true,run_record:false,pending_run_id:null,merge_record:false,quarantined_whole:0,retained_quarantine:0,active:false,free_bytes:10000000},error:null});
  const result=await reconcileExecutionWorkspaces(db.pool,'/tmp',{hosts});expect(result.failures).toEqual([{workspace_id:bad!.id,error:'execution_workspace_location_unavailable'}]);
  expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[good!.id])).rows[0].cleanup_json['source-g1']).toMatchObject({state:'pending'});
  expect((await db.pool.query('SELECT inventory_json,cleanup_state FROM execution_workspaces WHERE id=$1',[bad!.id])).rows[0]).toMatchObject({cleanup_state:'blocked',inventory_json:{reconciliation_error:'execution_workspace_location_unavailable'}});
 });
 it.for(['receipt','checkpoint','location'] as const)('saves independent repositories when one %s cannot be recovered',async (failure,ctx)=>{
  if(!db.available)return ctx.skip();
  const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {checkpointWorkspaceRun,registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const {JobHandlerRegistry,JobDeferredError}=await import('../src/modules/jobs/handlerRegistry.js');
  const {run,w}=await integration(),hosts=await host(),folder=randomUUID(),location=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'checkpoint attachment','code','active',false,false,now(),now())`,[folder,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote',true,'active',now(),now())`,[location,SPACE,folder,HOST]);
  await ensureExecutionWorkspace(db.pool,run,HOST,location,'write');
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending',start_commit=$2,launch_sequence=1 WHERE run_id=$1",[run.id,'a'.repeat(40)]);
  if(failure==='receipt')await db.pool.query('UPDATE execution_workspace_runs SET start_commit=NULL WHERE run_id=$1 AND workspace_id=$2',[run.id,w.workspace.id]);
  if(failure==='location')await db.pool.query("UPDATE workspace_locations SET status='archived' WHERE id=$1",[LOCATION]);
  let rejected=false;
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const f=frame as any;
   if(f.action==='inspect'||failure==='checkpoint'&&!rejected){rejected=true;return {ok:false,error:'host_offline'};}
   return {ok:true,commit:'b'.repeat(40),branch:'owned',error:null};
  };
  const registry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(registry,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),hosts);
  const advance=failure!=='receipt'?()=>checkpointWorkspaceRun(db.pool,run.id,SPACE,hosts):()=>registry.dispatch({job_id:randomUUID(),job_type:'execution_workspace_checkpoint',space_id:SPACE,user_id:OWNER,attempts:1,max_attempts:8,worker_id:'test',payload:{run_id:run.id}});
  if(failure==='location')await expect(advance()).rejects.toThrow('execution_workspace_location_unavailable');
  else await expect(advance()).rejects.toBeInstanceOf(JobDeferredError);
  expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1 ORDER BY checkpoint_state',[run.id])).rows).toEqual([{checkpoint_state:'pending'},{checkpoint_state:'saved'}]);
 });
 it('keeps cleanup failure budget while waiting for active repair profiles or Host leases',async ctx=>{
  if(!db.available)return ctx.skip();
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {JobDeferredError}=await import('../src/modules/jobs/handlerRegistry.js');
  const {w,mergeId}=await integration(),hosts=await host(),repairId=randomUUID(),m=await row(mergeId);
  await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[repairId]);
  await db.pool.query("UPDATE task_merges SET status='failed',resolution_run_id=$2 WHERE id=$1",[mergeId,repairId]);
  await enqueueWorkspaceCleanup(db.pool,w.workspace,{id:w.workspace.id,generation:1,integration_id:m.attempt_id},'c'.repeat(40),true,OWNER);
  const resource=async()=>(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  const initial=await resource(),advance=()=>advanceWorkspaceCleanup(db.pool,w.workspace.id,m.attempt_id,initial.operation_id,OWNER,hosts);
  hosts.requestTaskBranch=async():Promise<any>=>{throw new Error('active repair profile must not be archived');};
  for(let n=0;n<9;n++)await expect(advance()).rejects.toBeInstanceOf(JobDeferredError);
  expect(await resource()).toMatchObject({attempts:0,state:'retry_wait',error:'workspace_profile_run_active'});
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[repairId]);
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>(frame as any).action==='archive_profiles'?{ok:true,error:null}:{ok:false,error:'task_busy',cleanup_state:'retry_wait'};
  for(let n=0;n<9;n++)await expect(advance()).rejects.toBeInstanceOf(JobDeferredError);
  expect(await resource()).toMatchObject({attempts:0,state:'retry_wait',profiles_archived:true,error:'task_busy'});
  hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error:'host_offline'});
  await expect(advance()).rejects.toBeInstanceOf(JobDeferredError);
  expect(await resource()).toMatchObject({attempts:0,state:'retry_wait',profiles_archived:true,error:'host_offline'});
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,error:null,cleanup_state:'cleaned',inventory:{worktree:false,registration:false,run_record:false,merge_record:false,branch:true,quarantined_whole:0}});
  expect(await advance()).toEqual({cleanup_state:'cleaned'});
  expect(await resource()).toMatchObject({attempts:1,state:'cleaned'});
 });
 it.for(['conflict','no_changes'] as const)('persists candidate recovery for %s without a Host receipt, then cleans only its captured tip',async (outcome,ctx)=>{
  if(!db.available)return ctx.skip();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {w,mergeId}=await integration(),hosts=await host(),m=await row(mergeId);
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>({ok:(frame as any).action==='prepare',outcome,automatic_repair_allowed:false,onto_commit:'a'.repeat(40),candidate_commit:null,conflicted_files:['README.md'],error:(frame as any).action==='prepare'?null:(frame as any).action==='repair'?'unsupported_resolution':'host_offline'});
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts})).toEqual({status:outcome});
  const resource=async()=>(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  const pending=await resource();expect(pending).toMatchObject({state:'pending',capture:{source_commit:'b'.repeat(40),base_commit:'a'.repeat(40),target_ref:'refs/heads/dev'}});
  const actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{
   const f=frame as any;actions.push(f.action);
   if(f.action==='preserve')return {ok:true,candidate_commit:'d'.repeat(40),error:null};
   expect((await resource()).capture).toBeUndefined();expect((await resource()).expected_commit).toBe('d'.repeat(40));
   expect(f).toMatchObject({action:'cleanup',expected_commit:'d'.repeat(40),retain_branch:outcome==='conflict',workspace:{execution_workspace:{integration_id:m.attempt_id}}});
   return {ok:true,cleanup_state:'cleaned',error:null,inventory:{worktree:false,registration:false,branch:outcome==='conflict',run_record:false,merge_record:false,quarantined_whole:0}};
  };
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,m.attempt_id,pending.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(actions).toEqual(['preserve','cleanup']);expect(await resource()).toMatchObject({state:'cleaned',expected_commit:'d'.repeat(40)});
 });
 it('retains old candidate capture intent when target movement replaces the attempt during Host disconnect',async ctx=>{
  if(!db.available)return ctx.skip();const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {w,mergeId}=await integration(),hosts=await host(),m=await row(mergeId);
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;return {ok:action!=='preserve',outcome:action==='prepare'?'rebased':action==='finish'?'main_moved':'sealed',onto_commit:'a'.repeat(40),candidate_commit:action==='preserve'?null:'c'.repeat(40),conflicted_files:[],error:action==='preserve'?'host_offline':null};};
  await expect(advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts,verify:async()=>({status:'passed',checks:[]})})).rejects.toThrow('integration_target_moved');
  expect((await row(mergeId)).attempt_id).not.toBe(m.attempt_id);
  const r=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  expect(r).toMatchObject({state:'pending',expected_commit:'c'.repeat(40),retain_branch:false,capture:{source_commit:'b'.repeat(40),base_commit:'a'.repeat(40)}});
 });
 it('keeps original repair profile ownership after another integration attempt replaces it',async ctx=>{
  if(!db.available)return ctx.skip();
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {JobDeferredError}=await import('../src/modules/jobs/handlerRegistry.js');
  const {w,mergeId}=await integration(),hosts=await host(),m=await row(mergeId),repairId=randomUUID();
  await seedRun(db.pool,{id:repairId,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[repairId]);
  await db.pool.query('UPDATE task_merges SET resolution_run_id=$2 WHERE id=$1',[mergeId,repairId]);
  await enqueueWorkspaceCleanup(db.pool,w.workspace,{id:w.workspace.id,generation:1,integration_id:m.attempt_id},'c'.repeat(40),true,OWNER);
  const resource=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id];
  expect(resource.profile_run_ids).toEqual([repairId]);
  await db.pool.query('UPDATE task_merges SET attempt_id=$2,resolution_run_id=NULL WHERE id=$1',[mergeId,randomUUID()]);
  hosts.requestTaskBranch=async():Promise<any>=>{throw new Error('running previous-attempt profile must stay untouched');};
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,m.attempt_id,resource.operation_id,OWNER,hosts)).rejects.toBeInstanceOf(JobDeferredError);
  expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[m.attempt_id]).toMatchObject({attempts:0,state:'retry_wait'});
 });
 it.for(['absent','busy','quarantined','unknown'] as const)('requires absence proof before finishing candidate capture recovery (%s)',async (state,ctx)=>{
  if(!db.available)return ctx.skip();
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {w}=await integration(),hosts=await host(),attempt=randomUUID();
  await enqueueWorkspaceCleanup(db.pool,w.workspace,{id:w.workspace.id,generation:1,integration_id:attempt},'b'.repeat(40),true,OWNER,undefined,{source_commit:'b'.repeat(40),base_commit:'a'.repeat(40),target_ref:'refs/heads/dev',author:{name:'Agent',email:'agent@test.invalid'}});
  const resource=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[attempt],actions:string[]=[];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>{const action=(frame as any).action;actions.push(action);return action==='preserve'?{ok:false,candidate_commit:null,error:'integration_evidence_unavailable'}:state==='unknown'?{ok:false,error:'host_offline'}:{ok:true,inventory:{worktree:false,registration:false,branch:false,run_record:false,merge_record:false,quarantined_whole:state==='quarantined'?1:0,active:state==='busy'},error:null};};
  const advance=()=>advanceWorkspaceCleanup(db.pool,w.workspace.id,attempt,resource.operation_id,OWNER,hosts);
  if(state==='absent')expect(await advance()).toEqual({cleanup_state:'cleaned'});
  else{
   const {JobDeferredError}=await import('../src/modules/jobs/handlerRegistry.js');await expect(advance()).rejects.toBeInstanceOf(JobDeferredError);
   expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0].cleanup_json[attempt]).toMatchObject({state:'retry_wait',capture:resource.capture,attempts:state==='busy'||state==='unknown'?0:1});
  }
  expect(actions).toEqual(['preserve','inspect']);
 });
 it('retains a blocked cleanup manifest instead of reporting reclaimed resources',async ctx=>{
  if(!db.available)return ctx.skip();
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {w,run}=await integration(),hosts=await host(),workspace=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
  await db.pool.query("UPDATE runs SET updated_at=now()-interval '25 hours' WHERE id=$1",[run.id]);
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE workspace_id=$1",[w.workspace.id]);
  await enqueueWorkspaceCleanup(db.pool,workspace,{id:workspace.id,generation:1},'b'.repeat(40),true,OWNER);
  const manifest=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0].cleanup_json['source-g1'];
  hosts.requestTaskBranch=async(_host,_type,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:'b'.repeat(40),inventory:{active:false}}:{ok:false,branch:'owned',commit:'c'.repeat(40),cleanup_state:'blocked',error:'workspace_generation_moved'};
  expect(await advanceWorkspaceCleanup(db.pool,workspace.id,'source-g1',manifest.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  const result=(await db.pool.query('SELECT cleanup_state,cleanup_json FROM execution_workspaces WHERE id=$1',[workspace.id])).rows[0];
  expect(result.cleanup_state).toBe('blocked');expect(result.cleanup_json['source-g1'].error).toBe('workspace_generation_moved');
 });
});
