import { randomUUID } from "node:crypto";
import { upsertPendingResearchCheckpoint } from "../src/modules/projectResearch/checkpointWriter";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedArxivSourceChain, seedResearchOperation } from "./support/researchSeeds";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for reconcileOperation refreshing screening_progress
// ("Papers classified" / "Batches" on the research operation card) on every
// tick, even while classification batches are still in flight. Before this
// fix, isSourcePipelineDrained gated the whole recompute, so the numbers
// stayed empty/stale until every batch finished and then jumped straight to
// their final value instead of updating incrementally.

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "88888888-8888-4888-8888-888888888888";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const INCREMENTAL_OPERATION = "77777777-7777-4777-8777-777777777778";
const PLAN = "aaaaaaaa-1111-4111-8111-111111111111";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };


const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["source_post_processing_item_decisions", "source_post_processing_runs", "jobs", "source_items", "source_backfill_plans", "project_research_checkpoints", "project_research_workflows", "project_operations", "agents", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedArxivSourceChain(db.pool, { connector: CONNECTOR, connection: CONNECTION, channel: CHANNEL, space: SPACE, owner: OWNER, now });
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "backfill", now,
  });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, name: "Screening Agent", now });
  await seedOperation();
  await db.pool.query(
    `INSERT INTO source_backfill_plans (
       id, space_id, source_channel_id, project_operation_id, requested_by_user_id, origin,
       strategy_json, quota_policy_json, status, segments_total, segments_completed, segments_failed,
       items_ingested, idempotency_key, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'user',$6::jsonb,$7::jsonb,'completed',1,1,0,3,$8,$9,$9)`,
    [
      PLAN, SPACE, CHANNEL, OPERATION, OWNER,
      JSON.stringify({ window_unit: "date_window", history_mode: "bounded_range", from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z", window_size: 30, max_items: 10, direction: "backward" }),
      JSON.stringify({ window: "minute", limit_count: 10 }),
      `idem-${PLAN}`, now,
    ],
  );
});

async function seedSourceItem(id: string, title: string): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO source_items (
       id, space_id, owner_user_id, visibility, connection_id, item_type, title, first_seen_at, last_seen_at,
       content_state, retention_policy, metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,'space_shared',$4,'external_url',$5,$6,$6,'excerpt_saved','summary_only',$7::jsonb,$6,$6)`,
    [id, SPACE, OWNER, CONNECTION, title, now, JSON.stringify({ source_backfill_plan_id: PLAN })],
  );
}

async function seedClassifiedDecision(sourceItemId: string, relevance: string): Promise<void> {
  const now = new Date().toISOString();
  const runId = randomUUID();
  await db.pool.query(
    `INSERT INTO source_post_processing_runs (id, space_id, source_channel_id, agent_id, project_id, trigger_type, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'manual','succeeded',$6)`,
    [runId, SPACE, CHANNEL, AGENT, PROJECT, now],
  );
  await db.pool.query(
    `INSERT INTO source_post_processing_item_decisions (
       id, space_id, source_channel_id, run_id, project_id, source_item_id, relevance, review_status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$8)`,
    [randomUUID(), SPACE, CHANNEL, runId, PROJECT, sourceItemId, relevance, now],
  );
}

async function seedRecoveryJob(status: string, resultJson: Record<string, unknown> | null): Promise<void> {
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO jobs (id, space_id, job_type, status, priority, payload_json, result_json, attempts, max_attempts, created_at, updated_at)
     VALUES ($1,$2,'source_post_processing_event',$3,0,$4::jsonb,$5::jsonb,0,3,$6,$6)`,
    [
      randomUUID(), SPACE, status,
      JSON.stringify({ phase: "research_recovery", recovery_for_operation_id: OPERATION, source_channel_id: CHANNEL, rule_id: "rule-1", source_item_ids: [] }),
      resultJson ? JSON.stringify(resultJson) : null,
      now,
    ],
  );
}

