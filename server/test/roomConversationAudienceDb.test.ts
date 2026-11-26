import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { RoomRosterService } from "../src/modules/rooms/rosterService.js";
import { PgRoomRepository } from "../src/modules/rooms/repository.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { listAgentMemoryForDispatch } from "../src/modules/memory/agentMemoryDelivery.js";
import { roomAudience } from "../src/modules/rooms/threadReferences.js";
import { seedConversationMessages, seedProjectMainlineRoom, seedRun } from "./support/domainSeeds.js";
import { waitForBlockedBy } from "./support/lockWait.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

/**
 * Conversation audience (`.agent/modules/rooms.md`, "Conversation audience"):
 * an invitation that does not share history freezes the Room's existing
 * conversations to the people who could read them and opens one new
 * conversation the whole new audience reads.
 */
const db = useTestDatabase(import.meta.url, { max: 8 });
let testRoot: string | undefined;
let rooms: RoomService;
let roster: RoomRosterService;

const SPACE = "space-a";
const PROJECT = "project-a";
const owner = { spaceId: SPACE, userId: "owner" };
const member = { spaceId: SPACE, userId: "member" };
const newcomer = { spaceId: SPACE, userId: "newcomer" };
const later = { spaceId: SPACE, userId: "later" };
const page = { limit: 50, offset: 0 };

beforeAll(async () => {
  if (!db.available) return;
  testRoot = await mkdtemp(join(tmpdir(), "rainver-conversation-audience-"));
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: testRoot });
  rooms = new RoomService(config, db.pool);
  roster = new RoomRosterService(db.pool);
});

