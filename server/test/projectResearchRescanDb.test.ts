import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQuestionThreadScope, seedArxivSourceChain, seedPendingScreeningGate } from "./support/researchSeeds.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { loadConfig } from "../src/config.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow.js";

// Real-Postgres coverage for rescanning a literature intake operation that
// finished a legitimately (or wrongly) empty backfill. The operation is
// normally sitting on its `waiting_review` screening_gate checkpoint at this
// point, not `completed` — rescan must work from that state, and must waive
// the now-stale pending checkpoint so the review UI doesn't keep surfacing a
// decision that's moot once the backfill re-runs.

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "88888888-8888-4888-8888-888888888888";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const PLAN = "aaaaaaaa-1111-4111-8111-111111111111";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";

let threadScope: { thread_id: string; version: number; kind: string; statement: string };

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
const CONFIG = loadConfig({});

const db = useTestDatabase(import.meta.filename);

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["project_research_checkpoints", "project_research_workflows", "extraction_jobs", "source_backfill_segments", "source_backfill_plans", "project_operation_steps", "project_operations", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
    threadScope = await createQuestionThreadScope(db.pool, identity, PROJECT, "Does X improve Y?");
  await seedArxivSourceChain(db.pool, { connector: CONNECTOR, connection: CONNECTION, channel: CHANNEL, space: SPACE, owner: OWNER, now });
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "screening", primaryThreadId: threadScope.thread_id, state: {
      research_question: "Does X improve Y?",
      research_question_version: threadScope.version,
      thread_scope: [threadScope],
      agent_id: AGENT,
      initial_intake: { max_items: 10 },
    }, now,
  });
});

async function seedPlan(status: string, itemsIngested: number): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
       items_ingested, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'user',$6::jsonb,$7::jsonb,$8,1,1,0,$9,$10,$11,$11)`,
    [
      PLAN, SPACE, CHANNEL, OPERATION, OWNER,
      JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, direction: "backward" }),
      JSON.stringify({ window: "minute", limit_count: 10 }),
      status, itemsIngested, `idem-${PLAN}`, now,
    ],
  );
  await db.pool.query(
    `INSERT INTO source_backfill_segments (id, plan_id, space_id, seq, window_json, status, attempt_count, items_ingested)
     VALUES ($1,$2,$3,0,$4::jsonb,'succeeded',1,$5)`,
    [randomUUID(), PLAN, SPACE, JSON.stringify({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: 10 }), itemsIngested],
  );
}

async function seedOperation(status: "active" | "waiting_review", currentStage: string, planIds: string[], partial = false, maxItems = 10): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    research_question: "Does X improve Y?",
    research_question_version: threadScope.version,
    thread_scope: [threadScope],
    source_backfill_plan_ids: planIds,
    source_backfill_plan_id: planIds[0] ?? null,
    current_stage: currentStage,
    stage_state: status === "waiting_review" ? "waiting_review" : "running",
    history: { mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", max_items: maxItems },
    partial,
    channel_ids: [CHANNEL],
    source_item_ids: [],
    checkpoint_ids: [],
  };
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake',$4,$5,$6::jsonb,$7,$7)`,
    [OPERATION, SPACE, PROJECT, status, OWNER, JSON.stringify(progress), now],
  );
}

async function seedPendingScreeningCheckpoint(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await seedPendingScreeningGate(db.pool, { id: id, space: SPACE, project: PROJECT, workflow: WORKFLOW, machineResult: { operation_id: OPERATION, total: 0 }, now });
  return id;
}

