import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { connectManagedHost, loadManagedDaemon, type ManagedDaemon, type ManagedFrame } from "./support/managedWorkspaceHost.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { retryPendingArchivesForConnectedHosts } from "../src/modules/hosts/managedWorkspaceArchiveRecovery.js";
import { archiveManagedConversationWorkspaces, findManagedWorkspaceRestoreTarget } from "../src/modules/rooms/rosterService.js";
import { newDirectRestoreIdentity, restoreDirectManagedWorkspace, sendPendingManagedWorkspaceArchive, settleConversationCwdArchives } from "../src/modules/hosts/managedWorkspaceOperations.js";
import {
  enqueueRoomAgentWorkspaceRestore,
  processRoomAgentWorkspaceRestore,
  ROOM_AGENT_WORKSPACE_RESTORE_JOB,
} from "../src/modules/rooms/workspaceRestoreJob.js";

/**
 * Removing and re-adding a Room specialist against the daemon's own
 * managed-workspace code over a real filesystem, with the control plane's
 * real PostgreSQL state. The faults are where they happen in production: the
 * Host crashes between its two moves, its reply is lost after it finished, an
 * archive request is delivered after the restore that followed it.
 */

const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VERSION = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MACHINE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const HOST = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_VERSION = "44444444-4444-4444-8444-444444444444";

const db = useTestDatabase(import.meta.filename);
let roomId = "";
let stateDir = "";

type Frame = ManagedFrame;
type Daemon = ManagedDaemon;
const daemon = loadManagedDaemon;
const connectHost = connectManagedHost;

async function seedLiveState(host: Daemon) {
  const workspace = host.managedWorkspacePath(AGENT, { kind: "conversation", id: CONVERSATION });
  const profile = host.runtimeProfileContainerPath(AGENT, "conversation", CONVERSATION);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "shared work");
  await mkdir(join(profile, "claude_code"), { recursive: true });
  await writeFile(join(profile, "claude_code", "memory.md"), "what the Agent learned here");
  return { workspace, profile };
}

