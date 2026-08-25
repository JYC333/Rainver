import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedPendingScreeningGate } from "./support/researchSeeds";
import { useTestDatabase } from "./support/testDatabase";
import { seedSpaceOwnerProject, seedAgentWithVersion } from "./support/domainSeeds";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for a second, compounding bug on top of the
// reconcileOperation stage-clobber fix: `queueSynthesis`'s idempotency guard
// (`if (state.synthesis_run_id) return;`) silently no-ops whenever a
// synthesis run was already queued once, even if current_stage was since
// reset back to "screening" (by the now-fixed clobber bug, or any other
// path) and the operation genuinely still needs to advance. Any operation
// that got clobbered even once before the reconcile fix landed is stuck
// forever: re-approving the checkpoint calls decideCheckpoint successfully,
// but resumeAfterCheckpoint -> queueSynthesis returns immediately without
// touching current_stage, so nothing visibly happens and the checkpoint
// keeps coming back on the next reconcile tick.

const CONFIG = loadConfig({});
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const EXISTING_RUN_ID = "existing-synthesis-run-id";
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
    ["project_research_checkpoints", "project_research_workflows", "project_operations", "project_members", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "screening", now,
  });
});

async function seedStuckOperation(): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    agent_id: AGENT,
    source_backfill_plan_ids: [],
    source_backfill_plan_id: null,
    current_stage: "screening",
    stage_state: "waiting_review",
    partial: false,
    channel_ids: [],
    source_item_ids: [],
    checkpoint_ids: [],
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    // A prior approval already queued a synthesis run once, but current_stage
    // was reset back to "screening" afterward (the clobber bug this operation
    // simulates having already suffered before the reconcile fix landed).
    synthesis_run_id: EXISTING_RUN_ID,
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await db.pool.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','waiting_review',$4,$5::jsonb,$6,$6)`,
    [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
  );
}

async function seedPendingScreeningCheckpoint(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await seedPendingScreeningGate(db.pool, { id: id, space: SPACE, project: PROJECT, workflow: WORKFLOW, machineResult: { operation_id: OPERATION, total: 0 }, now });
  return id;
}

describe("ProjectResearchOrchestrator.decideCheckpoint resuming a stuck synthesis (real Postgres)", () => {
  it("advances current_stage to synthesis when re-approving after synthesis_run_id was already set by an earlier (clobbered) pass", async () => {
    if (!db.available) return;
    await seedStuckOperation();
    const checkpointId = await seedPendingScreeningCheckpoint();

    const result = await new ProjectResearchOrchestrator(db.pool, CONFIG).decideCheckpoint(identity, PROJECT, WORKFLOW, checkpointId, { decision: "approved" });
    expect(result.user_decision).toBe("approved");

    const operation = await db.pool.query<{ status: string; progress_json: { current_stage?: string; synthesis_run_id?: string } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    // Must reuse the existing run, not silently do nothing and not queue a duplicate.
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBe(EXISTING_RUN_ID);
    expect(operation.rows[0]!.status).toBe("active");

    const workflow = await db.pool.query<{ current_stage: string }>(
      `SELECT current_stage FROM project_research_workflows WHERE object_id=$1`,
      [WORKFLOW],
    );
    expect(workflow.rows[0]!.current_stage).toBe("synthesis");
  });
});