describe("ProjectResearchOrchestrator.rescanEmptyBackfill (real Postgres)", () => {
  it("updates the saved item limit without requiring a research question or source monitor", async () => {
    if (!db.available) return;

    await new ProjectResearchOrchestrator(db.pool, CONFIG).updateInitialItemLimit(identity, PROJECT, {
      workflow_id: WORKFLOW,
      max_items: 25,
    });

    const workflow = await db.pool.query<{ state_json: { research_question?: string; source_channel_ids?: string[]; initial_intake?: { max_items?: number } } }>(
      `SELECT state_json FROM project_research_workflows WHERE object_id=$1`,
      [WORKFLOW],
    );
    expect(workflow.rows[0]!.state_json.research_question).toBe("Does X improve Y?");
    expect(workflow.rows[0]!.state_json.source_channel_ids).toBeUndefined();
    expect(workflow.rows[0]!.state_json.initial_intake?.max_items).toBe(25);
  });

  it("updates a monitor-setup operation limit before backfill plans exist", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,$5::jsonb,$6,$6)`,
      [
        OPERATION,
        SPACE,
        PROJECT,
        OWNER,
        JSON.stringify({
          schema_version: "project_research_operation.v1",
          run_kind: "baseline",
          workflow_id: WORKFLOW,
          current_stage: "monitor_setup",
          stage_state: "running",
          history: { mode: "bounded_range", from: null, to: null, max_items: 10 },
          source_backfill_plan_ids: [],
          source_backfill_plan_id: null,
          channel_ids: [],
          source_item_ids: [],
          partial: false,
        }),
        now,
      ],
    );

    await new ProjectResearchOrchestrator(db.pool, CONFIG).updateItemLimit(identity, PROJECT, OPERATION, { max_items: 25 });

    const operation = await db.pool.query<{ progress_json: { history?: { max_items?: number } } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.history?.max_items).toBe(25);
  });

  it("raises and resumes a partial backfill only through an explicit item-limit update", async () => {
    if (!db.available) return;
    await seedOperation("active", "backfill", [PLAN], true, 10);
    await seedPlan("completed", 10);
    await db.pool.query(
      `UPDATE source_backfill_segments
          SET window_json=jsonb_set(window_json,'{partial}','true'::jsonb,true)
        WHERE plan_id=$1`,
      [PLAN],
    );

    await new ProjectResearchOrchestrator(db.pool, CONFIG).updateItemLimit(identity, PROJECT, OPERATION, { max_items: 25 });

    const plan = await db.pool.query<{ status: string; strategy_json: { max_items?: number } }>(
      `SELECT status, strategy_json FROM source_backfill_plans WHERE id=$1`,
      [PLAN],
    );
    expect(plan.rows[0]!.strategy_json.max_items).toBeUndefined();
    expect(["approved", "running"]).toContain(plan.rows[0]!.status);

    const operation = await db.pool.query<{ progress_json: { history?: { max_items?: number }; partial?: boolean } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.history?.max_items).toBe(25);
    expect(operation.rows[0]!.progress_json.partial).toBe(false);

    const workflow = await db.pool.query<{ state_json: { initial_intake?: { max_items?: number } } }>(
      `SELECT state_json FROM project_research_workflows WHERE object_id=$1`,
      [WORKFLOW],
    );
    expect(workflow.rows[0]!.state_json.initial_intake?.max_items).toBe(10);
  });

  it("rescans from waiting_review (the state a zero-result screening_gate checkpoint leaves the operation in) and waives the stale checkpoint", async () => {
    if (!db.available) return;
    await seedOperation("waiting_review", "screening", [PLAN]);
    await seedPlan("completed", 0);
    const checkpointId = await seedPendingScreeningCheckpoint();

    await new ProjectResearchOrchestrator(db.pool, CONFIG).rescanEmptyBackfill(identity, PROJECT, OPERATION, {});

    const operation = await db.pool.query<{ status: string; progress_json: { current_stage?: string } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("active");
    expect(operation.rows[0]!.progress_json.current_stage).toBe("backfill");

    const plan = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_plans WHERE id=$1`, [PLAN]);
    expect(["approved", "running"]).toContain(plan.rows[0]!.status);

    const segment = await db.pool.query<{ status: string }>(`SELECT status FROM source_backfill_segments WHERE plan_id=$1`, [PLAN]);
    expect(["pending", "running"]).toContain(segment.rows[0]!.status);

    const checkpoint = await db.pool.query<{ status: string }>(`SELECT status FROM project_research_checkpoints WHERE id=$1`, [checkpointId]);
    expect(checkpoint.rows[0]!.status).toBe("waived");
  });

  it("blocks approving an empty screening gate without creating a synthesis run", async () => {
    if (!db.available) return;
    await seedOperation("waiting_review", "screening", [PLAN]);
    await seedPlan("completed", 0);
    const checkpointId = await seedPendingScreeningCheckpoint();

    for (const decision of ["approved", "waived"] as const) {
      await expect(new ProjectResearchOrchestrator(db.pool, CONFIG).decideCheckpoint(
        identity,
        PROJECT,
        WORKFLOW,
        checkpointId,
        { decision },
      )).rejects.toMatchObject({ statusCode: 409 });
    }

    const checkpoint = await db.pool.query<{ status: string; user_decision: string | null }>(
      `SELECT status, user_decision FROM project_research_checkpoints WHERE id=$1`,
      [checkpointId],
    );
    expect(checkpoint.rows[0]).toEqual({ status: "pending", user_decision: null });

    const runs = await db.pool.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM runs WHERE project_id=$1`,
      [PROJECT],
    );
    expect(Number(runs.rows[0]!.count)).toBe(0);
  });

  it("raises the item limit for a plan still actively importing through Project Settings", async () => {
    if (!db.available) return;
    await seedOperation("active", "backfill", [PLAN]);
    await seedPlan("approved", 3);

    await new ProjectResearchOrchestrator(db.pool, CONFIG).updateItemLimit(identity, PROJECT, OPERATION, { max_items: 30 });

    const plan = await db.pool.query<{ status: string; strategy_json: { max_items?: number } }>(
      `SELECT status, strategy_json FROM source_backfill_plans WHERE id=$1`,
      [PLAN],
    );
    expect(plan.rows[0]!.status).toBe("approved");
    expect(plan.rows[0]!.strategy_json.max_items).toBeUndefined();

    const operation = await db.pool.query<{ progress_json: { history?: { max_items?: number } } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.history?.max_items).toBe(30);
  });

  it("rejects rescanning before source monitors have even been resolved", async () => {
    if (!db.available) return;
    await seedOperation("active", "monitor_setup", []);

    await expect(new ProjectResearchOrchestrator(db.pool, CONFIG).rescanEmptyBackfill(identity, PROJECT, OPERATION, {})).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("recovers a monitor-setup operation when its backfill plan was committed before the hook was lost", async () => {
    if (!db.available) return;
    await seedOperation("active", "monitor_setup", []);
    await seedPlan("approved", 0);

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await db.pool.query<{ progress_json: { current_stage?: string; source_backfill_plan_ids?: string[] } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json).toMatchObject({
      current_stage: "backfill",
      source_backfill_plan_ids: [PLAN],
    });
  });

  it("stops an empty initial intake before screening when the source search returns no items", async () => {
    if (!db.available) return;
    await seedOperation("active", "backfill", [PLAN]);
    await seedPlan("completed", 0);

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await db.pool.query<{ status: string; progress_json: { current_stage?: string; stage_state?: string } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("completed");
    expect(operation.rows[0]!.progress_json).toMatchObject({
      current_stage: "complete",
      stage_state: "skipped",
      empty_result: { kind: "no_source_items", source_item_count: 0 },
    });
    const checkpoint = await db.pool.query<{ checkpoint_type: string; status: string }>(
      `SELECT checkpoint_type, status FROM project_research_checkpoints WHERE space_id=$1 AND project_id=$2 AND workflow_id=$3`,
      [SPACE, PROJECT, WORKFLOW],
    );
    expect(checkpoint.rows).toHaveLength(0);
    const workflow = await db.pool.query<{ status: string; current_stage: string }>(
      `SELECT status, current_stage FROM project_research_workflows WHERE object_id=$1`,
      [WORKFLOW],
    );
    expect(workflow.rows[0]).toEqual({ status: "paused", current_stage: "initial_intake_setup" });
  });

  it("saves a channel-less draft carrying the refinement assessment", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE project_research_workflows SET status='not_started', current_stage='initial_intake_setup' WHERE object_id=$1`, [WORKFLOW]);
    const workflow = await new ProjectResearchOrchestrator(db.pool, CONFIG).saveInitialIntakeDraft(identity, PROJECT, {
      thread_id: threadScope.thread_id,
      research_question: "How should agents remember?",
      source_channel_ids: [],
      history_mode: "all_available",
      max_items: 10,
      monitoring_field: "submittedDate",
      report_depth: "quick",
      question_refine_skipped: false,
      question_refinement: {
        assessment: { answerable: true },
        suggested_questions: ["q"],
        sub_questions: ["Which benchmarks measure recovery?"],
        scope: { in: ["Tool-using coding agents"], out: ["Human-only studies"] },
      },
      execution: {},
    }) as { state_json: Record<string, unknown> };
    expect(workflow.state_json).toMatchObject({
      source_channel_ids: [],
      question_refine_skipped: false,
      question_refinement: { assessment: { answerable: true }, suggested_questions: ["q"] },
      research_scope: {
        sub_questions: ["Which benchmarks measure recovery?"],
        in: ["Tool-using coding agents"],
        out: ["Human-only studies"],
      },
    });
  });

  it("does not create a second draft when the same Inquiry already has an active initial intake", async () => {
    if (!db.available) return;
    await expect(new ProjectResearchOrchestrator(db.pool, CONFIG).saveInitialIntakeDraft(identity, PROJECT, {
      thread_id: threadScope.thread_id,
      research_question: "Does X improve Y?",
      source_channel_ids: [],
      history_mode: "bounded_range",
      from: "2026-01-01",
      to: "2026-02-01",
      max_items: 10,
      monitoring_field: "submittedDate",
      report_depth: "quick",
      question_refine_skipped: false,
      execution: {},
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "An active research workflow cannot be edited after initial material intake has started",
    });

    const workflows = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(workflows.rows[0]?.count).toBe(1);
  });

  it("reuses the same Thread draft when autosave omits workflow_id", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE project_research_workflows
          SET status='not_started', current_stage='initial_intake_setup'
        WHERE object_id=$1`,
      [WORKFLOW],
    );

    const saved = await new ProjectResearchOrchestrator(db.pool, CONFIG).saveInitialIntakeDraft(identity, PROJECT, {
      thread_id: threadScope.thread_id,
      research_question: "Does X improve Y?",
      source_channel_ids: [],
      history_mode: "bounded_range",
      from: "2026-01-01",
      to: "2026-02-01",
      max_items: 20,
      monitoring_field: "submittedDate",
      report_depth: "quick",
      question_refine_skipped: false,
      execution: {},
    });

    expect(saved).toMatchObject({ id: WORKFLOW, status: "not_started" });
    const workflows = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(workflows.rows[0]?.count).toBe(1);
  });

  it("enforces one non-archived research workflow per Inquiry Thread in the database", async () => {
    if (!db.available) return;
    const now = new Date().toISOString();
    await expect(insertResearchWorkflowFixture(db.pool, {
      id: randomUUID(), spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      status: "not_started", primaryThreadId: threadScope.thread_id, now,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not create a new draft after the same Inquiry intake completed", async () => {
    if (!db.available) return;
    await db.pool.query(
      `UPDATE project_research_workflows SET status='completed', current_stage='completed' WHERE object_id=$1`,
      [WORKFLOW],
    );

    await expect(new ProjectResearchOrchestrator(db.pool, CONFIG).saveInitialIntakeDraft(identity, PROJECT, {
      thread_id: threadScope.thread_id,
      research_question: "Does X improve Y?",
      source_channel_ids: [],
      history_mode: "bounded_range",
      from: "2026-01-01",
      to: "2026-02-01",
      max_items: 10,
      monitoring_field: "submittedDate",
      report_depth: "quick",
      question_refine_skipped: false,
      execution: {},
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "This research workflow can no longer be edited",
    });

    const workflows = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM project_research_workflows WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(workflows.rows[0]?.count).toBe(1);
  });

  it("refuses to start intake for a question that has not passed refinement", async () => {
    if (!db.available) return;
    await expect(new ProjectResearchOrchestrator(db.pool, CONFIG).startInitialIntake(identity, PROJECT, {
      research_question: "Unrefined question",
      query_strategy_id: "22222222-2222-4222-8222-222222222222",
      history_mode: "bounded_range",
      from: "2026-02-01",
      to: "2026-03-01",
      max_items: 10,
      monitoring_field: "submittedDate",
      report_depth: "full",
      question_refine_skipped: true,
      execution: { model_provider_id: "provider-1" },
    })).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("refinement") });
  });

  it("allows an empty initial intake to reopen setup with the previous values available", async () => {
    if (!db.available) return;
    await seedOperation("active", "backfill", [PLAN]);
    await seedPlan("completed", 0);
    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const workflow = await new ProjectResearchOrchestrator(db.pool, CONFIG).saveInitialIntakeDraft(identity, PROJECT, {
      workflow_id: WORKFLOW,
      thread_id: threadScope.thread_id,
      research_question: "Adjusted research question",
      source_channel_ids: [CHANNEL],
      history_mode: "bounded_range",
      from: "2026-02-01",
      to: "2026-03-01",
      max_items: 25,
      monitoring_field: "lastUpdatedDate",
      report_depth: "full",
      question_refine_skipped: false,
      execution: { model_provider_id: "provider-1", model_name: "model-1" },
    });

    expect(workflow).toMatchObject({ status: "not_started", current_stage: "initial_intake_setup" });
    expect(workflow.state_json).toMatchObject({
      research_question: "Adjusted research question",
      source_channel_ids: [CHANNEL],
      initial_intake: { from: "2026-02-01T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z", max_items: 25, monitoring_field: "lastUpdatedDate" },
      draft: { status: "saved" },
    });
    const project = await db.pool.query<{ current_focus: string | null }>(`SELECT current_focus FROM projects WHERE id=$1`, [PROJECT]);
    expect(project.rows[0]?.current_focus).toBeNull();
  });

  it("completes idea review from a durable decision when the decision hook was lost", async () => {
    if (!db.available) return;
    await seedOperation("waiting_review", "idea_review", []);
    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO project_research_checkpoints (
         id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
         user_decision, decided_by_user_id, decided_at, machine_result_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'idea_review','idea_review','approved','approved',$5,$6,$7::jsonb,$6,$6)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OWNER, now, JSON.stringify({ operation_id: OPERATION })],
    );

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await db.pool.query<{ status: string; progress_json: { current_stage?: string; monitoring_active?: boolean } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("completed");
    expect(operation.rows[0]!.progress_json).toMatchObject({ current_stage: "complete", monitoring_active: true });
  });
});