async function seedOperation(): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    source_backfill_plan_ids: [PLAN],
    source_backfill_plan_id: PLAN,
    current_stage: "backfill",
    stage_state: "running",
    partial: false,
    channel_ids: [CHANNEL],
    source_item_ids: [],
    checkpoint_ids: [],
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await seedResearchOperation(db.pool, { id: OPERATION, space: SPACE, project: PROJECT, owner: OWNER, progress: progress, now });
}

describe("ProjectResearchOrchestrator.reconcileOperation screening progress (real Postgres)", () => {
  it("refreshes classified/batch counts on a tick while a recovery batch is still running, instead of waiting for the whole pipeline to drain", async () => {
    if (!db.available) return;
    await seedSourceItem("item-1", "Paper one");
    await seedSourceItem("item-2", "Paper two");
    await seedSourceItem("item-3", "Paper three");
    await seedClassifiedDecision("item-1", "relevant");
    await seedClassifiedDecision("item-2", "maybe");
    // item-3 is not classified yet — one batch already completed, one is still running.
    await seedRecoveryJob("completed", { status: "succeeded" });
    await seedRecoveryJob("running", null);

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await db.pool.query<{ status: string; progress_json: { screening_progress?: Record<string, unknown> } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    const progress = operation.rows[0]!.progress_json.screening_progress;
    expect(progress).toBeDefined();
    expect(progress).toMatchObject({
      total_items: 3,
      classified_items: 2,
      unclassified_items: 1,
      total_batches: 2,
      completed_batches: 1,
      active_batches: 1,
      queued_batches: 0,
      running_batches: 1,
    });
    // The pipeline isn't drained yet (one batch still running), so the stage
    // transition — and the screening_gate checkpoint it creates — must not
    // have fired yet, even though the display numbers above are already fresh.
    expect(operation.rows[0]!.status).toBe("active");
    const execution = await db.pool.query<{ status: string; current: boolean }>(
      `SELECT execution.status,
              operation.current_execution_id=execution.id AS current
         FROM workflow_executions execution
         JOIN project_operations operation
           ON operation.id=execution.research_operation_id
          AND operation.space_id=execution.space_id
        WHERE execution.space_id=$1 AND execution.research_operation_id=$2`,
      [SPACE, OPERATION],
    );
    expect(execution.rows).toEqual([{ status: "completed", current: true }]);
    const checkpoints = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_research_checkpoints WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(checkpoints.rows).toHaveLength(0);
  });
});

// countRelevantItems (which gates whether the screening_gate checkpoint gets
// created/refreshed) reads project_corpus_items/project_corpus_item_sources,
// not source_post_processing_item_decisions directly — a corpus row is what
// an AI classification actually produces once it's synced to the project.
async function seedCorpusRelevance(sourceItemId: string, relevance: "relevant" | "maybe" | "not_relevant"): Promise<void> {
  const now = new Date().toISOString();
  const corpusItemId = randomUUID();
  await db.pool.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, source_item_id, role, status, triage_status, relevance,
       metadata_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','new',$5,'{}'::jsonb,$6,$6)`,
    [corpusItemId, SPACE, PROJECT, sourceItemId, relevance, now],
  );
  await db.pool.query(
    `INSERT INTO project_corpus_item_sources (id, corpus_item_id, space_id, project_id, source_item_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
}

async function seedIncrementalOperation(sourceItemIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "incremental",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    current_stage: "screening",
    stage_state: "running",
    partial: false,
    channel_ids: [CHANNEL],
    source_item_ids: sourceItemIds,
    checkpoint_ids: [],
    awaiting_source_scan: false,
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await seedResearchOperation(db.pool, { id: INCREMENTAL_OPERATION, space: SPACE, project: PROJECT, owner: OWNER, progress: progress, now, title: "Incremental scan" });
}

describe("ProjectResearchRepository checkpointReview classified count (real Postgres)", () => {
  it("reflects material classified after the screening_gate checkpoint was first created, not just at creation time", async () => {
    if (!db.available) return;
    await seedSourceItem("item-1", "Paper one");
    await seedSourceItem("item-2", "Paper two");
    await seedSourceItem("item-3", "Paper three");
    await seedClassifiedDecision("item-1", "relevant");
    await seedCorpusRelevance("item-1", "relevant");
    // beforeEach seeds a baseline OPERATION on the same workflow; only one
    // active research operation per workflow is allowed, and this test needs
    // its own incremental operation instead.
    await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`, [OPERATION]);
    // item-2 and item-3 are not classified yet when the gate is first opened —
    // this mirrors an incremental scan, which opens the screening_gate as soon
    // as the operation enters "screening", then refreshes it on every
    // subsequent reconcile tick while classification is still in flight.
    await seedIncrementalOperation(["item-1", "item-2", "item-3"]);

    const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG);
    const repo = new ProjectResearchRepository(db.pool);

    await orchestrator.reconcileOperation(SPACE, INCREMENTAL_OPERATION);
    const firstPass = await repo.listCheckpoints(identity, PROJECT, WORKFLOW);
    expect(firstPass).toHaveLength(1);
    expect((firstPass[0] as { review: { summary: Record<string, unknown> } }).review.summary).toMatchObject({
      total: 3, classified: 1, unclassified: 2, processing_status: "incomplete",
    });

    // The remaining papers finish classification after the checkpoint already
    // exists. A later reconcile tick refreshes the same (still-pending)
    // checkpoint row in place rather than creating a new one.
    await seedClassifiedDecision("item-2", "maybe");
    await seedClassifiedDecision("item-3", "not_relevant");
    await seedCorpusRelevance("item-2", "maybe");
    await seedCorpusRelevance("item-3", "not_relevant");
    await orchestrator.reconcileOperation(SPACE, INCREMENTAL_OPERATION);

    const checkpointRows = await db.pool.query<{ id: string }>(
      `SELECT id FROM project_research_checkpoints WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(checkpointRows.rows).toHaveLength(1);
    expect(checkpointRows.rows[0]!.id).toBe((firstPass[0] as { id: string }).id);

    const secondPass = await repo.listCheckpoints(identity, PROJECT, WORKFLOW);
    expect((secondPass[0] as { review: { summary: Record<string, unknown> } }).review.summary).toMatchObject({
      total: 3, classified: 3, unclassified: 0, processing_status: "complete",
    });
  });
});

// The reviewer approves the screening gate; the approval itself enqueues a
// reconcile, and that tick used to find no *pending* gate for the operation and
// mint a second one — the operation moved on to synthesis while the reviewer
// was handed the same intake to approve again.
describe("research checkpoints are one decision point per operation (real Postgres)", () => {
  it("does not open a second gate for an operation whose gate was already decided", async () => {
    if (!db.available) return;
    const operationId = randomUUID();
    const input = {
      spaceId: SPACE,
      projectId: PROJECT,
      workflowId: WORKFLOW,
      operationId,
      checkpointType: "screening_gate",
      machineResult: { operation_id: operationId, total: 16 },
    };

    const first = await upsertPendingResearchCheckpoint(db.pool, input);
    // A tick before the decision keeps refreshing the pending gate in place.
    expect(await upsertPendingResearchCheckpoint(db.pool, { ...input, machineResult: { operation_id: operationId, total: 20 } })).toBe(first);

    await db.pool.query(
      `UPDATE project_research_checkpoints
          SET status='approved', user_decision='approved', decided_at=now(), updated_at=now()
        WHERE id=$1 AND space_id=$2`,
      [first, SPACE],
    );

    expect(await upsertPendingResearchCheckpoint(db.pool, input)).toBe(first);
    const rows = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_research_checkpoints
        WHERE space_id=$1 AND checkpoint_type='screening_gate'
          AND machine_result_json->>'operation_id'=$2`,
      [SPACE, operationId],
    );
    expect(rows.rows[0]!.count).toBe("1");

    const decided = await db.pool.query<{ status: string; total: string }>(
      `SELECT status, machine_result_json->>'total' AS total
         FROM project_research_checkpoints WHERE id=$1 AND space_id=$2`,
      [first, SPACE],
    );
    // The decision stands and the snapshot the reviewer judged is untouched.
    expect(decided.rows[0]!.status).toBe("approved");
    expect(decided.rows[0]!.total).toBe("20");
  });
});
