import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { WorkflowExecutionService } from "../src/modules/automations/workflowExecutionService.js";
import { EvolvableAssetRepository } from "../src/modules/evolution/assetRepository.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { PgRunRepository } from "../src/modules/runs/repository.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { createQuestionThreadScope, seedArxivSourceChain, seedPendingScreeningGate, seedRelevantCorpusItem, seedResearchOperation } from "./support/researchSeeds.js";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

describe("projectResearchSynthesisOnlyExecutionDb", () => {
  // Real-Postgres coverage for the synthesis_only vertical slice migrated to
  // execution-per-pass WorkflowExecution authority (plan section 17.3): the
  // Dedicated synthesis-only WorkflowExecution coverage. All Project Research
  // run kinds now use execution-per-pass authority; this file exercises the
  // specialized two-node report-snapshot pass.

  const CATALOG_ROOT = join(process.cwd(), "..", "catalog");
  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "55555555-5555-4555-8555-555555555555";
  const WORKFLOW = "66666666-6666-4666-8666-666666666666";
  const AGENT = "99999999-9999-4999-8999-999999999999";
  const VERSION = "84444444-4444-4444-8444-444444444444";
  const RUNTIME_PROFILE = "83333333-3333-4333-8333-333333333333";
  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };


  const db = useTestDatabase(`${import.meta.filename}#projectResearchSynthesisOnlyExecutionDb`);

  beforeAll(async () => {
    if (!db.available) return;
    registerProjectResearchExecutionHandlers();
    await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
  });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["runs", "agent_versions", "agents", "project_research_workflows", "project_operations", "project_members", "projects", "space_memberships", "users", "spaces", "automations"],
      { cascade: true },
    );
    const now = new Date().toISOString();
    await db.pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
    await db.pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
    await db.pool.query(
      `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO projects (id, space_id, owner_user_id, name, status, current_focus, created_at, updated_at) VALUES ($1,$2,$3,'Research','active','Does X improve Y?',$4,$4)`,
      [PROJECT, SPACE, OWNER, now],
    );
    const thread = await new InquiryThreadService(db.pool).createThread(
      identity,
      PROJECT,
      { kind: "question", statement: "Does X improve Y?" },
    );
    await insertResearchWorkflowFixture(db.pool, {
      id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      currentStage: "synthesis", primaryThreadId: String(thread.id), state: {
        research_question: "Does X improve Y?", research_question_version: 1, report_depth: "quick",
        thread_scope: [{ thread_id: thread.id, version: thread.version, kind: "question", statement: thread.statement }],
        agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE, question_refine_skipped: true,
      }, now,
    });
    await seedAgentWithVersion(db.pool, { agent: AGENT, version: VERSION, space: SPACE, owner: OWNER, systemPrompt: "Test agent.", now });
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (
         id,space_id,agent_id,name,adapter_type,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at
       ) VALUES ($1,$2,$3,'Research','model_api','{}'::jsonb,'{}'::jsonb,true,true,$4,$4)`,
      [RUNTIME_PROFILE, SPACE, AGENT, now],
    );
    // TRUNCATE ... spaces CASCADE above also empties evolvable_assets (it has
    // a nullable FK to spaces), which wipes the system-scoped builtin prompt
    // catalog synced in beforeAll — re-sync every test, not just once.
    await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
  });

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
      if (!db.available) return;
      await seedRelevantCorpusItem(db.pool, { space: SPACE, project: PROJECT, owner: OWNER });
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test-internal-token" });
      const orchestrator = new ProjectResearchOrchestrator(db.pool, config);

      const created = await orchestrator.generateReportSnapshot(identity, PROJECT) as { id: string };
      const operationId = created.id;

      const afterStart = await db.pool.query<{
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

      const execution = await db.pool.query<{ status: string; research_operation_id: string }>(
        `SELECT status, research_operation_id FROM workflow_executions WHERE id=$1 AND space_id=$2`,
        [executionId, SPACE],
      );
      expect(execution.rows[0]).toEqual({ status: "running", research_operation_id: operationId });

      const nodes = await db.pool.query<{ node_key: string; node_kind: string; status: string }>(
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

      const synthesizeRun = (await db.pool.query<{ run_id: string }>(
        `SELECT link.run_id FROM workflow_execution_node_runs link
           JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
          WHERE node.execution_id=$1 AND node.node_key='synthesize'`,
        [executionId],
      )).rows[0]!.run_id;

      const archiveArtifactId = randomUUID();
      const now = new Date().toISOString();
      await db.pool.query(
        `INSERT INTO artifacts (
           id,space_id,run_id,project_id,artifact_type,surface_role,title,content,mime_type,
           exportable,export_formats_json,canonical_format,preview,created_at,updated_at,visibility,owner_user_id,trust_level
         ) VALUES ($1,$2,$3,$4,'research_report.archive.v1','system_archive','Draft',$5,'application/json',
           true,'["json"]'::jsonb,'json',false,$6,$6,'space_shared',$7,'high')`,
        [archiveArtifactId, SPACE, synthesizeRun, PROJECT, JSON.stringify(validReport), now, OWNER],
      );
      const runs = new PgRunRepository(db.pool);
      await runs.markRunRunning({ run_id: synthesizeRun, space_id: SPACE, started_at: now });
      await runs.markRunTerminal({
        run_id: synthesizeRun, space_id: SPACE, status: "succeeded",
        output_json: { status: "succeeded", artifacts: [{ title: "Draft", artifact_type: "research_report.archive.v1", mime_type: "application/json", content: validReport }] },
        completed_at: now,
      });
      await runs.insertRunEvaluation({ space_id: SPACE, run_id: synthesizeRun, outcome_status: "passed", trajectory_status: "acceptable", evaluated_at: now });

      await new WorkflowExecutionService(config).reconcileForRun(db.pool, SPACE, synthesizeRun, OWNER);

      const finalNodes = await db.pool.query<{ node_key: string; status: string }>(
        `SELECT node_key, status FROM workflow_execution_nodes WHERE execution_id=$1 ORDER BY node_key`,
        [executionId],
      );
      expect(finalNodes.rows).toEqual([
        { node_key: "materialize_report", status: "done" },
        { node_key: "synthesize", status: "done" },
      ]);

      const finalOperation = await db.pool.query<{ status: string; current_stage: string }>(
        `SELECT status, progress_json->>'current_stage' AS current_stage FROM project_operations WHERE id=$1`,
        [operationId],
      );
      // Checkpoint reform: reaching idea_review no longer means
      // waiting on anybody, so the operation stays active rather than
      // advertising a review that will never be asked for.
      expect(finalOperation.rows[0]).toEqual({ status: "active", current_stage: "idea_review" });

      const report = await db.pool.query<{ synthesis_run_id: string; run_kind: string; status: string }>(
        `SELECT synthesis_run_id, run_kind, status FROM project_research_reports WHERE operation_id=$1`,
        [operationId],
      );
      expect(report.rows).toEqual([{ synthesis_run_id: synthesizeRun, run_kind: "synthesis_only", status: "awaiting_review" }]);
      const checkpoint = await db.pool.query<{ checkpoint_type: string; status: string; operation_id: string }>(
        `SELECT checkpoint_type, status, machine_result_json->>'operation_id' AS operation_id
           FROM project_research_checkpoints
          WHERE space_id=$1 AND machine_result_json->>'operation_id'=$2`,
        [SPACE, operationId],
      );
      // Checkpoint reform: idea_review is recorded but does not
      // hold the operation, so it is waived at creation and
      // `reconcileIdeaReviewStage` carries the operation on from there.
      expect(checkpoint.rows).toContainEqual({
        checkpoint_type: "idea_review",
        status: "waived",
        operation_id: operationId,
      });

      // materialize_report's own completion is synchronous (the Action node
      // infra's fire-and-complete path), but it lands mid-way through the same
      // reconcile() call that dispatched it — after that call's own
      // isComplete() check already ran. The next periodic-reconciler tick
      // picks up the now-all-done node graph and finishes the execution.
      await new WorkflowExecutionService(config).reconcile(db.pool, SPACE, executionId!, OWNER);
      const finalExecution = await db.pool.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id=$1`, [executionId]);
      expect(finalExecution.rows[0]).toEqual({ status: "completed" });

      // The pass is terminal, but the long-lived operation remains blocked on
      // domain review. A second snapshot cannot bypass that checkpoint.
      await expect(orchestrator.generateReportSnapshot(identity, PROJECT))
        .rejects.toMatchObject({ statusCode: 409 });
    });

    it("fails the operation when the synthesis run produces an invalid report, without retrying (max_attempts defaults to 1)", async () => {
      if (!db.available) return;
      await seedRelevantCorpusItem(db.pool, { space: SPACE, project: PROJECT, owner: OWNER });
      const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, SERVER_INTERNAL_TOKEN: "test-internal-token" });
      const orchestrator = new ProjectResearchOrchestrator(db.pool, config);
      const created = await orchestrator.generateReportSnapshot(identity, PROJECT) as { id: string };
      const operationId = created.id;
      const executionId = (await db.pool.query<{ current_execution_id: string }>(
        `SELECT current_execution_id FROM project_operations WHERE id=$1`, [operationId],
      )).rows[0]!.current_execution_id;
      const synthesizeRun = (await db.pool.query<{ run_id: string }>(
        `SELECT link.run_id FROM workflow_execution_node_runs link
           JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
          WHERE node.execution_id=$1 AND node.node_key='synthesize'`,
        [executionId],
      )).rows[0]!.run_id;
      const now = new Date().toISOString();
      const runs = new PgRunRepository(db.pool);
      await runs.markRunRunning({ run_id: synthesizeRun, space_id: SPACE, started_at: now });
      await runs.markRunTerminal({ run_id: synthesizeRun, space_id: SPACE, status: "failed", error_json: { error_code: "provider_error" }, completed_at: now });
      await new WorkflowExecutionService(config).reconcileForRun(db.pool, SPACE, synthesizeRun, OWNER);

      const node = await db.pool.query<{ status: string }>(
        `SELECT status FROM workflow_execution_nodes WHERE execution_id=$1 AND node_key='synthesize'`,
        [executionId],
      );
      expect(node.rows[0]).toEqual({ status: "failed" });
      const execution = await db.pool.query<{ status: string }>(`SELECT status FROM workflow_executions WHERE id=$1`, [executionId]);
      expect(execution.rows[0]).toEqual({ status: "failed" });
      // The Project Research module owns the outcome projection through the
      // registered WorkflowExecution outcome handler. A failed pass must free
      // the Project from a permanently-active operation.
      const operation = await db.pool.query<{ status: string; current_stage: string }>(
        `SELECT status, progress_json->>'current_stage' AS current_stage
           FROM project_operations WHERE id=$1`,
        [operationId],
      );
      expect(operation.rows[0]).toEqual({ status: "failed", current_stage: "failed" });
    });
  });
});

