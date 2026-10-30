import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import {
  AGENT, CONNECTION, MEMBER, OWNER, PROFILE, PROJECT, SPACE,
  briefingWorld, manual, output, outputValue,
} from "./support/briefingFixture.js";
import { assertBriefingDispatch, settleBriefingRun } from "../src/modules/informationDigest/briefing/settlement.js";
import { buildRunOrchestration } from "../src/modules/runs/orchestrationFactory.js";
import { PgRetrievalIntentProvider } from "../src/modules/runtimeContext/productionAcquisition.js";
import { RuntimeContextPolicyRepository } from "../src/modules/policy/runtimeContextPolicyRepository.js";
import { WorkContextService } from "../src/modules/runtimeContext/workContextService.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { createProductionRuntimeContextPlanningService } from "../src/modules/runtimeContext/productionAcquisition.js";
import { RetrievalProjectionService } from "../src/modules/retrieval/projectionService.js";
import { memoryRetrievalRegistry } from "../src/modules/memory/retrievalAdapter.js";

const db = useTestDatabase(import.meta.filename);
const w = briefingWorld(db);
const { adapter, service, config, material, finishRun, rowOf, runOf, inputsOf, count } = w;
const REFUSING = { allow_external_model_egress: false, allow_local_provider_egress: false };
const CONSENTING = { allow_external_model_egress: true, allow_local_provider_egress: true };
const SECOND_CONNECTION = "bf000000-0000-4000-8000-0000000000c1";
const SECOND_CHANNEL = "bf000000-0000-4000-8000-0000000000c2";

beforeEach(async () => { if (db.available) await w.seed(); });

/** A Following topic of the Project whose binding collects from `connection`, selecting `item` with `reason`. */
async function following(item: string, connection: string, reason: string) {
  const goal = randomUUID(), binding = randomUUID();
  await db.pool.query(`INSERT INTO source_goals (id,space_id,owner_user_id,project_id,agent_id,runtime_profile_id,intent_json,budget_json,status) VALUES ($1,$2,$3,$4,$5,$6,'{"intent":"Gripper watch"}','{}','running')`, [goal, SPACE, OWNER, PROJECT, AGENT, PROFILE]);
  await db.pool.query(`INSERT INTO source_goal_bindings (id,space_id,goal_id,source_connection_id,spec_json) VALUES ($1,$2,$3,$4,'{}')`, [binding, SPACE, goal, connection]);
  await db.pool.query(
    `INSERT INTO source_goal_items (id,space_id,goal_id,source_item_id,source_connection_id,binding_id,version_id,first_goal_run_id,last_goal_run_id,selection_status,selection_reason,delivery_kind,associated_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'v','r','r','important',$7,'new_publication',now() - interval '1 hour',now() - interval '1 hour')`,
    [randomUUID(), SPACE, goal, item, connection, binding, reason],
  );
}

