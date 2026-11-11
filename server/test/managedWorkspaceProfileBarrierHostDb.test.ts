import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { connectManagedHost, loadManagedDaemon, type ManagedDaemon, type ManagedFrame } from "./support/managedWorkspaceHost.js";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { retryPendingArchivesForConnectedHosts, settleLaunchProfileArchives } from "../src/modules/hosts/managedWorkspaceArchiveRecovery.js";
import { archiveManagedConversationWorkspaces, findManagedWorkspaceRestoreTarget } from "../src/modules/rooms/rosterService.js";
import { enqueueRoomAgentWorkspaceRestore, processRoomAgentWorkspaceRestore, ROOM_AGENT_WORKSPACE_RESTORE_JOB } from "../src/modules/rooms/workspaceRestoreJob.js";
import { archiveTookConversationCwd, HOST_UPDATE_REQUIRED, settleConversationCwdArchives } from "../src/modules/hosts/managedWorkspaceOperations.js";
import { HostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { executeRemoteHostCliAdapter, NO_PROVIDER_BINDINGS } from "../src/modules/runs/remoteHostCliAdapter.js";
import { resolveRuntimeProfileScope } from "../src/modules/runs/remoteProviderBinding.js";
import type { AgentRunRecord } from "../src/modules/runs/repository.js";

/**
 * The order between an Agent's old archive and its next use of the same host
 * state, against the daemon's real journal over a real filesystem and the
 * control plane's real PostgreSQL. An Agent leaves (its profile archive
 * commits), comes back without a restore, and starts a Run in the same profile
 * directory; the old archive is in the network, its reply lost, or its Host
 * receipt older than this release's schema.
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
const FOLDER = "55555555-5555-4555-8555-555555555555";
const LOCATION = "66666666-6666-4666-8666-666666666666";
const WORKSPACE = "77777777-7777-4777-8777-777777777777";

const db = useTestDatabase(import.meta.filename);
let roomId = "";
let stateDir = "";

const threads = () => new PgHostThreadRepository(db.pool);
const pendingArchive = async (threadId: string) => (await db.pool.query<{ pending: boolean }>(
  `SELECT pending_archive_at IS NOT NULL AS pending FROM host_threads WHERE id = $1`, [threadId])).rows[0]!.pending;
const scope = async (threadId: string) => (await db.pool.query<{ include: boolean | null; confirmed: boolean }>(
  `SELECT archive_include_workspace AS include, archive_scope_confirmed AS confirmed FROM host_threads WHERE id = $1`, [threadId])).rows[0]!;
const archiveFrames = (sent: Array<{ type: string; frame: ManagedFrame }>, agent: string) =>
  sent.filter((item) => item.type === "managed_workspace_archive" && item.frame.agent_id === agent).map((item) => item.frame);
const archivesOf = async (live: string) => (await readdir(dirname(live)).catch(() => [] as string[]))
  .filter((name) => name.startsWith(`${live.slice(dirname(live).length + 1)}.removed-`));
const age = () => db.pool.query(`UPDATE host_threads SET pending_archive_at = now() - interval '10 minutes' WHERE pending_archive_at IS NOT NULL`);
const conversationProfile = { agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION };

async function joinConversation(agentId: string, mode: "managed" | "location" = "managed") {
  const updated = await db.pool.query(`UPDATE room_agent_members SET status = 'active' WHERE room_id = $1 AND agent_id = $2`, [roomId, agentId]);
  if (!updated.rowCount) {
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`, [randomUUID(), SPACE, roomId, agentId]);
  }
  return threads().getOrCreateForConversationAgent({
    executionHostId: HOST, workspaceMode: mode, ...(mode === "location" ? { workspaceLocationId: LOCATION } : {}),
    spaceId: SPACE, sessionId: CONVERSATION, agentId, runtimeKey: "claude_code", runtimeInstallation: "own", createdByUserId: OWNER,
  });
}

/** The Agent leaves the Room: the intent commits, then its after-commit attempt runs (shaped by the link's next fault). */
async function leave(agentId: string, send = true) {
  await db.pool.query(`UPDATE room_agent_members SET status = 'removed' WHERE room_id = $1 AND agent_id = $2`, [roomId, agentId]);
  const closed = await threads().closeConversationAgentForRoom(SPACE, roomId, agentId);
  expect(closed).toHaveLength(1);
  if (send) await archiveManagedConversationWorkspaces(db.pool, [{ threadId: closed[0]!.id, hostId: HOST, agentId, conversationId: CONVERSATION }]);
  return closed[0]!;
}

async function seedProfile(host: ManagedDaemon, agentId: string, content: string, kind: "conversation" | "workspace" = "conversation", id = CONVERSATION) {
  const profile = host.runtimeProfileContainerPath(agentId, kind, id);
  await mkdir(join(profile, "claude_code"), { recursive: true });
  await writeFile(join(profile, "claude_code", "memory.md"), content);
  return profile;
}

async function seedWorkspace(host: ManagedDaemon) {
  const workspace = host.managedWorkspacePath(AGENT, { kind: "conversation", id: CONVERSATION });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.md"), "shared work");
  return workspace;
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "rainver-profile-barrier-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  if (!db.available) return;
  await resetTables(db.pool,
    ["jobs", "messages", "host_threads", "execution_workspaces", "workspace_locations", "project_folders", "room_agent_members", "sessions",
      "agents", "agent_versions", "rooms", "projects", "hosts", "machines", "space_memberships", "users", "spaces"],
    { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  roomId = (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE space_id = $1 AND is_mainline = true LIMIT 1`, [SPACE])).rows[0]!.id;
  await db.pool.query(`INSERT INTO sessions (id, space_id, project_id, room_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)`,
    [CONVERSATION, SPACE, PROJECT, roomId, now]);
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await seedAgentWithVersion(db.pool, { agent: OTHER_AGENT, version: OTHER_VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`, [MACHINE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', '{"managed_workspace_operations":1,"workspace_profile_operations":1,"execution_workspaces":{"version":2}}'::jsonb, $4, $4)`,
    [HOST, OWNER, MACHINE, now]);
  await db.pool.query(`INSERT INTO project_folders (id, space_id, project_id, name, kind, status, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, 'repo', 'code', 'active', false, false, $4, $4)`, [FOLDER, SPACE, PROJECT, now]);
  await db.pool.query(`INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind, display_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/workspace/repo', true, 'active', $5, $5)`, [LOCATION, SPACE, FOLDER, HOST, now]);
});

afterEach(async () => {
  delete process.env.RAINVER_HOST_CONFIG_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("an Agent's old archive lands before its next Run uses the same profile", () => {
  it("re-added without restore while a profile-only archive is still in the network (managed cwd, another Agent stays)", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const oldProfile = await seedProfile(host, AGENT, "what A learned before");
    const otherProfile = await seedProfile(host, OTHER_AGENT, "B's own memory");
    const link = connectManagedHost(host);
    try {
      // A leaves while B stays: profile only. The after-commit send is held in the network.
      link.next("hold");
      const closed = await leave(AGENT);
      expect(closed.include_workspace).toBe(false);
      expect(existsSync(oldProfile)).toBe(true);
      // A is re-added without restore and gets a new thread; B keeps working, and B's launch owes nothing of A's.
      await joinConversation(AGENT);
      expect(await settleLaunchProfileArchives(db.pool, HOST, { agent_id: OTHER_AGENT, container_kind: "conversation", container_id: CONVERSATION }))
        .toEqual({ ok: true, changed: false, error: null });
      expect(archiveFrames(link.sent, AGENT)).toHaveLength(1);
      // A's new Run: the old archive is settled first, as the same operation, before the runtime starts.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(existsSync(oldProfile)).toBe(false);
      expect(await archivesOf(oldProfile)).toHaveLength(1);
      // The new Run writes A's fresh profile in the same directory.
      await seedProfile(host, AGENT, "A's new run");
      // The held original arrives late: its receipt answers and nothing moves.
      expect(await link.release()).toEqual([{ ok: true, changed: true, error: null }]);
      expect(await readFile(join(oldProfile, "claude_code", "memory.md"), "utf8")).toBe("A's new run");
      expect(await archivesOf(oldProfile)).toHaveLength(1);
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await readFile(join(otherProfile, "claude_code", "memory.md"), "utf8")).toBe("B's own memory");
      const frames = archiveFrames(link.sent, AGENT);
      expect(frames).toHaveLength(2);
      expect(frames[1]).toEqual(frames[0]);
      // Nothing left for the recovery pass or the next launch.
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(0);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(link.sent).toHaveLength(2);
    } finally { link.restore(); }
  });

  it("in location mode, refuses the launch while the archive is unconfirmed and repeats it after a lost reply and a crash mid-move", async (ctx) => {
    if (!db.available) return ctx.skip();
    let host = await loadManagedDaemon();
    await joinConversation(AGENT, "location");
    const profile = await seedProfile(host, AGENT, "what A learned before");
    const link = connectManagedHost(host);
    try {
      link.next("offline");
      const closed = await leave(AGENT);
      expect(closed.include_workspace).toBe(false);
      await joinConversation(AGENT, "location");
      // Host offline: the launch is refused, nothing has moved.
      link.next("offline");
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toMatchObject({ ok: false, error: "host_offline" });
      expect(existsSync(profile)).toBe(true);
      // The daemon moves the profile and dies before recording it: still refused.
      link.next("crash_after_profile");
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toMatchObject({ ok: false, error_code: "io_error" });
      expect(existsSync(profile)).toBe(false);
      // Restarted daemon, reply lost this time: still refused, still the same operation.
      host = await loadManagedDaemon();
      link.restore();
      const relinked = connectManagedHost(host);
      relinked.next("lost_reply");
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toMatchObject({ ok: false, error: "host_timeout" });
      expect(await pendingArchive(closed.id)).toBe(true);
      // The journal decides from the filesystem that its move already happened; the launch proceeds.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(await archivesOf(profile)).toHaveLength(1);
      await seedProfile(host, AGENT, "A's new run");
      // A recovery resend of the old intent after a lost acknowledgement replays; the new profile stays.
      await db.pool.query(`UPDATE host_threads SET pending_archive_at = now() - interval '10 minutes' WHERE id = $1`, [closed.id]);
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's new run");
      expect(await archivesOf(profile)).toHaveLength(1);
      const operations = [...link.sent, ...relinked.sent].filter((item) => item.type === "managed_workspace_archive").map((item) => item.frame.operation_id);
      expect(new Set(operations).size).toBe(1);
      relinked.restore();
    } finally { link.restore(); }
  });

  async function isolatedThread(host: ManagedDaemon) {
    await db.pool.query(`INSERT INTO execution_workspaces (id, space_id, project_id, workspace_location_id, execution_host_id, owner_kind, session_id)
       VALUES ($1, $2, $3, $4, $5, 'conversation', $6)`, [WORKSPACE, SPACE, PROJECT, LOCATION, HOST, CONVERSATION]);
    const first = await joinConversation(AGENT, "location");
    await db.pool.query(`UPDATE host_threads SET execution_workspace_json = $2::jsonb WHERE id = $1`,
      [first.id, JSON.stringify({ id: WORKSPACE, generation: 1, profile_container_id: WORKSPACE })]);
    return seedProfile(host, AGENT, "A's isolated run", "workspace", WORKSPACE);
  }
  const workspaceProfile = { agent_id: AGENT, container_kind: "workspace", container_id: WORKSPACE };
  const unfenced = async (threadId: string) => (await db.pool.query<{ unfenced: boolean }>(
    `SELECT archive_unfenced_at IS NOT NULL AS unfenced FROM host_threads WHERE id = $1`, [threadId])).rows[0]!.unfenced;

  it("an isolated-workspace profile archive is one journaled operation: its original request arriving after the next Run began moves nothing", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const profile = await isolatedThread(host);
    const link = connectManagedHost(host);
    try {
      const closed = await leave(AGENT, false);
      await joinConversation(AGENT, "location");
      // The original request is held in the network; the barrier's repeat of it lands and settles it.
      link.next("hold");
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toMatchObject({ ok: false, error: "host_timeout" });
      expect(existsSync(profile)).toBe(true);
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(await archivesOf(profile)).toHaveLength(1);
      // The next Run starts in the same directory; then the original request arrives.
      await seedProfile(host, AGENT, "A's new run", "workspace", WORKSPACE);
      expect(await link.release()).toEqual([{ ok: true, branch: null, commit: null, error: null }]);
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's new run");
      expect(await archivesOf(profile)).toHaveLength(1);
      const frames = link.sent.filter((item) => item.type === "execution_workspace_command:archive_profiles")
        .map((item) => (item.frame as unknown as { archive_identity: { operation_id: string; generation: number } }).archive_identity);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toEqual(frames[1]);
      expect(frames[0]!.operation_id).toMatch(new RegExp(`^archive:${closed.id}:`));
      // A lost reply is settled by the repeat the same way.
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(0);
      expect(await unfenced(closed.id)).toBe(false);
    } finally { link.restore(); }
  });

  it("an isolated-workspace profile archive on a Host that cannot journal it keeps the launch refused after it is acknowledged, until the Host is upgraded", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await db.pool.query(`UPDATE hosts SET capabilities_json = capabilities_json - 'workspace_profile_operations' WHERE id = $1`, [HOST]);
    const profile = await isolatedThread(host);
    const link = connectManagedHost(host);
    try {
      const closed = await leave(AGENT, false);
      await joinConversation(AGENT, "location");
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      // Recovery still delivers it (legacy, no identity): the first copy is held, the second lands.
      link.next("hold");
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(await pendingArchive(closed.id)).toBe(true);
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(existsSync(profile)).toBe(false);
      expect(link.sent.at(-1)!.frame).not.toHaveProperty("archive_identity");
      // Acknowledged, but the held copy may still land: no launch on this Host as it is.
      expect(await unfenced(closed.id)).toBe(true);
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      await link.release();
      // Reporting the fence proves nothing about copies the same process may still run: still refused.
      await db.pool.query(`UPDATE hosts SET capabilities_json = capabilities_json || '{"workspace_profile_operations":1}'::jsonb WHERE id = $1`, [HOST]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      expect(link.drains).toEqual([]);
      // A Host that drains them answers once none is running; only then is the profile released.
      await db.pool.query(`UPDATE hosts SET capabilities_json = capabilities_json || '{"legacy_archive_drain":1}'::jsonb WHERE id = $1`, [HOST]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(link.drains).toEqual([{ ok: true, changed: false, error: null }]);
      expect(await unfenced(closed.id)).toBe(false);
    } finally { link.restore(); }
  });

  it("on a Host without the journal, a recovered legacy archive does not release the launch while an earlier copy may be in flight", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const profile = await seedProfile(host, AGENT, "what A learned before");
    const link = connectManagedHost(host);
    try {
      // The after-commit legacy archive times out in flight.
      link.next("hold");
      const closed = await leave(AGENT);
      await joinConversation(AGENT);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      expect(existsSync(profile)).toBe(true);
      // The recovery pass sends another legacy archive; it lands and is acknowledged.
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(archiveFrames(link.sent, AGENT).every((frame) => frame.operation_id === undefined)).toBe(true);
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(existsSync(profile)).toBe(false);
      // That acknowledgement says nothing of the copy still in flight: the launch stays refused.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      // The shared cwd's barrier too: an identity-less copy's cwd scope is not bound to its intent's.
      expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      // Were a Run allowed now, the late copy would take its profile: shown on a profile seeded here.
      await seedProfile(host, AGENT, "a Run that should not have started");
      await link.release();
      expect(existsSync(profile)).toBe(false);
      // Reporting the journal is no proof that no old copy still runs: still refused.
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1}'::jsonb WHERE id = $1`, [HOST]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
      await db.pool.query(`UPDATE hosts SET capabilities_json = '{"managed_workspace_operations":1,"legacy_archive_drain":1}'::jsonb WHERE id = $1`, [HOST]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(await unfenced(closed.id)).toBe(false);
    } finally { link.restore(); }
  });
});

describe("an identity-less archive the same daemon still runs when the control plane is upgraded", () => {
  const ALL = '{"managed_workspace_operations":1,"workspace_profile_operations":1,"legacy_archive_drain":1,"execution_workspaces":{"version":2}}';
  /** The control plane before this release sends identity-less archives; then it is upgraded and the same daemon process reconnects, reporting everything. */
  const oldControlPlane = () => db.pool.query(`UPDATE hosts SET capabilities_json = '{"execution_workspaces":{"version":2}}'::jsonb WHERE id = $1`, [HOST]);
  const upgradedControlPlane = () => db.pool.query(`UPDATE hosts SET capabilities_json = $2::jsonb WHERE id = $1`, [HOST, ALL]);
  const unfenced = async (threadId: string) => (await db.pool.query<{ unfenced: boolean }>(
    `SELECT archive_unfenced_at IS NOT NULL AS unfenced FROM host_threads WHERE id = $1`, [threadId])).rows[0]!.unfenced;
  const legacyArchive = (host: ManagedDaemon, frame: Partial<ManagedFrame> = {}) => host.executeManagedWorkspaceOperation({
    action: "archive", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION, include_workspace: false, ...frame });
  const timedOut = { ok: false, changed: false, error: "host_timeout" };
  const workspaceProfile = { agent_id: AGENT, container_kind: "workspace", container_id: WORKSPACE };

  it("managed profile: the launch waits for the old request the daemon is still running, released after the attempt; later ones are refused", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await oldControlPlane();
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const profile = await seedProfile(host, AGENT, "what A learned before");
    const link = connectManagedHost(host);
    try {
      // The archive lands and is acknowledged; a duplicate the daemon admitted after it is still running.
      link.next("ack_after_duplicate");
      const closed = await leave(AGENT);
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(await unfenced(closed.id)).toBe(true);
      expect(existsSync(profile)).toBe(false);
      await upgradedControlPlane();
      await joinConversation(AGENT);
      // The capability and the reconnect are no proof: the daemon's drain waits for that duplicate, so no launch.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual(timedOut);
      expect(await unfenced(closed.id)).toBe(true);
      // Had the launch gone ahead, its Run would now be using the profile: the duplicate finishes after the attempt.
      const live = await seedProfile(host, AGENT, "a Run that did not start");
      expect(await link.releaseInFlight()).toEqual([{ ok: true, changed: true, error: null }]);
      expect(existsSync(live)).toBe(false);
      // Drained: the barrier releases the profile, and the next Run starts in it.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      expect(link.drains.map((answer) => answer.ok)).toEqual([false, true]);
      expect(await unfenced(closed.id)).toBe(false);
      await seedProfile(host, AGENT, "A's new run");
      // Any later identity-less copy — on this process or a restarted one — moves nothing.
      expect(await legacyArchive(host)).toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await legacyArchive(await loadManagedDaemon())).toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's new run");
    } finally { link.restore(); }
  });

  it("managed cwd: another Agent's Run waits for an old cwd archive still running, whatever scope its intent recorded", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await oldControlPlane();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      link.next("ack_after_duplicate");
      const closed = await leave(AGENT);
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      // Even an intent confirmed profile-only: a legacy copy chose its cwd scope per send.
      await db.pool.query(`UPDATE host_threads SET archive_include_workspace = false, archive_scope_confirmed = true WHERE id = $1`, [closed.id]);
      await upgradedControlPlane();
      await joinConversation(OTHER_AGENT);
      expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual(timedOut);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "b.md"), "B's work, had it started");
      expect(await link.releaseInFlight()).toEqual([{ ok: true, changed: true, error: null }]);
      expect(existsSync(workspace)).toBe(false);
      expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
      expect(await unfenced(closed.id)).toBe(false);
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "b.md"), "B's work");
      expect(await legacyArchive(host, { include_workspace: true })).toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await readFile(join(workspace, "b.md"), "utf8")).toBe("B's work");
    } finally { link.restore(); }
  });

  it("isolated workspace: a legacy archive_profiles still running holds the workspace profile's launch until drained", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await oldControlPlane();
    const first = await joinConversation(AGENT, "location");
    await db.pool.query(`INSERT INTO execution_workspaces (id, space_id, project_id, workspace_location_id, execution_host_id, owner_kind, session_id)
       VALUES ($1, $2, $3, $4, $5, 'conversation', $6)`, [WORKSPACE, SPACE, PROJECT, LOCATION, HOST, CONVERSATION]);
    await db.pool.query(`UPDATE host_threads SET execution_workspace_json = $2::jsonb WHERE id = $1`,
      [first.id, JSON.stringify({ id: WORKSPACE, generation: 1, profile_container_id: WORKSPACE })]);
    const profile = await seedProfile(host, AGENT, "A's isolated run", "workspace", WORKSPACE);
    const link = connectManagedHost(host);
    try {
      const closed = await leave(AGENT, false);
      link.next("ack_after_duplicate");
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(await pendingArchive(closed.id)).toBe(false);
      expect(link.sent.at(-1)!.frame).not.toHaveProperty("archive_identity");
      await upgradedControlPlane();
      await joinConversation(AGENT, "location");
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual(timedOut);
      const live = await seedProfile(host, AGENT, "a Run that did not start", "workspace", WORKSPACE);
      expect(await link.releaseInFlight()).toEqual([{ ok: true, branch: null, commit: null, error: null }]);
      expect(existsSync(live)).toBe(false);
      expect(await settleLaunchProfileArchives(db.pool, HOST, workspaceProfile)).toEqual({ ok: true, changed: false, error: null });
      await seedProfile(host, AGENT, "A's new run", "workspace", WORKSPACE);
      expect(await host.executeWorkspaceCommand(null, { workspace: { workspace_location_id: LOCATION, execution_workspace: { id: WORKSPACE, generation: 1 } },
        action: "archive_profiles", operation_id: randomUUID(), profile_agents: [AGENT], retain_branch: true }))
        .toMatchObject({ ok: false, error_code: "legacy_closed" });
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's new run");
    } finally { link.restore(); }
  });

  it("workspace cleanup: a profile archive sent unfenced and not done keeps the launch waiting; done, it is released only by the drain", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await upgradedControlPlane();
    await db.pool.query(`INSERT INTO execution_workspaces (id, space_id, project_id, workspace_location_id, execution_host_id, owner_kind, session_id)
       VALUES ($1, $2, $3, $4, $5, 'conversation', $6)`, [WORKSPACE, SPACE, PROJECT, LOCATION, HOST, CONVERSATION]);
    const resource = (state: string) => JSON.stringify({ legacy: { kind: "legacy_profiles", legacy_agent_id: AGENT, legacy_container_id: CONVERSATION,
      version: 1, operation_id: randomUUID(), state, attempts: 1, sent_unfenced: true } });
    await db.pool.query(`UPDATE execution_workspaces SET cleanup_json = $2::jsonb WHERE id = $1`, [WORKSPACE, resource("retry_wait")]);
    const profile = await seedProfile(host, AGENT, "the cutover's legacy profile");
    const link = connectManagedHost(host);
    try {
      // The Job still owes it: a fencing, draining Host is no reason to start in that profile now.
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: false, changed: false, error: "workspace_cleanup_profile_archive_unconfirmed" });
      // The Job's earlier identity-less send is still running on the daemon; the Job then records the resource done.
      let finish = () => {};
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const running = host.executeManagedWorkspaceOperation({ action: "archive", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION, include_workspace: false },
        { beforeLegacyMove: () => gate });
      await db.pool.query(`UPDATE execution_workspaces SET cleanup_json = $2::jsonb WHERE id = $1`, [WORKSPACE, resource("cleaned")]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual(timedOut);
      finish();
      expect(await running).toEqual({ ok: true, changed: true, error: null });
      expect(existsSync(profile)).toBe(false);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: true, changed: false, error: null });
      const flag = (await db.pool.query<{ flag: boolean }>(`SELECT (cleanup_json->'legacy'->>'sent_unfenced')::boolean AS flag FROM execution_workspaces WHERE id = $1`, [WORKSPACE])).rows[0]!.flag;
      expect(flag).toBe(false);
      // On a Host that cannot drain, such a resource keeps the launch refused.
      await db.pool.query(`UPDATE execution_workspaces SET cleanup_json = $2::jsonb WHERE id = $1`, [WORKSPACE, resource("cleaned")]);
      await db.pool.query(`UPDATE hosts SET capabilities_json = capabilities_json - 'legacy_archive_drain' WHERE id = $1`, [HOST]);
      expect(await settleLaunchProfileArchives(db.pool, HOST, conversationProfile)).toEqual({ ok: false, changed: false, error: HOST_UPDATE_REQUIRED });
    } finally { link.restore(); }
  });
});