afterAll(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  const people = [owner.userId, member.userId, newcomer.userId, later.userId];
  for (const id of people) {
    await db.pool.query(
      `INSERT INTO users (id, display_name, status, created_at, updated_at, email, registration_source)
       VALUES ($1::varchar, $1::varchar, 'active', now(), now(), $1::varchar || '@test.invalid', 'system')`,
      [id],
    );
  }
  await db.pool.query(
    `INSERT INTO spaces (id, name, type, created_by_user_id, created_at, updated_at)
     VALUES ($1, 'Team', 'team', 'owner', now(), now())`,
    [SPACE],
  );
  for (const id of people) {
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now(), now())`,
      [randomUUID(), SPACE, id, id === owner.userId ? "owner" : "member"],
    );
  }
  await db.pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1, $2, 'owner', 'Audience Project', 'active', now(), now())`,
    [PROJECT, SPACE],
  );
  await seedProjectMainlineRoom(db.pool, { space: SPACE, project: PROJECT, owner: owner.userId });
  for (const id of [member.userId, newcomer.userId, later.userId]) {
    await db.pool.query(
      `INSERT INTO project_members (id, space_id, project_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, PROJECT, id],
    );
  }
});

/** A limited Room of owner + member with one conversation that has history. */
async function seedRoomWithHistory(): Promise<{ roomId: string; oldId: string }> {
  const roomId = randomUUID();
  await db.pool.query(
    `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', 'Limited', 'active', now(), now())`,
    [roomId, SPACE, PROJECT],
  );
  for (const [userId, role] of [[owner.userId, "owner"], [member.userId, "member"]] as const) {
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now())`,
      [randomUUID(), SPACE, roomId, userId, role],
    );
  }
  const old = await new PgSessionRepository(db.pool).createRoomConversation({
    space_id: SPACE, room_id: roomId, project_id: PROJECT, project_folder_id: null,
    title: "Before the newcomer", metadata: { execution_setup_started: true },
  });
  await seedConversationMessages(db.pool, {
    space: SPACE, session: old.id,
    messages: [{ id: randomUUID(), role: "user", content: "something only we discussed", userId: owner.userId }],
  });
  return { roomId, oldId: old.id };
}

const notFound = { statusCode: 404 };

describe("conversation audience on invitation", () => {
  it("freezes existing conversations and opens a shared one when history is not shared", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { roomId, oldId } = await seedRoomWithHistory();
    const invitation = await roster.inviteUser(owner, roomId, { user_id: newcomer.userId }) as {
      status: string; share_history: boolean; shared_conversation_id: string | null;
    };
    expect(invitation).toMatchObject({ status: "active", share_history: false });
    const sharedId = invitation.shared_conversation_id;
    expect(sharedId).toEqual(expect.any(String));

    // The newcomer is in the Room, sees only the new conversation, and the old
    // one answers exactly as a missing one does.
    const newcomerList = await rooms.listConversations(newcomer, roomId, page);
    expect(newcomerList.items.map((item) => item.id)).toEqual([sharedId]);
    expect(newcomerList.total).toBe(1);
    await expect(rooms.listMessages(newcomer, roomId, oldId, page)).rejects.toMatchObject(notFound);
    await expect(rooms.listMessages(newcomer, roomId, randomUUID(), page)).rejects.toMatchObject(notFound);
    expect(await new PgSessionRepository(db.pool).getRoomConversation(SPACE, newcomer.userId, oldId)).toBeNull();
    const projectList = await rooms.listProjectConversations(newcomer, PROJECT, page);
    expect(projectList.items.map((item) => item.id)).toEqual([sharedId]);
    for (const status of ["archived", "deleted"] as const) {
      const other = await rooms.listConversations(newcomer, roomId, { ...page, status });
      expect(other.items).toEqual([]);
    }

    // The original members keep both, and each conversation names its real audience.
    const ownerList = await rooms.listConversations(owner, roomId, page);
    expect(new Set(ownerList.items.map((item) => item.id))).toEqual(new Set([oldId, sharedId]));
    const byId = new Map(ownerList.items.map((item) => [item.id, item]));
    expect(byId.get(oldId)?.audience).toEqual({ restricted: true, other_member_names: [member.userId] });
    expect(byId.get(sharedId!)?.audience).toEqual({ restricted: false, other_member_names: [member.userId, newcomer.userId].sort() });
    const ownerMessages = await rooms.listMessages(owner, roomId, oldId, page);
    expect(ownerMessages.items.map((item) => item.content)).toContain("something only we discussed");

    // The owner continues in the old conversation; what they add there stays
    // with the people it was frozen to.
    await seedConversationMessages(db.pool, {
      space: SPACE, session: oldId,
      messages: [{ id: randomUUID(), role: "user", content: "added after the invitation", userId: owner.userId }],
    });
    const memberMessages = await rooms.listMessages(member, roomId, oldId, page);
    expect(memberMessages.items.map((item) => item.content)).toContain("added after the invitation");
    await expect(rooms.listMessages(newcomer, roomId, oldId, page)).rejects.toMatchObject(notFound);

    // Who-already-saw-it answers per conversation, the Room's answer does not narrow.
    const room = (await new PgRoomRepository(db.pool).getRoomById(SPACE, roomId))!;
    expect((await roomAudience(db.pool, SPACE, room, oldId)).sort()).toEqual([member.userId, owner.userId].sort());
    expect((await roomAudience(db.pool, SPACE, room)).sort()).toEqual([member.userId, newcomer.userId, owner.userId].sort());

    // Lifecycle commands by id are refused like a missing conversation.
    await expect(rooms.setConversationArchived(newcomer, roomId, oldId, true)).rejects.toMatchObject(notFound);
  });

  it("shares history when asked, and never widens a frozen conversation later", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { roomId, oldId } = await seedRoomWithHistory();
    const first = await roster.inviteUser(owner, roomId, { user_id: newcomer.userId, share_history: false }) as { shared_conversation_id: string };
    const shared = await roster.inviteUser(owner, roomId, { user_id: later.userId, share_history: true }) as {
      status: string; share_history: boolean; shared_conversation_id: string | null;
    };
    expect(shared).toMatchObject({ status: "active", share_history: true, shared_conversation_id: null });
    const visible = await rooms.listConversations(later, roomId, page);
    // The conversation the first invitation opened is shared with them; the
    // one it froze stays frozen.
    expect(visible.items.map((item) => item.id)).toEqual([first.shared_conversation_id]);
    await expect(rooms.listMessages(later, roomId, oldId, page)).rejects.toMatchObject(notFound);
    const frozen = await db.pool.query(`SELECT count(*)::int AS n FROM room_conversation_audiences WHERE room_id = $1`, [roomId]);
    expect(frozen.rows[0].n).toBe(1);
  });

  it("keeps a frozen conversation's Runs and their notes inside its audience", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { roomId, oldId } = await seedRoomWithHistory();
    const agentId = randomUUID();
    const runId = randomUUID();
    await seedRun(db.pool, { id: runId, space: SPACE, owner: owner.userId, agent: agentId, version: randomUUID() });
    await db.pool.query(`UPDATE runs SET session_id = $2, project_id = $3 WHERE id = $1`, [runId, oldId, PROJECT]);
    await db.pool.query(
      `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', 'active', now(), now())`,
      [randomUUID(), SPACE, roomId, agentId],
    );
    const note = async (originSessionId: string | null) => {
      const id = randomUUID();
      await db.pool.query(
        `INSERT INTO memory_entries (
           id, space_id, scope_type, memory_type, content, status, created_at, updated_at,
           visibility, confidence, importance, owner_user_id, agent_id, origin_room_id, origin_session_id, version, access_count
         ) VALUES ($1, $2, 'agent', 'note', $3, 'active', now(), now(), 'private', 1, 0.5, 'owner', $4, $5, $6, 1, 0)`,
        [id, SPACE, `note ${originSessionId ?? "legacy"}`, agentId, roomId, originSessionId],
      );
      return id;
    };
    const fromOld = await note(oldId);
    const legacy = await note(null);

    const invitation = await roster.inviteUser(owner, roomId, { user_id: newcomer.userId }) as { shared_conversation_id: string };
    const runs = new PgRunRepository(db.pool);
    expect(await runs.getVisibleRun(SPACE, owner.userId, runId)).not.toBeNull();
    expect(await runs.getVisibleRun(SPACE, newcomer.userId, runId)).toBeNull();

    // In the old conversation both notes still reach its frozen audience.
    const inOld = await listAgentMemoryForDispatch(db.pool, { spaceId: SPACE, agentId, roomId, sessionId: oldId });
    expect(inOld.map((entry) => entry.id).sort()).toEqual([fromOld, legacy].sort());
    // In the shared conversation the newcomer is listening: neither note goes.
    const inShared = await listAgentMemoryForDispatch(db.pool, {
      spaceId: SPACE, agentId, roomId, sessionId: invitation.shared_conversation_id,
    });
    expect(inShared).toEqual([]);
    // A note learned in the shared conversation reaches it.
    const fromShared = await note(invitation.shared_conversation_id);
    const afterwards = await listAgentMemoryForDispatch(db.pool, {
      spaceId: SPACE, agentId, roomId, sessionId: invitation.shared_conversation_id,
    });
    expect(afterwards.map((entry) => entry.id)).toEqual([fromShared]);
  });

  it("serializes activation behind a conversation writer holding the Room", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { roomId, oldId } = await seedRoomWithHistory();
    const writer = await db.pool.connect();
    let lateId = "";
    try {
      await writer.query("BEGIN");
      // A send or draft creation holds the Room the way `lockRoomForTurn` does.
      await writer.query("SELECT id FROM rooms WHERE space_id = $1 AND id = $2 FOR NO KEY UPDATE", [SPACE, roomId]);
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      let settled = false;
      const activation = roster.inviteUser(owner, roomId, { user_id: newcomer.userId }).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, pid, { settled: () => settled });
      expect(settled).toBe(false);
      lateId = (await new PgSessionRepository(writer).createRoomConversation({
        space_id: SPACE, room_id: roomId, project_id: PROJECT, project_folder_id: null,
        title: "Written while the invitation waited", metadata: { execution_setup_started: true },
      })).id;
      await writer.query("COMMIT");
      await activation;
    } finally {
      writer.release();
    }
    // What committed before the membership change belongs to the old audience.
    const visible = await rooms.listConversations(newcomer, roomId, page);
    expect(visible.items.map((item) => item.id)).not.toContain(lateId);
    expect(visible.items.map((item) => item.id)).not.toContain(oldId);
    expect(visible.total).toBe(1);
  });
  it("names each conversation's audience by the rule its freeze snapshot uses", async (ctx) => {
    if (!db.available) return ctx.skip();
    const sorted = (ids: string[]) => [...ids].sort();
    // The mainline: every Project reader reads it, enrolled on its roster or not.
    const mainline = (await db.pool.query<{ id: string }>(
      `SELECT id FROM rooms WHERE space_id = $1 AND project_id = $2 AND is_mainline`, [SPACE, PROJECT],
    )).rows[0]!.id;
    const main = await new PgSessionRepository(db.pool).createRoomConversation({
      space_id: SPACE, room_id: mainline, project_id: PROJECT, project_folder_id: null,
      title: "Mainline", metadata: { execution_setup_started: true },
    });
    const readers = sorted([member.userId, newcomer.userId, later.userId]);
    const mainlineRoom = { id: mainline, project_id: PROJECT, is_mainline: true };
    expect(sorted(await roomAudience(db.pool, SPACE, mainlineRoom, main.id))).toEqual(sorted([owner.userId, ...readers]));
    const mainList = await rooms.listConversations(owner, mainline, page);
    expect(mainList.items.find((item) => item.id === main.id)?.audience).toEqual({ restricted: false, other_member_names: readers });
    const projectList = await rooms.listProjectConversations(owner, PROJECT, page);
    expect(projectList.items.find((item) => item.id === main.id)?.audience).toEqual({ restricted: false, other_member_names: readers });

    // A limited Room frozen when the newcomer joined, then the old member
    // loses the Project: no label still names them, frozen or not.
    const { roomId, oldId } = await seedRoomWithHistory();
    const { shared_conversation_id: sharedId } = await roster.inviteUser(owner, roomId, { user_id: newcomer.userId }) as { shared_conversation_id: string };
    await db.pool.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PROJECT, member.userId]);
    const limitedRoom = { id: roomId, project_id: PROJECT, is_mainline: false };
    expect(await roomAudience(db.pool, SPACE, limitedRoom, oldId)).toEqual([owner.userId]);
    const limited = new Map((await rooms.listConversations(owner, roomId, page)).items.map((item) => [item.id, item.audience]));
    expect(limited.get(oldId)).toEqual({ restricted: true, other_member_names: [] });
    expect(limited.get(sharedId)).toEqual({ restricted: false, other_member_names: [newcomer.userId] });
    const overview = new Map((await rooms.listProjectConversations(owner, PROJECT, page)).items.map((item) => [item.id, item]));
    expect(overview.get(oldId)?.audience).toEqual({ restricted: true, other_member_names: [] });
    expect(overview.get(sharedId)?.room_other_member_names).toEqual([newcomer.userId]);
    expect((await new PgRoomRepository(db.pool).audienceForViewer(SPACE, roomId, owner.userId)).other_member_names).toEqual([newcomer.userId]);
    // The Rooms index counts the people it names, the viewer included: every Project reader for the
    // mainline, and not the roster member who lost the Project.
    const index = new Map((await new PgRoomRepository(db.pool).listProjectRoomSummaries({
      space_id: SPACE, user_id: owner.userId, project_id: PROJECT, limit: 50, offset: 0,
    })).items.map((item) => [item.room.id, item]));
    expect(index.get(roomId)).toMatchObject({ other_member_names: [newcomer.userId], person_count: 2 });
    const mainlineSummary = index.get(mainline)!;
    expect(mainlineSummary.person_count).toBe(mainlineSummary.other_member_names.length + 1);
  });
});
