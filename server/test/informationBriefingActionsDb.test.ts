import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { resetTables } from "./support/resetTables.js";
import { seedRoomManager } from "./support/domainSeeds.js";
import { AGENT, CONNECTION, MEMBER, OWNER, PROJECT, SPACE, briefingWorld, manual, output, outputValue } from "./support/briefingFixture.js";
import { loadConfig } from "../src/config.js";
import { settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { personalBriefingScope } from "../src/modules/informationDigest/briefing/personalScope.js";
import { PERSONAL_BRIEFING_LABEL } from "../src/modules/informationDigest/briefing/routes.js";
import { prepareFollowUp } from "../src/modules/informationDigest/briefing/followUp.js";
import { confirmAdoption, previewAdoption } from "../src/modules/informationDigest/briefing/adoption.js";
import { RoomService } from "../src/modules/rooms/service.js";
import { PgTaskRepository } from "../src/modules/tasks/repository.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { informationDigestModule } from "../src/modules/informationDigest/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { PgSessionRepository } from "../src/modules/sessions/repository.js";

const db = useTestDatabase(import.meta.filename, { max: 10 });
const w = briefingWorld(db);
const { adapter, service, material, finishRun, rowOf, runOf, inputsOf, count, age } = w;
const owner = { spaceId: SPACE, userId: OWNER };
const member = { spaceId: SPACE, userId: MEMBER };
let home: string;
let rooms: RoomService;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "rainver-briefing-actions-"));
});
afterAll(async () => { if (home) await rm(home, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["activity_records", "project_work_events", "settings", "messages", "sessions", "room_agent_members"], { cascade: true });
  await w.seed();
  rooms = new RoomService(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home }), db.pool);
});

