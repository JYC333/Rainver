import { randomUUID } from "node:crypto";
import { PgHostThreadRepository } from "../src/modules/hosts/threadRepository.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { ImportedSessionService } from "../src/modules/importedSessions/service.js";
import { PgImportedSessionRepository } from "../src/modules/importedSessions/repository.js";
import { sharedHostConnectionRegistry } from "../src/modules/hosts/connectionRegistry.js";
import type { AmbientSessionImport } from "@rainver/protocol";

/**
 * The sync path, with the daemon round trip stubbed at the connection
 * registry.
 *
 * The repository tests cover reconciliation given a replay; what needs
 * covering here is everything the service decides *around* it — which
 * sessions count as gone, who may run a sync at all, and whether a replay's
 * reported token usage reaches the ledger once and only once. Each of these
 * is a place where using the server's own records instead of the host's
 * report would look correct and be wrong.
 */

const SPACE = "61111111-1111-4111-8111-111111111111";
const OWNER = "6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "6a222222-2222-4222-8222-222222222222";
const PROJECT = "6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MACHINE = "6ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOST = "6ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const FOLDER = "6eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LOCATION = "6fffffff-ffff-4fff-8fff-ffffffffffff";

const db = useTestDatabase(import.meta.filename);

/**
 * The usage ledger resolves its own pool from config rather than from the
 * injected queryable — usage is a separate ledger, not part of the import's
 * transaction — so the real connection string has to be handed in for the
 * forwarding path to be exercised at all.
 */
function serverConfig() {
  return { databaseUrl: db.connectionUri } as never;
}

function replay(sessionId: string, overrides: Partial<AmbientSessionImport> = {}): AmbientSessionImport {
  return {
    session: { session_id: sessionId, cwd: "/home/me/project", title: sessionId, updated_at: "2026-08-20T10:00:00.000Z" },
    load_state: "complete",
    records: [{
      record_key: "message:msg-1",
      kind: "user_message",
      sequence: 0,
      occurred_at: null,
      text: "hello",
      tool_name: null,
      tool_status: null,
      tool_input: null,
      tool_output: null,
      raw_json: null,
      truncated: false,
    }],
    usage: [],
    error: null,
    ...overrides,
  };
}

/** Stands in for a paired host: hands back the given replays, then a terminal report. */
function stubHost(replays: AmbientSessionImport[], listed: string[] | null = null) {
  return vi.spyOn(sharedHostConnectionRegistry, "requestAmbientImport").mockImplementation(
    async (_hostId, _frame, onSession) => {
      for (const entry of replays) onSession(entry);
      return {
        ok: listed !== null,
        error: listed !== null ? null : "host_offline",
        session_count: replays.length,
        listed_session_ids: listed,
      };
    },
  );
}

