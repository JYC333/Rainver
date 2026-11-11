import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { HostDaemonFrameSchema, type AmbientSessionImport, type HostCommandKind } from "@rainver/protocol";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { hostCommandHarness } from "./support/hostCommandHarness.js";
import { hostsModule } from "../src/modules/hosts/index.js";
import { importedSessionsModule } from "../src/modules/importedSessions/index.js";
import { PgImportedSessionRepository } from "../src/modules/importedSessions/repository.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import { wakeHostCommandsForHost } from "../src/modules/hosts/hostCommandWorker.js";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";
import { loadHostCommand, settleStaleHostCommand } from "../src/modules/hosts/hostCommands.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";

/**
 * Who may still read a Host command, and replay a recorded change, is decided
 * by the authority its kind needs today (`authorizeHostCommandResource`) —
 * for every one of the thirteen kinds and whatever state it settled in — and
 * an imported session's replayed change by its service's own authority. A
 * history import's report says what it committed: success, definite failure,
 * or a partial commit that is neither.
 */
const SPACE = "71111111-1111-4111-8111-111111111111";
const OWNER = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "7a222222-2222-4222-8222-222222222222";
const PROJECT = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "7ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "7ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOLDER = "7eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "7fffffff-ffff-4fff-8fff-ffffffffffff";
const AGENT = "7e111111-1111-4111-8111-111111111111";
const VERSION = "7e222222-2222-4222-8222-222222222222";

const db = useTestDatabase(import.meta.filename);
let app: FastifyInstance | undefined;
let commands: ReturnType<typeof hostCommandHarness>;

/** Each kind as its settled row keeps it: only the ids its authority needs survive redaction. */
const SETTLED: Record<HostCommandKind, { frozen: Record<string, unknown>; agent?: string }> = {
  workspace_register: { frozen: { project_id: PROJECT, name: "Repo" } },
  runtime_install: { frozen: { runtime_key: "codex", version: "1.0.0" } },
  runtime_uninstall: { frozen: { runtime_key: "codex", version: "1.0.0" } },
  runtime_own_update: { frozen: { runtime_key: "claude_code" } },
  runtime_managed_update: { frozen: { runtime_key: "claude_code" } },
  runtime_rollback: { frozen: { runtime_key: "codex", variant: "tool" } },
  runtime_usage_refresh: { frozen: { runtime_key: "codex", installation: "own" } },
  ordinary_tool_install: { frozen: { operation: { action: "install", tool_id: "gh" } } },
  ordinary_tool_register: { frozen: { operation: { action: "register", tool_id: "gh" } } },
  ordinary_tool_remove: { frozen: { operation: { action: "remove", tool_id: "gh" } } },
  ordinary_account_logout: { frozen: { tool_id: "gh", account_key: "acct" } },
  agent_host_state_reset: { frozen: { sessions_retired: 0 }, agent: AGENT },
  ambient_sync: { frozen: { location_id: LOCATION, runtime_key: "claude_code", installation: "own" } },
};
const KINDS = Object.keys(SETTLED) as HostCommandKind[];
const STATES = ["succeeded", "failed", "needs_attention"] as const;

