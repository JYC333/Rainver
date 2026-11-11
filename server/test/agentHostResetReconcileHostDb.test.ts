import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostCommandHarness } from "./support/hostCommandHarness.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { sharedHostConnectionRegistry, type HostCommandAnswer } from "../src/modules/hosts/connectionRegistry.js";
import { agentHostResetFence } from "../src/modules/hosts/hostCommands.js";
import { hostCommandFingerprint, wakeHostCommandsForHost } from "../src/modules/hosts/hostCommandWorker.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";

/**
 * The reset fence is released only by proof (`agentHostResetFence`): the
 * Host's own receipt for the exact reset that was sent and never confirmed.
 * The daemon here is its real command journal (`hostCommandJournal.ts`) and
 * its real profile archive (`archiveAgentProfiles`) over a real directory,
 * behind the control plane's registry; the network faults are shaped where a
 * lost answer or a held frame would shape them. A later reset that fails —
 * never sent, refused, or answered after archiving only part — releases nothing.
 */
const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const AGENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VERSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";
const RECEIPTS = { host_command_receipts: 1 };

type Fault = "none" | "lost_ack" | "hold";
type Journal = {
  runJournaledHostCommand: (frame: unknown, execute: (inner: { type: string; request_id: string; agent_id: string }, sink: { send(frame: unknown): void }) => void, outer: { send(frame: unknown): void }) => Promise<{ outcome: HostCommandAnswer["outcome"]; replayed: boolean; result: Record<string, unknown> | null; error: string | null }>;
  hostCommandsDir: () => string;
  resetHostCommandJournalForTest: () => void;
};

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let commands: ReturnType<typeof hostCommandHarness>;
let stateDir = "";
let journal: Journal;
let archiveAgentProfiles: (agentId: string) => Promise<boolean>;
let faults: Fault[] = [];
let held: Array<() => Promise<unknown>> = [];
let delivered: string[] = [];

const fence = () => withQueryableTransaction(db.pool, (tx) => agentHostResetFence(tx, HOST, AGENT));
const intent = async (id: string) => (await db.pool.query<{ status: string; error_code: string | null; effect_json: Record<string, any>; created_at: string }>(
  "SELECT status, error_code, effect_json, created_at FROM host_command_intents WHERE id = $1", [id])).rows[0]!;