describe("a Run's dispatch", () => {
  it("settles the Agent's owed profile archive before the launch frame, and launches nothing while it is unconfirmed", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    await joinConversation(AGENT, "location");
    await joinConversation(OTHER_AGENT, "location");
    const profile = await seedProfile(host, AGENT, "what A learned before");
    const registry = new HostConnectionRegistry();
    const order: string[] = [];
    let crash = true;
    registry.registerConnection(HOST, {
      send(frame) {
        const f = frame as unknown as Record<string, unknown>;
        order.push(String(f.type));
        if (f.type === "managed_workspace_archive") {
          const kill = crash; crash = false;
          void host.executeManagedWorkspaceOperation({ ...(f as unknown as ManagedFrame), action: "archive" },
            kill ? { afterMove: () => { throw new Error("daemon killed"); } } : undefined)
            .then((result) => registry.receiveManagedWorkspaceResult(HOST, String(f.request_id), result));
        }
        if (f.type === "launch") {
          queueMicrotask(() => registry.receiveComplete(HOST, String(f.run_id), { exit_code: 1, timed_out: false, error: "stopped after launch" }, String(f.launch_id)));
        }
      },
      close() {},
    });
    await db.pool.query(`UPDATE room_agent_members SET status = 'removed' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
    const [closed] = await threads().closeConversationAgentForRoom(SPACE, roomId, AGENT);
    const readded = await joinConversation(AGENT, "location");
    const dispatch = () => executeRemoteHostCliAdapter({
      run: {
        id: randomUUID(), space_id: SPACE, agent_id: AGENT, agent_version_id: VERSION, execution_kind: "agent", status: "queued", mode: "live",
        prompt: "continue", instruction: null, project_folder_id: null, session_id: CONVERSATION, project_id: PROJECT, runtime_key: "opencode",
        model_provider_id: null, required_sandbox_level: "none", trigger_origin: "manual", instructed_by_user_id: OWNER, owner_user_id: OWNER,
        started_at: null, ended_at: null, host_task_thread_id: readded.id,
      } as unknown as AgentRunRecord,
      prompt: "continue", model: null, resume_session_id: null,
    }, HOST, null, {
      db: db.pool, connectionRegistry: registry,
      bindings: { ...NO_PROVIDER_BINDINGS, profileScope: (run, location) => resolveRuntimeProfileScope(db.pool, run, location) },
    });
    // The daemon moves the profile and dies before recording it: the Run fails before any launch.
    await expect(dispatch()).resolves.toMatchObject({ success: false, error_code: "runtime_profile_archive_unsettled" });
    expect(order).toEqual(["managed_workspace_archive"]);
    expect(await pendingArchive(closed!.id)).toBe(true);
    // The next turn repeats the same operation, which the journal finishes from the filesystem; then it launches.
    await dispatch();
    expect(order).toEqual(["managed_workspace_archive", "managed_workspace_archive", "launch"]);
    expect(await pendingArchive(closed!.id)).toBe(false);
    expect(await archivesOf(profile)).toHaveLength(1);
  });
});

describe("an archive intent from before its cwd scope was recorded", () => {
  /**
   * The schema those intents lived in: neither scope column. The migrations
   * that add them run verbatim from their files against the rows as they are.
   */
  async function upgradeFromPreScopeSchema() {
    await db.pool.query(`ALTER TABLE host_threads DROP COLUMN archive_scope_confirmed, DROP COLUMN archive_include_workspace`);
    // The formal migration preserves each original file and its search-path boundary.
    // Replay only the two scope upgrades against the pre-scope rows under test.
    const formal = await readFile(fileURLToPath(new URL("../migrations/0018_workspace_operation_core.sql", import.meta.url)), "utf8");
    const upgrades = formal.split("\n\nRESET search_path;\n").filter(sql =>
      /ADD COLUMN "archive_(include_workspace|scope_confirmed)"/.test(sql));
    expect(upgrades).toHaveLength(2);
    for (const sql of upgrades) {
      for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.pool.query(statement);
    }
  }
  /** What the earlier release sent: the same identity, the cwd scope as membership said at that send. */
  async function earlierSend(host: ManagedDaemon, threadId: string, includeWorkspace: boolean, hooks?: { afterMove?: (stage: string) => void }) {
    const generation = Number((await db.pool.query<{ g: string }>(`SELECT archive_generation AS g FROM host_threads WHERE id = $1`, [threadId])).rows[0]!.g);
    return host.executeManagedWorkspaceOperation({
      action: "archive", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION,
      include_workspace: includeWorkspace, operation_id: `archive:${threadId}:${generation}`, generation,
    }, hooks);
  }

  it("profile-only on the Host, inferred as a cwd archive after the last Agent left (false, then true): the receipt is the operation", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const otherProfile = await seedProfile(host, OTHER_AGENT, "B's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      // The earlier release's send reached the Host profile-only; its reply was lost.
      expect(await earlierSend(host, a.id, false)).toEqual({ ok: true, changed: true, error: null });
      const b = await leave(OTHER_AGENT, false);
      await upgradeFromPreScopeSchema();
      expect(await scope(a.id)).toEqual({ include: true, confirmed: false });
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      // Inferred true, refused as a mismatch, repeated as the Host holds it: replayed, nothing moved twice.
      expect(archiveFrames(link.sent, AGENT).map((frame) => frame.include_workspace)).toEqual([true, false]);
      expect(new Set(archiveFrames(link.sent, AGENT).map((frame) => frame.operation_id)).size).toBe(1);
      expect(await scope(a.id)).toEqual({ include: false, confirmed: true });
      expect(await pendingArchive(a.id)).toBe(false);
      // B was the last out: B's own archive takes the cwd, once.
      expect(archiveFrames(link.sent, OTHER_AGENT).map((frame) => frame.include_workspace)).toEqual([true]);
      expect(await pendingArchive(b.id)).toBe(false);
      expect(existsSync(workspace)).toBe(false);
      expect(await archivesOf(workspace)).toHaveLength(1);
      expect(await archivesOf(profile)).toHaveLength(1);
      expect(await archivesOf(otherProfile)).toHaveLength(1);
      expect(await archiveTookConversationCwd(db.pool, a.id)).toBe(false);
    } finally { link.restore(); }
  });

  it("a cwd archive on the Host, inferred profile-only after another Agent joined (true, then false): settled as it is before that Agent's Run", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      // A was last out: the earlier release sent a cwd archive. It crashed after the profile, before the cwd.
      await expect(earlierSend(host, a.id, true, { afterMove: (stage) => { if (stage === "profile") throw new Error("daemon killed"); } }))
        .resolves.toMatchObject({ ok: false, error_code: "io_error" });
      expect(existsSync(profile)).toBe(false);
      expect(existsSync(workspace)).toBe(true);
      // B joined before the upgrade; the migration infers A's scope from that.
      await joinConversation(OTHER_AGENT);
      await upgradeFromPreScopeSchema();
      expect(await scope(a.id)).toEqual({ include: false, confirmed: false });
      // B's first Run: the unconfirmed intent is settled first, as the Host holds it — the cwd move finishes before B starts.
      expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
      expect(archiveFrames(link.sent, AGENT).map((frame) => frame.include_workspace)).toEqual([false, true]);
      expect(await scope(a.id)).toEqual({ include: true, confirmed: true });
      expect(await archiveTookConversationCwd(db.pool, a.id)).toBe(true);
      expect(existsSync(workspace)).toBe(false);
      expect(await archivesOf(workspace)).toHaveLength(1);
      expect(await archivesOf(profile)).toHaveLength(1);
      // B works in a fresh cwd. Any later copy of either value replays or is refused; B's cwd stays.
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "b.md"), "B's work");
      expect(await earlierSend(host, a.id, true)).toMatchObject({ ok: true });
      expect(await earlierSend(host, a.id, false)).toMatchObject({ ok: false, error_code: "operation_mismatch" });
      expect(await readFile(join(workspace, "b.md"), "utf8")).toBe("B's work");
      expect(await settleConversationCwdArchives(db.pool, { hostId: HOST, conversationId: CONVERSATION })).toEqual({ ok: true, changed: false, error: null });
      expect(archiveFrames(link.sent, AGENT)).toHaveLength(2);
    } finally { link.restore(); }
  });

  it("a restore after it takes its cwd scope from what the Host confirms that archive did, not from the inference", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      // Last out: the earlier release's cwd archive ran; its reply was lost. Then B joined (no Run yet).
      expect(await earlierSend(host, a.id, true)).toMatchObject({ ok: true, changed: true });
      await joinConversation(OTHER_AGENT);
      await upgradeFromPreScopeSchema();
      expect(await scope(a.id)).toEqual({ include: false, confirmed: false });
      // A is re-added with restore, before any heartbeat reported the cwd archive.
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`UPDATE room_agent_members SET status = 'active' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
        const target = await findManagedWorkspaceRestoreTarget(client, SPACE, AGENT, roomId, OWNER);
        expect(target?.includeWorkspace).toBe(false);
        await enqueueRoomAgentWorkspaceRestore(client, { spaceId: SPACE, userId: OWNER, roomId, target: target! });
        await client.query("COMMIT");
      } finally { client.release(); }
      const job = (await db.pool.query<{ id: string; user_id: string; payload_json: Record<string, unknown> }>(
        `SELECT id, user_id, payload_json FROM jobs WHERE job_type = $1`, [ROOM_AGENT_WORKSPACE_RESTORE_JOB])).rows[0]!;
      expect(job.payload_json).toMatchObject({ include_workspace: false, include_workspace_after_archive: true });
      expect(await processRoomAgentWorkspaceRestore(db.pool, { job_id: job.id, space_id: SPACE, user_id: job.user_id, attempts: 1, payload: job.payload_json }))
        .toEqual({ outcome: "restored" });
      // The archive settled as the Host held it (a cwd archive), so the restore brings the cwd back with the profile.
      expect(archiveFrames(link.sent, AGENT).map((frame) => frame.include_workspace)).toEqual([false, true]);
      const restore = link.sent.find((item) => item.type === "managed_workspace_restore")!.frame;
      expect(restore.include_workspace).toBe(true);
      expect((await db.pool.query(`SELECT payload_json FROM jobs WHERE id = $1`, [job.id])).rows[0].payload_json)
        .toMatchObject({ include_workspace: true, include_workspace_resolved: true, operation_id: restore.operation_id, generation: restore.generation });
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's memory");
    } finally { link.restore(); }
  });

  /**
   * A restore Job the earlier release queued: identity and generation fixed, its cwd scope taken from the
   * inference then, no marker. Its operation already reached the Host with that scope (reply lost).
   */
  async function earlierRestoreJob(host: ManagedDaemon, threadId: string, includeWorkspace: boolean) {
    const generation = Number((await db.pool.query<{ g: string }>(`SELECT nextval('managed_workspace_generation_seq') AS g`)).rows[0]!.g);
    const operationId = `restore:${randomUUID()}`;
    await db.pool.query(`UPDATE room_agent_members SET status = 'active' WHERE room_id = $1 AND agent_id = $2`, [roomId, AGENT]);
    // Enqueued exactly as that release did: its payload, no marker, through the real queue.
    const job = await new PgJobQueueRepository(db.pool).enqueue({
      job_type: ROOM_AGENT_WORKSPACE_RESTORE_JOB, space_id: SPACE, user_id: OWNER, agent_id: AGENT, max_attempts: 5,
      payload: {
        room_id: roomId, thread_id: threadId, host_id: HOST, agent_id: AGENT, conversation_id: CONVERSATION,
        include_workspace: includeWorkspace, requested_at: new Date().toISOString(), operation_id: operationId, generation,
      },
    });
    return { jobId: job.id, operationId, generation };
  }
  const runJob = async (jobId: string) => {
    const job = (await db.pool.query<{ payload_json: Record<string, unknown> }>(`SELECT payload_json FROM jobs WHERE id = $1`, [jobId])).rows[0]!;
    return processRoomAgentWorkspaceRestore(db.pool, { job_id: jobId, space_id: SPACE, user_id: OWNER, attempts: 1, payload: job.payload_json });
  };
  const restoreFrames = (sent: Array<{ type: string; frame: ManagedFrame }>) =>
    sent.filter((item) => item.type === "managed_workspace_restore").map((item) => item.frame);

  it("an earlier release's restore Job without the cwd (false) after an archive the Host confirms took it: its operation stays, the cwd follows", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      expect(await earlierSend(host, a.id, true)).toMatchObject({ ok: true, changed: true });
      await joinConversation(OTHER_AGENT);
      await upgradeFromPreScopeSchema();
      const old = await earlierRestoreJob(host, a.id, false);
      // That operation already reached the Host as profile-only; its parameters cannot change now.
      expect(await host.executeManagedWorkspaceOperation({ action: "restore", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION,
        include_workspace: false, operation_id: old.operationId, generation: old.generation })).toMatchObject({ ok: true, changed: true });
      expect(existsSync(workspace)).toBe(false);
      expect(await runJob(old.jobId)).toEqual({ outcome: "restored" });
      const [main, followUp] = restoreFrames(link.sent);
      expect(main).toMatchObject({ operation_id: old.operationId, generation: old.generation, include_workspace: false });
      expect(followUp!.include_workspace).toBe(true);
      expect(followUp!.operation_id).not.toBe(old.operationId);
      expect(followUp!.generation!).toBeGreaterThan(old.generation);
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's memory");
      // A retry is the same two operations, replayed.
      expect(await runJob(old.jobId)).toEqual({ outcome: "restored" });
      expect(restoreFrames(link.sent).slice(2)).toEqual([main, followUp]);
    } finally { link.restore(); }
  });

  it("an earlier release's profile-only restore Job after a cwd archive, when another Agent rebuilt the shared cwd: partial, never reported restored", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      expect(await earlierSend(host, a.id, true)).toMatchObject({ ok: true, changed: true });
      await joinConversation(OTHER_AGENT);
      await upgradeFromPreScopeSchema();
      const old = await earlierRestoreJob(host, a.id, false);
      // B's Run created the shared cwd again before the Job ran.
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "b.md"), "B's work");
      expect(await runJob(old.jobId)).toEqual({ outcome: "partially_restored", error: "live_conflict" });
      const [main, followUp] = restoreFrames(link.sent);
      expect(main).toMatchObject({ operation_id: old.operationId, include_workspace: false });
      expect(followUp).toMatchObject({ include_workspace: true });
      // The profile came back; B's cwd was left as it is; A's earlier cwd is still in the Host's archive.
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's memory");
      expect(await readFile(join(workspace, "b.md"), "utf8")).toBe("B's work");
      expect(existsSync(join(workspace, "notes.md"))).toBe(false);
      expect(await archivesOf(workspace)).toHaveLength(1);
      const told = async () => (await db.pool.query<{ content: string; details: Record<string, unknown> }>(
        `SELECT content, metadata_json->'execution_details' AS details FROM messages WHERE session_id = $1
            AND metadata_json->>'host_thread_event' = 'managed_workspace_restore_unavailable'`, [CONVERSATION])).rows;
      const notices = await told();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.details).toMatchObject({ error: "live_conflict", restored: "partial" });
      expect(notices[0]!.content).toMatch(/own host state was restored, but the conversation's earlier shared workspace was not/);
      // A retry replays both receipts and reaches the same outcome, told once.
      expect(await runJob(old.jobId)).toEqual({ outcome: "partially_restored", error: "live_conflict" });
      expect(await told()).toHaveLength(1);
      expect(await archivesOf(workspace)).toHaveLength(1);
    } finally { link.restore(); }
  });

  it("the same follow-up finding no earlier cwd left in the Host's archive is partial too, not restored on the profile's evidence", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      expect(await earlierSend(host, a.id, true)).toMatchObject({ ok: true, changed: true });
      await joinConversation(OTHER_AGENT);
      await upgradeFromPreScopeSchema();
      const old = await earlierRestoreJob(host, a.id, false);
      // The 30-day sweep removed the archived cwd.
      for (const name of await archivesOf(workspace)) await rm(join(dirname(workspace), name), { recursive: true, force: true });
      expect(await runJob(old.jobId)).toEqual({ outcome: "partially_restored", error: "workspace_archive_missing" });
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's memory");
      expect(existsSync(workspace)).toBe(false);
    } finally { link.restore(); }
  });

  it("an earlier release's restore Job with the cwd (true) after a profile-only archive, meeting a live cwd: the profile is still restored", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      const a = await leave(AGENT, false);
      expect(await earlierSend(host, a.id, false)).toMatchObject({ ok: true, changed: true });
      await upgradeFromPreScopeSchema();
      const old = await earlierRestoreJob(host, a.id, true);
      expect(await runJob(old.jobId)).toEqual({ outcome: "restored" });
      const [main, followUp] = restoreFrames(link.sent);
      expect(main).toMatchObject({ operation_id: old.operationId, generation: old.generation, include_workspace: true });
      expect(followUp).toMatchObject({ include_workspace: false });
      expect(followUp!.generation!).toBeGreaterThan(old.generation);
      expect(await scope(a.id)).toEqual({ include: false, confirmed: true });
      expect(await readFile(join(profile, "claude_code", "memory.md"), "utf8")).toBe("A's memory");
      expect(await readFile(join(workspace, "notes.md"), "utf8")).toBe("shared work");
      // The first operation's receipt stays what it was: a repeat of it is still the live-cwd refusal.
      expect(await host.executeManagedWorkspaceOperation({ action: "restore", agent_id: AGENT, container_kind: "conversation", container_id: CONVERSATION,
        include_workspace: true, operation_id: old.operationId, generation: old.generation })).toMatchObject({ ok: false, error_code: "live_conflict" });
    } finally { link.restore(); }
  });

  it("with no receipt on the Host, sends the inferred scope once and keeps it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const host = await loadManagedDaemon();
    const workspace = await seedWorkspace(host);
    await joinConversation(AGENT);
    await joinConversation(OTHER_AGENT);
    const profile = await seedProfile(host, AGENT, "A's memory");
    const link = connectManagedHost(host);
    try {
      // The earlier release's sends never reached the Host.
      const a = await leave(AGENT, false);
      const b = await leave(OTHER_AGENT, false);
      await upgradeFromPreScopeSchema();
      expect(await scope(a.id)).toEqual({ include: true, confirmed: false });
      expect(await scope(b.id)).toEqual({ include: true, confirmed: false });
      await age();
      await expect(retryPendingArchivesForConnectedHosts(db.pool)).resolves.toBe(1);
      expect(archiveFrames(link.sent, AGENT).map((frame) => frame.include_workspace)).toEqual([true]);
      expect(await scope(a.id)).toEqual({ include: true, confirmed: true });
      expect(await pendingArchive(a.id)).toBe(false);
      expect(await pendingArchive(b.id)).toBe(false);
      expect(await archivesOf(workspace)).toHaveLength(1);
      expect(await archivesOf(profile)).toHaveLength(1);
      // A late copy with the other value is a different request to the Host and moves nothing.
      expect(await earlierSend(host, a.id, false)).toMatchObject({ ok: false, error_code: "operation_mismatch" });
      expect(await archivesOf(workspace)).toHaveLength(1);
    } finally { link.restore(); }
  });
});