async function settled(kind: HostCommandKind, status: (typeof STATES)[number]): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO host_command_intents (id, space_id, host_id, user_id, agent_id, kind, scope_key, status, job_id, frozen_json, effect_json, result_json, error_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, '{"dispatched_at":"2026-11-11T00:00:00.000Z","journaled":true,"sends":1}'::jsonb, $11::jsonb, $12, now(), now())`,
    [id, SPACE, HOST, OWNER, SETTLED[kind].agent ?? null, kind, randomUUID().replaceAll("-", ""), status, randomUUID(), JSON.stringify(SETTLED[kind].frozen),
      status === "succeeded" ? JSON.stringify({ private_marker: "released-only-to-authority" }) : null, status === "succeeded" ? null : "host_command_failed"]);
  return id;
}
/** Every kind in every settled state; the status read of each. */
async function matrix(): Promise<Array<{ kind: HostCommandKind; status: string; id: string }>> {
  const rows = [];
  for (const kind of KINDS) for (const status of STATES) rows.push({ kind, status, id: await settled(kind, status) });
  return rows;
}
const readable = async (id: string) => {
  const read = await commands.status(app!, HOST, id);
  if (read.statusCode === 404) expect(read.body).not.toContain("released-only-to-authority");
  return read.statusCode;
};
async function expectReadable(rows: Array<{ kind: HostCommandKind; id: string; status: string }>, hidden: ReadonlySet<HostCommandKind>) {
  const seen = await Promise.all(rows.map(async (row) => [`${row.kind}:${row.status}`, await readable(row.id)] as const));
  expect(Object.fromEntries(seen)).toEqual(Object.fromEntries(rows.map((row) => [`${row.kind}:${row.status}`, hidden.has(row.kind) ? 404 : 200])));
}
const revokeProjectWrite = async () => {
  await db.pool.query(`UPDATE projects SET owner_user_id = $2 WHERE id = $1`, [PROJECT, OTHER]);
  await db.pool.query(`UPDATE space_memberships SET role = 'member' WHERE space_id = $1 AND user_id = $2`, [SPACE, OWNER]);
};

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["host_command_intents", "jobs", "imported_session_records", "imported_sessions", "token_usage_events", "activity_records", "host_threads", "runs",
    "workspace_locations", "project_folders", "project_members", "agents", "agent_versions", "projects", "hosts", "machines", "space_memberships", "users", "spaces"], { cascade: true });
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(`INSERT INTO users (id, email, display_name, status, created_at, updated_at, registration_source) VALUES ($1, 'other7@example.com', 'Other', 'active', $2, $2, 'system')`, [OTHER, now]);
  await db.pool.query(`INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'member', 'active', $4, $4)`, [randomUUID(), SPACE, OTHER, now]);
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, now });
  await db.pool.query(`UPDATE agents SET owner_user_id = $2, visibility = 'private' WHERE id = $1`, [AGENT, OWNER]);
  await db.pool.query(`INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at) VALUES ($1, $2, 'laptop', 'laptop', $3, $3)`, [MACHINE, OWNER, now]);
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, platform, last_heartbeat_at, capabilities_json, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', 'linux', $4, '{"host_command_receipts":1}'::jsonb, $4, $4)`, [HOST, OWNER, MACHINE, now]);
  await db.pool.query(
    `INSERT INTO project_folders (id, space_id, project_id, created_by_user_id, name, status, kind, is_primary, protected, system_managed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'repo', 'active', 'code', true, false, false, $5, $5)`, [FOLDER, SPACE, PROJECT, OWNER, now]);
  await db.pool.query(
    `INSERT INTO workspace_locations (id, space_id, project_folder_id, execution_host_id, execution_host_kind, display_path, execution_ready, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'remote', '/home/me/project', true, 'active', $5, $5)`, [LOCATION, SPACE, FOLDER, HOST, now]);
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  app = buildModuleServer(config, [hostsModule, importedSessionsModule]);
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

describe("a Host command's status read, for every kind and settled state", () => {
  it("is the issuer's while every authority holds", async (ctx) => {
    if (!db.available) return ctx.skip();
    await expectReadable(await matrix(), new Set());
  });

  it("hides every kind once the Host is revoked", async (ctx) => {
    if (!db.available) return ctx.skip();
    const rows = await matrix();
    await db.pool.query(`UPDATE hosts SET status = 'revoked' WHERE id = $1`, [HOST]);
    await expectReadable(rows, new Set(KINDS));
  });

  it("hides a reset once the Agent is no longer the person's, and nothing else", async (ctx) => {
    if (!db.available) return ctx.skip();
    const rows = await matrix();
    await db.pool.query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [AGENT, OTHER]);
    await expectReadable(rows, new Set(["agent_host_state_reset"]));
  });

  it("hides a Location registration and a history import once Project write is gone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const rows = await matrix();
    await revokeProjectWrite();
    await expectReadable(rows, new Set(["workspace_register", "ambient_sync"]));
  });

  it("hides a history import once its Location is gone or on another Host", async (ctx) => {
    if (!db.available) return ctx.skip();
    const rows = await matrix();
    await db.pool.query(`UPDATE workspace_locations SET execution_host_id = NULL WHERE id = $1`, [LOCATION]).catch(async () => {
      await db.pool.query(`DELETE FROM workspace_locations WHERE id = $1`, [LOCATION]);
    });
    await expectReadable(rows, new Set(["ambient_sync"]));
  });

  it("does not rely on a private path the settled row no longer keeps", async (ctx) => {
    if (!db.available) return ctx.skip();
    // A registration whose project id was lost cannot be authorized from anything else: hidden.
    const id = await settled("workspace_register", "succeeded");
    await db.pool.query(`UPDATE host_command_intents SET frozen_json = '{"path":"/home/owner/private"}'::jsonb WHERE id = $1`, [id]);
    expect(await readable(id)).toBe(404);
  });
});

