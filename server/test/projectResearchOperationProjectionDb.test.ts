import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { seedResearchOperation } from "./support/researchSeeds";
import { useTestDatabase } from "./support/testDatabase";
import { resetTables } from "./support/resetTables";
import { advanceOperation, type ResearchOperationState } from "../src/modules/projectResearch/operationProjection";
import { ProjectOperationService } from "../src/modules/projects/projectOperationService";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";


const db = useTestDatabase(__filename);

function operationProjection(): ResearchOperationState {
  return {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    research_question: "Question",
    research_question_version: 1,
    thread_scope: [{ thread_id: "thread-1", version: 1, kind: "question", statement: "Question" }],
    report_depth: "full",
    question_refine_skipped: false,
    research_scope: { in: [], out: [], sub_questions: [], must_have: [], nice_to_have: [] },
    channel_ids: [],
    project_source_binding_ids: [],
    source_post_processing_rule_ids: [],
    project_source_binding_id: null,
    source_post_processing_rule_id: null,
    source_backfill_plan_id: null,
    source_backfill_plan_ids: [],
    query: { source_channel_ids: [], fingerprint: "", sort_by: "submittedDate", history_mode: null, from: null, to: null },
    history: { mode: null, from: null, to: null, max_items: null },
    watermark: { before: null, after: null, overlap_hours: 48 },
    source_item_ids: [],
    current_stage: "monitor_setup",
    stage_state: "running",
    agent_id: "agent-1",
    runtime_profile_id: "profile-1",
    checkpoint_ids: [],
    synthesis_run_id: null,
    artifact_ids: [],
    partial: false,
    monitoring_active: false,
    idempotency: { key: "key", fingerprint: "fingerprint" },
  };
}

async function seed(): Promise<void> {
  await resetTables(
    db.pool,
    ["project_operations", "project_research_workflows", "projects", "space_memberships", "users", "spaces"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,'Owner','active',$2,$2)`, [OWNER, now]);
  await db.pool.query(`INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at) VALUES ($1,$2,$3,'Research','active',$4,$4)`, [PROJECT, SPACE, OWNER, now]);
  await insertResearchWorkflowFixture(db.pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "initial_intake_setup", now,
  });
  await seedResearchOperation(db.pool, { id: OPERATION, space: SPACE, project: PROJECT, owner: OWNER, progress: operationProjection(), now, title: "Research" });
}

describe("project research operation projection store (real Postgres)", () => {
  beforeEach(async () => {
    if (db.available) await seed();
  });

  it("serializes concurrent pass outcomes and lets the loser observe the new stage", async () => {
    if (!db.available) return;
    const transitionSpec = {
      from: ["monitor_setup"] as const,
      to: "backfill" as const,
      mutate: ({ state }: { state: ResearchOperationState }) => {
        state.stage_state = "running";
      },
      onStale: "throw" as const,
    };
    const results = await Promise.allSettled([
      advanceOperation(db.pool, SPACE, OPERATION, transitionSpec),
      advanceOperation(db.pool, SPACE, OPERATION, transitionSpec),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const row = await db.pool.query<{ current_stage: string; status: string; version: number }>(
      `SELECT progress_json->>'current_stage' AS current_stage, status, version FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(row.rows[0]).toEqual({ current_stage: "backfill", status: "active", version: 2 });
  });

  it("enforces one active research operation per workflow in the database", async () => {
    if (!db.available) return;
    await expect(db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Duplicate','waiting_review',$4,$5::jsonb,now(),now())`,
      [randomUUID(), SPACE, PROJECT, OWNER, JSON.stringify(operationProjection())],
    )).rejects.toMatchObject({ code: "23505", constraint: "uq_project_operations_active_research_workflow" });
  });

  it("rejects a stale managed-operation version", async () => {
    if (!db.available) return;
    await expect(new ProjectOperationService(db.pool).setManagedState(SPACE, PROJECT, OPERATION, {
      status: "active",
      progress: operationProjection() as unknown as Record<string, unknown>,
      replaceProgress: true,
      expectedVersion: 0,
    })).rejects.toMatchObject({ statusCode: 409 });
    const row = await db.pool.query<{ version: number }>(`SELECT version FROM project_operations WHERE id=$1`, [OPERATION]);
    expect(row.rows[0]!.version).toBe(1);
  });

  it("creates and activates managed operations atomically under contention", async () => {
    if (!db.available) return;
    await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`, [OPERATION]);
    const service = new ProjectOperationService(db.pool);
    const input = {
      title: "Incremental research",
      intentText: "Test atomic activation",
      status: "active" as const,
      progress: operationProjection() as unknown as Record<string, unknown>,
      steps: [{ title: "Collect", status: "active" as const }],
    };
    const results = await Promise.allSettled([
      service.createManagedResearch({ spaceId: SPACE, userId: OWNER }, PROJECT, input),
      service.createManagedResearch({ spaceId: SPACE, userId: OWNER }, PROJECT, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await db.pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM project_operations
        WHERE space_id=$1 AND project_id=$2 AND kind='research' AND status IN ('draft','active','waiting_review')
        GROUP BY status ORDER BY status`,
      [SPACE, PROJECT],
    );
    expect(rows.rows).toEqual([{ status: "active", count: 1 }]);
  });
});
