import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrator.js";
import { useTestDatabase } from "./support/testDatabase.js";

// 0001_agent_workbench was rewritten as a schema-only diff; the repair part of
// 0002 (squashed from 0002_skill_library_packages and
// 0003_repair_upgrade_backfills) restores the row transitions its replaced
// development migrations performed (ADR 0025 addendum). The database here
// takes the production path: 0001 by normal `up` over rows in the pre-0001
// shape, then the rest of the chain.
const db = useTestDatabase(import.meta.filename, { empty: true });
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
// The squash keeps each source file whole between the runner's boundaries;
// the second part is the former 0003 repair.
const REPAIR = readFileSync(join(MIGRATIONS_DIR, "0002_skill_library_and_upgrade_repairs.sql"), "utf8")
  .split(/^RESET search_path;$/m)[1]!;
let root: string;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "rainver-repair-migration-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

async function seedPreUpgradeRows(): Promise<void> {
  const client = await db.pool.connect();
  try {
    // Seeded without their own parents; the repair's own writes still run
    // under every constraint, so the parents of those rows are real.
    await client.query("SET session_replication_role = replica");
    await client.query(`
      INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ('space', 'Space', 'personal', now(), now());
      INSERT INTO users (id, email, display_name, registration_source, status, created_at, updated_at)
        VALUES ('user', 'user@example.test', 'User', 'system', 'active', now(), now()),
               ('user-2', 'user-2@example.test', 'User 2', 'system', 'active', now(), now());
      INSERT INTO agents (id, space_id, name, status, visibility, created_at, updated_at)
        VALUES ('agent', 'space', 'Agent', 'active', 'space_shared', now(), now()),
               ('agent-2', 'space', 'Agent 2', 'active', 'space_shared', now(), now());
      INSERT INTO agent_runtime_profiles (id, space_id, agent_id, name, runtime_key, backend_mode, created_at, updated_at)
        VALUES ('profile-agent', 'space', 'agent', 'Claude', 'claude', 'runtime_native', now(), now()),
               ('profile-agent-2', 'space', 'agent-2', 'Claude', 'claude', 'runtime_native', now(), now());
      INSERT INTO projects (id, space_id, name, status, created_at, updated_at) VALUES ('project', 'space', 'Project', 'active', now(), now());
      INSERT INTO policy_decision_records (id, action, decision, risk_level, created_at) VALUES ('p', 'setup', 'allow', 'low', now());
      INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status, created_at, updated_at)
        VALUES ('room', 'space', 'project', 'owner', 'Room', 'active', now(), now());
      INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
        VALUES ('member', 'space', 'room', 'agent', 'member', 'active', now(), now()),
               ('member-2', 'space', 'room', 'agent-2', 'member', 'active', now(), now());
      INSERT INTO sessions (id, space_id, room_id, project_id, status, created_at, updated_at) VALUES
        ('conversation-1', 'space', 'room', 'project', 'active', now(), now()),
        ('conversation-2', 'space', 'room', 'project', 'active', now(), now()),
        ('conversation-3', 'space', 'room', 'project', 'active', now(), now());
      INSERT INTO runs (id, space_id, session_id, execution_kind, agent_id, agent_version_id, run_type,
        trigger_origin, status, mode, created_at, updated_at) VALUES
        ('run-1', 'space', 'conversation-1', 'agent', 'agent', 'version', 'agent', 'manual', 'failed', 'live', now(), now()),
        ('run-3', 'space', 'conversation-3', 'agent', 'agent', 'version', 'agent', 'manual', 'failed', 'live', now(), now());
      INSERT INTO messages (id, space_id, session_id, role, content, path_depth, branch_path, created_at) VALUES
        ('message-1', 'space', 'conversation-1', 'user', 'one', 0, 'a', now()),
        ('message-2', 'space', 'conversation-2', 'user', 'two', 0, 'b', now()),
        ('message-3', 'space', 'conversation-1', 'user', 'three', 0, 'c', now());
      INSERT INTO context_events (id, space_id, work_context_scope_id, scope_sequence, event_type,
        canonical_ref_json, canonical_ref_key, trust, sensitivity, token_estimate, confirmation_state,
        capture_status, created_at)
      SELECT id, 'space', scope, sequence, 'message', ref::jsonb, id, 'trusted', 'normal', 1, 'observed', capture, now()
        FROM (VALUES
          ('event-1', 'member', 1, '{"type":"message","id":"message-1"}', 'complete'),
          ('event-2', 'member', 2, '{"type":"message","id":"message-2"}', 'complete'),
          ('event-3', 'member', 3, '{"type":"message","id":"message-3"}', 'complete'),
          ('event-4', 'member', 4, '{"type":"note","id":"elsewhere"}', 'complete'),
          ('event-5', 'member-2', 1, '{"type":"message","id":"message-2"}', 'recovered'))
          AS event(id, scope, sequence, ref, capture);
      INSERT INTO context_event_scopes (space_id, work_context_scope_id, event_head_cursor, capture_status, updated_at)
        VALUES ('space', 'member', 4, 'partial', now()), ('space', 'member-2', 1, 'recovered', now());
      -- Open gaps on the whole-Room scope: one from a Run of conversation-1,
      -- one from reconciliation (its invocation names the scope, no Run), one
      -- from a Run of a Conversation with no captured events. A recovered gap
      -- is history, not a hole.
      INSERT INTO context_capture_gaps (id, space_id, work_context_scope_id, invocation_id, code,
        after_cursor, before_cursor, detail, replay_event_json, status, created_at) VALUES
        ('gap-run', 'space', 'member', 'run-1', 'ingest_failed', 1, 3, 'lost tool result',
          '{"invocation_id":"run-1"}', 'open', '2026-10-01T00:00:00Z'),
        ('gap-reconcile', 'space', 'member', 'member', 'reconciliation_mismatch', 4, NULL, 'count=3',
          NULL, 'open', '2026-10-02T00:00:00Z'),
        ('gap-unsplit', 'space', 'member', 'run-3', 'ingest_failed', 4, NULL, NULL,
          '{"invocation_id":"run-3"}', 'open', '2026-10-03T00:00:00Z'),
        ('gap-recovered', 'space', 'member', NULL, 'ingest_failed', 0, NULL, NULL,
          NULL, 'recovered', '2026-09-01T00:00:00Z');
      INSERT INTO work_context_setups (id, space_id, work_context_scope_id, scope_kind, version, user_id,
        project_id, project_instruction_enabled, setup_fingerprint, reason, policy_decision_record_id,
        created_by_user_id, created_at, retrieval_preferences_json) VALUES
        ('setup-old', 'space', 'member', 'room_recipient', 1, 'user', 'project', true, 'f1', 'r', 'p', 'user', now(), '{"web":false}'),
        ('setup-new', 'space', 'member', 'room_recipient', 2, 'user', 'project', true, 'f2', 'r', 'p', 'user', now(), '{"web":true}');
      INSERT INTO host_threads (id, space_id, execution_host_id, workspace_mode, session_id, agent_id,
        container_kind, runtime_key, vendor_session_id, retired_vendor_session_ids, status,
        created_by_user_id, created_at, updated_at) VALUES
        ('thread-open', 'space', 'host', 'managed', 'conversation-1', 'agent', 'conversation', 'claude', 'vs-open', '[]', 'active', 'user', now(), now()),
        ('thread-closed', 'space', 'host', 'managed', 'conversation-2', 'agent-2', 'conversation', 'claude', NULL, '["vs-closed"]', 'closed', 'user', now(), now());
      INSERT INTO runtime_context_cli_bindings (id, space_id, work_context_scope_id, scope_kind, user_id,
        agent_id, runtime_profile_id, runtime_key, runtime_state_key, vendor_session_id,
        authority_fingerprint, runtime_fingerprint, fingerprint_json, cli_known_cursor, created_at, updated_at)
      SELECT id, 'space', scope, kind, user_id, agent_id, 'profile-' || agent_id, 'claude', id, vendor, 'a', 'r', '{}'::jsonb, cursor, now(), now()
        FROM (VALUES
          ('follows-thread', 'member', 'room_recipient', 'user', 'agent', 'vs-open', 3),
          ('room-without-session', 'member', 'room_recipient', 'user-2', 'agent', NULL, 0),
          ('closed-thread-session', 'direct-1', 'direct_session', 'user', 'agent-2', 'vs-closed', 0),
          ('server-local', 'direct-2', 'direct_session', 'user', 'agent', 'vs-local', 0))
          AS binding(id, scope, kind, user_id, agent_id, vendor, cursor);
      INSERT INTO jobs (id, space_id, job_type, status, priority, payload_json, attempts, max_attempts, created_at, updated_at)
      SELECT id, 'space', job_type, status, 10, jsonb_build_object('work_context_scope_id', scope, 'target_cursor', cursor), 0, 5, now(), now()
        FROM (VALUES
          ('checkpoint-room-pending', 'runtime_context_checkpoint', 'pending', 'member', 4),
          ('checkpoint-room-claimed', 'runtime_context_checkpoint', 'claimed', 'member-2', 1),
          ('checkpoint-room-completed', 'runtime_context_checkpoint', 'completed', 'member', 2),
          ('checkpoint-direct', 'runtime_context_checkpoint', 'pending', 'direct-1', 1),
          ('other-room-job', 'room_dispatch', 'pending', 'member', 4))
          AS job(id, job_type, status, scope, cursor);
    `);
  } finally {
    await client.query("RESET session_replication_role").catch(() => {});
    client.release();
  }
}

