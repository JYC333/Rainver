import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { InquiryProblemEngineService } from "../src/modules/inquiry/problemEngineService.js";
import { seedResearchOperation } from "./support/researchSeeds.js";
import { problemThreadPage } from "../src/modules/inquiry/problemReadModel.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { undoProjectUpdate } from "../src/modules/projectWork/updateUndo.js";
const db = useTestDatabase(import.meta.filename);
let space: string, owner: string, project: string, thread: string;
const identity = () => ({
  spaceId: space,
  userId: owner
});
const engine = () => new InquiryProblemEngineService(db.pool);
const threads = () => new InquiryThreadService(db.pool);
async function token() {
  const p = await engine().projection(identity(), project, thread);
  return {
    method_version: "problem_solving.v1",
    expected_version: p.version,
    expected_revision: p.revision,
    idempotency_key: randomUUID()
  };
}
beforeEach(async () => {
  if (!db.available) return;
  await resetTables(db.pool, ["spaces", "users"], {
    cascade: true
  });
  space = randomUUID();
  owner = randomUUID();
  project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project,
    spaceType: "household"
  });
  thread = String((await threads().createThread(identity(), project, {
    kind: "question",
    statement: "Compatibility"
  })).id);
});
describe("problem consumers use durable facts", () => {
  it("rejects old Step writes instead of guessing their method or round",async()=>{
    await expect(db.pool.query(`INSERT INTO inquiry_thread_steps(id,space_id,project_id,thread_id,kind,status,slot,origin,created_at) VALUES($1,$2,$3,$4,'search_acquisition','in_progress','background','system',now())`,[randomUUID(),space,project,thread])).rejects.toMatchObject({code:'23514'});
    expect((await engine().projection(identity(),project,thread)).steps).toEqual([]);
  });
  it("Thread detail follows close-outs, not position-only or compensating Iterations", async () => {
    const iterations = new InquiryIterationService(db.pool);
    await iterations.recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "position_only",
      change_summary: "Partial",
      answer_state: "partial"
    });
    expect((await threads().getThread(identity(), project, thread)).problem_summary).toMatchObject({
      round_number: 1,
      round_started_at: null
    });
    await engine().closeRound(identity(), project, thread, {
      ...(await token()),
      summary: "Keep judgment"
    });
    const detail = await threads().getThread(identity(), project, thread);
    expect(detail.problem_summary).toMatchObject({
      round_number: 2
    });
    const update = (await getProjectUpdates(db.pool, identity(), project, null)).items.find(e => e.event_kind === "thread.round_closed")!;
    await undoProjectUpdate(db.pool, identity(), project, update.id);
    const after = (await threads().getThread(identity(), project, thread)).problem_summary;
    expect(after).toEqual({
      ...(detail.problem_summary as Record<string, unknown>),
      revision: (detail.problem_summary as {
        revision: number;
      }).revision + 1
    });
  });
  it("pages compact Thread summaries and bounded histories without losing the live boundary", async () => {
    for (let n = 0; n < 4; n++) await threads().createThread(identity(), project, {
      kind: "question",
      statement: `Question ${n}`
    });
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = await problemThreadPage(db.pool, identity(), project, {
        limit: 2,
        after_thread_id: cursor
      });
      ids.push(...page.threads.map(t => t.thread_id));
      expect(JSON.stringify(page)).not.toContain('"steps"');
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(5);
    for (let n = 0; n < 4; n++) await engine().closeRound(identity(), project, thread, {
      ...(await token()),
      summary: `Round ${n}`
    });
    const first = await engine().projection(identity(), project, thread, {
      limit: 2
    });
    expect(first.closeouts).toHaveLength(2);
    expect(first.round_number).toBe(5);
    expect(first.next_closeout_cursor).toEqual(expect.any(Number));
    const second = await engine().projection(identity(), project, thread, {
      limit: 2,
      before_closeout: first.next_closeout_cursor as number
    });
    expect(second.closeouts).toHaveLength(2);
    expect(second.round_number).toBe(5);
  });
  it("closing selected work records why it ended, not a produced result", async () => {
    await engine().recordWork(identity(), project, thread, {
      ...(await token()),
      stage: "verify",
      work_kind: "select_method",
      reason: "Inspect later"
    });
    await engine().closeRound(identity(), project, thread, {
      ...(await token()),
      summary: "No evidence"
    });
    const row = (await db.pool.query(`SELECT status,ended_reason,context_refs FROM inquiry_thread_steps WHERE thread_id=$1 AND work_kind='select_method'`, [thread])).rows[0];
    expect(row).toMatchObject({
      status: "abandoned",
      ended_reason: "round_closed",
      context_refs: []
    });
  });
  it("shows a changed close-out once while retaining two independent audit/undo entries", async () => {
    await new InquiryIterationService(db.pool).recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "close_round",
      change_summary: "Found cause",
      answer_state: "partial"
    });
    const updates = (await getProjectUpdates(db.pool, identity(), project, null)).items.filter(e => e.event_kind === "thread.round_closed" || e.event_kind === "thread.concluded");
    expect(updates).toHaveLength(1);
    expect(updates[0].members?.map(e => e.undo?.action)).toEqual(["revert_round_closeout", "revert_iteration"]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_work_events WHERE subject_id=$1 AND event_kind IN ('thread.round_closed','thread.concluded')`, [thread])).rows[0].n).toBe(2);
  });
  it("counts a generic primary toward WIP even beside active background work", async () => {
    const iterations = new InquiryIterationService(db.pool);
    const operationId = randomUUID();
    await seedResearchOperation(db.pool, {
      id: operationId,
      space,
      project,
      owner,
      progress: {},
      now: new Date().toISOString()
    });
    await db.pool.query(`INSERT INTO inquiry_thread_steps(id,space_id,project_id,thread_id,kind,method_version,method_stage,work_kind,round_number,status,slot,origin,started_at,created_at) VALUES($1,$2,$3,$4,'invoke_research','problem_solving.v1','act','invoke_research',1,'in_progress','background','system',now(),now())`,[randomUUID(),space,project,thread]);
    await engine().recordWork(identity(),project,thread,{...(await token()),stage:'verify',work_kind:'record_work',reason:'Continue verification'});
    await iterations.updateWork(identity(),project,thread,{attention_state:'focused'});
    await db.pool.query(`INSERT INTO inquiry_project_settings(project_id,space_id,shared_focus_wip_limit,updated_at) VALUES($1,$2,1,now()) ON CONFLICT(project_id) DO UPDATE SET shared_focus_wip_limit=1`, [project, space]);
    const another = String((await threads().createThread(identity(), project, {
      kind: "question",
      statement: "Other work"
    })).id);
    await iterations.updateWork(identity(),project,another,{attention_state:"backlog"});
    expect(await iterations.updateWork(identity(), project, another, {
      attention_state: "focused"
    })).toMatchObject({
      wip_limit_exceeded: true
    });
  });
  it("rejects forged refs and hides referenced private content from another full Thread reader", async () => {
    await expect(engine().recordWork(identity(), project, thread, {
      ...(await token()),
      stage: "verify",
      work_kind: "record_work",
      reason: "Bad",
      output_refs: [{
        type: "task",
        id: randomUUID()
      }]
    })).rejects.toMatchObject({
      statusCode: 404
    });
    const ref = await threads().createThread(identity(), project, {
      kind: "question",
      statement: "Private reference"
    });
    await db.pool.query(`UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1`, [ref.id, owner]);
    await engine().recordWork(identity(), project, thread, {
      ...(await token()),
      stage: "verify",
      work_kind: "record_work",
      reason: "Secret measurements",
      output_refs: [{
        type: "inquiry_thread",
        id: ref.id
      }]
    });
    const reader = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'Reader','active',now(),now(),$2,'system')`, [reader, reader + '@test.invalid']);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, reader]);
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, reader]);
    const limited = {
      spaceId: space,
      userId: reader
    };
    const projection = await engine().projection(limited, project, thread);
    expect(JSON.stringify(projection)).not.toContain('Secret measurements');
    expect(JSON.stringify(projection)).not.toContain(String(ref.id));
    expect(JSON.stringify(await getProjectUpdates(db.pool, limited, project, null))).not.toContain('Secret measurements');
  });
});