describe("projectResearchSynthesisResumeDb", () => {
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

  const db = useTestDatabase(`${import.meta.filename}#projectResearchSynthesisResumeDb`);

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
});

describe("projectResearchSynthesisRetryDb", () => {
  // Real-Postgres coverage for retrying a failed synthesis stage through the
  // immutable execution-per-pass authority. The retry command starts one
  // WorkflowExecution; its domain action atomically updates the operation
  // projection and queues the governed Run/Job.

  const SPACE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "55555555-5555-4555-8555-555555555555";
  const WORKFLOW = "66666666-6666-4666-8666-666666666666";
  const OPERATION = "77777777-7777-4777-8777-777777777777";
  const AGENT = "99999999-9999-4999-8999-999999999999";
  const VERSION = "84444444-4444-4444-8444-444444444444";
  const PROMPT_KEY = "project_research.synthesis";
  const CONFIG = loadConfig({});

  let threadScope: Array<{ thread_id: string; version: number; kind: "question"; statement: string }> = [];

  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

  const db = useTestDatabase(`${import.meta.filename}#projectResearchSynthesisRetryDb`);

  beforeAll(async () => {
    if (!db.available) return;
    registerProjectResearchExecutionHandlers();
  });

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["jobs", "run_events", "runs", "artifacts", "project_research_reports", "prompt_deployment_refs", "evolvable_asset_versions", "evolvable_assets", "agent_versions", "agents", "project_research_checkpoints", "project_research_workflows", "project_operations", "project_members", "projects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
      threadScope = [await createQuestionThreadScope(db.pool, identity, PROJECT, "Does agent memory improve synthesis?")];
    await insertResearchWorkflowFixture(db.pool, {
      id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
      currentStage: "synthesis", primaryThreadId: threadScope[0]!.thread_id, state: {
        research_question: "Does agent memory improve synthesis?",
        thread_scope: threadScope,
      }, now,
    });
    await db.pool.query(
      `INSERT INTO agents (id, space_id, owner_user_id, name, status, current_version_id, created_at, updated_at, visibility)
       VALUES ($1,$2,$3,'Research Agent','active',NULL,$4,$4,'space_shared')`,
      [AGENT, SPACE, OWNER, now],
    );
    await db.pool.query(
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
    await db.pool.query(`UPDATE agents SET current_version_id=$1 WHERE id=$2`, [VERSION, AGENT]);
  });

  async function seedSynthesisPrompt(): Promise<void> {
    const repo = new EvolvableAssetRepository(db.pool);
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
    await db.pool.query(
      `UPDATE evolvable_asset_versions SET status='approved', updated_at=$3 WHERE asset_id=$1 AND id=$2`,
      [asset.id, version.id, now],
    );
    await db.pool.query(
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
    await db.pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Initial literature intake','failed',$4,$5::jsonb,$6,$6)`,
      [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
    );
  }

  describe("ProjectResearchOrchestrator.retryFailedOperation synthesis stage (real Postgres)", () => {
    it("retries through one WorkflowExecution pass and atomically binds the queued Run and Job", async () => {
      if (!db.available) return;
      await seedSynthesisPrompt();
      await seedRelevantCorpusItem(db.pool, { space: SPACE, project: PROJECT, owner: OWNER });
      await seedFailedSynthesisOperation("prior-failed-run-id");

      await new ProjectResearchOrchestrator(db.pool, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION);

      const operation = await db.pool.query<{
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
      const run = await db.pool.query<{ status: string; capability_id: string; contract_snapshot_json: { workflow_input_json?: { project_research?: { operation_id?: string; stage_key?: string; evidence_matrix_artifact_id?: string } } } }>(
        `SELECT status, capability_id, contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
        [runId, SPACE],
      );
      expect(run.rows[0]).toMatchObject({ status: "queued", capability_id: "research.brief_synthesize" });
      expect(run.rows[0]!.contract_snapshot_json.workflow_input_json?.project_research).toMatchObject({
        operation_id: OPERATION,
        stage_key: "synthesis",
        evidence_matrix_artifact_id: expect.any(String),
      });

      const job = await db.pool.query<{ status: string }>(
        `SELECT status FROM jobs WHERE space_id=$1 AND job_type='agent_run' AND payload_json->>'run_id'=$2`,
        [SPACE, runId],
      );
      expect(job.rows[0]?.status).toBe("pending");
      const execution = await db.pool.query<{ status: string; research_operation_id: string }>(
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
      if (!db.available) return;
      await seedSynthesisPrompt();
      await seedRelevantCorpusItem(db.pool, { space: SPACE, project: PROJECT, owner: OWNER });
      await seedFailedSynthesisOperation("prior-failed-run-id");

      const orchestrator = new ProjectResearchOrchestrator(db.pool, CONFIG);
      const [first, second] = await Promise.all([
        orchestrator.retryFailedOperation(identity, PROJECT, OPERATION),
        orchestrator.retryFailedOperation(identity, PROJECT, OPERATION),
      ]);

      expect((first as { id: string }).id).toBe(OPERATION);
      expect((second as { id: string }).id).toBe(OPERATION);
      const runs = await db.pool.query(
        `SELECT id FROM runs
          WHERE space_id=$1
            AND capability_id='research.brief_synthesize'
            AND contract_snapshot_json->'workflow_input_json'->'project_research'->>'operation_id'=$2`,
        [SPACE, OPERATION],
      );
      const jobs = await db.pool.query(
        `SELECT id FROM jobs WHERE space_id=$1 AND job_type='agent_run'`,
        [SPACE],
      );
      expect(runs.rows).toHaveLength(1);
      expect(jobs.rows).toHaveLength(1);
    });

    it("completes a retried synthesis without a report when its approved corpus is empty", async () => {
      if (!db.available) return;
      await seedSynthesisPrompt();
      await seedFailedSynthesisOperation("prior-failed-run-id");

      await new ProjectResearchOrchestrator(db.pool, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION);

      const operation = await db.pool.query<{
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
      const runs = await db.pool.query(
        `SELECT id FROM runs WHERE space_id=$1 AND capability_id='research.brief_synthesize'`,
        [SPACE],
      );
      const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1`, [SPACE]);
      expect(runs.rows).toHaveLength(0);
      expect(jobs.rows).toHaveLength(0);
    });

    it("keeps the operation failed and retryable when the pass cannot resolve its synthesis prompt", async () => {
      if (!db.available) return;
      // No synthesis prompt is seeded, so queueSynthesis fails inside the
      // transaction after the transition and run would otherwise have applied.
      await seedFailedSynthesisOperation(null);

      await expect(
        new ProjectResearchOrchestrator(db.pool, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION),
      ).resolves.toMatchObject({ id: OPERATION });

      const operation = await db.pool.query<{ status: string; progress_json: { current_stage?: string; synthesis_run_id?: string | null } }>(
        `SELECT status, progress_json FROM project_operations WHERE id=$1`,
        [OPERATION],
      );
      expect(operation.rows[0]!.status).toBe("failed");
      expect(operation.rows[0]!.progress_json.current_stage).toBe("failed");
      expect(operation.rows[0]!.progress_json.synthesis_run_id).toBeNull();
      const runs = await db.pool.query(
        `SELECT id FROM runs WHERE space_id=$1 AND capability_id='research.brief_synthesize'`,
        [SPACE],
      );
      const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1`, [SPACE]);
      expect(runs.rows).toHaveLength(0);
      expect(jobs.rows).toHaveLength(0);
      const execution = await db.pool.query<{ status: string }>(
        `SELECT status FROM workflow_executions
          WHERE space_id=$1 AND research_operation_id=$2`,
        [SPACE, OPERATION],
      );
      expect(execution.rows).toHaveLength(1);
      expect(execution.rows[0]?.status).toBe("failed");
    });
  });
});

describe("projectResearchSynthesisStageGuardDb", () => {
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


  const db = useTestDatabase(`${import.meta.filename}#projectResearchSynthesisStageGuardDb`);

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
});