/** A published first version, then a delta whose highlight says `novelty` about a newly published item. */
async function deltaWith(novelty: "new" | "update" | "ongoing", scope = adapter(), request = manual) {
  await material("First report");
  const first = await service().request(scope, OWNER, request);
  await settleBriefingRun(db.pool, await finishRun((await runOf(first.briefing.id)).id, output(contextFree(scope))));
  await age(1);
  const fresh = await material("Fresh report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
  const next = await service().request(scope, OWNER, request);
  const ref = (await inputsOf(next.briefing.id)).find((input) => input.source_item_id === fresh).ref_key as string;
  const value = outputValue(contextFree(scope), novelty);
  value.highlights[0]!.novelty = novelty;
  value.overview = { text: "FRESH_OVERVIEW", refs: [ref] };
  value.highlights[0] = { ...value.highlights[0]!, title: "FRESH_HIGHLIGHT", what_changed: "FRESH_TEXT", refs: [ref], statements: [{ kind: "fact", text: "FRESH_FACT", refs: [ref] }] };
  return { first: first.briefing.id, next: next.briefing.id, ref, fresh, value };
}

/** A personal briefing has no stated context here: its replies cite material only. */
function contextFree(scope: ReturnType<typeof adapter>): Parameters<typeof outputValue>[0] {
  if (scope.scope.type === "project") return {};
  const base = outputValue();
  return { highlights: [{ ...base.highlights[0]!, impact: { assessment: "insufficient_context", text: "No focus.", context_refs: [] }, statements: [{ kind: "fact", text: "Reported.", refs: ["S1"] }] }] };
}

const notices = async () => (await db.pool.query(
  `SELECT user_id, owner_user_id, visibility, project_id, title, content, payload_json, status, aggregate_key FROM activity_records WHERE activity_type='operational_alert' ORDER BY user_id`,
)).rows;

async function mainlineConversation() {
  const room = (await db.pool.query(`SELECT id FROM rooms WHERE project_id=$1 AND is_mainline`, [PROJECT])).rows[0].id as string;
  await seedRoomManager(db.pool, { space: SPACE, room, agent: AGENT });
  const conversation = await new PgSessionRepository(db.pool).createRoomConversation({ space_id: SPACE, room_id: room, project_id: PROJECT, project_folder_id: null, title: "Follow-up", metadata: {} });
  return { room, conversation: conversation.id as string };
}

describe("Briefing notices: only meaningful, current changes, as content-free pointers", () => {
  it("notifies each current reader once per scope for a published new/update change, never for a baseline, a replay or an ongoing-only version", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, value } = await deltaWith("new");
    // The baseline published above notified nobody.
    expect(await notices()).toEqual([]);
    const run = await finishRun((await runOf(next)).id, output(value));
    await settleBriefingRun(db.pool, run);
    let rows = await notices();
    expect(rows.map((row) => row.user_id).sort()).toEqual([OWNER, MEMBER].sort());
    for (const row of rows) {
      expect(row).toMatchObject({ visibility: "private", owner_user_id: row.user_id, project_id: null, status: "raw", title: "A Project briefing has new changes" });
      expect(row.payload_json).toMatchObject({ pointer_type: "briefing_changes", scope_type: "project", project_id: PROJECT, briefing_id: next });
      // A pointer, never content: no Project name, title, label or text.
      expect(JSON.stringify(row)).not.toMatch(/FRESH_|Robotics|Fresh report|Corpus/);
    }
    // A settlement replay (or recovery) does not notify again or bring a read notice back.
    await db.pool.query(`UPDATE activity_records SET status='processed' WHERE activity_type='operational_alert'`);
    await settleBriefingRun(db.pool, run);
    rows = await notices();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "processed")).toBe(true);

    // The next version is ongoing only: no notice changes.
    await age(1);
    const later = await material("Repeat of the launch", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const third = await service().request(adapter(), OWNER, manual);
    const ref = (await inputsOf(third.briefing.id)).find((input) => input.source_item_id === later).ref_key as string;
    const ongoing = outputValue({}, "ongoing");
    ongoing.overview = { text: "Nothing substantive.", refs: [ref] };
    ongoing.highlights[0] = { ...ongoing.highlights[0]!, refs: [ref], statements: [{ kind: "fact", text: "Repeated.", refs: [ref] }] };
    await settleBriefingRun(db.pool, await finishRun((await runOf(third.briefing.id)).id, output(ongoing)));
    expect((await notices()).every((row) => row.status === "processed" && row.payload_json.briefing_id === next)).toBe(true);
    // A later meaningful version updates the same one notice per reader (bounded), unread again.
    await age(1);
    const fourthItem = await material("Another fresh report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const fourth = await service().request(adapter(), OWNER, manual);
    const fourthRef = (await inputsOf(fourth.briefing.id)).find((input) => input.source_item_id === fourthItem).ref_key as string;
    const update = outputValue({}, "new");
    update.overview = { text: "New.", refs: [fourthRef] };
    update.highlights[0] = { ...update.highlights[0]!, refs: [fourthRef], statements: [{ kind: "fact", text: "New.", refs: [fourthRef] }] };
    await settleBriefingRun(db.pool, await finishRun((await runOf(fourth.briefing.id)).id, output(update)));
    rows = await notices();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "raw" && row.payload_json.briefing_id === fourth.briefing.id)).toBe(true);
  });

  it("does not notify for a change the audience cannot read, a failed or late attempt; a personal briefing notifies its owner alone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, fresh, value } = await deltaWith("new");
    // The new highlight rests on material no longer shared when it is published (the overview does not): partial, not news.
    value.overview = { text: "Old news only.", refs: ["S1"] };
    const first = (await inputsOf(next)).find((input) => input.delta_class === "background")?.ref_key;
    if (first) value.overview.refs = [first];
    await db.pool.query(`UPDATE source_items SET deleted_at=now() WHERE id=$1`, [fresh]);
    const run = await runOf(next);
    await settleBriefingRun(db.pool, await finishRun(run.id, output(value)));
    expect((await rowOf(next)).status).toBe(first ? "ready" : "failed");
    expect(await notices()).toEqual([]);
    // A failed attempt notifies nobody; neither does its late reply after a retry.
    await db.pool.query(`UPDATE source_items SET deleted_at=NULL WHERE id=$1`, [fresh]);
    await age(1);
    const again = await material("Yet another report", { addedHoursAgo: 0, publishedHoursAgo: 0.1 });
    const third = await service().request(adapter(), OWNER, manual);
    const failed = await finishRun((await runOf(third.briefing.id)).id, "", "failed");
    await settleBriefingRun(db.pool, failed);
    await service().request(adapter(), OWNER, manual);
    const ref = (await inputsOf(third.briefing.id)).find((input) => input.source_item_id === again).ref_key as string;
    const late = outputValue({}, "new");
    late.overview = { text: "Late.", refs: [ref] };
    late.highlights[0] = { ...late.highlights[0]!, refs: [ref], statements: [{ kind: "fact", text: "Late.", refs: [ref] }] };
    await db.pool.query(`UPDATE runs SET output_json=$2::jsonb, status='succeeded' WHERE id=$1`, [failed.id, JSON.stringify({ schema_version: "run_output.v1", result: { output_text: output(late) } })]);
    await settleBriefingRun(db.pool, (await w.runs().getRun(SPACE, failed.id))!);
    expect(await notices()).toEqual([]);
  });

  it("notifies a personal briefing's owner alone", async (ctx) => {
    if (!db.available) return ctx.skip();
    const personal = personalBriefingScope(SPACE, OWNER);
    const { next, value } = await deltaWith("update", personal, { ...manual, label: PERSONAL_BRIEFING_LABEL });
    // "update" must cite a revised or evidenced change; a fresh item is new, so make it so.
    value.highlights[0]!.novelty = "new";
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    const rows = await notices();
    expect(rows).toEqual([expect.objectContaining({ user_id: OWNER, visibility: "private", title: "Your briefing has new changes" })]);
    expect(rows[0].payload_json).toMatchObject({ scope_type: "personal", project_id: null, briefing_id: next });
  });
});