describe("replaying a recorded Host command receipt", () => {
  it("answers the receipt again only while the command's own resource authority holds", async (ctx) => {
    if (!db.available) return ctx.skip();
    const submit = (options: Parameters<typeof commands.submit>[1], key: string) => commands.submit(app!, options, key);
    const reset = { method: "POST" as const, url: `/api/v1/agents/${AGENT}/host-state/reset`, payload: { host_id: HOST } };
    const register = { method: "POST" as const, url: `/api/v1/hosts/${HOST}/workspaces`, payload: { project_id: PROJECT, path: "/home/owner/repo", name: "Repo" } };
    const sync = { method: "POST" as const, url: `/api/v1/workspace-locations/${LOCATION}/ambient-sessions/sync`, payload: { runtime_key: "claude_code" } };
    const first = { reset: await submit(reset, "reset-key"), register: await submit(register, "register-key"), sync: await submit(sync, "sync-key") };
    for (const accepted of Object.values(first)) expect(accepted.statusCode, accepted.body).toBe(202);
    expect((await submit(reset, "reset-key")).json()).toEqual(first.reset.json());

    await db.pool.query(`UPDATE agents SET owner_user_id = $2 WHERE id = $1`, [AGENT, OTHER]);
    expect((await submit(reset, "reset-key")).statusCode).toBe(404);
    expect((await submit(register, "register-key")).statusCode).toBe(202);
    await revokeProjectWrite();
    expect((await submit(register, "register-key")).statusCode).toBe(404);
    expect((await submit(sync, "sync-key")).statusCode).toBe(404);
  });
});

describe("an imported session's recorded change", () => {
  async function importedBy(owner: string, locationId: string | null = LOCATION): Promise<string> {
    const outcome = await new PgImportedSessionRepository(db.pool).reconcile({
      spaceId: SPACE, projectId: PROJECT, projectFolderId: FOLDER, workspaceLocationId: LOCATION, executionHostId: HOST, ownerUserId: owner,
      runtimeKey: "claude_code", installation: "own", visibility: "space_shared",
      session: { session_id: `sess-${randomUUID()}`, cwd: "/home/me/project", title: "t", updated_at: null }, loadState: "complete", error: null, records: [],
    });
    if (locationId === null) await db.pool.query(`UPDATE imported_sessions SET workspace_location_id = NULL WHERE id = $1`, [outcome.session.id]);
    return outcome.session.id;
  }
  const change = (sessionId: string, key: string, visibility = "private") =>
    commands.submit(app!, { method: "PATCH", url: `/api/v1/imported-sessions/${sessionId}`, payload: { visibility } }, key);

  it("replays a Host owner's change to someone else's session only while they may still make it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const sessionId = await importedBy(OTHER);
    const first = await change(sessionId, "visibility-key");
    expect(first.statusCode, first.body).toBe(200);
    expect((await change(sessionId, "visibility-key")).json()).toEqual(first.json());
    await revokeProjectWrite();
    // Neither the replay nor a new request is the Host owner's any more.
    expect((await change(sessionId, "visibility-key")).statusCode).toBe(404);
    expect((await change(sessionId, "visibility-key-2", "space_shared")).statusCode).toBe(404);
    // The importer keeps their own session.
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    expect((await change(sessionId, "importer-key", "space_shared")).statusCode).toBe(200);
  });

  it("keeps a session whose Location is gone its importer's alone, for a change and its replay", async (ctx) => {
    if (!db.available) return ctx.skip();
    const sessionId = await importedBy(OTHER, null);
    // Only a row existing in the Space is not enough: the Host owner never may.
    expect((await change(sessionId, "owner-key")).statusCode).toBe(404);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OTHER });
    const own = await change(sessionId, "importer-key");
    expect(own.statusCode, own.body).toBe(200);
    // Another member replaying the importer's key is a different actor's request, never their result.
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    expect((await change(sessionId, "importer-key")).statusCode).toBe(404);
  });
});