async function seedTopology(): Promise<void> {
  const now = new Date().toISOString();
  await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await db.pool.query(
    `INSERT INTO machines (id, owner_user_id, display_name, device_kind, created_at, updated_at)
     VALUES ($1, $2, 'Laptop', 'laptop', $3, $3)`,
    [MACHINE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO hosts (id, owner_user_id, machine_id, name, kind, environment_kind, status, last_heartbeat_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'laptop', 'remote', 'linux_native', 'online', $4, $4, $4)`,
    [HOST, OWNER, MACHINE, now],
  );
  await db.pool.query(
    `INSERT INTO project_folders (
       id, space_id, project_id, created_by_user_id, name, status, kind,
       is_primary, protected, system_managed, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'repo', 'active', 'code', true, false, false, $5, $5)`,
    [FOLDER, SPACE, PROJECT, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO workspace_locations (
       id, space_id, project_folder_id, execution_host_id, execution_host_kind, display_path,
       execution_ready, status, preferred, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'remote','/home/me/project',true,'active',true,$5,$5)`,
    [LOCATION, SPACE, FOLDER, HOST, now],
  );
}

describe("ambient session sync", () => {
  beforeEach(async () => {
    if (!db.available) return;
    vi.restoreAllMocks();
    await resetTables(
      db.pool,
      [
        "token_usage_events", "imported_session_records", "imported_sessions", "activity_records",
        "host_threads", "workspace_locations", "project_folders", "project_members", "hosts", "machines",
        "projects", "space_memberships", "users", "spaces",
      ],
      { cascade: true },
    );
    await seedTopology();
  });

  function service() {
    return new ImportedSessionService(db.pool, serverConfig());
  }

  it("marks a session gone when the host stops listing it, even though the server still holds it", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    const first = stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    first.mockRestore();

    // The second sync sends nothing back because the host no longer has it.
    // Deciding "gone" from the server's own held set would keep it present
    // forever — the server always holds the session in question.
    stubHost([], []);
    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    expect(report.marked_gone).toBe(1);

    const rows = await new PgImportedSessionRepository(db.pool).listForLocation(SPACE, LOCATION);
    expect(rows[0]).toMatchObject({ source_state: "gone", record_count: 1 });
  });

  it("marks nothing gone when the enumeration itself failed", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    // An empty list from a host that could not answer is evidence of nothing.
    vi.restoreAllMocks();
    stubHost([], null);
    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    expect(report.error).toBe("host_offline");
    expect(report.marked_gone).toBe(0);
  });

  it("marks nothing gone when the request named only some sessions", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    vi.restoreAllMocks();
    stubHost([replay("sess-2")], ["sess-2"]);
    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code", session_ids: ["sess-2"] });
    expect(report.marked_gone).toBe(0);
  });

  it("forwards reported token usage once, and not again on a re-sync", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    const usage = [{
      record_key: "usage-0",
      model: "claude-x",
      occurred_at: "2026-08-20T10:00:00.000Z",
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
    }];
    stubHost([replay("sess-1", { usage })], ["sess-1"]);
    const first = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    expect(first.usage_events).toBe(1);
    expect(first.usage_failures).toBe(0);

    const ledger = await db.pool.query<{ total: string; owner: string; source_type: string }>(
      `SELECT count(*)::text AS total, min(owner_user_id) AS owner, min(source_type) AS source_type
         FROM token_usage_events WHERE space_id = $1`,
      [SPACE],
    );
    expect(ledger.rows[0]).toMatchObject({ total: "1", owner: OWNER, source_type: "ambient_host_history" });

    vi.restoreAllMocks();
    stubHost([replay("sess-1", { usage })], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    const after = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM token_usage_events WHERE space_id = $1`,
      [SPACE],
    );
    expect(after.rows[0]!.total).toBe("1");
  });

  it("writes one Activity pointer per sync, carrying counts rather than content", async () => {
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync({ spaceId: SPACE, userId: OWNER }, LOCATION, { adapter_type: "claude_code" });
    const rows = await db.pool.query<{ title: string; content: string; source_kind: string }>(
      `SELECT title, content, source_kind FROM activity_records WHERE space_id = $1`,
      [SPACE],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.title).toMatch(/Imported 1 claude_code session/);
    expect(rows.rows[0]!.content).not.toMatch(/hello/);
  });

  it("refuses a sync requested by someone who does not own the host", async () => {
    await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "admin" });
    stubHost([replay("sess-1")], ["sess-1"]);
    await expect(service().sync({ spaceId: SPACE, userId: OTHER }, LOCATION, { adapter_type: "claude_code" }))
      .rejects.toThrow(/host owner/i);
  });

  it("keeps administering a session possible after its Location is unregistered", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });
    const [session] = await new PgImportedSessionRepository(db.pool).listForLocation(SPACE, LOCATION);

    // Unbinding the folder must not destroy the history — by now the vendor
    // may have deleted its own copy — and must not strand it beyond reach.
    await db.pool.query(`DELETE FROM workspace_locations WHERE id = $1`, [LOCATION]);
    const survivor = await new PgImportedSessionRepository(db.pool).byId(SPACE, session!.id);
    expect(survivor).toMatchObject({ workspace_location_id: null, record_count: 1 });

    await expect(service().setVisibility(identity, session!.id, "private")).resolves.toMatchObject({
      visibility: "private",
    });
    expect(await service().remove(identity, [session!.id])).toBe(1);
  });

  it("does not open a transcript to a viewer the gate grants only summary access", async () => {
    await seedSpaceMember(db.pool, { space: SPACE, user: OTHER, role: "admin" });
    await db.pool.query(`UPDATE spaces SET oversight_mode = 'summary' WHERE id = $1`, [SPACE]);
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, OTHER],
    );
    const repository = new PgImportedSessionRepository(db.pool);
    const secret = await repository.reconcile({
      spaceId: SPACE,
      projectId: PROJECT,
      projectFolderId: FOLDER,
      workspaceLocationId: LOCATION,
      executionHostId: HOST,
      ownerUserId: OWNER,
      adapterType: "claude_code",
      installation: "own",
      visibility: "private",
      session: { session_id: "sess-secret", cwd: "/home/me/project", title: "Private", updated_at: null },
      loadState: "complete",
      error: null,
      records: [],
    });

    // Oversight grants `summary` over a colleague's private content. A
    // transcript is the content itself, so summary must not open it — the
    // failure mode is an admin silently reading a teammate's terminal work.
    await expect(service().records({ spaceId: SPACE, userId: OTHER }, secret.session.id))
      .rejects.toThrow(/not found/i);
  });

  it("re-adopts its history when the same folder is bound again, instead of importing a second copy", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    // Unregistering nulls the location, and Postgres treats nulls as distinct,
    // so the source-identity constraint stops constraining. Without adoption a
    // rebind imports the whole history again.
    await db.pool.query(`DELETE FROM workspace_locations WHERE id = $1`, [LOCATION]);
    const REBOUND = "6f000000-0000-4000-8000-000000000001";
    await db.pool.query(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind, display_path,
         execution_ready, status, preferred, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'remote','/home/me/project',true,'active',true,now(),now())`,
      [REBOUND, SPACE, FOLDER, HOST],
    );

    vi.restoreAllMocks();
    stubHost([replay("sess-1")], ["sess-1"]);
    await service().sync(identity, REBOUND, { adapter_type: "claude_code" });

    const all = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM imported_sessions WHERE space_id = $1`,
      [SPACE],
    );
    expect(all.rows[0]!.total).toBe("1");
    const rows = await new PgImportedSessionRepository(db.pool).listForLocation(SPACE, REBOUND);
    expect(rows[0]).toMatchObject({ record_count: 1, workspace_location_id: REBOUND });
  });

  it("keeps the sessions it did write when a daemon reports one in a shape this server rejects", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    // A daemon is a machine the person owns, not a trusted peer: what it sends
    // is parsed, and one report that does not fit the contract is dropped
    // rather than allowed to cost the sessions that did — the source may not
    // exist to retry against.
    const oversized = replay("sess-bad", {
      records: [{ ...replay("sess-bad").records[0]!, record_key: "k".repeat(300) }],
    });
    stubHost([replay("sess-good"), oversized], ["sess-good", "sess-bad"]);
    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    expect(report.sessions_written).toBe(1);
    expect(report.malformed_sessions).toBe(1);
    const rows = await new PgImportedSessionRepository(db.pool).listForLocation(SPACE, LOCATION);
    expect(rows.map((row) => row.vendor_session_id)).toContain("sess-good");
    // A sync that partly failed still leaves a record of itself.
    const activity = await db.pool.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM activity_records WHERE space_id = $1`,
      [SPACE],
    );
    expect(activity.rows[0]!.total).toBe("1");
  });

  it("does not import a vendor session already owned by a host thread", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    const room = await db.pool.query<{ id: string }>(
      `SELECT id FROM rooms WHERE space_id = $1 AND project_id = $2 AND is_mainline = true LIMIT 1`,
      [SPACE, PROJECT],
    );
    const agentId = randomUUID();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, project_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Room host Agent', 'active', 'standard', 'private', now(), now())`,
      [agentId, SPACE, PROJECT, OWNER],
    );
    await db.pool.query(
      `INSERT INTO host_threads (
         id, workspace_location_id, room_id, agent_id, adapter_type,
         runtime_installation, vendor_session_id, status, created_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'claude_code', 'own', 'agent-session-1', 'active', $5, now(), now())`,
      [randomUUID(), LOCATION, room.rows[0]!.id, agentId, OWNER],
    );
    stubHost([replay("agent-session-1")], ["agent-session-1"]);

    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    expect(report.sessions_seen).toBe(0);
    expect(report.sessions_written).toBe(0);
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM imported_sessions WHERE vendor_session_id = 'agent-session-1'`,
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("keeps excluding an Agent's session after its thread was reset and closed", async () => {
    const identity = { spaceId: SPACE, userId: OWNER };
    const room = await db.pool.query<{ id: string }>(
      `SELECT id FROM rooms WHERE space_id = $1 AND project_id = $2 AND is_mainline = true LIMIT 1`,
      [SPACE, PROJECT],
    );
    const agentId = randomUUID();
    await db.pool.query(
      `INSERT INTO agents (id, space_id, project_id, owner_user_id, name, status, agent_kind, visibility, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Room host Agent', 'active', 'standard', 'private', now(), now())`,
      [agentId, SPACE, PROJECT, OWNER],
    );
    const threadId = randomUUID();
    await db.pool.query(
      `INSERT INTO host_threads (
         id, workspace_location_id, room_id, agent_id, adapter_type,
         runtime_installation, vendor_session_id, status, created_by_user_id,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'claude_code', 'own', 'agent-session-old', 'active', $5, now(), now())`,
      [threadId, LOCATION, room.rows[0]!.id, agentId, OWNER],
    );
    const threads = new PgHostThreadRepository(db.pool);
    // Reset moves the thread on from its first session; the second session
    // then breaks on resume; finally the specialist leaves the Room.
    await threads.resetRoomAgent(room.rows[0]!.id, agentId);
    await threads.recordRunOutcome(threadId, { lastRunId: randomUUID(), vendorSessionId: "agent-session-mid", sessionReset: false });
    await threads.recordRunOutcome(threadId, { lastRunId: randomUUID(), vendorSessionId: null, sessionReset: true });
    await threads.closeRoomAgent(room.rows[0]!.id, agentId);
    await expect(db.pool.query<{ vendor_session_id: string | null; retired: string[] }>(
      `SELECT vendor_session_id, retired_vendor_session_ids AS retired FROM host_threads WHERE id = $1`,
      [threadId],
    )).resolves.toMatchObject({ rows: [{ vendor_session_id: null, retired: ["agent-session-old", "agent-session-mid"] }] });

    stubHost([replay("agent-session-old"), replay("agent-session-mid")], ["agent-session-old", "agent-session-mid"]);
    const report = await service().sync(identity, LOCATION, { adapter_type: "claude_code" });

    expect(report.sessions_written).toBe(0);
    await expect(db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM imported_sessions WHERE vendor_session_id IN ('agent-session-old', 'agent-session-mid')`,
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});
