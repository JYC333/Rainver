import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedAgentWithVersion, seedConversationMessages, seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { loadConfig } from "../src/config.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { roomsModule } from "../src/modules/rooms/index.js";
import { RoomService } from "../src/modules/rooms/service.js";
import {
  DISPOSABLE_MESSAGE_REFERENCES,
  EXCLUSIVE_SESSION_CONTENT,
  MESSAGE_ANCHOR_REFERENCES,
  PROTECTED_SESSION_REFERENCES,
  SESSION_BINDING_REFERENCES,
  purgeExpiredRoomConversations,
} from "../src/modules/rooms/conversationTrash.js";
import { lockRoomConversationQueue } from "../src/modules/rooms/messageQueue.js";

const db = useTestDatabase(import.meta.filename);
const space = "space-trash";
const owner = { spaceId: space, userId: "trash-owner" };
const viewer = { spaceId: space, userId: "trash-viewer" };
const editor = { spaceId: space, userId: "trash-editor" };
const page = { limit: 20, offset: 0 };
let roomId: string;
let service: RoomService;

async function conversation(title: string, status = "active"): Promise<string> {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO sessions (id, space_id, room_id, project_id, title, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'project-trash', $4, $5, now(), now())`,
    [id, space, roomId, title, status],
  );
  return id;
}

async function ageDeletion(sessionId: string, days: number): Promise<void> {
  await db.pool.query("UPDATE sessions SET deleted_at = now() - make_interval(days => $2) WHERE id = $1", [sessionId, days]);
}

const sessionRow = async (id: string) =>
  (await db.pool.query("SELECT status, title, deleted_at, deleted_from_status, purged_at FROM sessions WHERE id = $1", [id])).rows[0];

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  await seedSpaceOwnerProject(db.pool, { space, owner: owner.userId, project: "project-trash", spaceType: "team" });
  roomId = (await db.pool.query<{ id: string }>("SELECT id FROM rooms WHERE project_id = 'project-trash'")).rows[0]!.id;
  for (const [user, role] of [[viewer.userId, "viewer"], [editor.userId, "member"]] as const) {
    await seedSpaceMember(db.pool, { space, user });
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, 'project-trash', $3, $4, 'active', now(), now())`,
      [randomUUID(), space, user, role],
    );
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), space, roomId, user],
    );
  }
  service = new RoomService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), db.pool);
});

afterEach(() => __setAuthIdentityForTests(null));