describe("a history import's outcome", () => {
  const replay = (id: string): AmbientSessionImport => ({
    session: { session_id: id, cwd: "/home/me/project", title: id, updated_at: "2026-08-20T10:00:00.000Z" }, load_state: "complete",
    records: [{ record_key: "message:1", kind: "user_message", sequence: 0, occurred_at: null, text: "hello", tool_name: null, tool_status: null, tool_input: null, tool_output: null, raw_json: null, truncated: false }],
    usage: [], error: null,
  });
  const host = (sessions: AmbientSessionImport[], ok: boolean, error: string | null) =>
    vi.spyOn(sharedHostConnectionRegistry, "requestAmbientImport").mockImplementationOnce(async (_hostId, _frame, onSession) => {
      for (const session of sessions) onSession(session);
      return { ok, error, session_count: sessions.length, listed_session_ids: ok ? sessions.map((s) => s.session.session_id) : null };
    });
  const sync = async () => {
    const accepted = await commands.submit(app!, { method: "POST", url: `/api/v1/workspace-locations/${LOCATION}/ambient-sessions/sync`, payload: { runtime_key: "claude_code" } });
    expect(accepted.statusCode, accepted.body).toBe(202);
    return accepted.json().data.id as string;
  };
  const read = async (id: string) => (await commands.status(app!, HOST, id)).json();
  const sessions = async () => (await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM imported_sessions WHERE space_id = $1`, [SPACE])).rows[0]!.n;

  it("is success only when the import finished without an error", async (ctx) => {
    if (!db.available) return ctx.skip();
    host([replay("a")], true, null);
    const id = await sync();
    await commands.process();
    expect(await read(id)).toMatchObject({ status: "succeeded", error: null, result: { sessions_written: 1, error: null } });
  });

  it("repeats an import whose Host was lost before anything was committed, and never calls it success meanwhile", async (ctx) => {
    if (!db.available) return ctx.skip();
    host([], false, "host_disconnected");
    const id = await sync();
    await commands.process();
    expect(await read(id)).toMatchObject({ status: "dispatched", result: null });
    host([replay("a")], true, null);
    await wakeHostCommandsForHost(db.pool, HOST);
    await commands.process();
    expect(await read(id)).toMatchObject({ status: "succeeded", result: { sessions_written: 1 } });
    expect(await sessions()).toBe(1);
  });

  it("reports a definite failure that committed nothing as failed, with its report", async (ctx) => {
    if (!db.available) return ctx.skip();
    host([], false, "runtime_history_unreadable");
    const id = await sync();
    await commands.process();
    expect(await read(id)).toMatchObject({ status: "failed", error: { code: "ambient_sync_failed", detail: "runtime_history_unreadable" },
      result: { sessions_written: 0, error: "runtime_history_unreadable" } });
  });

  /**
   * A connected Host on the real registry answering `ambient_import` with the frames the daemon
   * sends (`commands/run.ts`): one `ambient_import_session` per replay, then an
   * `ambient_import_result` that is `ok` even when a replay stopped part way — the partial
   * state is in that session's own `load_state`. Every frame is parsed as the daemon wire.
   */
  function connectedHost(sessions: AmbientSessionImport[]) {
    const frames: Array<Record<string, unknown>> = [];
    const daemonSends = (frame: Record<string, unknown>) => {
      const parsed = HostDaemonFrameSchema.parse(frame);
      if (parsed.type === "ambient_import_session") sharedHostConnectionRegistry.receiveAmbientImportSession(HOST, parsed.request_id, parsed.session);
      if (parsed.type === "ambient_import_result") sharedHostConnectionRegistry.receiveAmbientImportResult(HOST, parsed.request_id, parsed);
    };
    const sink = {
      send(frame: Record<string, unknown>) {
        frames.push(frame);
        if (frame.type !== "ambient_import") return;
        const requestId = String(frame.request_id);
        queueMicrotask(() => {
          for (const session of sessions) daemonSends({ type: "ambient_import_session", request_id: requestId, session });
          daemonSends({ type: "ambient_import_result", request_id: requestId, ok: true, error: null, session_count: sessions.length, listed_session_ids: sessions.map((s) => s.session.session_id) });
        });
      },
      close() {},
    };
    sharedHostConnectionRegistry.registerConnection(HOST, sink as never);
    return { frames, close: () => sharedHostConnectionRegistry.unregisterConnection(HOST, sink as never) };
  }

  it("reports a replay the Host could read only in part as needing attention, with the partial session kept and counted", async (ctx) => {
    if (!db.available) return ctx.skip();
    const partial: AmbientSessionImport = { ...replay("b"), load_state: "partial", error: "the replay was still streaming when the drain ceiling was reached" };
    const host = connectedHost([replay("a"), partial]);
    try {
      const id = await sync();
      await commands.process();
      expect(host.frames.filter((frame) => frame.type === "ambient_import")).toHaveLength(1);
      const settled = await read(id);
      expect(settled).toMatchObject({ status: "needs_attention", error: { code: "ambient_sync_partial" },
        result: { sessions_written: 2, partial_sessions: 1, records_inserted: 2, failed_sessions: 0 } });
      expect(settled.result.error).toMatch(/only be read in part/);
      // What was read is committed, the partial one marked so and retried by the next sync.
      const rows = (await db.pool.query<{ load_state: string; last_error: string | null }>(
        `SELECT load_state, last_error FROM imported_sessions WHERE space_id = $1 ORDER BY load_state`, [SPACE])).rows;
      expect(rows).toEqual([{ load_state: "complete", last_error: null }, { load_state: "partial", last_error: partial.error }]);
      // Not success, so not repeated by its Job: one import, and a later sync completes it without duplicates.
      await wakeHostCommandsForHost(db.pool, HOST);
      await commands.process();
      expect(host.frames.filter((frame) => frame.type === "ambient_import")).toHaveLength(1);
    } finally { host.close(); }
    const complete = connectedHost([replay("a"), replay("b")]);
    try {
      const again = await sync();
      await commands.process();
      expect(await read(again)).toMatchObject({ status: "succeeded", error: null, result: { partial_sessions: 0, error: null } });
      expect(await sessions()).toBe(2);
      expect((await db.pool.query(`SELECT 1 FROM imported_sessions WHERE space_id = $1 AND load_state = 'partial'`, [SPACE])).rowCount).toBe(0);
    } finally { complete.close(); }
  });

  it("reports an import that committed sessions and then lost its Host as needing attention, with what it committed", async (ctx) => {
    if (!db.available) return ctx.skip();
    host([replay("a")], false, "host_disconnected");
    const id = await sync();
    await commands.process();
    expect(await read(id)).toMatchObject({ status: "needs_attention", error: { code: "ambient_sync_partial", detail: "host_disconnected" },
      result: { sessions_written: 1, records_inserted: 1, error: "host_disconnected" } });
    expect(await sessions()).toBe(1);
    // A later import of the same history reconciles: nothing is imported twice.
    host([replay("a")], true, null);
    const again = await sync();
    await commands.process();
    expect(await read(again)).toMatchObject({ status: "succeeded", result: { sessions_written: 1, records_inserted: 0, records_unchanged: 1 } });
    expect(await sessions()).toBe(1);
  });
});

describe("a Host command settled because its Job can no longer run", () => {
  const PRIVATE = {
    project_id: PROJECT, name: "Repo", path: "/home/me/private/repo",
    egress_transport: { mode: "proxy", proxy_url: "http://user:secret@proxy.internal:3128" },
    operation: { action: "register", tool_id: "gh", path: "/home/me/bin/gh" },
  };
  async function active(kind: HostCommandKind, sent: boolean, jobStatus: "cancelled" | "failed"): Promise<string> {
    const id = randomUUID();
    const jobId = (await new PgJobQueueRepository(db.pool).enqueue({ job_type: "host_command", space_id: SPACE, user_id: OWNER, payload: { intent_id: id }, max_attempts: 5 })).id;
    await db.pool.query(`UPDATE jobs SET status = $2, attempts = max_attempts WHERE id = $1`, [jobId, jobStatus]);
    await db.pool.query(
      `INSERT INTO host_command_intents (id, space_id, host_id, user_id, kind, scope_key, status, job_id, frozen_json, effect_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now(), now())`,
      [id, SPACE, HOST, OWNER, kind, randomUUID().replaceAll("-", ""), sent ? "dispatched" : "pending", jobId, JSON.stringify(PRIVATE),
        JSON.stringify(sent ? { dispatched_at: new Date().toISOString(), journaled: true, sends: 1 } : {})]);
    return id;
  }
  const frozenOf = async (id: string) => (await db.pool.query<{ status: string; error_code: string; frozen_json: Record<string, unknown> }>(
    `SELECT status, error_code, frozen_json FROM host_command_intents WHERE id = $1`, [id])).rows[0]!;
  const KEPT = { project_id: PROJECT, name: "Repo", operation: { action: "register", tool_id: "gh" } };

  it("keeps no private path or proxy transport when cancelled or exhausted, the same as a normal terminal write, and stays readable", async (ctx) => {
    if (!db.available) return ctx.skip();
    const cases = [
      { kind: "workspace_register" as const, sent: false, job: "cancelled" as const, status: "failed", code: "host_command_job_cancelled" },
      { kind: "workspace_register" as const, sent: true, job: "failed" as const, status: "needs_attention", code: "host_command_job_failed" },
      { kind: "ordinary_tool_register" as const, sent: true, job: "cancelled" as const, status: "needs_attention", code: "host_command_job_cancelled" },
      { kind: "ordinary_tool_install" as const, sent: false, job: "failed" as const, status: "failed", code: "host_command_job_failed" },
    ];
    for (const item of cases) {
      const id = await active(item.kind, item.sent, item.job);
      // Settled by the status read, the way a person sees it.
      expect((await commands.status(app!, HOST, id)).json()).toMatchObject({ status: item.status, error: { code: item.code } });
      expect(await frozenOf(id)).toEqual({ status: item.status, error_code: item.code, frozen_json: KEPT });
    }
    // Settled by a barrier (admission, launch fence) in its own transaction: the same redaction.
    const barrier = await active("workspace_register", true, "cancelled");
    await withQueryableTransaction(db.pool, async (tx) => settleStaleHostCommand(tx, (await loadHostCommand(tx, barrier, true))!));
    expect((await frozenOf(barrier)).frozen_json).toEqual(KEPT);
    expect(JSON.stringify((await db.pool.query(`SELECT frozen_json FROM host_command_intents`)).rows)).not.toMatch(/private|secret|proxy/);
  });

  it("does not touch a command whose Job can still run", async (ctx) => {
    if (!db.available) return ctx.skip();
    const id = await active("workspace_register", true, "cancelled");
    await db.pool.query(`UPDATE jobs SET status = 'pending' WHERE id = (SELECT job_id FROM host_command_intents WHERE id = $1)`, [id]);
    expect((await commands.status(app!, HOST, id)).json()).toMatchObject({ status: "dispatched" });
    expect((await frozenOf(id)).frozen_json).toEqual(PRIVATE);
  });
});
