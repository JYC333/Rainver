import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { loadConfig } from "../src/config";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { PgRunRepository } from "../src/modules/runs/repository";
import { WorkflowExecutionService } from "../src/modules/automations/workflowExecutionService";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for the synthesis_only vertical slice migrated to
// execution-per-pass WorkflowExecution authority (plan section 17.3): the
// Dedicated synthesis-only WorkflowExecution coverage. All Project Research
// run kinds now use execution-per-pass authority; this file exercises the
// specialized two-node report-snapshot pass.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const CATALOG_ROOT = join(process.cwd(), "..", "catalog");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const AGENT = "99999999-9999-4999-8999-999999999999";
const VERSION = "84444444-4444-4444-8444-444444444444";
const RUNTIME_PROFILE = "83333333-3333-4333-8333-333333333333";
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    await syncBuiltinPrompts(pool, CATALOG_ROOT);
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[project-research-synthesis-only-execution-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE runs, agent_versions, agents, project_research_workflows, project_operations,
       project_members, projects, space_memberships, users, spaces, automations CASCADE`,
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, current_focus, created_at, updated_at) VALUES ($1,$2,$3,'Research','active','Does X improve Y?',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  const thread = await new InquiryThreadService(pool).createThread(
    identity,
    PROJECT,
    { kind: "question", statement: "Does X improve Y?" },
  );
  await insertResearchWorkflowFixture(pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "synthesis", primaryThreadId: String(thread.id), state: {
      research_question: "Does X improve Y?", research_question_version: 1, report_depth: "quick",
      thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE, question_refine_skipped: true,
    }, now,
  });
  await pool.query(
    `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
     VALUES ($1,$2,$3,'Research Agent','active',NULL,$4,$4,'space_shared')`,
    [AGENT, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_versions (
       id, agent_id, space_id, version_label, system_prompt,
       model_config_json, runtime_config_json, context_policy_json,
       memory_policy_json, capabilities_json, tool_permissions_json,
       runtime_policy_json, created_at
     ) VALUES ($1, $2, $3, 'v1', 'Test agent.',
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
               '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $4)`,
    [VERSION, AGENT, SPACE, now],
  );
  await pool.query(`UPDATE agents SET current_version_id=$2 WHERE id=$1`, [AGENT, VERSION]);
  await pool.query(
    `INSERT INTO agent_runtime_profiles (
       id,space_id,agent_id,name,adapter_type,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
     ) VALUES ($1,$2,$3,'Research','model_api','{}'::jsonb,'{}'::jsonb,true,true,$4,$4)`,
    [RUNTIME_PROFILE, SPACE, AGENT, now],
  );
  // TRUNCATE ... spaces CASCADE above also empties evolvable_assets (it has
  // a nullable FK to spaces), which wipes the system-scoped builtin prompt
  // catalog synced in beforeAll — re-sync every test, not just once.
  await syncBuiltinPrompts(pool, CATALOG_ROOT);
});

async function seedRelevantCorpus(): Promise<void> {
  const now = new Date().toISOString();
  const sourceItemId = randomUUID();
  const corpusItemId = randomUUID();
  await pool!.query(
    `INSERT INTO source_items (
       id,space_id,owner_user_id,visibility,item_type,title,excerpt,
       first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at
     ) VALUES ($1,$2,$3,'space_shared','external_url','Relevant paper','Relevant evidence.',
       $4,$4,'excerpt_saved','summary_only',$4,$4)`,
    [sourceItemId, SPACE, OWNER, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_items (
       id,space_id,project_id,source_item_id,role,status,triage_status,
       triage_confirmed_by_user,relevance,confidence,reason,created_at,updated_at
     ) VALUES ($1,$2,$3,$4,'candidate','active','relevant',false,'relevant',0.9,'In scope',$5,$5)`,
    [corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
  await pool!.query(
    `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItemId, now],
  );
}

const validReport = {
  schema_version: "research_report.v1",
  research_question: "Does X improve Y?",
  summary: "A bounded synthesis.",
  findings: [{ claim: "X may improve Y.", support: "multi-source evidence", references: [{ arxiv_id: "2601.12345" }] }],
  limitations: ["Coverage ends in 2026."],
  sources: [{ title: "Paper", authors: ["Author"], year: 2026, relevance: "relevant" as const, summary: "Evidence.", references: [{ arxiv_id: "2601.12345" }] }],
  ideas: [],
};