describe("Room conversation recycle bin", () => {
  it("restores a deleted conversation to the list it came from within the window", async () => {
    const active = await conversation("Planning");
    const archived = await conversation("Old notes", "archived");
    await seedConversationMessages(db.pool, { space, session: active, messages: [{ id: randomUUID(), role: "user", content: "Kept through deletion", userId: owner.userId }] });

    await service.deleteConversation(owner, roomId, active);
    await service.deleteConversation(owner, roomId, archived);
    await expect(service.listConversations(owner, roomId, page)).resolves.toMatchObject({ items: [], total: 0 });
    const bin = await service.listConversations(owner, roomId, { ...page, status: "deleted" });
    expect(bin.total).toBe(2);
    for (const item of bin.items) {
      expect(Date.parse(item.purge_after!) - Date.parse(item.deleted_at!)).toBe(30 * 86_400_000);
    }
    expect(await sessionRow(archived)).toMatchObject({ status: "deleted", deleted_from_status: "archived" });

    await service.restoreDeletedConversation(owner, roomId, active);
    await service.restoreDeletedConversation(owner, roomId, archived);
    expect(await sessionRow(active)).toMatchObject({ status: "active", deleted_at: null, deleted_from_status: null });
    expect(await sessionRow(archived)).toMatchObject({ status: "archived", deleted_at: null });
    await expect(service.listConversations(owner, roomId, { ...page, status: "deleted" })).resolves.toMatchObject({ total: 0 });
    await expect(db.pool.query("SELECT content FROM messages WHERE session_id = $1", [active]))
      .resolves.toMatchObject({ rows: [{ content: "Kept through deletion" }] });
  });

  it("withholds the bin and restore from Room members who cannot delete", async () => {
    const id = await conversation("Private plan");
    await service.deleteConversation(owner, roomId, id);
    await expect(service.listConversations(viewer, roomId, { ...page, status: "deleted" })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.restoreDeletedConversation(viewer, roomId, id)).rejects.toMatchObject({ statusCode: 403 });

    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [roomsModule]);
    const viewerDecisions = async () =>
      Number((await db.pool.query("SELECT count(*) FROM policy_decision_records WHERE actor_id = $1", [viewer.userId])).rows[0].count);
    try {
      __setAuthIdentityForTests(viewer);
      const list = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/conversations?status=deleted` });
      expect(list.statusCode, list.body).toBe(403);
      const decisionsBefore = await viewerDecisions();
      const refused = await app.inject({
        method: "POST", url: `/api/v1/rooms/${roomId}/conversations/${id}/restore-deleted`,
        headers: { "idempotency-key": randomUUID() },
      });
      // The operation core reports a refused command as not found, and refuses
      // it at admission: no policy decision is taken for a non-writer.
      expect(refused.statusCode, refused.body).toBe(404);
      expect(await viewerDecisions()).toBe(decisionsBefore);
      expect((await sessionRow(id)).status).toBe("deleted");

      __setAuthIdentityForTests(owner);
      const listed = await app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/conversations?status=deleted` });
      expect(listed.json()).toMatchObject({ total: 1, items: [{ id, title: "Private plan", status: "deleted" }] });
      const restored = await app.inject({
        method: "POST", url: `/api/v1/rooms/${roomId}/conversations/${id}/restore-deleted`,
        headers: { "idempotency-key": randomUUID() },
      });
      expect(restored.statusCode, restored.body).toBe(200);
      expect((await sessionRow(id)).status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("re-checks Project writer authority when a restore receipt is replayed", async () => {
    const id = await conversation("Shared plan");
    await service.deleteConversation(owner, roomId, id);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri }), [roomsModule]);
    const key = randomUUID();
    const restore = () => app.inject({
      method: "POST", url: `/api/v1/rooms/${roomId}/conversations/${id}/restore-deleted`,
      headers: { "idempotency-key": key },
    });
    try {
      __setAuthIdentityForTests(editor);
      const first = await restore();
      expect(first.statusCode, first.body).toBe(200);
      const replay = await restore();
      expect(replay.statusCode, replay.body).toBe(200);

      // Still a Room member, no longer a Project writer.
      await db.pool.query("UPDATE project_members SET role = 'viewer' WHERE user_id = $1", [editor.userId]);
      const demoted = await restore();
      expect(demoted.statusCode, demoted.body).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("rejects a deleted row that does not record the list it came from", async () => {
    const id = await conversation("Half-recorded");
    await expect(db.pool.query(
      "UPDATE sessions SET status = 'deleted', deleted_at = now(), deleted_from_status = NULL WHERE id = $1", [id],
    )).rejects.toMatchObject({ code: "23514", constraint: "ck_sessions_trash_state" });
    await expect(db.pool.query(
      "UPDATE sessions SET status = 'deleted', deleted_at = now(), deleted_from_status = 'deleted' WHERE id = $1", [id],
    )).rejects.toMatchObject({ code: "23514" });
    expect(await sessionRow(id)).toMatchObject({ status: "active", deleted_at: null });
  });

  it("refuses a restore that obtains the conversation locks only after the window closed", async () => {
    const id = await conversation("Last minute");
    await service.deleteConversation(owner, roomId, id);
    await db.pool.query(
      "UPDATE sessions SET deleted_at = now() - interval '30 days' + interval '1500 milliseconds' WHERE id = $1", [id],
    );
    const deadline = (await db.pool.query<{ at: Date }>("SELECT deleted_at + interval '30 days' AS at FROM sessions WHERE id = $1", [id])).rows[0]!.at;

    // A second connection holds the queue lock, as a delete, restore or purge would.
    const blocker = await db.pool.connect();
    let restore: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await lockRoomConversationQueue(blocker, space, id);
      restore = service.restoreDeletedConversation(owner, roomId, id);
      restore.catch(() => undefined);
      // The restore's transaction began before the deadline and is waiting on the lock.
      let waiting: { xact_start: Date } | undefined;
      for (let tries = 0; !waiting && tries < 100; tries += 1) {
        // Polled outside the blocker: a transaction keeps its first pg_stat_activity snapshot.
        waiting = (await db.pool.query<{ xact_start: Date }>(
          `SELECT xact_start FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        )).rows[0];
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBeDefined();
      expect(waiting!.xact_start.getTime()).toBeLessThan(deadline.getTime());
      while ((await blocker.query<{ past: boolean }>("SELECT clock_timestamp() > $1::timestamptz AS past", [deadline])).rows[0]!.past === false) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    await expect(restore).rejects.toMatchObject({ statusCode: 409 });
    expect(await sessionRow(id)).toMatchObject({ status: "deleted", purged_at: null });
    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 1 });
  });

  it("backs off a conversation whose purge keeps failing so later ones are not starved", async () => {
    const poisoned = await conversation("Poisoned");
    const later = await conversation("Later");
    await db.pool.query(
      `INSERT INTO room_queued_messages (id, space_id, room_id, session_id, user_id, content, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'poison', 'withdrawn', now(), now())`,
      [randomUUID(), space, roomId, poisoned, owner.userId],
    );
    for (const id of [poisoned, later]) await service.deleteConversation(owner, roomId, id);
    await ageDeletion(poisoned, 45);
    await ageDeletion(later, 31);
    await db.pool.query(`CREATE FUNCTION trash_test_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.content = 'poison' THEN RAISE EXCEPTION 'poisoned purge'; END IF; RETURN OLD; END $$`);
    await db.pool.query(`CREATE TRIGGER trash_test_poison BEFORE DELETE ON room_queued_messages
      FOR EACH ROW EXECUTE FUNCTION trash_test_poison()`);
    const attempts = async (id: string) => (await db.pool.query<{ purge_attempts: number; retry_in: number | null }>(
      `SELECT purge_attempts, extract(epoch FROM purge_retry_at - now())::float AS retry_in FROM sessions WHERE id = $1`, [id],
    )).rows[0]!;
    try {
      const failures: string[] = [];
      const onFailure = (id: string) => failures.push(id);
      // The oldest fails, is counted and deferred; the purge still reports it.
      await expect(purgeExpiredRoomConversations(db.pool, { limit: 1, onFailure })).rejects.toThrow(/failed for 1/);
      expect(failures).toEqual([poisoned]);
      expect(await attempts(poisoned)).toMatchObject({ purge_attempts: 1, retry_in: expect.closeTo(3600, -2) });

      // Even once its retry is due, a conversation never tried goes first.
      await db.pool.query("UPDATE sessions SET purge_retry_at = now() - interval '1 second' WHERE id = $1", [poisoned]);
      await expect(purgeExpiredRoomConversations(db.pool, { limit: 1, onFailure })).resolves.toMatchObject({ removed: 1 });
      expect(await sessionRow(later)).toBeUndefined();

      // Each further failure doubles the wait.
      await expect(purgeExpiredRoomConversations(db.pool, { limit: 1, onFailure })).rejects.toThrow();
      expect(await attempts(poisoned)).toMatchObject({ purge_attempts: 2, retry_in: expect.closeTo(7200, -2) });
      await expect(purgeExpiredRoomConversations(db.pool, { onFailure })).resolves.toMatchObject({ removed: 0, failed: 0 });
    } finally {
      await db.pool.query("DROP TRIGGER trash_test_poison ON room_queued_messages");
      await db.pool.query("DROP FUNCTION trash_test_poison()");
    }
    await db.pool.query("UPDATE sessions SET purge_retry_at = now() WHERE id = $1", [poisoned]);
    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 1 });
  });

  it("keeps a message a Gmail private check started from, with its ancestors", async () => {
    const id = await conversation("Mail question");
    const [first, asked, after] = await seedConversationMessages(db.pool, {
      space, session: id, messages: [
        { id: randomUUID(), role: "user", content: "Hello", userId: owner.userId },
        { id: randomUUID(), role: "user", content: "Check my inbox for the offer", userId: owner.userId },
        { id: randomUUID(), role: "user", content: "Thanks", userId: owner.userId },
      ],
    });
    await seedAgentWithVersion(db.pool, { agent: "agent-mail", version: "version-mail", space, owner: owner.userId });
    const proposal = randomUUID();
    await db.pool.query(
      `INSERT INTO proposals (id, space_id, project_id, proposal_type, status, risk_level, urgency, title, payload_json, created_at, updated_at, created_by_user_id, owner_user_id)
       VALUES ($1, $2, 'project-trash', 'gmail_private_check', 'approved', 'low', 'normal', 'Check mail', '{}', now(), now(), $3, $3)`,
      [proposal, space, owner.userId],
    );
    const check = randomUUID();
    await db.pool.query(
      `INSERT INTO gmail_private_checks (id, space_id, owner_user_id, project_id, gmail_connection_id, connection_generation,
         source_session_id, source_message_id, source_run_id, agent_id, proposal_id, status, result_text, created_at, finished_at)
       VALUES ($1, $2, $3, 'project-trash', $4, 1, $5, $6, $7, 'agent-mail', $8, 'delivered', 'One offer found', now(), now())`,
      [check, space, owner.userId, randomUUID(), id, asked, randomUUID(), proposal],
    );
    await service.deleteConversation(owner, roomId, id);
    await ageDeletion(id, 31);

    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 0, tombstoned: 1, failed: 0 });
    const remaining = await db.pool.query<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE session_id = $1 ORDER BY path_depth", [id],
    );
    expect(remaining.rows).toEqual([{ id: first, content: "" }, { id: asked, content: "" }]);
    expect(remaining.rows.map((row) => row.id)).not.toContain(after);
    await expect(db.pool.query("SELECT result_text FROM gmail_private_checks WHERE id = $1", [check]))
      .resolves.toMatchObject({ rows: [{ result_text: "One offer found" }] });
    expect(await sessionRow(id)).toMatchObject({ status: "deleted", purged_at: expect.anything() });
  });

  it("neither lists, restores nor purges expired or legacy deletions it did not record", async () => {
    const expired = await conversation("Expired");
    await service.deleteConversation(owner, roomId, expired);
    await ageDeletion(expired, 31);
    const legacy = await conversation("Legacy deleted", "deleted");
    await db.pool.query("UPDATE sessions SET updated_at = now() - interval '400 days' WHERE id = $1", [legacy]);

    await expect(service.listConversations(owner, roomId, { ...page, status: "deleted" })).resolves.toMatchObject({ total: 0 });
    await expect(service.restoreDeletedConversation(owner, roomId, expired)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.restoreDeletedConversation(owner, roomId, legacy)).rejects.toMatchObject({ statusCode: 404 });

    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 1, tombstoned: 0, failed: 0 });
    expect(await sessionRow(expired)).toBeUndefined();
    expect(await sessionRow(legacy)).toMatchObject({ status: "deleted", title: "Legacy deleted", deleted_at: null, purged_at: null });
  });

  it("purges exclusive content in bounded batches and keeps what Project records reference", async () => {
    const plain = await conversation("Plain");
    const recent = await conversation("Recent");
    const withRun = await conversation("With a Run");
    const [plainMessage] = await seedConversationMessages(db.pool, {
      space, session: plain, messages: [{ id: randomUUID(), role: "user", content: "Disposable", userId: owner.userId }],
    });
    await db.pool.query(
      `INSERT INTO room_queued_messages (id, space_id, room_id, session_id, user_id, content, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'Queued words', 'withdrawn', now(), now())`,
      [randomUUID(), space, roomId, plain, owner.userId],
    );

    const [trigger, reply, followUp] = await seedConversationMessages(db.pool, {
      space, session: withRun, messages: [
        { id: randomUUID(), role: "user", content: "Start the analysis", userId: owner.userId },
        { id: randomUUID(), role: "assistant", content: "Analysis result" },
        { id: randomUUID(), role: "user", content: "Thanks", userId: owner.userId },
      ],
    });
    await seedRun(db.pool, { id: "run-trash", space, owner: owner.userId, agent: "agent-trash", version: "version-trash" });
    const group = randomUUID();
    await db.pool.query(
      `INSERT INTO agent_run_groups (id, space_id, manager_user_id, title, goal, status, room_id, session_id, trigger_message_id, project_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'Analysis', 'Analyse', 'succeeded', $4, $5, $6, 'project-trash', now(), now())`,
      [group, space, owner.userId, roomId, withRun, trigger],
    );
    await db.pool.query(
      "UPDATE runs SET session_id = $2, project_id = 'project-trash', run_group_id = $3 WHERE id = $1",
      ["run-trash", withRun, group],
    );
    await db.pool.query("UPDATE messages SET run_id = 'run-trash' WHERE id = $1", [reply]);

    for (const id of [plain, recent, withRun]) await service.deleteConversation(owner, roomId, id);
    await ageDeletion(plain, 40);
    await ageDeletion(withRun, 35);
    await ageDeletion(recent, 5);

    await expect(purgeExpiredRoomConversations(db.pool, { limit: 1 })).resolves.toMatchObject({ removed: 1, tombstoned: 0 });
    expect(await sessionRow(plain)).toBeUndefined();
    await expect(db.pool.query("SELECT 1 FROM messages WHERE id = $1", [plainMessage])).resolves.toMatchObject({ rowCount: 0 });
    await expect(db.pool.query("SELECT 1 FROM room_queued_messages WHERE session_id = $1", [plain])).resolves.toMatchObject({ rowCount: 0 });

    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 0, tombstoned: 1, failed: 0 });
    expect(await sessionRow(withRun)).toMatchObject({ status: "deleted", title: null, purged_at: expect.anything() });
    const remaining = await db.pool.query<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE session_id = $1 ORDER BY path_depth", [withRun],
    );
    expect(remaining.rows).toEqual([{ id: trigger, content: "" }]);
    expect(remaining.rows.map((row) => row.id)).not.toContain(followUp);
    await expect(db.pool.query("SELECT status, session_id FROM runs WHERE id = 'run-trash'"))
      .resolves.toMatchObject({ rows: [{ status: "succeeded", session_id: withRun }] });
    await expect(db.pool.query("SELECT trigger_message_id FROM agent_run_groups WHERE id = $1", [group]))
      .resolves.toMatchObject({ rows: [{ trigger_message_id: trigger }] });

    // Not yet due, and a tombstone is never processed twice.
    await expect(purgeExpiredRoomConversations(db.pool)).resolves.toMatchObject({ removed: 0, tombstoned: 0 });
    expect(await sessionRow(recent)).toMatchObject({ status: "deleted", title: "Recent", purged_at: null });
    await expect(service.restoreDeletedConversation(owner, roomId, withRun)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("classifies every table that references a conversation", async () => {
    const references = await db.pool.query<{ table_name: string }>(
      `SELECT DISTINCT conrelid::regclass::text AS table_name
         FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'sessions'::regclass AND conrelid <> 'sessions'::regclass
        ORDER BY 1`,
    );
    const classified = new Set<string>([...PROTECTED_SESSION_REFERENCES, ...EXCLUSIVE_SESSION_CONTENT, ...SESSION_BINDING_REFERENCES]);
    expect(references.rows.map((row) => row.table_name).filter((name) => !classified.has(name))).toEqual([]);
  });

  it("classifies every foreign key that references a message", async () => {
    const references = await db.pool.query<{ reference: string }>(
      `SELECT DISTINCT c.conrelid::regclass::text || '.' || a.attname AS reference
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'messages'::regclass
        ORDER BY 1`,
    );
    const classified = new Set<string>([
      ...MESSAGE_ANCHOR_REFERENCES.map(({ table, column }) => `${table}.${column}`),
      ...DISPOSABLE_MESSAGE_REFERENCES,
    ]);
    expect(references.rows.map((row) => row.reference).filter((name) => !classified.has(name))).toEqual([]);
  });
});