/** The Agent leaves the Room: the closing transaction commits the archive intent, then its after-commit attempt runs. */
async function removeAgent() {
  await db.pool.query(`UPDATE room_agent_members SET status = 'removed' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
  const closed = await new PgHostThreadRepository(db.pool).closeConversationAgentForRoom(SPACE, roomId, AGENT);
  expect(closed).toHaveLength(1);
  await archiveManagedConversationWorkspaces(db.pool, closed.map((thread) => ({
    threadId: thread.id, hostId: HOST, agentId: AGENT, conversationId: CONVERSATION,
  })));
  return closed[0]!.id;
}

/** Re-added with "restore": the membership and the restore Job commit together. */
async function readdWithRestore(host: Daemon) {
  await db.pool.query(`UPDATE hosts SET managed_workspaces_json = $2::jsonb WHERE id = $1`, [HOST, JSON.stringify(await host.listManagedWorkspaces())]);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE room_agent_members SET status = 'active' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
    const target = await findManagedWorkspaceRestoreTarget(client, SPACE, AGENT, roomId, OWNER);
    expect(target).not.toBeNull();
    await enqueueRoomAgentWorkspaceRestore(client, { spaceId: SPACE, userId: OWNER, roomId, target: target! });
    await client.query("COMMIT");
    return target!;
  } finally { client.release(); }
}

/** One worker attempt; `completed` false is a process that died before recording the Job's result. */
async function attemptRestore(completed = true) {
  const job = (await db.pool.query<{ id: string; user_id: string; attempts: number; payload_json: Record<string, unknown> }>(
    `SELECT id, user_id, attempts, payload_json FROM jobs WHERE job_type = $1 AND status = 'pending' ORDER BY created_at LIMIT 1`,
    [ROOM_AGENT_WORKSPACE_RESTORE_JOB])).rows[0];
  expect(job).toBeDefined();
  try {
    const result = await processRoomAgentWorkspaceRestore(db.pool, { job_id: job!.id, space_id: SPACE, user_id: job!.user_id, attempts: job!.attempts + 1, payload: job!.payload_json });
    if (completed) await db.pool.query(`UPDATE jobs SET status = 'completed' WHERE id = $1`, [job!.id]);
    return result;
  } catch (error) {
    if ((error as Error).name !== "JobDeferredError") throw error;
    return "deferred" as const;
  }
}

const notices = async () => (await db.pool.query<{ content: string }>(
  `SELECT content FROM messages WHERE session_id = $1 AND metadata_json->>'host_thread_event' = 'managed_workspace_restore_unavailable'`,
  [CONVERSATION])).rows.map((row) => row.content);
const pendingArchive = async (threadId: string) => (await db.pool.query<{ pending: boolean }>(
  `SELECT pending_archive_at IS NOT NULL AS pending FROM host_threads WHERE id = $1`, [threadId])).rows[0]!.pending;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-restore-host-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  if (!db.available) return;
  await resetTables(db.pool,
    ["jobs", "messages", "host_threads", "room_agent_members", "sessions", "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  roomId = (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`, [SPACE])).rows[0]!.id;
  await db.pool.query(`INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [CONVERSATION, SPACE, PROJECT, roomId, now]);
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(`INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'member', 'active', $5, $5)`,
    [randomUUID(), SPACE, roomId, AGENT, now]);
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`, [MACHINE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', '{"managed_workspace_operations":1}'::jsonb, $4, $4)`, [HOST, OWNER, MACHINE, now]);
  await new PgHostThreadRepository(db.pool).getOrCreateForConversationAgent({
    executionHostId: HOST, workspaceMode: "managed", spaceId: SPACE, sessionId: CONVERSATION, agentId: AGENT,
    runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER,
  });
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("restoring a re-added specialist's host state through the real daemon", () => {
  it("finishes a restore the Host crashed in between the workspace and the profile, and one whose reply was lost", async (ctx) => {
    if (!db.available) return ctx.skip();
    let host = await daemon();
    const { workspace, profile } = await seedLiveState(host);
    const link = connectHost(host);
    try {
      const threadId = await removeAgent();
      expect(await pendingArchive(threadId)).toBe(false);
      expect(existsSync(workspace) || existsSync(profile)).toBe(false);
      const target = await readdWithRestore(host);
      expect(target.includeWorkspace).toBe(true);

      // The workspace moves back, then the daemon dies before the profile: retried, never completed.
      link.next("crash_after_workspace");
      expect(await attemptRestore()).toBe("deferred");
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(profile)).toBe(false);
      expect(await notices()).toEqual([]);

      // Restarted daemon; this time it finishes but the reply is lost: still retried, still the same operation.
      host = await daemon();
      link.restore();
      const relinked = connectHost(host);
      relinked.next("lost_reply");
      expect(await attemptRestore()).toBe("deferred");
      expect(existsSync(profile)).toBe(true);

      // The server then dies after the Host answered and before the Job recorded it.
      expect(await attemptRestore(false)).toEqual({ outcome: "restored" });
      // The next process runs the same Job again: the Host's receipt answers, no conflict with the live workspace.
      host = await daemon();
      relinked.restore();
      const last = connectHost(host);
      expect(await attemptRestore()).toEqual({ outcome: "restored" });
      last.restore();
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("what the Agent learned here");
      expect(await notices()).toEqual([]);
      const restores = [...link.sent, ...relinked.sent, ...last.sent].filter((item) => item.type === "managed_workspace_restore");
      expect(new Set(restores.map((item) => item.frame.operation_id)).size).toBe(1);
    } finally { link.restore(); }
  });

  it("never lets an archive delivered after the restore undo it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    const { workspace, profile } = await seedLiveState(host);
    const link = connectHost(host);
    try {
      // The archive is sent and held in the network; its acknowledgement never arrives.
      link.next("hold");
      const threadId = await removeAgent();
      expect(await pendingArchive(threadId)).toBe(true);
      expect(existsSync(profile)).toBe(true);

      // Re-added with restore. The Job first settles the still-pending archive as its own operation, then restores.
      await readdWithRestore(host);
      expect(await attemptRestore()).toEqual({ outcome: "restored" });
      expect(await pendingArchive(threadId)).toBe(false);
      expect(existsSync(profile)).toBe(true);

      // The held copy of the old archive finally arrives at the Host.
      expect(await link.release()).toEqual([{ ok: true, changed: true, error: null }]);
      // And the recovery pass has nothing to resend.
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(0);
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("what the Agent learned here");

      // A lost acknowledgement and a recovery resend of the old intent after the restore: its receipt replays, nothing moves.
      await db.pool.query(`UPDATE host_threads SET pending_archive_at = now() - interval '10 minutes' WHERE id = $1`, [threadId]);
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(await pendingArchive(threadId)).toBe(false);
      expect(existsSync(profile)).toBe(true);
      expect(existsSync(workspace)).toBe(true);
    } finally { link.restore(); }
  });

  it("refuses an archive older than a restore the Host already applied, even with no receipt for it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    const { profile } = await seedLiveState(host);
    const link = connectHost(host);
    try {
      link.next("hold");
      const threadId = await removeAgent();
      await readdWithRestore(host);
      // The archive step of the Job is offline this time; the restore is not attempted before it.
      link.next("offline");
      expect(await attemptRestore()).toBe("deferred");
      expect(link.sent.filter((item) => item.type === "managed_workspace_restore")).toHaveLength(0);
      // The held original arrives first: it archives, under its own identity.
      expect(await link.release()).toEqual([{ ok: true, changed: true, error: null }]);
      expect(existsSync(profile)).toBe(false);
      // The Job's repeat of that archive replays its receipt, then the restore runs.
      expect(await attemptRestore()).toEqual({ outcome: "restored" });
      expect(existsSync(profile)).toBe(true);
      // A copy of an older generation for this target that the Host never journaled is fenced.
      const archive = link.sent.find((item) => item.type === "managed_workspace_archive")!.frame;
      expect(await host.executeManagedWorkspaceOperation({ ...archive, action: "archive", operation_id: `archive:${randomUUID()}:${archive.generation}` }))
        .toMatchObject({ ok: false, error_code: "stale_generation" });
      expect(existsSync(profile)).toBe(true);
      expect(await pendingArchive(threadId)).toBe(false);
    } finally { link.restore(); }
  });

  it("keeps the live-workspace conflict a definite refusal: told once, nothing moved, not retried", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    const { workspace, profile } = await seedLiveState(host);
    const link = connectHost(host);
    try {
      await removeAgent();
      await readdWithRestore(host);
      // Another Agent's Run created the shared cwd again in the meantime.
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "other.md"), "another agent's work");
      expect(await attemptRestore()).toEqual({ outcome: "unavailable", error: "live_conflict" });
      expect(await notices()).toHaveLength(1);
      expect(await readFile(join(workspace, "other.md"), "utf8")).toBe("another agent's work");
      expect(existsSync(join(workspace, "notes.md"))).toBe(false);
      expect(existsSync(profile)).toBe(false);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type = $1 AND status = 'pending'`, [ROOM_AGENT_WORKSPACE_RESTORE_JOB])).rows[0].n).toBe(0);
    } finally { link.restore(); }
  });

  it("waits for an identity-less archive the same daemon still runs before restoring, and refuses on a Host that cannot drain it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    const { workspace, profile } = await seedLiveState(host);
    const link = connectHost(host);
    try {
      // Before this release's control plane: an identity-less archive, acknowledged while a duplicate still runs.
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
      link.next("ack_after_duplicate");
      const threadId = await removeAgent();
      expect(await pendingArchive(threadId)).toBe(false);
      // Upgraded control plane, same daemon process: it journals, but has not drained.
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1,"legacy_archive_drain":1}'::jsonb WHERE id = $1`, [HOST]);
      await readdWithRestore(host);
      expect(await attemptRestore()).toBe("deferred");
      expect(link.sent.filter((item) => item.type === "managed_workspace_restore")).toHaveLength(0);
      // The duplicate finishes (nothing left to move); drained, the restore runs and nothing can undo it.
      expect(await link.releaseInFlight()).toEqual([{ ok: true, changed: false, error: null }]);
      expect(await attemptRestore()).toEqual({ outcome: "restored" });
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await host.executeManagedWorkspaceOperation({ action: "archive", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION, include_workspace: true }))
        .toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("what the Agent learned here");
    } finally { link.restore(); }
  });

  it("refuses a restore over an identity-less archive on a Host that journals but cannot drain (Room and direct)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    await seedLiveState(host);
    const link = connectHost(host);
    try {
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
      await removeAgent();
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1}'::jsonb WHERE id = $1`, [HOST]);
      await readdWithRestore(host);
      expect(await attemptRestore()).toEqual({ outcome: "unavailable", error: "host_update_required" });
      const threads = new PgHostThreadRepository(db.pool);
      await threads.getOrCreateForDirect({ executionHostId: HOST, workspaceMode: "managed", userId: OWNER, agentId: AGENT, runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER });
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
      await threads.closeDirectAgent(AGENT, OWNER, true);
      const direct = (await db.pool.query<{ id: string }>(`SELECT id FROM host_threads WHERE container_kind = 'direct'`)).rows[0]!.id;
      expect(await sendPendingManagedWorkspaceArchive(db.pool, direct, { hostId: HOST, agentId: AGENT, containerKind: "direct", containerId: OWNER }))
        .toMatchObject({ ok: true, settled: true });
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1}'::jsonb WHERE id = $1`, [HOST]);
      expect(await restoreDirectManagedWorkspace(db.pool, { hostId: HOST, agentId: AGENT, userId: OWNER, includeWorkspace: true, identity: await newDirectRestoreIdentity(db.pool) }))
        .toEqual({ ok: false, changed: false, error: "host_update_required" });
      expect(link.drains).toEqual([]);
      expect(link.sent.filter((item) => item.type === "managed_workspace_restore")).toHaveLength(0);
    } finally { link.restore(); }
  });

  it("direct chat: a restore waits for an identity-less archive the same daemon still runs after the upgrade, a drain that failed on disk releases nothing, and a restarted daemon still refuses the old request", async (ctx) => {
    if (!db.available) return ctx.skip();
    let host = await daemon();
    const threads = new PgHostThreadRepository(db.pool);
    await threads.getOrCreateForDirect({ executionHostId: HOST, workspaceMode: "managed", userId: OWNER, agentId: AGENT, runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER });
    const workspace = host.managedWorkspacePath(AGENT, { kind: "direct", id: OWNER });
    const profile = host.runtimeProfileContainerPath(AGENT, "direct", OWNER);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "draft.md"), "direct work");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "memory.md"), "direct memory");
    let link = connectHost(host);
    try {
      // Before this release's control plane: the session's identity-less archive is acknowledged while a duplicate still runs.
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
      await threads.closeDirectAgent(AGENT, OWNER, true);
      const direct = (await db.pool.query<{ id: string }>(`SELECT id FROM host_threads WHERE container_kind = 'direct'`)).rows[0]!.id;
      link.next("ack_after_duplicate");
      expect(await sendPendingManagedWorkspaceArchive(db.pool, direct, { hostId: HOST, agentId: AGENT, containerKind: "direct", containerId: OWNER }))
        .toMatchObject({ ok: true, settled: true });
      expect(existsSync(workspace) || existsSync(profile)).toBe(false);
      const unfenced = async () => (await db.pool.query<{ marked: boolean }>(
        `SELECT archive_unfenced_at IS NOT NULL AS marked FROM host_threads WHERE id = $1`, [direct])).rows[0]!.marked;
      expect(await unfenced()).toBe(true);
      // Upgraded control plane, same daemon process. Its first drain cannot persist the closure (the disk refuses the marker).
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1,"legacy_archive_drain":1}'::jsonb WHERE id = $1`, [HOST]);
      const marker = join(stateDir, "managed-operations", "legacy-archives-closed");
      await mkdir(marker, { recursive: true });
      const input = { hostId: HOST, agentId: AGENT, userId: OWNER, includeWorkspace: true, identity: await newDirectRestoreIdentity(db.pool) };
      expect(await restoreDirectManagedWorkspace(db.pool, input)).toMatchObject({ ok: false, changed: false, error_code: "io_error" });
      expect(await unfenced()).toBe(true);
      // The disk recovers, but the duplicate still runs: the drain has not answered, so nothing is released.
      await rm(marker, { recursive: true });
      expect(await restoreDirectManagedWorkspace(db.pool, input)).toEqual({ ok: false, changed: false, error: "host_timeout" });
      expect(await unfenced()).toBe(true);
      expect(link.sent.filter((item) => item.type === "managed_workspace_restore")).toHaveLength(0);
      // The duplicate finishes (nothing left to move); drained, the restore runs.
      expect(await link.releaseInFlight()).toEqual([{ ok: true, changed: false, error: null }]);
      expect(await restoreDirectManagedWorkspace(db.pool, input)).toEqual({ ok: true, changed: true, error: null });
      expect(await unfenced()).toBe(false);
      expect(link.drains.map((answer) => answer.ok)).toEqual([false, false, true]);
      // A restarted daemon keeps the closure it acknowledged: the old request arriving now moves nothing.
      link.restore();
      host = await daemon();
      link = connectHost(host);
      expect(await host.executeManagedWorkspaceOperation({ action: "archive", agent_id: AGENT, container_kind: "direct", container_id: OWNER, include_workspace: true }))
        .toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await readFile(join(workspace, "draft.md"), "utf8")).toBe("direct work");
      expect(await readFile(join(profile, "memory.md"), "utf8")).toBe("direct memory");
    } finally { link.restore(); }
  });

  it("settles a direct chat's pending archive first and replays the turn's restore when a retried turn repeats it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await daemon();
    const threads = new PgHostThreadRepository(db.pool);
    await threads.getOrCreateForDirect({ executionHostId: HOST, workspaceMode: "managed", userId: OWNER, agentId: AGENT, runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER });
    const direct = { kind: "direct" as const, id: OWNER };
    const workspace = host.managedWorkspacePath(AGENT, direct as never);
    const profile = host.runtimeProfileContainerPath(AGENT, "direct" as never, OWNER);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "draft.md"), "direct work");
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, "memory.md"), "direct memory");
    const link = connectHost(host);
    try {
      // The session is deleted; its archive intent commits and its after-commit attempt is held in the network.
      await threads.closeDirectAgent(AGENT, OWNER, true);
      // The person asks for it back in a new turn: the turn commits its restore identity, ordered after that intent.
      const identity = await newDirectRestoreIdentity(db.pool);
      const input = { hostId: HOST, agentId: AGENT, userId: OWNER, includeWorkspace: true, identity };
      link.next("lost_reply");
      // The pending archive goes first; its reply is lost, so the turn fails and nothing is restored blind.
      expect(await restoreDirectManagedWorkspace(db.pool, input)).toMatchObject({ ok: false, error: "host_timeout" });
      expect(existsSync(workspace)).toBe(false);
      // The archive's repeat replays; the restore runs, and its reply is lost too.
      link.next("none");
      const first = await restoreDirectManagedWorkspace(db.pool, input);
      expect(first).toEqual({ ok: true, changed: true, error: null });
      // A retried turn carries the same identity: the receipt answers, not a live-workspace conflict.
      expect(await restoreDirectManagedWorkspace(db.pool, input)).toEqual({ ok: true, changed: true, error: null });
      expect(await readFile(join(workspace, "draft.md"), "utf8")).toBe("direct work");
      expect(await readFile(join(profile, "memory.md"), "utf8")).toBe("direct memory");
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM host_threads WHERE container_kind = 'direct' AND pending_archive_at IS NOT NULL`)).rows[0].n).toBe(0);
    } finally { link.restore(); }
  });

  describe("an archive's cwd scope is fixed when it commits", () => {
    const archiveFrames = (sent: Array<{ type: string; frame: Frame }>, agent: string) =>
      sent.filter((item) => item.type === "managed_workspace_archive" && item.frame.agent_id === agent).map((item) => item.frame);
    const age = () => db.pool.query(`UPDATE host_threads SET pending_archive_at = now() - interval '10 minutes' WHERE pending_archive_at IS NOT NULL`);

    async function addOther(now = new Date().toISOString()) {
      await seedAgentWithVersion(db.pool, { agent: OTHER_AGENT, version: OTHER_VERSION, space: SPACE, owner: OWNER, now });
      await db.pool.query(`INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'member', 'active', $5, $5)`,
        [randomUUID(), SPACE, roomId, OTHER_AGENT, now]);
      await new PgHostThreadRepository(db.pool).getOrCreateForConversationAgent({
        executionHostId: HOST, workspaceMode: "managed", spaceId: SPACE, sessionId: CONVERSATION, agentId: OTHER_AGENT,
        runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER,
      });
    }

    it("repeats a profile-only archive as profile-only after the last other Agent leaves (false, then true)", async (ctx) => {
      if (!db.available) return ctx.skip();
      const host = await daemon();
      const { workspace, profile } = await seedLiveState(host);
      await addOther();
      const link = connectHost(host);
      try {
        // A leaves while B stays: profile only. The Host does it; the acknowledgement is lost.
        link.next("lost_reply");
        const threadId = await removeAgent();
        expect(await pendingArchive(threadId)).toBe(true);
        expect(existsSync(profile)).toBe(false);
        expect(existsSync(workspace)).toBe(true);
        // B leaves too: B's own intent is the one that takes the cwd. Its after-commit attempt never ran.
        await db.pool.query(`UPDATE room_agent_members SET status = 'removed' WHERE room_id = $1 AND agent_id = $2`, [roomId, OTHER_AGENT]);
        const [other] = await new PgHostThreadRepository(db.pool).closeConversationAgentForRoom(SPACE, roomId, OTHER_AGENT);
        expect(other!.include_workspace).toBe(true);
        // The recovery pass repeats A's archive exactly as it committed, then sends B's.
        await age();
        await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
        const frames = archiveFrames(link.sent, AGENT);
        expect(frames).toHaveLength(2);
        expect(frames[1]).toEqual(frames[0]);
        expect(frames[0]!.include_workspace).toBe(false);
        expect(archiveFrames(link.sent, OTHER_AGENT).map((frame) => frame.include_workspace)).toEqual([true]);
        expect(await pendingArchive(threadId)).toBe(false);
        expect(await pendingArchive(other!.id)).toBe(false);
        expect(existsSync(workspace)).toBe(false);
      } finally { link.restore(); }
    });

    it("repeats a cwd archive as a cwd archive after another Agent joins (true, then false), and settles it before that Agent's Run", async (ctx) => {
      if (!db.available) return ctx.skip();
      const host = await daemon();
      const { workspace } = await seedLiveState(host);
      const link = connectHost(host);
      try {
        // A leaves last: its archive takes the cwd. That delivery is held in the network.
        link.next("hold");
        const threadId = await removeAgent();
        expect(await pendingArchive(threadId)).toBe(true);
        // B joins the conversation before the Host saw A's archive.
        await addOther();
        expect((await new PgHostThreadRepository(db.pool).listPendingManagedWorkspaceArchives(HOST))
          .find((row) => row.id === threadId)?.include_workspace).toBe(true);
        // B's first Run settles that archive first, as committed; then B works in a fresh cwd.
        expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
        expect(await pendingArchive(threadId)).toBe(false);
        expect(existsSync(workspace)).toBe(false);
        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, "b.md"), "B's work");
        // The held original copy of A's archive arrives late: its receipt answers, B's cwd is not moved.
        expect(await link.release()).toEqual([{ ok: true, changed: true, error: null }]);
        expect(await readFile(join(workspace, "b.md"), "utf8")).toBe("B's work");
        const frames = archiveFrames(link.sent, AGENT);
        expect(frames).toHaveLength(2);
        expect(frames[1]).toEqual(frames[0]);
        expect(frames[0]!.include_workspace).toBe(true);
        // Nothing left for a later Run or the recovery pass.
        await age();
        await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(0);
        expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
        expect(link.sent).toHaveLength(2);
      } finally { link.restore(); }
    });

    it("refuses a Run's launch while the cwd archive before it is unconfirmed, and repeats the same operation next time", async (ctx) => {
      if (!db.available) return ctx.skip();
      const host = await daemon();
      const { workspace } = await seedLiveState(host);
      const link = connectHost(host);
      try {
        link.next("offline");
        const threadId = await removeAgent();
        await addOther();
        link.next("lost_reply");
        expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toMatchObject({ ok: false, error: "host_timeout" });
        expect(await pendingArchive(threadId)).toBe(true);
        expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
        expect(new Set(archiveFrames(link.sent, AGENT).map((frame) => JSON.stringify(frame))).size).toBe(1);
        expect(existsSync(workspace)).toBe(false);
        expect(await pendingArchive(threadId)).toBe(false);
      } finally { link.restore(); }
    });
  });

  describe("a restore past its deadline", () => {
    const overdueNotices = async () => (await db.pool.query<{ content: string }>(
      `SELECT content FROM messages WHERE session_id = $1 AND metadata_json->>'host_thread_event' = 'managed_workspace_restore_overdue'`,
      [CONVERSATION])).rows.map((row) => row.content);
    const jobStatus = async () => (await db.pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE job_type = $1`, [ROOM_AGENT_WORKSPACE_RESTORE_JOB])).rows.map((row) => row.status);
    const overdue = () => db.pool.query(
      `UPDATE jobs SET payload_json = payload_json || jsonb_build_object('requested_at', (now() - interval '8 days')::text) WHERE job_type = $1`,
      [ROOM_AGENT_WORKSPACE_RESTORE_JOB]);

    it("warns once and keeps reconciling an unknown outcome until the Host's receipt settles it", async (ctx) => {
      if (!db.available) return ctx.skip();
      const host = await daemon();
      const { profile } = await seedLiveState(host);
      const link = connectHost(host);
      try {
        await removeAgent();
        await readdWithRestore(host);
        await overdue();
        // The restore reaches the Host and completes; the reply is lost. Unknown, past the deadline.
        link.next("lost_reply");
        expect(await attemptRestore()).toBe("deferred");
        link.next("offline");
        expect(await attemptRestore()).toBe("deferred");
        expect(await overdueNotices()).toHaveLength(1);
        expect(await notices()).toEqual([]);
        expect(await jobStatus()).toEqual(["pending"]);
        // The Host is back: the same operation's receipt answers. The obligation was never dropped.
        expect(await attemptRestore()).toEqual({ outcome: "restored" });
        expect(existsSync(profile)).toBe(true);
        expect(await overdueNotices()).toHaveLength(1);
        const restores = link.sent.filter((item) => item.type === "managed_workspace_restore");
        expect(new Set(restores.map((item) => item.frame.operation_id)).size).toBe(1);
      } finally { link.restore(); }
    });

    it("ends when the request is withdrawn, not when the deadline passes", async (ctx) => {
      if (!db.available) return ctx.skip();
      const host = await daemon();
      await seedLiveState(host);
      const link = connectHost(host);
      try {
        await removeAgent();
        await readdWithRestore(host);
        await overdue();
        link.next("offline");
        expect(await attemptRestore()).toBe("deferred");
        expect(await jobStatus()).toEqual(["pending"]);
        const sentBefore = link.sent.length;
        await db.pool.query(`UPDATE room_agent_members SET status = 'removed' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
        expect(await attemptRestore()).toEqual({ outcome: "withdrawn" });
        expect(link.sent).toHaveLength(sentBefore);
        expect(await jobStatus()).toEqual(["completed"]);
      } finally { link.restore(); }
    });
  });
});
