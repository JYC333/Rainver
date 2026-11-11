import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostCommandHarness } from "./support/hostCommandHarness.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { sharedHostConnectionRegistry, type HostCommandAnswer } from "../src/modules/hosts/connectionRegistry.js";
import { wakeHostCommandsForHost } from "../src/modules/hosts/hostCommandWorker.js";

/**
 * The Host command worker's fault matrix (`hostCommandWorker.ts`): every
 * path where the Host may or may not have acted, through real admission over
 * HTTP, the real Job worker and the owner-only status read. A command whose
 * outcome the control plane cannot prove is `needs_attention`, never
 * `succeeded`, and nothing is released to someone who lost the authority it
 * was admitted under. The Host is a spy on the shared registry.
 */
const SPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SPACE = "abababab-abab-4bab-8bab-abababababab";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROJECT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MACHINE = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";
const UNINSTALL = { method: "DELETE" as const, url: `/api/v1/hosts/${HOST}/installations/codex/managed:1.0.0` };
const REGISTER = (path = "/home/owner/private/repo") => ({ method: "POST" as const, url: `/api/v1/hosts/${HOST}/workspaces`, payload: { project_id: PROJECT, path, name: "Repo" } });

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let commands: ReturnType<typeof hostCommandHarness>;

const intent = async (id: string) => (await db.pool.query<{ status: string; error_code: string | null; effect_json: Record<string, unknown>; frozen_json: Record<string, unknown>; result_json: unknown }>(
  "SELECT status, error_code, effect_json, frozen_json, result_json FROM host_command_intents WHERE id = $1", [id])).rows[0]!;
const runtimeChanges = async () => (await db.pool.query("SELECT action, from_version FROM host_runtime_changes WHERE host_id = $1", [HOST])).rows;
async function admit(options: Parameters<typeof commands.submit>[1], key?: string): Promise<string> {
  const accepted = await commands.submit(app!, options, key);
  expect(accepted.statusCode, accepted.body).toBe(202);
  return accepted.json().data.id as string;
}
const status = async (id: string) => commands.status(app!, HOST, id);
const toolResult = (ok = true) => ({ type: "tool_result", request_id: "send", runtime_key: "codex", action: "uninstall_tool", ok, installation: null, error: ok ? null : "rm failed" });
const answer = (partial: Partial<HostCommandAnswer>): HostCommandAnswer => ({ sent: true, outcome: null, replayed: false, result: null, error: null, ...partial });
async function processAgain(): Promise<void> {
  await wakeHostCommandsForHost(db.pool, HOST);
  await commands.process();
}
async function setJournal(journaled: boolean): Promise<void> {
  await db.pool.query(`UPDATE hosts SET capabilities_json = $2::jsonb WHERE id = $1`, [HOST, JSON.stringify(journaled ? { host_command_receipts: 1 } : {})]);
}

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "host_runtime_changes", "jobs", "workspace_locations", "project_folders", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(`INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source) VALUES ($1, 'other@example.com', 'Other', 'active', $2, $2, 'system')`, [OTHER, now]);
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1, 'Elsewhere', 'team', $2, $2)`, [OTHER_SPACE, now]);
  for (const [space, user, role] of [[SPACE, OTHER, "member"], [OTHER_SPACE, OWNER, "owner"]] as const) {
    await db.pool.query(`INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'active', $5, $5)`, [randomUUID(), space, user, role, now]);
  }
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`, [MACHINE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, platform, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', 'linux', '{"host_command_receipts":1}'::jsonb, $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  app = buildModuleServer(config, [hostsModule]);
  commands = hostCommandHarness(db.pool, config);
  __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
  vi.spyOn(sharedHostConnectionRegistry, "isOnline").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setAuthIdentityForTests(null);
  await app?.close();
  app = undefined;
});

