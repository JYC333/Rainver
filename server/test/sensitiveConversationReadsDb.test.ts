import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedConversationMessages, seedProjectMainlineRoom, seedRun, seedSpaceMember, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import {
  hasProjectBoundRead, hasSensitivePluginRead, inheritedReads, persistRunContextTaint, readRunContextTaint, runSensitiveReads, sensitiveConversationReads, UNRESOLVED_SENSITIVE_READ,
} from "../src/modules/runs/contextTaint.js";
import { sensitiveTaintEgressContext } from "../src/modules/plugins/egress.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";
import { RoomService } from "../src/modules/rooms/service.js";

// Which private-source reads a conversation holds (ADR 0030/0033 §6), on real PostgreSQL with synthetic
// Runs and messages only: no mailbox, Host or model. Owners stay the real data owners, every Run and
// message of a long conversation counts, old references are checked against their source, and an
// answer that cannot be complete says so (and a reference out of it is refused).
const db = useTestDatabase(import.meta.filename);
let config: ServerConfig;
let space: string, spaceOwner: string, owner: string, peer: string, project: string, room: string, agent: string, version: string;

const taint = (reads: unknown[]) => JSON.stringify({ schema_version: 1, narrowest_visibility: "private", input_owner_user_ids: [], non_instructing_owner_user_ids: [], personal_memory_grant_ids: [], plugin_reads: reads });