describe("Briefing dependencies: every text that reaches the model is authorized on its own", () => {
  it("drops a family member, signal or analysis whose own Source refuses the model, and keeps it out of dispatch and reads", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.addSource(SECOND_CONNECTION, SECOND_CHANNEL, "Refusing feed", REFUSING);
    // Same capture on two Sources: the allowed one leads; the refusing one carries a secret judgment.
    const lead = await material("Allowed lead", { uri: "https://news.test/same", addedHoursAgo: 0.2 });
    const other = await material("Secondary same capture", { uri: "https://news.test/same", addedHoursAgo: 0.5, owner: MEMBER, connection: SECOND_CONNECTION, channel: SECOND_CHANNEL, reason: "SECONDARY_SECRET_SIGNAL" });
    // A Following judgment collected through the refusing Source, on an item from the allowed Source.
    const followed = await material("Followed article", { addedHoursAgo: 0.3 });
    await following(followed, SECOND_CONNECTION, "COLLECTING_SOURCE_SECRET_REASON");
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("Allowed lead");
    expect(run.prompt).toContain("Followed article");
    expect(run.prompt).not.toContain("SECONDARY_SECRET_SIGNAL");
    expect(run.prompt).not.toContain("COLLECTING_SOURCE_SECRET_REASON");
    expect(run.prompt).not.toContain("Gripper watch");
    const inputs = await inputsOf(requested.briefing.id);
    const family = inputs.find((input) => input.source_item_id === lead)!;
    // The refused member is part of the family (one capture) but none of its text is a dependency.
    expect(family.analysis_json.item_ids.sort()).toEqual([lead, other].sort());
    expect(family.analysis_json.deps.items.map((dep: { id: string }) => dep.id)).toEqual([lead]);
    expect(JSON.stringify(inputs.find((input) => input.source_item_id === followed)!.analysis_json.deps.signals)).not.toContain(SECOND_CONNECTION);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
  });

  it("re-checks every member and collecting Source of a merged family at dispatch, publication and read", async (ctx) => {
    if (!db.available) return ctx.skip();
    await w.addSource(SECOND_CONNECTION, SECOND_CHANNEL, "Second feed", CONSENTING);
    await material("Allowed lead", { uri: "https://news.test/same", addedHoursAgo: 0.2 });
    const other = await material("Secondary same capture", { uri: "https://news.test/same", addedHoursAgo: 0.5, owner: MEMBER, connection: SECOND_CONNECTION, channel: SECOND_CHANNEL, reason: "SECONDARY_SIGNAL" });
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("SECONDARY_SIGNAL");
    // The secondary Source withdraws model consent after freezing: the lead alone cannot carry its text out.
    await db.pool.query(`UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1`, [SECOND_CONNECTION, JSON.stringify(REFUSING)]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    await db.pool.query(`UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1`, [SECOND_CONNECTION, JSON.stringify(CONSENTING)]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).resolves.toBeUndefined();
    // Published, then the secondary Source is archived: the overview resting on that family is withheld.
    await settleBriefingRun(db.pool, await finishRun(run.id, output({ overview: { text: "SECONDARY_SIGNAL matters", refs: ["S1"] } })));
    expect(await service().get(adapter(), MEMBER, requested.briefing.id)).toMatchObject({ visibility: "visible" });
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`, [SECOND_CONNECTION]);
    expect((await adapter().allowedItems(db.pool, [other])).has(other)).toBe(false);
    const read = await service().get(adapter(), MEMBER, requested.briefing.id);
    expect(read).toMatchObject({ visibility: "withheld", overview: null, evidence: [] });
    expect(JSON.stringify(read)).not.toContain("SECONDARY_SIGNAL");
  });

  it("re-checks frozen Project context at dispatch and publication: a Task leaving the Project stops it, an edited one invalidates it", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const task = await w.task("SECRET_TASK_CONTEXT");
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.prompt).toContain("SECRET_TASK_CONTEXT");
    // Still shared but edited: the frozen text is no longer current.
    await db.pool.query(`UPDATE tasks SET title='Renamed task', updated_at=now() WHERE id=$1`, [task]);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 409, code: "briefing_inputs_changed" });
    // Moved out of the Project and made private: no Project reader but its owner may read it now.
    await db.pool.query(`UPDATE tasks SET visibility='private', project_id=NULL, updated_at=now() WHERE id=$1`, [task]);
    expect((await adapter().contextState(db.pool, [{ type: "task", id: task, revision: "x" }])).allowed.size).toBe(0);
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_access_changed" });
    // Had it already been sent, publication still refuses an overview resting on it.
    const taskKey = (await rowOf(requested.briefing.id)).context_json.find((entry: { source: { id: string } }) => entry.source.id === task).key;
    await settleBriefingRun(db.pool, await finishRun(run.id, output({ overview: { text: "Per the task", refs: ["S1", taskKey] } })));
    expect(await rowOf(requested.briefing.id)).toMatchObject({ status: "failed", error_code: "briefing_access_changed" });
    expect(await service().get(adapter(), MEMBER, requested.briefing.id)).toMatchObject({ overview: null, highlights: [] });
    // A new Project brief is a changed context too: a version frozen before it is not dispatched.
    const next = await service().request(adapter(), OWNER, manual);
    await db.pool.query(`UPDATE projects SET active_brief_version_id=NULL WHERE id=$1`, [PROJECT]);
    await expect(assertBriefingDispatch(config(), await runOf(next.briefing.id), db.pool)).rejects.toMatchObject({ code: "briefing_inputs_changed" });
  });
});

describe("Briefing reads after context changes", () => {
  it("hides published units resting on a Task that left the Project, and the next version no longer reads it", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const task = await w.task("SECRET_TASK_CONTEXT");
    const requested = await service().request(adapter(), OWNER, manual);
    const taskKey = (await rowOf(requested.briefing.id)).context_json.find((entry: { source: { id: string } }) => entry.source.id === task).key;
    const cited = { ...outputValue().highlights[0]!, title: "Task risk", impact: { assessment: "affects" as const, text: "SECRET_TASK_CONTEXT is at risk", context_refs: [taskKey] } };
    await settleBriefingRun(db.pool, await finishRun((await runOf(requested.briefing.id)).id, output({ highlights: [outputValue().highlights[0]!, cited] })));
    expect((await service().get(adapter(), MEMBER, requested.briefing.id)).highlights).toHaveLength(2);
    await db.pool.query(`UPDATE tasks SET visibility='private', project_id=NULL WHERE id=$1`, [task]);
    const read = await service().get(adapter(), MEMBER, requested.briefing.id);
    expect(read).toMatchObject({ visibility: "partial", hidden_units: 1, highlights: [{ title: "Gripper launch" }] });
    expect(JSON.stringify(read)).not.toContain("SECRET_TASK_CONTEXT");
    // The next version no longer reads it at all.
    await w.age(1);
    await material("Second report", { addedHoursAgo: 0 });
    const next = await service().request(adapter(), OWNER, manual);
    expect((await rowOf(next.briefing.id)).context_json.some((entry: { source: { id: string } }) => entry.source.id === task)).toBe(false);
    expect((await runOf(next.briefing.id)).prompt).not.toContain("SECRET_TASK_CONTEXT");
  });
});

describe("Briefing Runs on the production orchestrator", () => {
  it("fails a refused dispatch terminally through the Supervisor and settlement, releasing the scope for a safe new request", async (ctx) => {
    if (!db.available) return ctx.skip();
    await material("Report");
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    expect(run.contract_snapshot_json).toMatchObject({ policy_context_json: { managed_execution: "information_briefing", credential_pre_authorized: false, failure_policy: "fail_fast" } });
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`, [CONNECTION]);
    // The real orchestrator, as the agent-run job worker calls it: the guard refuses before any Host or model is involved.
    const response = await buildRunOrchestration(config()).orchestration.executeRun({ run_id: run.id, space_id: SPACE, worker_id: "briefing-guard-check", command_source: "job" });
    expect(response).toMatchObject({ status: "failed", error_code: "briefing_access_changed" });
    const terminal = (await w.runs().getRun(SPACE, run.id))!;
    expect(terminal.status).toBe("failed");
    expect(await count(`run_supervisor_decisions WHERE run_id='${run.id}' AND decision='human_review'`)).toBe(0);
    expect(await rowOf(requested.briefing.id)).toMatchObject({ status: "failed", error_code: "briefing_access_changed" });
    // The scope is free again: a new request is decided on today's state, never stuck behind the old one.
    await db.pool.query(`UPDATE source_connections SET status='active' WHERE id=$1`, [CONNECTION]);
    await material("Another report");
    const next = await service().request(adapter(), OWNER, manual);
    expect(next).toMatchObject({ created: true, briefing: { status: "queued" } });
    expect(next.briefing.id).not.toBe(requested.briefing.id);
  });

  it("never lets a briefing Run add retrieval or pinned context beyond its frozen request", async (ctx) => {
    if (!db.available) return ctx.skip();
    await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [SPACE, OWNER]);
    await new RuntimeContextPolicyRepository(db.pool).write({ spaceId: SPACE, userId: OWNER }, "space", SPACE, {
      base_version_id: null, policy: { constraints: {}, preferences: {} }, reason: "Isolated synthetic default policy",
    });
    await material("Report");
    const requested = await service().request(adapter(), OWNER, manual);
    const run = await runOf(requested.briefing.id);
    const setups = (await db.pool.query(`SELECT scope_kind, retrieval_preferences_json, pinned_refs_json FROM work_context_setups WHERE work_context_scope_id=$1`, [run.id])).rows;
    expect(setups).toEqual([{ scope_kind: "root_task", retrieval_preferences_json: { enabled: false }, pinned_refs_json: [] }]);

    // An ordinary root Run of the same requester (positive control) does plan automatic retrieval of their material.
    const plain = await plainRun(run);
    const plainIntent = await retrievalIntent(plain);
    expect(plainIntent).toMatchObject({ userId: OWNER, allowedRefs: [] });
    expect(plainIntent?.objectTypes).toEqual(expect.arrayContaining(["memory_entry", "source_item"]));
    // The briefing Run, through the same production setup, control snapshot and intent provider: none.
    expect(await retrievalIntent(run)).toBeNull();

    // A private Memory of the requester that matches the material: the plain Run's planned context
    // carries it; the briefing Run's planned context, from the same production planner, does not.
    const memory = randomUUID();
    await db.pool.query(
      `INSERT INTO memory_entries (id,space_id,scope_type,memory_type,status,visibility,access_level,sensitivity_level,confidence,importance,version,access_count,title,content,owner_user_id,created_at,updated_at)
       VALUES ($1,$2,'user','fact','active','private','full','normal',1,0.5,1,0,'Report summary','PRIVATE_MEMORY_HIT about the report summary',$3,now(),now())`,
      [memory, SPACE, OWNER],
    );
    await new RetrievalProjectionService(db.pool, memoryRetrievalRegistry).reindex(SPACE, "memory_entry", memory);
    const plannedText = async (target: RunRecord) => {
      const setup = (await db.pool.query(`SELECT version FROM work_context_setups WHERE work_context_scope_id=$1 ORDER BY version DESC LIMIT 1`, [target.id])).rows[0];
      const plan = await createProductionRuntimeContextPlanningService(db.pool, config()).planExecution({
        identity: { spaceId: SPACE, userId: OWNER }, invocationId: target.id, deliveryId: randomUUID(),
        turn: {
          work_context_scope_id: target.id, expected_setup_version: Number(setup.version),
          current_message_ref: { type: "run_request", id: target.id }, one_off_refs: [],
          retrieval_intent: "Report summary", invocation_purpose: "agent_task",
        },
      } as never);
      return JSON.stringify(plan.envelope.items);
    };
    expect(await plannedText(plain)).toContain("PRIVATE_MEMORY_HIT");
    expect(await plannedText(run)).not.toContain("PRIVATE_MEMORY_HIT");

    // Reopening its context (retrieval on, or a pin) after creation stops the Run before dispatch.
    const setup = (await db.pool.query(`SELECT version FROM work_context_setups WHERE work_context_scope_id=$1 ORDER BY version DESC LIMIT 1`, [run.id])).rows[0];
    await new WorkContextService(db.pool).create({ spaceId: SPACE, userId: OWNER }, {
      work_context_scope_id: run.id, scope_kind: "root_task", project_id: null, project_folder_id: null,
      agent_id: AGENT, runtime_ref: { type: "runtime_profile", id: PROFILE }, pinned_refs: [], excluded_refs: [],
      retrieval_preferences: { enabled: true }, continuity_preferences: {}, base_version: setup.version, reason: "Reopened",
    });
    await expect(assertBriefingDispatch(config(), run, db.pool)).rejects.toMatchObject({ statusCode: 403, code: "briefing_context_widened" });
  });
});