describe("Host command worker faults", () => {
  it("returns a send that never left to pending, then settles one effect and its exact result", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ sent: false, error: "host_offline" }))
      .mockResolvedValueOnce(answer({ outcome: "completed", result: toolResult() }));
    const id = await admit(UNINSTALL);
    await commands.process();
    expect(await intent(id)).toMatchObject({ status: "pending", effect_json: { sends: 0 } });
    expect((await intent(id)).effect_json.dispatched_at).toBeUndefined();
    await processAgain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toEqual(send.mock.calls[0]![1]);
    expect(send.mock.calls[0]![1]).toMatchObject({ command_id: id, command: { type: "uninstall_tool", runtime_key: "codex", version: "1.0.0" } });
    const read = await status(id);
    expect(read.json()).toMatchObject({ id, status: "succeeded", error: null,
      result: { host_id: HOST, runtime_key: "codex", ok: true, error: null, installation: null } });
    expect(await runtimeChanges()).toEqual([{ action: "remove", from_version: "1.0.0" }]);
  });

  it("sends an unjournaled command at most once: a lost answer is needs_attention and is never repeated", async (ctx) => {
    if (!db.available) return ctx.skip();
    await setJournal(false);
    const journaled = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    const bare = vi.spyOn(sharedHostConnectionRegistry, "requestToolAction").mockResolvedValue({ ok: false, error: "host_timeout" } as never);
    const id = await admit(UNINSTALL);
    await commands.process();
    expect(journaled).not.toHaveBeenCalled();
    expect(bare).toHaveBeenCalledTimes(1);
    expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_outcome_unknown", effect_json: { journaled: false, sends: 1 } });
    await processAgain();
    expect(bare).toHaveBeenCalledTimes(1);
    expect((await status(id)).json()).toMatchObject({ status: "needs_attention", result: null, error: { code: "host_command_outcome_unknown" } });
    expect(await runtimeChanges()).toEqual([]);
  });

  it("treats a process that died after recording the send, before it left, as unknown on an unjournaled Host", async (ctx) => {
    if (!db.available) return ctx.skip();
    await setJournal(false);
    const bare = vi.spyOn(sharedHostConnectionRegistry, "requestToolAction");
    const id = await admit(UNINSTALL);
    // The dispatch marker committed; the worker stopped before it knew whether the frame left.
    await db.pool.query(`UPDATE host_command_intents SET status = 'dispatched', effect_json = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify({ dispatched_at: new Date().toISOString(), journaled: false, sends: 1 })]);
    await commands.process();
    expect(bare).not.toHaveBeenCalled();
    expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_outcome_unknown" });
  });

  it("maps the Host journal's interrupted, mismatch and refused receipts without claiming success", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    const cases: Array<[Partial<HostCommandAnswer>, string, string]> = [
      [{ outcome: "interrupted", replayed: true }, "needs_attention", "host_command_interrupted"],
      [{ outcome: "mismatch" }, "needs_attention", "host_command_mismatch"],
      [{ outcome: "refused", error: "host_command_not_recorded: EIO" }, "failed", "host_command_not_recorded"],
      [{ outcome: "completed", result: toolResult(false) }, "failed", "host_command_failed"],
    ];
    for (const [reply, expected, code] of cases) {
      send.mockResolvedValueOnce(answer(reply));
      const id = await admit(UNINSTALL);
      await commands.process();
      expect(await intent(id)).toMatchObject({ status: expected, error_code: code, result_json: null });
    }
    expect(await runtimeChanges()).toEqual([]);
  });

  it("repeats a journaled command whose answer was lost until the Host's receipt arrives, across a disconnect", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ error: "host_disconnected" }))
      .mockResolvedValueOnce(answer({ error: "host_timeout" }))
      .mockResolvedValueOnce(answer({ outcome: "completed", replayed: true, result: toolResult() }));
    const id = await admit(UNINSTALL);
    await commands.process();
    expect(await intent(id)).toMatchObject({ status: "dispatched", effect_json: { journaled: true, sends: 1 } });
    expect((await status(id)).json()).toMatchObject({ status: "dispatched", result: null });
    // Offline after the frame left: the command waits, still dispatched, nothing new is sent.
    vi.mocked(sharedHostConnectionRegistry.isOnline).mockReturnValue(false);
    await processAgain();
    expect(send).toHaveBeenCalledTimes(1);
    vi.mocked(sharedHostConnectionRegistry.isOnline).mockReturnValue(true);
    await processAgain();
    await processAgain();
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map((call) => JSON.stringify(call[1]))).size).toBe(1);
    expect(await intent(id)).toMatchObject({ status: "succeeded", effect_json: { sends: 3 } });
    expect(await runtimeChanges()).toHaveLength(1);
  });

  it("withdraws a command whose Host is revoked: unsent fails, sent needs attention, and nothing is released", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    const first = await admit(UNINSTALL, "uninstall-1");
    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    await commands.process();
    expect(send).not.toHaveBeenCalled();
    expect(await intent(first)).toMatchObject({ status: "failed", error_code: "host_command_authority_withdrawn" });
    expect((await status(first)).statusCode).toBe(404);
    // The transport replay of a revoked Host's command answers nothing either.
    expect((await commands.submit(app!, UNINSTALL, "uninstall-1")).statusCode).toBe(404);

    await db.pool.query(`UPDATE hosts SET status = 'online' WHERE id = $1`, [HOST]);
    const second = await admit(UNINSTALL);
    send.mockImplementationOnce(async () => {
      // Revoked while the Host was acting: it did, but the result is no longer the person's.
      await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
      return answer({ outcome: "completed", result: toolResult() });
    });
    await commands.process();
    expect(await intent(second)).toMatchObject({ status: "needs_attention", error_code: "host_command_authority_withdrawn", result_json: null });
    expect(await runtimeChanges()).toEqual([]);
  });

  it("withdraws a command whose person left the Space before it was sent", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    const id = await admit(UNINSTALL);
    await db.pool.query(`UPDATE space_memberships SET status = 'removed' WHERE space_id = $1 AND user_id = $2`, [SPACE, OWNER]);
    await commands.process();
    expect(send).not.toHaveBeenCalled();
    expect(await intent(id)).toMatchObject({ status: "failed" });
    expect((await intent(id)).error_code).toMatch(/withdrawn|refused/);
  });

  it("settles a cancelled Job by what was sent: never sent fails, sent is unknown", async (ctx) => {
    if (!db.available) return ctx.skip();
    vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand").mockResolvedValue(answer({ error: "host_timeout" }));
    const unsent = await admit(UNINSTALL);
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE id = (SELECT job_id FROM host_command_intents WHERE id = $1)`, [unsent]);
    expect((await status(unsent)).json()).toMatchObject({ status: "failed", error: { code: "host_command_job_cancelled" } });

    const sent = await admit(UNINSTALL);
    await commands.process();
    expect((await intent(sent)).status).toBe("dispatched");
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE id = (SELECT job_id FROM host_command_intents WHERE id = $1)`, [sent]);
    expect((await status(sent)).json()).toMatchObject({ status: "needs_attention", error: { code: "host_command_job_cancelled" } });
    // A settled scope admits a new command.
    expect((await commands.submit(app!, UNINSTALL)).statusCode).toBe(202);
  });

  it("keeps the transport key, the business scope and the reader separate", async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await commands.submit(app!, UNINSTALL, "key-1");
    const id = first.json().data.id as string;
    // Same transport key: the same receipt; another key for the same scope: busy, naming the person's own command.
    expect((await commands.submit(app!, UNINSTALL, "key-1")).json()).toEqual(first.json());
    const busy = await commands.submit(app!, UNINSTALL, "key-2");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.metadata).toMatchObject({ code: "host_command_busy", command_id: id });
    // The same key with another input is refused by the transport, never a second command.
    const reused = await commands.submit(app!, { ...UNINSTALL, url: `/api/v1/hosts/${HOST}/installations/codex/managed:2.0.0` }, "key-1");
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("idempotency_key_reused");
    expect((await db.pool.query("SELECT count(*)::int AS n FROM host_command_intents")).rows[0].n).toBe(1);

    // Nobody else reads it: another member, or the same person in another Space.
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    expect((await status(id)).statusCode).toBe(404);
    expect((await commands.submit(app!, UNINSTALL, "key-1")).statusCode).toBe(404);
    __setAuthIdentityForTests({ spaceId: OTHER_SPACE, userId: OWNER });
    expect((await status(id)).statusCode).toBe(404);
  });

  it("registers a Location under the Project write check and keeps no private path once settled", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ outcome: "completed", result: { type: "workspace_register_result", request_id: "send", ok: true, workspace_id: "ws-1", display_path: "~/private/repo", error: null } }));
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    // Not the Host's owner: the hidden 404, whatever the Project allows.
    expect((await commands.submit(app!, REGISTER())).statusCode).toBe(404);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    expect((await commands.submit(app!, { ...REGISTER(), payload: { ...REGISTER().payload, path: "bad\0path" } })).statusCode).toBe(422);
    const id = await admit(REGISTER());
    expect((await intent(id)).frozen_json).toMatchObject({ path: "/home/owner/private/repo" });
    await commands.process();
    expect(send.mock.calls[0]![1].command).toMatchObject({ type: "workspace_register", path: "/home/owner/private/repo", project_id: PROJECT, name: "Repo" });
    const settled = await intent(id);
    expect(settled.status).toBe("succeeded");
    expect(settled.frozen_json).not.toHaveProperty("path");
    expect((await status(id)).json().result).toEqual({ workspace_id: "ws-1", display_path: "~/private/repo" });
  });

  it("never resends an unjournaled registration whose Host disconnected after the frame left", async (ctx) => {
    if (!db.available) return ctx.skip();
    await setJournal(false);
    const frames: Array<{ type: string }> = [];
    // The real registry with a socket that drops right after the frame leaves.
    const sink = { send(frame: { type: string }) { frames.push(frame); queueMicrotask(() => sharedHostConnectionRegistry.unregisterConnection(HOST, sink as never)); }, close() {} };
    sharedHostConnectionRegistry.registerConnection(HOST, sink as never);
    try {
      const id = await admit(REGISTER());
      await commands.process();
      expect(frames.map((frame) => frame.type)).toEqual(["workspace_register"]);
      expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_outcome_unknown" });
      sharedHostConnectionRegistry.registerConnection(HOST, sink as never);
      await processAgain();
      expect(frames).toHaveLength(1);
    } finally {
      sharedHostConnectionRegistry.unregisterConnection(HOST, sink as never);
    }
  });

  it("gives up a command that never left after ten minutes, so a reconnect cannot run it stale", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand");
    vi.mocked(sharedHostConnectionRegistry.isOnline).mockReturnValue(false);
    const fresh = await admit(UNINSTALL);
    await commands.process();
    expect(await intent(fresh)).toMatchObject({ status: "pending" });
    await db.pool.query(`UPDATE host_command_intents SET created_at = now() - interval '11 minutes' WHERE id = $1`, [fresh]);
    await processAgain();
    expect(await intent(fresh)).toMatchObject({ status: "failed", error_code: "host_offline" });
    vi.mocked(sharedHostConnectionRegistry.isOnline).mockReturnValue(true);
    await processAgain();
    expect(send).not.toHaveBeenCalled();
    expect((await status(fresh)).json()).toMatchObject({ status: "failed", result: null, error: { code: "host_offline" } });
  });

  it("gives up a command that never left after ten minutes when its Host is online at the first dispatch, sending nothing", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand").mockResolvedValue(answer({ outcome: "completed", result: toolResult() }));
    // A backlog: the Job was never picked up while the Host was online the whole time.
    const stale = await admit(UNINSTALL);
    await db.pool.query(`UPDATE host_command_intents SET created_at = now() - interval '11 minutes' WHERE id = $1`, [stale]);
    await commands.process();
    expect(send).not.toHaveBeenCalled();
    const settled = await intent(stale);
    expect(settled).toMatchObject({ status: "failed", error_code: "host_command_expired", result_json: null });
    expect(settled.effect_json.dispatched_at).toBeUndefined();
    expect(await runtimeChanges()).toEqual([]);
    await processAgain();
    expect(send).not.toHaveBeenCalled();
    expect((await status(stale)).json()).toMatchObject({ status: "failed", result: null, error: { code: "host_command_expired" } });
  });

  it("keeps repeating a command that was sent before the ten minutes ran out: expiry never settles a sent obligation", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ error: "host_timeout" }))
      .mockResolvedValueOnce(answer({ outcome: "completed", replayed: true, result: toolResult() }));
    const id = await admit(UNINSTALL);
    await commands.process();
    expect(await intent(id)).toMatchObject({ status: "dispatched", effect_json: { sends: 1 } });
    await db.pool.query(`UPDATE host_command_intents SET created_at = now() - interval '11 minutes' WHERE id = $1`, [id]);
    await processAgain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toEqual(send.mock.calls[0]![1]);
    expect(await intent(id)).toMatchObject({ status: "succeeded", effect_json: { receipt: { by: id, replayed: true } } });
  });

  it("does not take a Host's unrecorded outcome as its receipt: the same command is repeated until the receipt is durable", async (ctx) => {
    if (!db.available) return ctx.skip();
    const send = vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ outcome: "unrecorded", error: "host_command_outcome_not_recorded: EIO" }))
      .mockResolvedValueOnce(answer({ outcome: "unrecorded", replayed: true, error: "host_command_outcome_not_recorded: EIO" }))
      .mockResolvedValueOnce(answer({ outcome: "completed", replayed: true, result: toolResult() }));
    const id = await admit(UNINSTALL);
    await commands.process();
    const held = await intent(id);
    expect(held).toMatchObject({ status: "dispatched", result_json: null });
    expect(held.effect_json.receipt).toBeUndefined();
    expect((await status(id)).json()).toMatchObject({ status: "dispatched", result: null, error: null });
    await processAgain();
    expect((await intent(id)).status).toBe("dispatched");
    expect(await runtimeChanges()).toEqual([]);
    await processAgain();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]![1]).toEqual(send.mock.calls[0]![1]);
    expect(await intent(id)).toMatchObject({ status: "succeeded", effect_json: { receipt: { by: id, replayed: true } } });
    expect(await runtimeChanges()).toEqual([{ action: "remove", from_version: "1.0.0" }]);
  });

  it("does not read a journal refusal on a repeat as nothing having happened", async (ctx) => {
    if (!db.available) return ctx.skip();
    vi.spyOn(sharedHostConnectionRegistry, "requestHostCommand")
      .mockResolvedValueOnce(answer({ error: "host_timeout" }))
      .mockResolvedValueOnce(answer({ outcome: "refused", error: "host_command_journal_unreadable: EIO" }));
    const id = await admit(UNINSTALL);
    await commands.process();
    await processAgain();
    expect(await intent(id)).toMatchObject({ status: "needs_attention", error_code: "host_command_not_recorded" });
  });
});
