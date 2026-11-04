import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { InquiryProblemEngineService } from "../src/modules/inquiry/problemEngineService.js";
import { getProjectUpdates } from "../src/modules/projectWork/updatesReadModel.js";
import { undoProjectUpdate } from "../src/modules/projectWork/updateUndo.js";
import { ProblemProjectionSchema } from "@rainver/protocol";
const db = useTestDatabase(import.meta.filename);
let space: string, owner: string, project: string, thread: string;
const identity = () => ({
  spaceId: space,
  userId: owner
});
const engine = () => new InquiryProblemEngineService(db.pool);
async function token() {
  const p = await engine().projection(identity(), project, thread);
  return {
    method_version: "problem_solving.v1",
    expected_version: p.version,
    expected_revision: p.revision,
    idempotency_key: randomUUID()
  };
}
async function work(stage = "frame", extra: Record<string, unknown> = {}) {
  return engine().recordWork(identity(), project, thread, {
    ...(await token()),
    stage,
    work_kind: "record_work",
    reason: "Working on this problem",
    ...extra
  });
}
async function close(extra: Record<string, unknown> = {}) {
  return engine().closeRound(identity(), project, thread, {
    ...(await token()),
    summary: "No new evidence; keep the judgment",
    ...extra
  });
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
    project
  });
  const t = await new InquiryThreadService(db.pool).createThread(identity(), project, {
    kind: "question",
    statement: "Why does import fail?"
  });
  thread = String(t.id);
});
describe("Inquiry problem rounds (real PostgreSQL)", () => {
  it("closes unchanged rounds repeatedly without inventing cognitive Iterations", async () => {
    await work();
    await close();
    await work("verify");
    await close();
    const p = await engine().projection(identity(), project, thread);
    expect(ProblemProjectionSchema.safeParse(p).success).toBe(true);
    expect(p.round_number).toBe(3);
    expect(p.current_focus).toBeNull();
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_iterations WHERE thread_id=$1`, [thread])).rows[0].n).toBe(0);
    expect((p.stages as {
      worked: boolean;
      has_outputs: boolean;
    }[]).every(s => !s.worked && !s.has_outputs)).toBe(true);
  });
  it("records skip and return facts in the same round without marking skipped work complete", async () => {
    await work("act", {
      work_kind: "select_method",
      selection_kind: "skip",
      skipped_stages: ["plan"]
    });
    const p = await work("plan", {
      work_kind: "select_method",
      selection_kind: "return"
    });
    expect(p.round_number).toBe(1);
    expect(p.current_focus).toMatchObject({
      stage: "plan"
    });
    expect((p.steps as {
      selection_kind: string;
    }[]).map(s => s.selection_kind)).toEqual(["skip", "return"]);
    expect((p.stages as {
      worked: boolean;
    }[]).every(s => !s.worked)).toBe(true);
  });
  it("distinguishes inputs, outputs and verification acceptance", async () => {
    let p = await work("verify", {
      input_refs: [{type:"inquiry_thread",id:thread}]
    });
    expect((p.stages as Record<string, unknown>[]).find(s => s.stage === "verify")).toMatchObject({
      worked: true,
      has_outputs: false
    });
    p = await work("verify", {
      output_refs: [{type:"inquiry_thread",id:thread}]
    });
    expect((p.stages as Record<string, unknown>[]).find(s => s.stage === "verify")).toMatchObject({
      has_outputs: true
    });
    expect(p).not.toHaveProperty("verification_passed");
  });
  it("counts a changed-position close-out once and preserves closed Step membership", async () => {
    await work("verify", {
      input_refs: [{type:"inquiry_thread",id:thread}]
    });
    const result = await new InquiryIterationService(db.pool).recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "close_round",
      change_summary: "Found the cause",
      answer_state: "partial",
      current_answer_summary: "Invalid delimiter"
    });
    expect(result.closeout).toMatchObject({
      round_number: 1,
      iteration_id: result.id
    });
    expect((await engine().projection(identity(), project, thread)).round_number).toBe(2);
    const steps = (await db.pool.query(`SELECT round_number FROM inquiry_thread_steps WHERE thread_id=$1`, [thread])).rows;
    expect(steps.every(s => s.round_number === 1)).toBe(true);
  });
  it("replays changed-position close-out once and cognitive undo does not close another round", async () => {
    const body = {
      ...(await token()),
      round_intent: "close_round",
      change_summary: "Answer",
      answer_state: "partial"
    };
    const iterations = new InquiryIterationService(db.pool);
    const first = await iterations.recordIteration(identity(), project, thread, body);
    expect(await iterations.recordIteration(identity(), project, thread, body)).toEqual(first);
    const updates = await getProjectUpdates(db.pool, identity(), project, null);
    const event = updates.items.flatMap(e=>e.members??[e]).find(e => e.event_kind === "thread.concluded")!;
    await undoProjectUpdate(db.pool, identity(), project, event.id);
    const p = await engine().projection(identity(), project, thread);
    expect(p.round_number).toBe(2);
    expect(p.closeouts).toHaveLength(1);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_iterations WHERE thread_id=$1`, [thread])).rows[0].n).toBe(2);
  });
  it("refuses stale cognitive undo instead of overwriting a newer judgment", async () => {
    const iterations = new InquiryIterationService(db.pool);
    await iterations.recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "position_only",
      change_summary: "Partial",
      answer_state: "partial"
    });
    const event = (await getProjectUpdates(db.pool, identity(), project, null)).items.flatMap(e=>e.members??[e]).find(e => e.event_kind === "thread.concluded")!;
    await iterations.recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "position_only",
      change_summary: "Answered",
      answer_state: "answered"
    });
    await expect(undoProjectUpdate(db.pool, identity(), project, event.id)).rejects.toMatchObject({
      statusCode: 409
    });
  });
  it("keeps position-only cognition in its current round and never starts a recorded next intent", async () => {
    await work("verify");
    await new InquiryIterationService(db.pool).recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "position_only",
      change_summary: "Partial answer",
      answer_state: "partial",
    });
    const p = await engine().projection(identity(), project, thread);
    expect(p.round_number).toBe(1);
    expect(p.current_focus).toMatchObject({
      stage: "verify"
    });
    expect(p.closeouts).toEqual([]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_thread_steps WHERE slot='background'`)).rows[0].n).toBe(0);
  });
  it("replays identical work and close-out commands, rejects changed payloads using the same key", async () => {
    const request = {
      ...(await token()),
      summary: "Keep judgment"
    };
    const first = await engine().closeRound(identity(), project, thread, request);
    const second = await engine().closeRound(identity(), project, thread, request);
    expect(second).toEqual(first);
    await expect(engine().closeRound(identity(), project, thread, {
      ...request,
      summary: "Different"
    })).rejects.toMatchObject({
      statusCode: 409
    });
    const req = {
      ...(await token()),
      stage: "plan",
      work_kind: "record_work",
      reason: "Compare"
    };
    const a = await engine().recordWork(identity(), project, thread, req);
    expect(await engine().recordWork(identity(), project, thread, req)).toEqual(a);
  });
  it("serializes concurrent close-outs and concurrent work using expected revision", async () => {
    const t = await token();
    const results = await Promise.allSettled([engine().closeRound(identity(), project, thread, {
      ...t,
      summary: "A"
    }), engine().closeRound(identity(), project, thread, {
      ...t,
      idempotency_key: randomUUID(),
      summary: "B"
    })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await engine().projection(identity(), project, thread)).round_number).toBe(2);
    const w = {
      ...(await token()),
      stage: "frame",
      work_kind: "record_work",
      reason: "A"
    };
    const wr = await Promise.allSettled([engine().recordWork(identity(), project, thread, w), engine().recordWork(identity(), project, thread, {
      ...w,
      idempotency_key: randomUUID()
    })]);
    expect(wr.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects retired method writers without creating history",async()=>{
    await expect(new InquiryIterationService(db.pool).recordIteration(identity(),project,thread,{change_summary:"Old request",method_version:"inquiry_research.v1",answer_state:"partial"})).rejects.toMatchObject({statusCode:422});
    expect((await engine().projection(identity(),project,thread)).round_number).toBe(1);
  });
  it("protects cognitive fields and requires modern explicit round intent", async () => {
    await expect(work("frame", {
      answer_state: "answered"
    })).rejects.toMatchObject({
      statusCode: 422
    });
    await expect(new InquiryIterationService(db.pool).recordIteration(identity(), project, thread, {
      ...(await token()),
      change_summary: "No intent",
      answer_state: "partial"
    })).rejects.toMatchObject({
      statusCode: 422
    });
    await expect(new InquiryIterationService(db.pool).recordIteration(identity(), project, thread, {
      ...(await token()),
      round_intent: "position_only",
      change_summary: "Unchanged",
      answer_state: "open"
    })).rejects.toMatchObject({
      statusCode: 422
    });
  });
  it("does not turn preparation or a close-out's next_focus into background execution", async () => {
    await work("frame", {
      work_kind: "invoke_research"
    });
    await close({
      next_focus: {
        stage: "act",
        work_kind: "invoke_research",
        reason: "Search later"
      }
    });
    expect((await engine().projection(identity(), project, thread)).current_focus).toBeNull();
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_thread_steps WHERE slot='background'`)).rows[0].n).toBe(0);
  });
  it("exposes a no-change close-out in Updates and undoes it through append-only compensation", async () => {
    await work("plan");
    const c = await close();
    const updates = await getProjectUpdates(db.pool, identity(), project, null);
    const event = updates.items.find(e => e.event_kind === "thread.round_closed");
    expect(event?.undo?.action).toBe("revert_round_closeout");
    await undoProjectUpdate(db.pool, identity(), project, event!.id);
    const p = await engine().projection(identity(), project, thread);
    expect(p.round_number).toBe(2);
    expect((p.closeouts as Record<string, unknown>[])[0]).toMatchObject({
      id: c.id,
      compensated: true
    });
    expect(p.current_focus).toMatchObject({
      stage: "plan"
    });
    await expect(undoProjectUpdate(db.pool, identity(), project, event!.id)).rejects.toMatchObject({
      statusCode: 409
    });
  });
  it("undoes a close-out that opened the next primary, restoring the prior choice with its inputs", async () => {
    const other = String((await new InquiryThreadService(db.pool).createThread(identity(), project, { kind: "question", statement: "Which loader runs?" })).id);
    await work("plan", { input_refs: [{ type: "inquiry_thread", id: other }] });
    await close({ start_next_primary: { stage: "act", work_kind: "record_work", reason: "Try the fix" } });
    expect((await engine().projection(identity(), project, thread)).current_focus).toMatchObject({ stage: "act" });
    const event = (await getProjectUpdates(db.pool, identity(), project, null)).items.find(e => e.event_kind === "thread.round_closed");
    await undoProjectUpdate(db.pool, identity(), project, event!.id);
    expect((await engine().projection(identity(), project, thread)).current_focus).toMatchObject({ stage: "plan" });
    const steps = await db.pool.query(`SELECT method_stage,status,ended_reason,context_refs FROM inquiry_thread_steps WHERE thread_id=$1 AND slot='primary' AND method_stage IN ('plan','act') ORDER BY created_at,method_stage`, [thread]);
    expect(steps.rows.filter(s => s.status === "in_progress")).toEqual([{ method_stage: "plan", status: "in_progress", ended_reason: null, context_refs: [{ role: "input", ref: { type: "inquiry_thread", id: other } }] }]);
    expect(steps.rows.find(s => s.method_stage === "act")).toMatchObject({ status: "abandoned", ended_reason: "closeout_reverted" });
  });
  it("refuses close-out undo after dependent work without deleting or moving either round", async () => {
    await close();
    const updates = await getProjectUpdates(db.pool, identity(), project, null);
    const event = updates.items.find(e => e.event_kind === "thread.round_closed")!;
    await work("act");
    await expect(undoProjectUpdate(db.pool, identity(), project, event.id)).rejects.toMatchObject({
      statusCode: 409
    });
    expect((await engine().projection(identity(), project, thread)).round_number).toBe(2);
  });
  it("rechecks Project and full Thread permissions for reads, writes and replay", async () => {
    const req = {
      ...(await token()),
      summary: "Private"
    };
    await engine().closeRound(identity(), project, thread, req);
    const stranger = {
      spaceId: space,
      userId: randomUUID()
    };
    await expect(engine().projection(stranger, project, thread)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(engine().closeRound(stranger, project, thread, req)).rejects.toBeDefined();
    const reader = randomUUID();
    await db.pool.query(`INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'Reader','active',now(),now(),$2,'system')`, [reader, reader + '@test.invalid']);
    await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, reader]);
    await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, reader]);
    await db.pool.query(`UPDATE space_objects SET access_level='summary',summary='Public summary' WHERE id=$1`, [thread]);
    const limited = {
      spaceId: space,
      userId: reader
    };
    await expect(engine().projection(limited, project, thread)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(engine().closeRound(limited, project, thread, req)).rejects.toMatchObject({
      statusCode: 404
    });
    expect((await getProjectUpdates(db.pool, limited, project, null)).items.some(e => e.event_kind === 'thread.round_closed')).toBe(false);
  });
});