async function snapshot() {
  const query = async (sql: string) => (await db.pool.query(sql)).rows;
  return {
    scopes: await query(`SELECT session_id, room_agent_member_id, id FROM room_conversation_recipients ORDER BY session_id, room_agent_member_id`),
    events: await query(`SELECT id, work_context_scope_id, scope_sequence FROM context_events ORDER BY id`),
    heads: await query(`SELECT work_context_scope_id, event_head_cursor, capture_status FROM context_event_scopes ORDER BY work_context_scope_id`),
    gaps: await query(`SELECT work_context_scope_id, invocation_id, code, after_cursor, before_cursor, detail,
                              replay_event_json, status, created_at
                         FROM context_capture_gaps ORDER BY work_context_scope_id, created_at`),
    setups: await query(`SELECT work_context_scope_id, version, retrieval_preferences_json FROM work_context_setups ORDER BY work_context_scope_id, version`),
    jobs: await query(`SELECT id, status, error IS NOT NULL AS has_error FROM jobs ORDER BY id`),
  };
}

describe("0002 repairs rows upgraded through the schema-only 0001 (real PostgreSQL)", () => {
  it("re-keys bindings, splits Room ledgers with their capture gaps, and leaves nothing active but unreachable", async (ctx) => {
    if (!db.available) return ctx.skip();
    const prefix = join(root, "published-prefix");
    mkdirSync(prefix);
    for (const file of ["0000_baseline.sql", "0001_agent_workbench.sql"]) cpSync(join(MIGRATIONS_DIR, file), join(prefix, file));
    await migrate(db.pool, prefix);
    await seedPreUpgradeRows();

    // The repair is asserted at the end of 0002: 0003 drops the CLI binding
    // table the repair also re-keys, so its idempotent re-run below needs the
    // chain to stop there first.
    const through0002 = join(root, "through-0002");
    mkdirSync(through0002);
    for (const file of ["0000_baseline.sql", "0001_agent_workbench.sql", "0002_skill_library_and_upgrade_repairs.sql"]) {
      cpSync(join(MIGRATIONS_DIR, file), join(through0002, file));
    }
    expect((await migrate(db.pool, through0002)).applied).toContain("0002");
    const after = await snapshot();
    const scopes = Object.fromEntries(after.scopes.map((row) => [`${row.session_id}/${row.room_agent_member_id}`, row.id as string]));
    const scope: Record<string, string> = { "conversation-1": scopes["conversation-1/member"]!, "conversation-2": scopes["conversation-2/member"]! };
    expect(Object.keys(scopes)).toEqual(["conversation-1/member", "conversation-2/member", "conversation-2/member-2"]);

    // Each Conversation's events move in order; an event naming no
    // Conversation stays on the whole-Room scope.
    expect(after.events).toEqual([
      { id: "event-1", work_context_scope_id: scope["conversation-1"], scope_sequence: 1 },
      { id: "event-2", work_context_scope_id: scope["conversation-2"], scope_sequence: 1 },
      { id: "event-3", work_context_scope_id: scope["conversation-1"], scope_sequence: 2 },
      { id: "event-4", work_context_scope_id: "member", scope_sequence: 4 },
      { id: "event-5", work_context_scope_id: scopes["conversation-2/member-2"], scope_sequence: 1 },
    ]);
    // A known hole in the Room history keeps every Conversation it may belong
    // to partial; only a history without one may be complete or recovered.
    expect(after.heads).toEqual(expect.arrayContaining([
      { work_context_scope_id: scope["conversation-1"], event_head_cursor: 2, capture_status: "partial" },
      { work_context_scope_id: scope["conversation-2"], event_head_cursor: 1, capture_status: "partial" },
      { work_context_scope_id: scopes["conversation-2/member-2"], event_head_cursor: 1, capture_status: "recovered" },
      { work_context_scope_id: "member", event_head_cursor: 4, capture_status: "partial" },
    ]));
    // The Run's gap moves to its own Conversation with its replay payload and
    // cursors on the new sequence. The reconciliation gap is copied into every
    // split Conversation of that recipient (no replay; the original stays),
    // and the gap of an unsplit Conversation's Run stays where it was.
    const gap = (scopeId: string, invocation: string | null, code: string, afterCursor: number,
      beforeCursor: number | null, detail: string | null, replay: unknown, status: string, createdAt: string) => ({
      work_context_scope_id: scopeId, invocation_id: invocation, code, after_cursor: afterCursor,
      before_cursor: beforeCursor, detail, replay_event_json: replay, status, created_at: new Date(createdAt),
    });
    expect(after.gaps).toEqual(expect.arrayContaining([
      gap(scope["conversation-1"], "run-1", "ingest_failed", 1, 2, "lost tool result", { invocation_id: "run-1" }, "open", "2026-10-01T00:00:00Z"),
      gap(scope["conversation-1"], "member", "reconciliation_mismatch", 2, null, "count=3", null, "open", "2026-10-02T00:00:00Z"),
      gap(scope["conversation-2"], "member", "reconciliation_mismatch", 1, null, "count=3", null, "open", "2026-10-02T00:00:00Z"),
      gap("member", "member", "reconciliation_mismatch", 4, null, "count=3", null, "open", "2026-10-02T00:00:00Z"),
      gap("member", "run-3", "ingest_failed", 4, null, null, { invocation_id: "run-3" }, "open", "2026-10-03T00:00:00Z"),
    ]));
    expect(after.gaps).toHaveLength(6);
    // The latest Setup follows into every split Conversation.
    for (const conversation of ["conversation-1", "conversation-2"]) {
      expect(after.setups).toContainEqual({ work_context_scope_id: scope[conversation], version: 1, retrieval_preferences_json: { web: true } });
    }

    // The CLI binding rows 0002 re-keyed were dropped with their table in 0003;
    // the repair itself still ran over them under every constraint.

    // Unfinished checkpoints of a whole-Room recipient scope are cancelled;
    // finished ones, other scopes' checkpoints and other job types are not.
    expect(after.jobs).toEqual([
      { id: "checkpoint-direct", status: "pending", has_error: false },
      { id: "checkpoint-room-claimed", status: "cancelled", has_error: true },
      { id: "checkpoint-room-completed", status: "completed", has_error: false },
      { id: "checkpoint-room-pending", status: "cancelled", has_error: true },
      { id: "other-room-job", status: "pending", has_error: false },
    ]);

    // A database that already carries the new shape (the original development
    // migrations, or this one) is left exactly as it is.
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(REPAIR);
      await client.query("COMMIT");
    } finally { client.release(); }
    expect(await snapshot()).toEqual(after);

    // The rest of the chain applies over the repaired rows.
    expect((await migrate(db.pool, MIGRATIONS_DIR)).applied).toContain("0003");
  });
});