/** A plain root Run of the same requester, Agent and runtime: no briefing contract, default Work Context. */
async function plainRun(like: RunRecord): Promise<RunRecord> {
  const run = await w.runs().createQueuedRunWithBudgetAdmission({
    execution_kind: "agent", space_id: SPACE, user_id: OWNER, project_id: PROJECT, agent_id: AGENT,
    runtime_profile_id: PROFILE, runtime_profile_selection_source: "explicit", mode: "live", run_type: "agent",
    trigger_origin: "manual", visibility: "private", capabilities_json: [], scenario_tool_allowance: [],
    prompt: like.prompt ?? "", instruction: like.instruction ?? "", contract_snapshot: { source: { kind: "direct", id: like.id } },
  });
  await new WorkContextService(db.pool).ensureForInvocation({ spaceId: SPACE, userId: OWNER }, run.id, { agentId: AGENT, runtimeProfileId: PROFILE });
  return run;
}

/** The production retrieval intent of a Run's Work Context, under its real execution control snapshot. */
async function retrievalIntent(run: RunRecord) {
  const orchestration = buildRunOrchestration(config()).orchestration as unknown as {
    executionControlSnapshotWriter: (run: RunRecord, inputs: Record<string, unknown>) => Promise<{ id: string; work_context_setup_ref: { id: string } } & Record<string, unknown>>;
  };
  // Routed to the requester's runtime, as the orchestrator does before writing the control snapshot.
  await db.pool.query(
    `UPDATE runs SET runtime_profile_id=$2, runtime_profile_selection_source='explicit', runtime_key='claude_code',
       runtime_profile_snapshot_json='{"backend_mode":"runtime_native"}'::jsonb WHERE id=$1 AND runtime_profile_id IS NULL`,
    [run.id, PROFILE],
  );
  const routed = (await w.runs().getRun(SPACE, run.id))!;
  const control = await orchestration.executionControlSnapshotWriter(routed, { dispatchesToHostDaemon: true });
  const setup = (await db.pool.query(`SELECT * FROM work_context_setups WHERE id=$1`, [control.work_context_setup_ref.id])).rows[0];
  return new PgRetrievalIntentProvider(db.pool).resolve({
    identity: { spaceId: SPACE, userId: OWNER },
    turn: { work_context_scope_id: setup.work_context_scope_id, expected_setup_version: setup.version, retrieval_intent: run.prompt, current_message_ref: { type: "run_request", id: run.id } },
  } as never, { controlSnapshot: control, agentId: AGENT, executionControlSnapshotId: control.id, egressDestination: "internal_process" } as never);
}
