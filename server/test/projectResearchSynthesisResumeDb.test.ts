import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

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

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const EXISTING_RUN_ID = "existing-synthesis-run-id";
const AGENT = "99999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "99999999-9999-4999-8999-999999999998";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    console.warn(`[project-research-synthesis-resume-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE project_research_checkpoints, project_research_workflows, project_operations,
       project_members, projects, space_memberships, users, spaces CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Research Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt, model_config_json,
       runtime_config_json, context_policy_json, memory_policy_json,
       capabilities_json, tool_permissions_json, runtime_policy_json, created_at
     ) VALUES ($1,$2,$3,'v1','Test research agent.','{}','{}','{}','{}','[]','{}','{}',$4)`,
    [AGENT_VERSION, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, AGENT_VERSION]);
  await pool.query(
    `INSERT INTO project_research_workflows (id, space_id, project_id, workflow_type, current_stage, status, mode, state_json, created_at, updated_at)
     VALUES ($1,$2,$3,'literature_review','screening','active','agent_assisted','{}'::jsonb,$4,$4)`,
    [WORKFLOW, SPACE, PROJECT, now],
  );
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
  await pool!.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','waiting_review',$4,$5::jsonb,$6,$6)`,
    [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
  );
}

async function seedPendingScreeningCheckpoint(): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO project_research_checkpoints (id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status, machine_result_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'screening','screening_gate','pending',$5::jsonb,$6,$6)`,
    [id, SPACE, PROJECT, WORKFLOW, JSON.stringify({ operation_id: OPERATION, total: 0 }), now],
  );
  return id;
}

describe("ProjectResearchOrchestrator.decideCheckpoint resuming a stuck synthesis (real Postgres)", () => {
  it("advances current_stage to synthesis when re-approving after synthesis_run_id was already set by an earlier (clobbered) pass", async () => {
    if (!available || !pool) return;
    await seedStuckOperation();
    const checkpointId = await seedPendingScreeningCheckpoint();

    const result = await new ProjectResearchOrchestrator(pool!).decideCheckpoint(identity, PROJECT, WORKFLOW, checkpointId, { decision: "approved" });
    expect(result.user_decision).toBe("approved");

    const operation = await pool!.query<{ status: string; progress_json: { current_stage?: string; synthesis_run_id?: string } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    // Must reuse the existing run, not silently do nothing and not queue a duplicate.
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBe(EXISTING_RUN_ID);
    expect(operation.rows[0]!.status).toBe("active");

    const workflow = await pool!.query<{ current_stage: string }>(
      `SELECT current_stage FROM project_research_workflows WHERE id=$1`,
      [WORKFLOW],
    );
    expect(workflow.rows[0]!.current_stage).toBe("synthesis");
  });
});