describe("synthesis_only under execution-per-pass WorkflowExecution authority (real Postgres)", () => {
  it("runs synthesize -> materialize_report through a real WorkflowExecution", async () => {
    if (!available || !pool || !container) return;
    await seedRelevantCorpus();
    const config = loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri(), SERVER_INTERNAL_TOKEN: "test-internal-token" });
    const orchestrator = new ProjectResearchOrchestrator(pool, config);

    const created = await orchestrator.generateReportSnapshot(identity, PROJECT) as { id: string };
    const operationId = created.id;

    const afterStart = await pool.query<{
      status: string; current_execution_id: string | null; generation: number;
      current_stage: string;
    }>(
      `SELECT status, current_execution_id, generation, progress_json->>'current_stage' AS current_stage
         FROM project_operations WHERE id=$1 AND space_id=$2`,
      [operationId, SPACE],
    );
    expect(afterStart.rows[0]).toMatchObject({ status: "active", generation: 1, current_stage: "synthesis" });
    const executionId = afterStart.rows[0]!.current_execution_id;
    expect(executionId).toBeTruthy();

    const execution = await pool.query<{ status: string; research_operation_id: string }>(
      `SELECT status, research_operation_id FROM workflow_executions WHERE id=$1 AND space_id=$2`,
      [executionId, SPACE],
    );
    expect(execution.rows[0]).toEqual({ status: "running", research_operation_id: operationId });

    const nodes = await pool.query<{ node_key: string; node_kind: string; status: string }>(
      `SELECT node_key, node_kind, status FROM workflow_execution_nodes WHERE execution_id=$1 ORDER BY node_key`,
      [executionId],
    );
    expect(nodes.rows).toEqual([
      { node_key: "materialize_report", node_kind: "action", status: "inbox" },
      { node_key: "synthesize", node_kind: "leaf", status: "in_progress" },
    ]);

    // A second call while the first pass is still active is refused —
    // "at most one active pass per operation," enforced at the application
    // layer (activeResearchOperation) ahead of the DB-level partial unique
    // index on workflow_executions.research_operation_id.
    await expect(orchestrator.generateReportSnapshot(identity, PROJECT)).rejects.toMatchObject({ statusCode: 409 });

    const synthesizeRun = (await pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
        WHERE node.execution_id=$1 AND node.node_key='synthesize'`,
      [executionId],
    )).rows[0]!.run_id;

    const archiveArtifactId = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO artifacts (
         id,space_id,run_id,project_id,artifact_type,surface_role,title,content,mime_type,
         exportable,export_formats_json,canonical_format,preview,created_at,updated_at,visibility,owner_user_id,trust_level
       ) VALUES ($1,$2,$3,$4,'research_report.archive.v1','system_archive','Draft',$5,'application/json',
         true,'["json"]'::jsonb,'json',false,$6,$6,'space_shared',$7,'high')`,
      [archiveArtifactId, SPACE, synthesizeRun, PROJECT, JSON.stringify(validReport), now, OWNER],
    );
    const runs = new PgRunRepository(pool);
    await runs.markRunRunning({ run_id: synthesizeRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({
      run_id: synthesizeRun, space_id: SPACE, status: "succeeded",
      output_json: { status: "succeeded", artifacts: [{ title: "Draft", artifact_type: "research_report.archive.v1", mime_type: "application/json", content: validReport }] },
      completed_at: now,
    });
    await runs.insertRunEvaluation({ space_id: SPACE, run_id: synthesizeRun, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: now });

    await new WorkflowExecutionService(config).reconcileForRun(pool, SPACE, synthesizeRun, OWNER);

    const finalNodes = await pool.query<{ node_key: string; status: string }>(
      `SELECT node_key, status FROM workflow_execution_nodes WHERE execution_id=$1 ORDER BY node_key`,
      [executionId],
    );
    expect(finalNodes.rows).toEqual([
      { node_key: "materialize_report", status: "done" },
      { node_key: "synthesize", status: "done" },
    ]);

    const finalOperation = await pool.query<{ status: string; current_stage: string }>(
      `SELECT status, progress_json->>'current_stage' AS current_stage FROM project_operations WHERE id=$1`,
      [operationId],
    );
    expect(finalOperation.rows[0]).toEqual({ status: "waiting_review", current_stage: "idea_review" });

    const report = await pool.query<{ synthesis_run_id: string; run_kind: string; status: string }>(
      `SELECT synthesis_run_id, run_kind, status FROM project_research_reports WHERE operation_id=$1`,
      [operationId],
    );
    expect(report.rows).toEqual([{ synthesis_run_id: synthesizeRun, run_kind: "synthesis_only", status: "awaiting_review" }]);
    const checkpoint = await pool.query<{ checkpoint_type: string; status: string; operation_id: string }>(
      `SELECT checkpoint_type, status, machine_result_json->>'operation_id' AS operation_id
         FROM project_research_checkpoints
        WHERE space_id=$1 AND machine_result_json->>'operation_id'=$2`,
      [SPACE, operationId],
    );
    expect(checkpoint.rows).toContainEqual({
      checkpoint_type: "idea_review",
      status: "pending",
      operation_id: operationId,
    });

    // materialize_report's own completion is synchronous (the Action node
    // infra's fire-and-complete path), but it lands mid-way through the same
    // reconcile() call that dispatched it — after that call's own
    // isComplete() check already ran. The next periodic-reconciler tick
    // picks up the now-all-done node graph and finishes the execution.
    await new WorkflowExecutionService(config).reconcile(pool, SPACE, executionId!, OWNER);
    const finalExecution = await pool.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id=$1`, [executionId]);
    expect(finalExecution.rows[0]).toEqual({ status: "completed" });

    // The pass is terminal, but the long-lived operation remains blocked on
    // domain review. A second snapshot cannot bypass that checkpoint.
    await expect(orchestrator.generateReportSnapshot(identity, PROJECT))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("fails the operation when the synthesis run produces an invalid report, without retrying (max_attempts defaults to 1)", async () => {
    if (!available || !pool || !container) return;
    await seedRelevantCorpus();
    const config = loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri(), SERVER_INTERNAL_TOKEN: "test-internal-token" });
    const orchestrator = new ProjectResearchOrchestrator(pool, config);
    const created = await orchestrator.generateReportSnapshot(identity, PROJECT) as { id: string };
    const operationId = created.id;
    const executionId = (await pool.query<{ current_execution_id: string }>(
      `SELECT current_execution_id FROM project_operations WHERE id=$1`, [operationId],
    )).rows[0]!.current_execution_id;
    const synthesizeRun = (await pool.query<{ run_id: string }>(
      `SELECT link.run_id FROM workflow_execution_node_runs link
         JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
        WHERE node.execution_id=$1 AND node.node_key='synthesize'`,
      [executionId],
    )).rows[0]!.run_id;
    const now = new Date().toISOString();
    const runs = new PgRunRepository(pool);
    await runs.markRunRunning({ run_id: synthesizeRun, space_id: SPACE, started_at: now });
    await runs.markRunTerminal({ run_id: synthesizeRun, space_id: SPACE, status: "failed", error_json: { error_code: "provider_error" }, completed_at: now });
    await new WorkflowExecutionService(config).reconcileForRun(pool, SPACE, synthesizeRun, OWNER);

    const node = await pool.query<{ status: string }>(
      `SELECT status FROM workflow_execution_nodes WHERE execution_id=$1 AND node_key='synthesize'`,
      [executionId],
    );
    expect(node.rows[0]).toEqual({ status: "failed" });
    const execution = await pool.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id=$1`, [executionId]);
    expect(execution.rows[0]).toEqual({ status: "failed" });
    // The Project Research module owns the outcome projection through the
    // registered WorkflowExecution outcome handler. A failed pass must free
    // the Project from a permanently-active operation.
    const operation = await pool.query<{ status: string; current_stage: string }>(
      `SELECT status, progress_json->>'current_stage' AS current_stage
         FROM project_operations WHERE id=$1`,
      [operationId],
    );
    expect(operation.rows[0]).toEqual({ status: "failed", current_stage: "failed" });
  });
});
