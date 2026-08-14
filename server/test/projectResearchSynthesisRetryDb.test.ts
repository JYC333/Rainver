import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { loadConfig } from "../src/config";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for retrying a failed synthesis stage through the
// immutable execution-per-pass authority. The retry command starts one
// WorkflowExecution; its domain action atomically updates the operation
// projection and queues the governed Run/Job.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const AGENT = "99999999-9999-4999-8999-999999999999";
const VERSION = "84444444-4444-4444-8444-444444444444";
const PROMPT_KEY = "project_research.synthesis";
const CONFIG = loadConfig({});

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;
let threadScope: Array<{ thread_id: string; version: number; kind: "question"; statement: string }> = [];

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

beforeAll(async () => {
  registerProjectResearchExecutionHandlers();
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[project-research-synthesis-retry-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE jobs, run_events, runs, artifacts, project_research_reports,
       prompt_deployment_refs, evolvable_asset_versions, evolvable_assets,
       agent_versions, agents, project_research_checkpoints, project_research_workflows,
       project_operations, project_members, projects, space_memberships, users, spaces CASCADE`,
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
  const thread = await new InquiryThreadService(pool).createThread(
    identity,
    PROJECT,
    { kind: "question", statement: "Does agent memory improve synthesis?" },
  );
  threadScope = [{
    thread_id: String(thread.id),
    version: Number(thread.version),
    kind: "question",
    statement: String(thread.statement),
  }];
  await insertResearchWorkflowFixture(pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "synthesis", primaryThreadId: String(thread.id), state: {
      research_question: "Does agent memory improve synthesis?",
      thread_scope: threadScope,
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
  await pool.query(`UPDATE agents SET current_version_id=$1 WHERE id=$2`, [VERSION, AGENT]);
});

async function seedSynthesisPrompt(): Promise<void> {
  const repo = new EvolvableAssetRepository(pool!);
  const asset = await repo.createAsset(identity, {
    asset_type: "prompt_template",
    asset_key: PROMPT_KEY,
    display_name: PROMPT_KEY,
    metadata_json: { prompt_type: "workflow" },
  });
  const version = await repo.createVersion(identity, asset.id as string, {
    scope_type: "space",
    content_json: {
      schema_version: "prompt_asset.v1",
      prompt_type: "workflow",
      template: "Project: {project_id}\nResearch question: {research_question}",
    },
  });
  const now = new Date().toISOString();
  await pool!.query(
    `UPDATE evolvable_asset_versions SET status='approved', updated_at=$3 WHERE asset_id=$1 AND id=$2`,
    [asset.id, version.id, now],
  );
  await pool!.query(
    `INSERT INTO prompt_deployment_refs (id, space_id, asset_id, scope_type, scope_id, label, version_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'space',$2,'production',$4,'active',$5,$5)`,
    [randomUUID(), SPACE, asset.id, version.id, now],
  );
}

async function seedFailedSynthesisOperation(previousRunId: string | null): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    projection_mode: "managed",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    research_question: "Does agent memory improve synthesis?",
    thread_scope: threadScope,
    agent_id: AGENT,
    source_backfill_plan_ids: [],
    source_backfill_plan_id: null,
    source_post_processing_rule_ids: [],
    source_post_processing_rule_id: null,
    current_stage: "failed",
    failed_stage: "synthesis",
    stage_state: "failed",
    partial: false,
    channel_ids: [],
    source_item_ids: [],
    checkpoint_ids: [],
    artifact_ids: [],
    synthesis_run_id: previousRunId,
    error: { code: "synthesis_output_invalid", message: "previous failure", at: now },
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await pool!.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','failed',$4,$5::jsonb,$6,$6)`,
    [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
  );
}

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

describe("ProjectResearchOrchestrator.retryFailedOperation synthesis stage (real Postgres)", () => {
  it("retries through one WorkflowExecution pass and atomically binds the queued Run and Job", async () => {
    if (!available || !pool) return;
    await seedSynthesisPrompt();
    await seedRelevantCorpus();
    await seedFailedSynthesisOperation("prior-failed-run-id");

    await new ProjectResearchOrchestrator(pool!, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION);

    const operation = await pool.query<{
      status: string;
      progress_json: { current_stage?: string; stage_state?: string; failed_stage?: string; synthesis_run_id?: string };
    }>(`SELECT status, progress_json FROM project_operations WHERE id=$1`, [OPERATION]);
    expect(operation.rows[0]!.status).toBe("active");
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    expect(operation.rows[0]!.progress_json.stage_state).toBe("running");
    expect(operation.rows[0]!.progress_json.failed_stage).toBeUndefined();

    const runId = operation.rows[0]!.progress_json.synthesis_run_id;
    expect(runId).toBeTruthy();
    expect(runId).not.toBe("prior-failed-run-id");
    const run = await pool.query<{ status: string; capability_id: string; contract_snapshot_json: { workflow_input_json?: { project_research?: { operation_id?: string; stage_key?: string; evidence_matrix_artifact_id?: string } } } }>(
      `SELECT status, capability_id, contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
      [runId, SPACE],
    );
    expect(run.rows[0]).toMatchObject({ status: "queued", capability_id: "research.brief_synthesize" });
    expect(run.rows[0]!.contract_snapshot_json.workflow_input_json?.project_research).toMatchObject({
      operation_id: OPERATION,
      stage_key: "synthesis",
      evidence_matrix_artifact_id: expect.any(String),
    });

    const job = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE space_id=$1 AND job_type='agent_run' AND payload_json->>'run_id'=$2`,
      [SPACE, runId],
    );
    expect(job.rows[0]?.status).toBe("pending");
    const execution = await pool.query<{ status: string; research_operation_id: string }>(
      `SELECT status,research_operation_id
         FROM workflow_executions
        WHERE space_id=$1 AND research_operation_id=$2`,
      [SPACE, OPERATION],
    );
    expect(execution.rows).toHaveLength(1);
    expect(execution.rows[0]).toMatchObject({
      status: "running",
      research_operation_id: OPERATION,
    });
  });

  it("treats concurrent synthesis retries as one idempotent command", async () => {
    if (!available || !pool) return;
    await seedSynthesisPrompt();
    await seedRelevantCorpus();
    await seedFailedSynthesisOperation("prior-failed-run-id");

    const orchestrator = new ProjectResearchOrchestrator(pool!, CONFIG);
    const [first, second] = await Promise.all([
      orchestrator.retryFailedOperation(identity, PROJECT, OPERATION),
      orchestrator.retryFailedOperation(identity, PROJECT, OPERATION),
    ]);

    expect((first as { id: string }).id).toBe(OPERATION);
    expect((second as { id: string }).id).toBe(OPERATION);
    const runs = await pool.query(
      `SELECT id FROM runs
        WHERE space_id=$1
          AND capability_id='research.brief_synthesize'
          AND contract_snapshot_json->'workflow_input_json'->'project_research'->>'operation_id'=$2`,
      [SPACE, OPERATION],
    );
    const jobs = await pool.query(
      `SELECT id FROM jobs WHERE space_id=$1 AND job_type='agent_run'`,
      [SPACE],
    );
    expect(runs.rows).toHaveLength(1);
    expect(jobs.rows).toHaveLength(1);
  });

  it("completes a retried synthesis without a report when its approved corpus is empty", async () => {
    if (!available || !pool) return;
    await seedSynthesisPrompt();
    await seedFailedSynthesisOperation("prior-failed-run-id");

    await new ProjectResearchOrchestrator(pool!, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION);

    const operation = await pool.query<{
      status: string;
      progress_json: { current_stage?: string; empty_result?: { kind?: string; reason_code?: string } };
    }>(`SELECT status, progress_json FROM project_operations WHERE id=$1`, [OPERATION]);
    expect(operation.rows[0]).toMatchObject({
      status: "completed",
      progress_json: {
        current_stage: "complete",
        empty_result: { kind: "no_relevant_sources", reason_code: "empty_approved_corpus" },
      },
    });
    const runs = await pool.query(
      `SELECT id FROM runs WHERE space_id=$1 AND capability_id='research.brief_synthesize'`,
      [SPACE],
    );
    const jobs = await pool.query(`SELECT id FROM jobs WHERE space_id=$1`, [SPACE]);
    expect(runs.rows).toHaveLength(0);
    expect(jobs.rows).toHaveLength(0);
  });

  it("keeps the operation failed and retryable when the pass cannot resolve its synthesis prompt", async () => {
    if (!available || !pool) return;
    // No synthesis prompt is seeded, so queueSynthesis fails inside the
    // transaction after the transition and run would otherwise have applied.
    await seedFailedSynthesisOperation(null);

    await expect(
      new ProjectResearchOrchestrator(pool!, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION),
    ).resolves.toMatchObject({ id: OPERATION });

    const operation = await pool.query<{ status: string; progress_json: { current_stage?: string; synthesis_run_id?: string | null } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(operation.rows[0]!.progress_json.current_stage).toBe("failed");
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBeNull();
    const runs = await pool.query(
      `SELECT id FROM runs WHERE space_id=$1 AND capability_id='research.brief_synthesize'`,
      [SPACE],
    );
    const jobs = await pool.query(`SELECT id FROM jobs WHERE space_id=$1`, [SPACE]);
    expect(runs.rows).toHaveLength(0);
    expect(jobs.rows).toHaveLength(0);
    const execution = await pool.query<{ status: string }>(
      `SELECT status FROM workflow_executions
        WHERE space_id=$1 AND research_operation_id=$2`,
      [SPACE, OPERATION],
    );
    expect(execution.rows).toHaveLength(1);
    expect(execution.rows[0]?.status).toBe("failed");
  });
});