describe("Follow-up: a highlight discussed only inside its own scope", () => {
  it("prepares without writing, attaches into its Project's Room at the explicit send, and refuses another Project, withdrawn material or an Agent its Sources refuse", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, value, fresh } = await deltaWith("new");
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    const before = [await count("messages"), await count("tasks"), await count("runs")];
    const preview = await prepareFollowUp(db.pool, adapter(), MEMBER, next, 0);
    expect(preview).toMatchObject({ scope_type: "project", project_id: PROJECT, title: "FRESH_HIGHLIGHT" });
    expect(preview.preview).toContain("FRESH_FACT");
    expect(preview.preview).toContain("Fresh report");
    expect([await count("messages"), await count("tasks"), await count("runs")]).toEqual(before);

    const { room, conversation } = await mainlineConversation();
    await rooms.attachConversationReferences(owner, room, conversation, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }] });
    const copied = (await db.pool.query(`SELECT role, content, metadata_json FROM messages WHERE session_id=$1`, [conversation])).rows;
    expect(copied).toEqual([expect.objectContaining({ role: "system" })]);
    expect(copied[0].metadata_json.reference).toMatchObject({ kind: "briefing_highlight", source_id: next, trust: "external_untrusted", item_ids: [fresh] });
    expect(copied[0].content).toContain("FRESH_FACT");
    expect(copied[0].content).toContain("instructions to follow");

    // Another Project's Room: refused, whatever the person can read.
    const otherProject = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,settings_json,created_at,updated_at) VALUES ($1,$2,$3,'Other','active','{}',now(),now())`, [otherProject, SPACE, OWNER]);
    const otherRoom = await rooms.createRoom(owner, { project_id: otherProject, title: "Elsewhere" });
    const elsewhere = await new PgSessionRepository(db.pool).createRoomConversation({ space_id: SPACE, room_id: otherRoom.room.id, project_id: otherProject, project_folder_id: null, title: "x", metadata: {} });
    await expect(rooms.attachConversationReferences(owner, otherRoom.room.id, elsewhere.id, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }], confirm_disclosure: true }))
      .rejects.toMatchObject({ statusCode: 422, responseBody: expect.objectContaining({ code: "briefing_reference_scope_mismatch" }) });
    // The Room's Agent runs where the Source refuses to go: refused at send.
    await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":false,"allow_local_provider_egress":false}'::jsonb WHERE id=$1`, [CONNECTION]);
    await expect(rooms.attachConversationReferences(owner, room, conversation, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }] }))
      .rejects.toMatchObject({ statusCode: 403, responseBody: expect.objectContaining({ code: "briefing_highlight_withheld" }) });
    // Withdrawn material: refused at prepare and at send.
    await db.pool.query(`UPDATE source_connections SET consent_json='{"allow_external_model_egress":true,"allow_local_provider_egress":true}'::jsonb WHERE id=$1`, [CONNECTION]);
    await db.pool.query(`UPDATE source_items SET deleted_at=now() WHERE id=$1`, [fresh]);
    await expect(prepareFollowUp(db.pool, adapter(), OWNER, next, 0)).rejects.toMatchObject({ statusCode: 403 });
    await expect(rooms.attachConversationReferences(owner, room, conversation, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(await count(`messages WHERE session_id='${conversation}'`)).toBe(1);
  });

  it("keeps a personal highlight to a conversation only its owner reads", async (ctx) => {
    if (!db.available) return ctx.skip();
    const personal = personalBriefingScope(SPACE, OWNER);
    const { next, value } = await deltaWith("new", personal, { ...manual, label: PERSONAL_BRIEFING_LABEL });
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    expect((await prepareFollowUp(db.pool, personal, OWNER, next, 0)).scope_type).toBe("personal");
    await expect(prepareFollowUp(db.pool, personalBriefingScope(SPACE, MEMBER), MEMBER, next, 0)).rejects.toMatchObject({ statusCode: 404 });
    // The Project's shared Room: refused even with a disclosure confirmation.
    const { room, conversation } = await mainlineConversation();
    await expect(rooms.attachConversationReferences(owner, room, conversation, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }], confirm_disclosure: [MEMBER] }))
      .rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "briefing_reference_scope_mismatch" }) });
    // Someone else attaching it: not found.
    await expect(rooms.attachConversationReferences(member, room, conversation, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }] }))
      .rejects.toMatchObject({ statusCode: 404 });
    // Their own private Room in a Project: allowed.
    const mine = await rooms.createRoom(owner, { project_id: PROJECT, title: "Just me", personal: true });
    const draft = await new PgSessionRepository(db.pool).createRoomConversation({ space_id: SPACE, room_id: mine.room.id, project_id: PROJECT, project_folder_id: null, title: "Mine", metadata: {} });
    await rooms.attachConversationReferences(owner, mine.room.id, draft.id, { references: [{ kind: "briefing_highlight", id: next, highlight: 0 }] });
    expect(await count(`messages WHERE session_id='${draft.id}'`)).toBe(1);
    expect(await count(`messages WHERE session_id='${conversation}'`)).toBe(0);
  });
});