const admit = async () => {
  const accepted = await commands.submit(app!, { method: "POST", url: `/api/v1/agents/${AGENT}/host-state/reset`, payload: { host_id: HOST } });
  expect(accepted.statusCode, accepted.body).toBe(202);
  return accepted.json().data.id as string;
};
const cancelJob = (id: string) => db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE id = (SELECT job_id FROM host_command_intents WHERE id = $1)`, [id]);
const processAgain = async () => { await wakeHostCommandsForHost(db.pool, HOST); await commands.process(); };
const profilesRoot = () => join(stateDir, "agents", AGENT, "profiles");
async function profile(kind: string): Promise<string> {
  const path = join(profilesRoot(), kind, randomUUID());
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "session.json"), "{}");
  return path;
}
const live = (path: string) => stat(path).then(() => true, () => false);

/** The daemon's `agent_profiles_reset` dispatch (`commands/run.ts`), run on a journaled frame. */
function execute(inner: { type: string; request_id: string; agent_id: string }, sink: { send(frame: unknown): void }): void {
  if (inner.type !== "agent_profiles_reset") throw new Error(`unexpected ${inner.type}`);
  void archiveAgentProfiles(inner.agent_id).then(
    (changed) => sink.send({ type: "managed_workspace_result", request_id: inner.request_id, action: "reset", ok: true, changed, error: null }),
    (error: unknown) => sink.send({ type: "managed_workspace_result", request_id: inner.request_id, action: "reset", ok: false, changed: false, error: error instanceof Error ? error.message : String(error) }));
}
/** One delivery of a `host_command` frame to the daemon's journal, as the socket carries it. */
function deliver(frame: { command_id: string; fingerprint: string; command: Record<string, unknown> }) {
  const requestId = randomUUID();
  return journal.runJournaledHostCommand({ type: "host_command", request_id: requestId, ...frame, command: { ...frame.command, request_id: requestId } }, execute, { send() {} });
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "jobs", "runs", "host_threads", "workspace_locations", "project_folders", "agents", "agent_versions", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(`UPDATE agents SET owner_user_id = $2, visibility = 'private' WHERE id = $1`, [AGENT, OWNER]);
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`, [MACHINE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', $4::jsonb, $5, $5)`, [HOST, OWNER, MACHINE, JSON.stringify(RECEIPTS), now]);
  stateDir = await mkdtemp(join(tmpdir(), "rainver-reset-fence-"));
  process.env.RAINVER_HOST_CONFIG_DIR = stateDir;
  vi.resetModules();
  const source = (path: string) => fileURLToPath(new URL(`../../packages/host-daemon/src/${path}`, import.meta.url));
  journal = await import(source("hostCommandJournal.ts")) as Journal;
  ({ archiveAgentProfiles } = await import(source("managedWorkspaces.ts")) as { archiveAgentProfiles: typeof archiveAgentProfiles });
  journal.resetHostCommandJournalForTest();
  faults = []; held = []; delivered = [];
  vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(true);
  vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand").mockImplementation(async (_hostId, frame) => {
    delivered.push(frame.command_id);
    const fault = faults.shift() ?? "none";
    const lost: HostCommandAnswer = { sent: true, outcome: null, replayed: false, result: null, error: "host_timeout" };
    // Held by the network: it reaches the daemon only later, if ever.
    if (fault === "hold") { held.push(() => deliver(frame as never)); return lost; }
    const answer = await deliver(frame as never);
    // The daemon ran it and recorded its receipt; the answer never came back.
    if (fault === "lost_ack") return lost;
    return { sent: true, outcome: answer.outcome, replayed: answer.replayed, result: answer.result, error: answer.error };
  });
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
  if (stateDir) {
    await chmod(stateDir, 0o755).catch(() => undefined);
    for (const kind of await readdir(profilesRoot()).catch(() => [] as string[])) await chmod(join(profilesRoot(), kind), 0o755).catch(() => undefined);
    await rm(stateDir, { recursive: true, force: true });
  }
  delete process.env.RAINVER_HOST_CONFIG_DIR;
});

/** A reset the daemon ran whose answer was lost, and whose Job then stopped: sent, never confirmed. */
async function unconfirmedReset(fault: Fault = "lost_ack"): Promise<string> {
  const id = await admit();
  faults.push(fault);
  await commands.process();
  expect(await intent(id)).toMatchObject({ status: "dispatched", effect_json: { journaled: true, sends: 1 } });
  await cancelJob(id);
  expect((await fence())?.id).toBe(id);
  expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_job_cancelled" });
  return id;
}

