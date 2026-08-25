import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedArxivSourceChain, seedResearchOperation } from "./support/researchSeeds";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for a regression where reconcileOperation's
// backfill->screening transition block has no stage guard: once backfill
// plans are 'completed' and the pipeline is drained, it unconditionally
// re-runs on every periodic tick — including AFTER the user has already
// approved the screening_gate checkpoint and the workflow has advanced to
// synthesis. That clobbers current_stage back to "screening" and creates a
// brand-new pending screening_gate checkpoint (the approved one no longer
// matches createCheckpoint's "status='pending'" upsert lookup), which is
// exactly what an "Approve screening did nothing, the checkpoint came back
// after refresh" report looks like from the outside.

const CONFIG = loadConfig({});
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


const db = useTestDatabase(__filename);

beforeAll(async () => {
  if (!db.available) return;
  registerProjectResearchExecutionHandlers();
});

beforeEach(async () => {
  if (!db.available) return;
  await resetTables(
    db.pool,
    ["runs", "agent_versions", "agents", "project_research_checkpoints", "project_research_workflows", "source_backfill_segments", "source_backfill_plans", "project_operations", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedArxivSourceChain(db.pool, { connector: CONNECTOR, connection: CONNECTION, channel: CHANNEL, space: SPACE, owner: OWNER, now });
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "synthesis", now,
  });
  await seedOperationInSynthesis();
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
  const versionId = randomUUID();
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: versionId, space: SPACE, owner: OWNER, systemPrompt: "Test agent.", now });
  // The synthesis run the operation points at is still executing — reconcile
  // must report on it, not clobber the operation back to screening.
  await db.pool.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       adapter_type, instructed_by_user_id, owner_user_id, project_id,
       contract_snapshot_json, created_at, updated_at, started_at
     ) VALUES ($1,$2,$3,$4,'agent','system','running','live','model_api',$5,$5,$6,'{}'::jsonb,$7,$7,$7)`,
    ["run-already-queued", SPACE, AGENT, versionId, OWNER, PROJECT, now],
  );
});

async function seedOperationInSynthesis(): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    source_backfill_plan_ids: [PLAN],
    source_backfill_plan_id: PLAN,
    current_stage: "synthesis",
    stage_state: "running",
    partial: false,
    channel_ids: [CHANNEL],
    source_item_ids: [],
    checkpoint_ids: [],
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    synthesis_run_id: "run-already-queued",
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await seedResearchOperation(db.pool, { id: OPERATION, space: SPACE, project: PROJECT, owner: OWNER, progress: progress, now });
}

async function seedApprovedScreeningCheckpoint(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.pool.query(
    `INSERT INTO project_research_checkpoints (
       id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
       user_decision, decided_by_user_id, decided_at, machine_result_json, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'screening','screening_gate','approved','approved',$5,$6,$7::jsonb,$6,$6)`,
    [id, SPACE, PROJECT, WORKFLOW, OWNER, now, JSON.stringify({ operation_id: OPERATION, total: 3 })],
  );
  return id;
}

describe("ProjectResearchOrchestrator.reconcileOperation stage guard after synthesis has started (real Postgres)", () => {
  it("does not reset an operation back to 'screening' or recreate the screening_gate checkpoint once synthesis has already been queued", async () => {
    if (!db.available) return;
    const checkpointId = await seedApprovedScreeningCheckpoint();

    await new ProjectResearchOrchestrator(db.pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await db.pool.query<{ progress_json: { current_stage?: string; synthesis_run_id?: string } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBe("run-already-queued");

    const checkpoints = await db.pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM project_research_checkpoints WHERE space_id=$1 AND project_id=$2 AND checkpoint_type='screening_gate'`,
      [SPACE, PROJECT],
    );
    expect(checkpoints.rows).toHaveLength(1);
    expect(checkpoints.rows[0]).toMatchObject({ id: checkpointId, status: "approved" });
  });
});