describe("Adoption: a highlight becomes a Task only by an explicit, previewed confirmation", () => {
  it("lets a Project writer preview, then create exactly one shared Task through the canonical writer, with provenance", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, value, fresh } = await deltaWith("new");
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    // A reader reads but does not write.
    await expect(previewAdoption(db.pool, adapter(), member, next, 0)).rejects.toMatchObject({ statusCode: 403 });
    const preview = await previewAdoption(db.pool, adapter(), owner, next, 0);
    expect(preview).toMatchObject({ project_id: PROJECT, visibility: "space_shared", title: "FRESH_HIGHLIGHT", existing_task_id: null });
    expect(preview.description).toContain("FRESH_FACT");
    expect(await count("tasks")).toBe(0);
    await expect(confirmAdoption(db.pool, adapter(), member, next, 0, preview.preview_hash)).rejects.toMatchObject({ statusCode: 403 });

    // Concurrent confirmations and a retry return the same Task.
    const results = await Promise.all([1, 2, 3].map(() => confirmAdoption(db.pool, adapter(), owner, next, 0, preview.preview_hash)));
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await confirmAdoption(db.pool, adapter(), owner, next, 0, preview.preview_hash)).toMatchObject({ created: false, task: { id: results[0]!.task.id } });
    const task = (await db.pool.query(`SELECT * FROM tasks`)).rows;
    expect(task).toEqual([expect.objectContaining({ project_id: PROJECT, visibility: "space_shared", title: "FRESH_HIGHLIGHT", priority: "high", created_by_user_id: OWNER })]);
    expect(task[0].metadata_json.briefing_adoption).toMatchObject({ briefing_id: next, highlight: 0, evidence_item_ids: [fresh] });
    // The canonical writer's own event, with the Task.
    expect(await count(`project_work_events WHERE subject_id='${task[0].id}' AND event_kind='task.created'`)).toBe(1);
    expect(await count("memory_entries")).toBe(0);
    expect((await previewAdoption(db.pool, adapter(), owner, next, 0)).existing_task_id).toBe(task[0].id);
  });

  it("refuses a confirmation when the highlight's standing or draft changed after the preview", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, value, fresh } = await deltaWith("new");
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    const preview = await previewAdoption(db.pool, adapter(), owner, next, 0);
    // The draft changed (the Project was renamed): preview again.
    await db.pool.query(`UPDATE projects SET name='Renamed' WHERE id=$1`, [PROJECT]);
    await expect(confirmAdoption(db.pool, adapter(), owner, next, 0, preview.preview_hash)).rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "briefing_adoption_changed" }) });
    // Material withdrawn between preview and confirm: refused, nothing created.
    const again = await previewAdoption(db.pool, adapter(), owner, next, 0);
    await db.pool.query(`UPDATE source_items SET deleted_at=now() WHERE id=$1`, [fresh]);
    await expect(confirmAdoption(db.pool, adapter(), owner, next, 0, again.preview_hash)).rejects.toMatchObject({ statusCode: 403 });
    expect(await count("tasks")).toBe(0);

  });

  it("adopts a personal highlight only as its owner's private Task", async (ctx) => {
    if (!db.available) return ctx.skip();
    const personal = personalBriefingScope(SPACE, OWNER);
    const mine = await deltaWith("new", personal, { ...manual, label: PERSONAL_BRIEFING_LABEL });
    await settleBriefingRun(db.pool, await finishRun((await runOf(mine.next)).id, output(mine.value)));
    const personalPreview = await previewAdoption(db.pool, personal, owner, mine.next, 0);
    expect(personalPreview).toMatchObject({ project_id: null, visibility: "private" });
    await confirmAdoption(db.pool, personal, owner, mine.next, 0, personalPreview.preview_hash);
    expect((await db.pool.query(`SELECT project_id, visibility, owner_user_id FROM tasks`)).rows).toEqual([{ project_id: null, visibility: "private", owner_user_id: OWNER }]);
    await expect(previewAdoption(db.pool, personalBriefingScope(SPACE, MEMBER), member, mine.next, 0)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("over HTTP, answers someone outside the briefing's scope 404 at preview and confirm, never their Task; the owner's retry returns it", async (ctx) => {
    if (!db.available) return ctx.skip();
    const personal = personalBriefingScope(SPACE, OWNER);
    const mine = await deltaWith("new", personal, { ...manual, label: PERSONAL_BRIEFING_LABEL });
    await settleBriefingRun(db.pool, await finishRun((await runOf(mine.next)).id, output(mine.value)));
    // A writer of the Project, too: Project authority is not authority over someone's personal briefing.
    await db.pool.query(`UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2`, [PROJECT, MEMBER]);
    const app = buildModuleServer(loadConfig({ SERVER_DATABASE_URL: db.connectionUri, RAINVER_HOME: home }), [informationDigestModule]);
    const personalUrl = `/api/v1/spaces/${SPACE}/information-briefings/personal/${mine.next}/highlights/0/adoption`;
    const projectUrl = `/api/v1/spaces/${SPACE}/projects/${PROJECT}/information-briefings/${mine.next}/highlights/0/adoption`;
    const post = (url: string, payload: object = {}) => app.inject({ method: "POST", url, payload });
    try {
      __setAuthIdentityForTests(owner);
      const preview = await post(`${personalUrl}/preview`);
      expect(preview.statusCode).toBe(200);
      const created = await post(personalUrl, { preview_hash: preview.json().preview_hash });
      expect(created.statusCode).toBe(201);
      const task = created.json().task as { id: string };

      __setAuthIdentityForTests(member);
      for (const url of [personalUrl, projectUrl]) {
        expect((await post(`${url}/preview`)).statusCode).toBe(404);
        const confirm = await post(url, { preview_hash: preview.json().preview_hash });
        expect(confirm.statusCode).toBe(404);
        expect(confirm.body).not.toContain(task.id);
      }
      await expect(new PgTaskRepository(db.pool).getTask(member, task.id)).resolves.toBeNull();

      __setAuthIdentityForTests(owner);
      const retry = await post(personalUrl, { preview_hash: preview.json().preview_hash });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ created: false, task: created.json().task });
      expect((await post(`${personalUrl}/preview`)).json().existing_task_id).toBe(task.id);
      expect(await count("tasks")).toBe(1);
    } finally {
      __setAuthIdentityForTests(null);
      await app.close();
    }
  });

  it("points a same-scope writer only at an adopted Task they can still read, and never duplicates one they cannot", async (ctx) => {
    if (!db.available) return ctx.skip();
    const { next, value } = await deltaWith("new");
    await settleBriefingRun(db.pool, await finishRun((await runOf(next)).id, output(value)));
    await db.pool.query(`UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2`, [PROJECT, MEMBER]);
    const preview = await previewAdoption(db.pool, adapter(), owner, next, 0);
    const created = await confirmAdoption(db.pool, adapter(), owner, next, 0, preview.preview_hash);
    expect((await previewAdoption(db.pool, adapter(), member, next, 0)).existing_task_id).toBe(created.task.id);
    expect(await confirmAdoption(db.pool, adapter(), member, next, 0, preview.preview_hash)).toEqual({ created: false, task: created.task });
    // The Task's creator made it private afterwards: the other writer is not pointed at it, and gets no second Task.
    await db.pool.query(`UPDATE tasks SET visibility='private', owner_user_id=$2 WHERE id=$1`, [created.task.id, OWNER]);
    await expect(new PgTaskRepository(db.pool).getTask(member, created.task.id)).resolves.toBeNull();
    const blind = await previewAdoption(db.pool, adapter(), member, next, 0);
    expect(blind.existing_task_id).toBeNull();
    await expect(confirmAdoption(db.pool, adapter(), member, next, 0, blind.preview_hash))
      .rejects.toMatchObject({ statusCode: 409, responseBody: expect.objectContaining({ code: "briefing_adoption_exists" }) });
    expect(await count("tasks")).toBe(1);
  });
});