describe("the Agent host-state reset fence", () => {
  it("is not released by later resets that were never sent, and is released by the earlier reset's own receipt", async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await profile("direct");
    const earlier = await unconfirmedReset("lost_ack");
    // The daemon did archive it; only its answer was lost.
    expect(await live(first)).toBe(false);

    // A later reset refused before anything left: the Host stopped reporting receipts.
    const unsent = await admit();
    await db.pool.query(`UPDATE hosts SET capabilities_json = '{}'::jsonb WHERE id = $1`, [HOST]);
    await commands.process();
    expect(await intent(unsent)).toMatchObject({ status: "failed", error_code: "host_update_required" });
    expect((await fence())?.id).toBe(earlier);
    // A later reset whose Job was cancelled before it ran.
    await db.pool.query(`UPDATE hosts SET capabilities_json = $2::jsonb WHERE id = $1`, [HOST, JSON.stringify(RECEIPTS)]);
    const cancelled = await admit();
    await cancelJob(cancelled);
    expect((await commands.status(app!, HOST, cancelled)).json()).toMatchObject({ status: "failed", error: { code: "host_command_job_cancelled" } });
    expect((await fence())?.id).toBe(earlier);
    expect(delivered).toEqual([earlier]);

    // The next reset re-delivers the earlier command's exact identity first: its receipt replays.
    const next = await admit();
    await commands.process();
    expect(delivered).toEqual([earlier, earlier, next]);
    expect(await intent(next)).toMatchObject({ status: "succeeded" });
    expect((await intent(earlier)).effect_json.receipt).toMatchObject({ by: next, replayed: true });
    expect(await intent(earlier)).toMatchObject({ status: "needs_attention" });
    expect(await fence()).toBeNull();

    // A late copy of the earlier frame only replays: a profile made since stays live.
    const since = await profile("direct");
    const command = { type: "agent_profiles_reset" as const, agent_id: AGENT };
    const late = await deliver({ command_id: earlier, fingerprint: hostCommandFingerprint(command), command });
    expect(late).toMatchObject({ outcome: "completed", replayed: true });
    expect(await live(since)).toBe(true);
  });

  it("finishes a held reset the Host never received under its own identity before a new reset is sent", async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await profile("conversation");
    const earlier = await unconfirmedReset("hold");
    // Held by the network: nothing ran yet.
    expect(await live(first)).toBe(true);
    // The Host is offline when the next reset runs: neither frame leaves, and the fence holds.
    const next = await admit();
    vi.mocked(sharedHostConnectionRegistry.requestHostCommand).mockImplementationOnce(async () => ({ sent: false, outcome: null, replayed: false, result: null, error: "host_offline" }));
    await commands.process();
    expect(await intent(next)).toMatchObject({ status: "pending", effect_json: { sends: 0 } });
    // Held twice over: by the new reset, still active, and by the earlier one nobody has proven.
    expect((await fence())?.id).toBe(next);
    expect((await intent(earlier)).effect_json.receipt).toBeUndefined();
    await processAgain();
    // The earlier reset ran now, under its own id, and its receipt is the proof.
    expect(delivered.slice(-2)).toEqual([earlier, next]);
    expect(await live(first)).toBe(false);
    expect((await intent(earlier)).effect_json.receipt).toMatchObject({ by: next, replayed: false });
    expect(await intent(next)).toMatchObject({ status: "succeeded" });
    expect(await fence()).toBeNull();
    // The frame the network held arrives at last: it replays and archives nothing new.
    const since = await profile("conversation");
    expect(await Promise.all(held.splice(0).map((run) => run()))).toEqual([expect.objectContaining({ outcome: "completed", replayed: true })]);
    expect(await live(since)).toBe(true);
  });

  it("keeps the fence when the Host cannot produce the earlier receipt, and sends nothing of the new reset", async (ctx) => {
    if (!db.available) return ctx.skip();
    const earlier = await unconfirmedReset("lost_ack");
    const since = await profile("direct");
    // The daemon's journal entry for the earlier command is unreadable.
    await writeFile(join(journal.hostCommandsDir(), `${createHash("sha256").update(earlier).digest("hex")}.json`), "{torn");
    const next = await admit();
    await commands.process();
    expect(await intent(next)).toMatchObject({ status: "failed", error_code: "host_reset_unreconciled" });
    expect((await intent(next)).effect_json.dispatched_at).toBeUndefined();
    expect(delivered).toEqual([earlier, earlier]);
    expect(await live(since)).toBe(true);
    expect((await fence())?.id).toBe(earlier);
  });

  it("does not treat a later reset that archived part of the profiles and then failed as proof", async (ctx) => {
    if (!db.available) return ctx.skip();
    const earlier = await unconfirmedReset("lost_ack");
    // A later reset recorded as failed after it was sent and answered (the daemon moved one profile,
    // then could not move the next), with the earlier one never re-delivered: it proves nothing.
    const later = randomUUID();
    await db.pool.query(
      `INSERT INTO host_command_intents (id, space_id, host_id, user_id, agent_id, kind, scope_key, status, job_id, frozen_json, effect_json, error_code, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'agent_host_state_reset', 'crafted', 'failed', NULL, '{}'::jsonb, $6::jsonb, 'host_command_failed', now(), now())`,
      [later, SPACE, HOST, OWNER, AGENT, JSON.stringify({ dispatched_at: new Date().toISOString(), journaled: true, sends: 1, error_detail: "EACCES" })]);
    expect((await fence())?.id).toBe(earlier);
    // Nor does a later success that never read the earlier command's receipt.
    await db.pool.query(`UPDATE host_command_intents SET status = 'succeeded', error_code = NULL WHERE id = $1`, [later]);
    expect((await fence())?.id).toBe(earlier);
  });

  it("records a real partial archive as failed after the earlier receipt was read, with the Host's error", async (ctx) => {
    if (!db.available) return ctx.skip();
    const earlier = await unconfirmedReset("lost_ack");
    const kept = [await profile("conversation"), await profile("direct")];
    // The daemon walks the kinds in directory order: the second one cannot be renamed into.
    const order = await readdir(profilesRoot());
    await chmod(join(profilesRoot(), order[1]!), 0o555);
    const next = await admit();
    await commands.process();
    const settled = await intent(next);
    expect(settled).toMatchObject({ status: "failed", error_code: "host_command_failed" });
    expect(String(settled.effect_json.error_detail)).toMatch(/EACCES|permission/i);
    const moved = await Promise.all(kept.map(live));
    expect(moved.filter((isLive) => !isLive)).toHaveLength(1);
    // The earlier reset is proven by its own replayed receipt, not by this failure.
    expect((await intent(earlier)).effect_json.receipt).toMatchObject({ by: next, replayed: true });
    expect(await fence()).toBeNull();
    expect((await commands.status(app!, HOST, next)).json()).toMatchObject({ status: "failed", result: null });
  });

  it("keeps the fence while the Host cannot make its receipt durable, and a late copy after the restart that finished it only replays", async (ctx) => {
    if (!db.available) return ctx.skip();
    const source = (path: string) => fileURLToPath(new URL(`../../packages/host-daemon/src/${path}`, import.meta.url));
    const durable = await import(source("durableFile.ts")) as { setDurableIoForTest: (io: { syncFile?: (handle: { sync(): Promise<void> }, path: string) => Promise<void> }) => () => void };
    // Real filesystem, except that every fsync of a receipt after the first (the `in_progress`
    // record before the effect) fails: the `done` record never becomes durable in this process.
    let receiptSyncs = 0;
    const restoreIo = durable.setDurableIoForTest({ async syncFile(handle, path) {
      if (path.includes(`${journal.hostCommandsDir()}/`) && ++receiptSyncs > 1) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      await handle.sync();
    } });
    const first = await profile("direct");
    const id = await admit();
    await commands.process();
    restoreIo();
    // The daemon archived the profile but holds no durable receipt: no proof, the fence stays.
    expect(await live(first)).toBe(false);
    expect(await intent(id)).toMatchObject({ status: "dispatched", effect_json: { journaled: true, sends: 1 } });
    expect((await intent(id)).effect_json.receipt).toBeUndefined();
    expect((await fence())?.id).toBe(id);

    // The daemon restarts before it records the outcome: the receipt on disk is only `in_progress`.
    vi.resetModules();
    journal = await import(source("hostCommandJournal.ts")) as Journal;
    ({ archiveAgentProfiles } = await import(source("managedWorkspaces.ts")) as { archiveAgentProfiles: typeof archiveAgentProfiles });
    journal.resetHostCommandJournalForTest();
    await processAgain();
    // The repeat finished it under the fence (it moves only what is still there) and its receipt
    // is durable now: the command's own proof releases the fence.
    expect(delivered).toEqual([id, id]);
    expect(await intent(id)).toMatchObject({ status: "succeeded", effect_json: { receipt: { by: id, replayed: true } } });
    expect(await fence()).toBeNull();

    // A Run launched since keeps its profile when a late copy of the reset arrives.
    const since = await profile("direct");
    const command = { type: "agent_profiles_reset" as const, agent_id: AGENT };
    const late = await deliver({ command_id: id, fingerprint: hostCommandFingerprint(command), command });
    expect(late).toMatchObject({ outcome: "completed", replayed: true });
    expect(await live(since)).toBe(true);
  });
});