beforeEach(async () => {
  await resetTables(db.pool, ["spaces", "users"], { cascade: true });
  space = randomUUID(); spaceOwner = randomUUID(); owner = randomUUID(); peer = randomUUID(); project = randomUUID();
  agent = randomUUID(); version = randomUUID();
  await seedSpaceOwnerProject(db.pool, { space, owner: spaceOwner, project, spaceType: "team" });
  for (const user of [owner, peer]) {
    await seedSpaceMember(db.pool, { space, user });
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
  }
  room = (await db.pool.query<{ id: string }>(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [project])).rows[0]?.id
    ?? (await seedProjectMainlineRoom(db.pool, { space, project, owner: spaceOwner })).roomId;
  for (const user of [owner, peer]) await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'member','active',now(),now()) ON CONFLICT DO NOTHING`, [randomUUID(), space, room, user]);
  await seedRun(db.pool, { id: randomUUID(), space, owner: spaceOwner, agent, version });
  config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: mkdtempSync(join(tmpdir(), "rainver-sensitive-reads-")) });
});

async function conversation(): Promise<string> {
  return (await new PgSessionRepository(db.pool).createRoomConversation({ space_id: space, room_id: room, project_id: project, project_folder_id: null, title: "Mail", metadata: {} })).id;
}

/** A finished Run of the conversation instructed by `by`, with these taint reads; `logOwner` adds its own read log. */
async function run(session: string, by: string, reads: unknown[], logOwner?: string): Promise<string> {
  const id = randomUUID();
  await seedRun(db.pool, { id, space, owner: by, agent, version, existingAgent: true });
  await db.pool.query(`UPDATE runs SET session_id=$2,instructed_by_user_id=$3,visibility='private',has_context_taint=true,context_taint_json=$4::jsonb WHERE id=$1`, [id, session, by, taint(reads)]);
  if (logOwner) await db.pool.query(`INSERT INTO agent_data_read_logs (id,space_id,owner_user_id,run_id,agent_id,action_id,resource_type,resource_ids_json,data_class,grant_id,accessed_at)
    VALUES ($1,$2,$3,$4,$5,'source.gmail.mail.read','gmail_message','[]'::jsonb,'sensitive',NULL,now())`, [randomUUID(), space, logOwner, id, agent]);
  return id;
}

/**
 * A reference message whose provenance names `sourceId`. `reads` undefined writes one from before reads were
 * recorded; `version` 2 marks a list written with real owners (the current writer), without it an old list.
 */
function referenceMessage(sourceId: string, reads?: unknown, version?: unknown) {
  return {
    id: randomUUID(), role: "system", content: "quoted", userId: owner,
    metadata: { room_display: "reference", reference: {
      kind: "messages", source_id: sourceId, source_room_id: room, source_title: "Mail", item_ids: [], trust: "domain_approved", clipped: false,
      attached_by_user_id: owner, attached_at: new Date().toISOString(), ...(reads === undefined ? {} : { sensitive_reads: reads }),
      ...(version === undefined ? {} : { sensitive_reads_version: version }),
    } },
  };
}

/** Shared Gmail text; `version` 2 marks reads recorded with real owners. */
function sharedMessage(sender: string, reads?: unknown, version?: unknown) {
  return { id: randomUUID(), role: "user", content: "Shared excerpt.", userId: sender, metadata: {
    shared_from: "private_gmail_summary", ...(reads === undefined ? {} : { sensitive_reads: reads }), ...(version === undefined ? {} : { sensitive_reads_version: version }),
  } };
}

const gmail = (ownerUserId: string | null) => ({ pluginId: "core:gmail", ownerUserId });
const sorted = (reads: { pluginId: string; ownerUserId: string | null }[]) => [...reads].sort((a, b) => `${a.pluginId}${a.ownerUserId}`.localeCompare(`${b.pluginId}${b.ownerUserId}`));

describe("sensitiveConversationReads", () => {
  it("keeps every real mailbox owner and never counts a later instructing person's inherited read as their own", async () => {
    const session = await conversation();
    await run(session, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    // The peer's later turn inherited the owner's read, recorded with the owner's id.
    await run(session, peer, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    let found = await sensitiveConversationReads(db.pool, space, session);
    expect(found).toEqual({ reads: [gmail(owner)], complete: true });
    // A second owner's own read in the same conversation (a multi-owner conversation).
    await run(session, peer, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: peer }, { plugin_id: "plugin_x", data_class: "personal", owner_user_id: peer }]);
    found = await sensitiveConversationReads(db.pool, space, session);
    expect(found.complete).toBe(true);
    expect(sorted(found.reads)).toEqual(sorted([gmail(owner), gmail(peer)]));
  });

  it("resolves entries written before owners were recorded from the Run's own read log, otherwise as unknown", async () => {
    const own = await conversation();
    await run(own, owner, [{ plugin_id: "core:gmail", data_class: "sensitive" }], owner);
    expect(await sensitiveConversationReads(db.pool, space, own)).toEqual({ reads: [gmail(owner)], complete: true });
    // An old inherited entry of the peer's turn: the peer read nothing, so the owner is unknown, never the peer.
    const inherited = await conversation();
    await run(inherited, peer, [{ plugin_id: "core:gmail", data_class: "sensitive" }]);
    expect(await sensitiveConversationReads(db.pool, space, inherited)).toEqual({ reads: [gmail(null)], complete: true });
    // The peer's own read log does not prove it either when the conversation already held reads it may have
    // inherited (an earlier Run's, here the owner's), nor when the Run logged anybody else's data as well.
    const mixed = await conversation();
    await run(mixed, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    await run(mixed, peer, [{ plugin_id: "core:gmail", data_class: "sensitive" }], peer);
    expect(sorted((await sensitiveConversationReads(db.pool, space, mixed)).reads)).toEqual(sorted([gmail(owner), gmail(null)]));
    const twoLogs = await conversation();
    const both = await run(twoLogs, peer, [{ plugin_id: "core:gmail", data_class: "sensitive" }], peer);
    await db.pool.query(`INSERT INTO agent_data_read_logs (id,space_id,owner_user_id,run_id,agent_id,action_id,resource_type,resource_ids_json,data_class,grant_id,accessed_at)
      VALUES ($1,$2,$3,$4,$5,'source.gmail.mail.read','gmail_message','[]'::jsonb,'sensitive',NULL,now())`, [randomUUID(), space, owner, both, agent]);
    expect(await sensitiveConversationReads(db.pool, space, twoLogs)).toEqual({ reads: [gmail(null)], complete: true });
  });

  it("aggregates every Run and message of a long conversation, not only its first rows", async () => {
    const session = await conversation();
    for (let i = 0; i < 105; i += 1) await run(session, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    await run(session, peer, [{ plugin_id: "core:gmail_digest", data_class: "sensitive", owner_user_id: peer }]);
    // 120 ordinary references (recorded as holding none), then the shared Gmail text of a third person.
    await seedConversationMessages(db.pool, { space, session, messages: Array.from({ length: 120 }, () => referenceMessage(session, [], 2)) });
    await seedConversationMessages(db.pool, { space, session, messages: [sharedMessage(spaceOwner, [{ plugin_id: "core:gmail", owner_user_id: spaceOwner }], 2)] });
    const found = await sensitiveConversationReads(db.pool, space, session);
    expect(found.complete).toBe(true);
    expect(sorted(found.reads)).toEqual(sorted([gmail(owner), { pluginId: "core:gmail_digest", ownerUserId: peer }, gmail(spaceOwner)]));
  });

  it("checks an old reference against its source, across hops, and is incomplete when that source is gone", async () => {
    const mail = await conversation();
    await run(mail, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    const middle = await conversation();
    await seedConversationMessages(db.pool, { space, session: middle, messages: [referenceMessage(mail)] });
    const last = await conversation();
    await seedConversationMessages(db.pool, { space, session: last, messages: [referenceMessage(middle)] });
    expect(await sensitiveConversationReads(db.pool, space, last)).toEqual({ reads: [gmail(owner)], complete: true });
    // A new reference records what its source held (here none), so the source is not consulted again.
    const recorded = await conversation();
    await seedConversationMessages(db.pool, { space, session: recorded, messages: [referenceMessage(mail, [], 2)] });
    expect(await sensitiveConversationReads(db.pool, space, recorded)).toEqual({ reads: [], complete: true });
    // An old list (no version) is not taken at its word: an empty one is checked against the source...
    const oldEmpty = await conversation();
    await seedConversationMessages(db.pool, { space, session: oldEmpty, messages: [referenceMessage(mail, [])] });
    expect(await sensitiveConversationReads(db.pool, space, oldEmpty)).toEqual({ reads: [gmail(owner)], complete: true });
    // ...an entry found there with the same owner is verified...
    const oldVerified = await conversation();
    await seedConversationMessages(db.pool, { space, session: oldVerified, messages: [referenceMessage(mail, [{ plugin_id: "core:gmail", owner_user_id: owner }])] });
    expect(await sensitiveConversationReads(db.pool, space, oldVerified)).toEqual({ reads: [gmail(owner)], complete: true });
    // ...and one the source does not hold (another owner, another read) cannot be: unknown owner, incomplete.
    const oldUnverified = await conversation();
    await seedConversationMessages(db.pool, { space, session: oldUnverified, messages: [referenceMessage(mail, [{ plugin_id: "core:gmail", owner_user_id: peer }])] });
    let found = await sensitiveConversationReads(db.pool, space, oldUnverified);
    expect(found.complete).toBe(false);
    expect(sorted(found.reads)).toEqual(sorted([gmail(owner), gmail(null)]));
    // An old list whose source is gone keeps its entries as unknown-owner reads and is incomplete.
    const oldOrphan = await conversation();
    await seedConversationMessages(db.pool, { space, session: oldOrphan, messages: [referenceMessage(randomUUID(), [{ plugin_id: "plugin_x", owner_user_id: owner }])] });
    expect(await sensitiveConversationReads(db.pool, space, oldOrphan)).toEqual({ reads: [{ pluginId: "plugin_x", ownerUserId: null }], complete: false });
    // Old shared text has nothing to be checked against (its source Run may have held others' reads).
    const oldShared = await conversation();
    await seedConversationMessages(db.pool, { space, session: oldShared, messages: [sharedMessage(owner, [{ plugin_id: "core:gmail", owner_user_id: owner }]), sharedMessage(owner)] });
    found = await sensitiveConversationReads(db.pool, space, oldShared);
    expect(found).toEqual({ reads: [gmail(null)], complete: false });
    const orphan = await conversation();
    await seedConversationMessages(db.pool, { space, session: orphan, messages: [referenceMessage(randomUUID())] });
    expect(await sensitiveConversationReads(db.pool, space, orphan)).toEqual({ reads: [], complete: false });
  });

  it("is incomplete for more distinct reads than a copy can carry or a malformed entry, and a new Run then inherits an unknown-owner read", async () => {
    const many = await conversation();
    await run(many, owner, Array.from({ length: 101 }, (_, i) => ({ plugin_id: `plugin_${i}`, data_class: "sensitive", owner_user_id: owner })));
    const found = await sensitiveConversationReads(db.pool, space, many);
    expect(found).toMatchObject({ complete: false });
    expect(found.reads).toHaveLength(100);
    expect(inheritedReads(found)).toContainEqual(UNRESOLVED_SENSITIVE_READ);
    const malformed = await conversation();
    await seedConversationMessages(db.pool, { space, session: malformed, messages: [referenceMessage(many, [{ plugin_id: 7, owner_user_id: owner }], 2)] });
    expect(await sensitiveConversationReads(db.pool, space, malformed)).toEqual({ reads: [], complete: false });
    // Malformed read metadata anywhere is never read as "no reads".
    const malformedCases: { messages?: unknown[]; runReads?: unknown; taint?: unknown }[] = [
      { messages: [referenceMessage(many, { plugin_id: "core:gmail" }, 2)] },
      { messages: [referenceMessage(many, null, 2)] },
      { messages: [referenceMessage(many, [], 3)] },
      { messages: [referenceMessage(many, [{ plugin_id: "core:gmail" }], 2)] },
      { messages: [sharedMessage(owner, "core:gmail", 2)] },
      { runReads: { plugin_id: "core:gmail", data_class: "sensitive" } },
      { runReads: ["core:gmail"] },
      { runReads: [{ plugin_id: "core:gmail", data_class: "secret" }] },
      { taint: { plugin_reads: [] } },
    ];
    for (const item of malformedCases) {
      const session = await conversation();
      if (item.messages) await seedConversationMessages(db.pool, { space, session, messages: item.messages as never });
      if (item.runReads !== undefined) await run(session, owner, item.runReads as unknown[]);
      if (item.taint !== undefined) {
        const id = await run(session, owner, []);
        await db.pool.query(`UPDATE runs SET context_taint_json=$2::jsonb WHERE id=$1`, [id, JSON.stringify(item.taint)]);
      }
      expect((await sensitiveConversationReads(db.pool, space, session)).complete, JSON.stringify(item)).toBe(false);
    }
    expect(inheritedReads({ reads: [], complete: false })).toEqual([UNRESOLVED_SENSITIVE_READ]);
    expect(inheritedReads({ reads: [gmail(owner)], complete: true })).toEqual([gmail(owner)]);
  });
});

describe("one malformed-taint rule for the current Run and its conversation", () => {
  const outward = { id: "task.create", side_effects: "durable" } as const;

  it("keeps outward-write, Memory and merge protection for any unparsable top-level taint, and leaves a Run with none untainted", async () => {
    for (const stored of ["null", "[]", "\"core:gmail\"", "7", JSON.stringify({ schema_version: 2, narrowest_visibility: "private" }),
      JSON.stringify({ schema_version: 1, narrowest_visibility: "public", plugin_reads: [] })]) {
      const session = await conversation();
      const id = await run(session, owner, []);
      await db.pool.query(`UPDATE runs SET context_taint_json=$2::jsonb WHERE id=$1`, [id, stored]);
      const current = await readRunContextTaint(db.pool, space, id);
      expect(current?.narrowest_visibility, stored).toBe("private");
      expect(hasSensitivePluginRead(current), stored).toBe(true);
      expect(hasProjectBoundRead(current, ["core:gmail"]), stored).toBe(true);
      expect((await sensitiveTaintEgressContext(db.pool, space, id, outward)).sensitive_plugin_read_taint, stored).toBe(true);
      // The conversation aggregate answers the same Run as incomplete, so a later Run inherits an unknown-owner read.
      const found = await sensitiveConversationReads(db.pool, space, session);
      expect(found.complete, stored).toBe(false);
      expect(inheritedReads(found)).toContainEqual(UNRESOLVED_SENSITIVE_READ);
      // Persisting more taint merges the conservative reading: the rewritten summary keeps the protection.
      await persistRunContextTaint(db.pool, { runId: id, spaceId: space, instructingUserId: owner, runVisibility: "space_shared", items: [] });
      const merged = (await db.pool.query<{ has_context_taint: boolean; context_taint_json: Record<string, unknown> }>(
        `SELECT has_context_taint, context_taint_json FROM runs WHERE id=$1`, [id])).rows[0]!;
      expect(merged.has_context_taint, stored).toBe(true);
      expect(merged.context_taint_json, stored).toMatchObject({ narrowest_visibility: "private", plugin_reads: [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: null }] });
      expect(hasProjectBoundRead(await readRunContextTaint(db.pool, space, id), ["core:gmail"])).toBe(true);
    }
    // No stored taint (SQL NULL) is the legal untainted state on both sides.
    const clean = await conversation();
    const plain = await run(clean, owner, []);
    await db.pool.query(`UPDATE runs SET has_context_taint=false, context_taint_json=NULL WHERE id=$1`, [plain]);
    expect(await readRunContextTaint(db.pool, space, plain)).toBeNull();
    expect((await sensitiveTaintEgressContext(db.pool, space, plain, outward)).sensitive_plugin_read_taint).toBe(false);
    expect(await sensitiveConversationReads(db.pool, space, clean)).toEqual({ reads: [], complete: true });
    await persistRunContextTaint(db.pool, { runId: plain, spaceId: space, instructingUserId: owner, runVisibility: "space_shared", items: [] });
    expect((await db.pool.query(`SELECT has_context_taint FROM runs WHERE id=$1`, [plain])).rows[0].has_context_taint).toBe(false);
    // A well-formed summary without reads stays without reads.
    const ordinary = await run(clean, owner, []);
    expect(hasSensitivePluginRead(await readRunContextTaint(db.pool, space, ordinary))).toBe(false);
    expect(await sensitiveConversationReads(db.pool, space, clean)).toEqual({ reads: [], complete: true });
  });

  it("proves an old entry's owner after earlier Runs that validly read nothing, never after an incomplete taint", async () => {
    /** An earlier Run of a new conversation with this stored taint, then the owner's Run with an old entry and its own read log. */
    async function after(stored: unknown) {
      const session = await conversation();
      const earlier = await run(session, peer, []);
      await db.pool.query(`UPDATE runs SET context_taint_json=$2::jsonb, created_at=created_at - interval '1 minute' WHERE id=$1`, [earlier, JSON.stringify(stored)]);
      const later = await run(session, owner, [{ plugin_id: "core:gmail", data_class: "sensitive" }], owner);
      return { conversation: await sensitiveConversationReads(db.pool, space, session), run: await runSensitiveReads(db.pool, space, later) };
    }
    // The ordinary synthetic history: an earlier summary without reads, as the writer stores it (no plugin_reads).
    for (const visibility of ["private", "selected_users", "space_shared"]) {
      const found = await after({ schema_version: 1, narrowest_visibility: visibility, input_owner_user_ids: [], non_instructing_owner_user_ids: [], personal_memory_grant_ids: [] });
      expect(found.conversation).toEqual({ reads: [gmail(owner)], complete: true });
      expect(found.run).toEqual({ reads: [gmail(owner)], complete: true });
    }
    // A non-object summary, missing schema_version, missing or JSON-null visibility: the earlier source is unknown, so is the owner.
    for (const stored of [[], { narrowest_visibility: "private" }, { schema_version: 1 }, { schema_version: 1, narrowest_visibility: null }, { schema_version: null, narrowest_visibility: "private" }]) {
      const found = await after(stored);
      expect(found.conversation).toEqual({ reads: [gmail(null)], complete: false });
      expect(found.run).toEqual({ reads: [gmail(null)], complete: true });
    }
  });

  it("tells an explicit JSON null in a recorded field from an absent field when checking old references", async () => {
    const mail = await conversation();
    await run(mail, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    // Absent fields: an old reference, checked against its source.
    const absent = await conversation();
    await seedConversationMessages(db.pool, { space, session: absent, messages: [referenceMessage(mail)] });
    expect(await sensitiveConversationReads(db.pool, space, absent)).toEqual({ reads: [gmail(owner)], complete: true });
    // An explicit null list or version is malformed, never "no list" or "no version".
    for (const message of [referenceMessage(mail, null), referenceMessage(mail, [], null), referenceMessage(mail, [{ plugin_id: "core:gmail", owner_user_id: owner }], null),
      sharedMessage(owner, null), sharedMessage(owner, [], null)]) {
      const session = await conversation();
      await seedConversationMessages(db.pool, { space, session, messages: [message] });
      expect((await sensitiveConversationReads(db.pool, space, session)).complete, JSON.stringify(message.metadata)).toBe(false);
    }
  });
});

describe("Room references out of a conversation", () => {
  it("shares ordinary content normally, recording that it holds no private reads", async () => {
    const source = await conversation();
    const [said] = await seedConversationMessages(db.pool, { space, session: source, messages: [{ id: randomUUID(), role: "user", content: "Kitchen plan: tiles on Monday.", userId: owner }] });
    const target = await conversation();
    await new RoomService(config, db.pool).attachConversationReferences({ spaceId: space, userId: peer }, room, target, { references: [{ kind: "messages", id: source, item_ids: [said!] }] });
    const copied = (await db.pool.query<{ content: string; metadata_json: Record<string, any> }>(
      `SELECT content,metadata_json FROM messages WHERE session_id=$1 AND metadata_json->>'room_display'='reference'`, [target])).rows;
    expect(copied).toHaveLength(1);
    expect(copied[0]!.content).toContain("Kitchen plan: tiles on Monday.");
    expect(copied[0]!.metadata_json.reference).toMatchObject({ trust: "domain_approved", sensitive_reads: [], sensitive_reads_version: 2 });
    expect(copied[0]!.metadata_json.reference.source_project_id).toBeUndefined();
    // The source reading Gmail afterwards does not reach back into the copy already made.
    await run(source, owner, [{ plugin_id: "core:gmail", data_class: "sensitive", owner_user_id: owner }]);
    expect(await sensitiveConversationReads(db.pool, space, target)).toEqual({ reads: [], complete: true });
  });

  it("refuses to copy out of a conversation whose reads cannot all be determined", async () => {
    const source = await conversation();
    const [, said] = await seedConversationMessages(db.pool, { space, session: source, messages: [referenceMessage(randomUUID()), { id: randomUUID(), role: "user", content: "Anything.", userId: owner }] });
    const target = await conversation();
    await expect(new RoomService(config, db.pool).attachConversationReferences({ spaceId: space, userId: owner }, room, target, { references: [{ kind: "messages", id: source, item_ids: [said!] }] }))
      .rejects.toMatchObject({ statusCode: 409, responseBody: { code: "reference_sensitive_reads_unresolved" } });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM messages WHERE session_id=$1`, [target])).rows[0].n).toBe(0);
  });
});
