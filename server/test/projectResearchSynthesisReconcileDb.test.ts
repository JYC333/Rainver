import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { migrate } from "../src/db/migrator";
import { loadConfig } from "../src/config";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { canonicalRunOutput } from "../src/modules/runs/orchestrationResults";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { WorkflowExecutionService } from "../src/modules/automations/workflowExecutionService";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";
import { insertResearchWorkflowFixture } from "./support/researchWorkflow";

// Real-Postgres coverage for reconcileOperation's synthesis stage. The
// synthesis run's terminal state is normally projected by a one-shot hook in
// the agent_run job handler; before this coverage existed the periodic
// reconciler ignored the synthesis stage entirely, so (a) the UI had no live
// run-status feedback at all while synthesis executed and (b) an operation
// whose one-shot projection was missed waited forever with no recovery.

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const WORKFLOW = "66666666-6666-4666-8666-666666666666";
const OPERATION = "77777777-7777-4777-8777-777777777777";
const AGENT = "99999999-9999-4999-8999-999999999999";
const VERSION = "84444444-4444-4444-8444-444444444444";
const RUNTIME_PROFILE = "83333333-3333-4333-8333-333333333333";
const CATALOG_ROOT = join(process.cwd(), "..", "catalog");
const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };
const CONFIG = loadConfig({});

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;
let threadScope: Array<{ thread_id: string; version: number; kind: "question"; statement: string }> = [];

beforeAll(async () => {
  registerProjectResearchExecutionHandlers();
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    await syncBuiltinPrompts(pool, CATALOG_ROOT);
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[project-research-synthesis-reconcile-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  if (!available || !pool) return;
  await pool.query(
    `TRUNCATE runs, agent_versions, agents, project_research_checkpoints, project_research_workflows,
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
    { kind: "question", statement: "Does X improve Y?" },
  );
  threadScope = [{
    thread_id: String(thread.id),
    version: Number(thread.version),
    kind: "question",
    statement: String(thread.statement),
  }];
  await insertResearchWorkflowFixture(pool, {
    id: WORKFLOW, spaceId: SPACE, projectId: PROJECT, startedByUserId: OWNER,
    currentStage: "synthesis", primaryThreadId: String(thread.id),
    state: { research_question: "Does X improve Y?", thread_scope: threadScope }, now,
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
  await syncBuiltinPrompts(pool, CATALOG_ROOT);
});

async function seedSynthesisRun(runId: string, status: string, contract: Record<string, unknown> | null, errorMessage: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO runs (
       id, space_id, agent_id, agent_version_id, run_type, trigger_origin, status, mode,
       adapter_type, instructed_by_user_id, owner_user_id, project_id,
       contract_snapshot_json, error_message, created_at, updated_at, started_at
     ) VALUES ($1,$2,$3,$4,'agent','system',$5,'live','model_api',$6,$6,$7,$8::jsonb,$9,$10,$10,$11)`,
    [
      runId, SPACE, AGENT, VERSION, status, OWNER, PROJECT,
      JSON.stringify(contract ?? {}),
      errorMessage,
      now,
      status === "queued" ? null : now,
    ],
  );
}

async function settleDelegatedRun(runId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO run_evaluations (
       id,space_id,run_id,evaluator_type,evaluator_version,outcome_status,
       trajectory_status,evidence_json,rule_trace_json,evaluated_at
     ) VALUES ($1,$2,$3,'deterministic_harness','test','passed',
       'acceptable','{}'::jsonb,'[]'::jsonb,$4)`,
    [randomUUID(), SPACE, runId, now],
  );
  const executions = new WorkflowExecutionService(CONFIG);
  // A terminal delegated Run completes its Action node. Two bounded apply
  // nodes then advance one at a time, so drain one graph-length here just as
  // production finalization/reconciliation does.
  for (let index = 0; index < 6; index += 1) {
    await executions.reconcileForRun(pool!, SPACE, runId, OWNER);
  }
  const stillActive = await pool!.query<{ id: string }>(
    `SELECT execution.id
       FROM workflow_execution_node_runs link
       JOIN workflow_execution_nodes node ON node.id=link.node_id AND node.space_id=link.space_id
       JOIN workflow_executions execution ON execution.id=node.execution_id AND execution.space_id=node.space_id
      WHERE link.space_id=$1 AND link.run_id=$2
        AND execution.status IN ('queued','running')`,
    [SPACE, runId],
  );
  expect(stillActive.rows).toHaveLength(0);
  // Production terminal handling first reconciles WorkflowExecution and then
  // dispatches exactly one domain-owned terminal hook. Exercise both halves.
  await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileRun(SPACE, runId);
}

// A project's notebook is ordinary Notes (see notebookNotes.ts /
// areaService.ts), filed under the project's auto-created folder and
// tagged with primary_project_id.
async function seedUnderstandingNote(now: string, opts?: { contentJson?: Record<string, unknown>; plainText?: string; version?: number }): Promise<string> {
  const folderId = randomUUID();
  await pool!.query(
    `INSERT INTO note_collections (id,space_id,parent_id,name,system_role,sort_order,is_system,is_hidden,project_id,created_at,updated_at)
     VALUES ($1,$2,NULL,'Project','project',0,true,false,$3,$4,$4)
     ON CONFLICT (space_id,project_id) WHERE project_id IS NOT NULL DO NOTHING`,
    [folderId, SPACE, PROJECT, now],
  );
  const folder = await pool!.query<{ id: string }>(`SELECT id FROM note_collections WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
  const objectId = randomUUID();
  await pool!.query(
    `INSERT INTO space_objects (id, space_id, object_type, title, visibility, owner_user_id, primary_project_id, created_by_user_id, created_at, updated_at)
     VALUES ($1,$2,'note','Current understanding','space_shared',$3,$4,$3,$5,$5)`,
    [objectId, SPACE, OWNER, PROJECT, now],
  );
  // The `understanding` role is what makes this note the comparison baseline
  // (NA). The title is only a default now, so a fixture that sets the title
  // alone would produce a project the monitoring comparison correctly refuses
  // to run against.
  await pool!.query(
    `INSERT INTO notes (object_id,space_id,content_json,content_format,content_schema_version,plain_text,version,content_hash,role_project_id,project_role)
     VALUES ($1,$2,$3::jsonb,'prosemirror_json',1,$4,$5,'hash',$6,'understanding')`,
    [objectId, SPACE, JSON.stringify(opts?.contentJson ?? { type: "doc", content: [] }), opts?.plainText ?? "Current claim", opts?.version ?? 1, PROJECT],
  );
  await pool!.query(
    `INSERT INTO note_collection_items (id,space_id,collection_id,note_id,sort_order,created_at) VALUES ($1,$2,$3,$4,0,$5)`,
    [randomUUID(), SPACE, folder.rows[0]!.id, objectId, now],
  );
  return objectId;
}

/**
 * A note's current refs. They live on the note's latest revision since N8
 * removed `notes.refs_json` — a second copy of the same list that nothing read
 * back and that had to be kept in step by hand.
 */
async function latestRefs(noteId: string): Promise<string[]> {
  const result = await pool!.query<{ refs_json: string[] }>(
    `SELECT refs_json FROM note_revisions WHERE note_id=$1 AND space_id=$2 ORDER BY version DESC LIMIT 1`,
    [noteId, SPACE],
  );
  return result.rows[0]?.refs_json ?? [];
}

async function seedSynthesisOperation(runId: string | null): Promise<void> {
  const now = new Date().toISOString();
  const progress = {
    schema_version: "project_research_operation.v1",
    run_kind: "baseline",
    workflow_id: WORKFLOW,
    research_question: "Does X improve Y?",
    thread_scope: threadScope,
    agent_id: AGENT,
    runtime_profile_id: RUNTIME_PROFILE,
    source_backfill_plan_ids: [],
    source_backfill_plan_id: null,
    current_stage: "synthesis",
    stage_state: "running",
    partial: false,
    channel_ids: [],
    source_item_ids: [],
    checkpoint_ids: [],
    artifact_ids: [],
    synthesis_run_id: runId,
    watermark: { before: null, after: null, overlap_hours: 48 },
  };
  await pool!.query(
    `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
     VALUES ($1,$2,$3,'research','Initial literature intake','active',$4,$5::jsonb,$6,$6)`,
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

function synthesisContract(): Record<string, unknown> {
  return {
    workflow_input_json: {
      project_research: { workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "baseline", stage_key: "synthesis" },
    },
  };
}

function critiqueContract(): Record<string, unknown> {
  return {
    workflow_input_json: {
      project_research: { workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "baseline", stage_key: "synthesis_critique" },
    },
  };
}

const report = {
  schema_version: "research_report.v1",
  research_question: "Does X improve Y?",
  summary: "A bounded synthesis.",
  findings: [{ claim: "X may improve Y.", support: "multi-source evidence", references: [{ arxiv_id: "2601.12345" }] }],
  limitations: ["Coverage ends in 2026."],
  sources: [{ title: "Paper", authors: ["Author"], year: 2026, relevance: "relevant", summary: "Evidence.", references: [{ arxiv_id: "2601.12345" }] }],
  ideas: [],
};

async function seedCritiqueScenario(input: { depth: "quick" | "full"; round: number; revisionCount: number; output: Record<string, unknown> }): Promise<{ candidateRunId: string; critiqueRunId: string; archiveArtifactId: string }> {
  const candidateRunId = randomUUID();
  const critiqueRunId = randomUUID();
  const archiveArtifactId = randomUUID();
  await seedSynthesisRun(candidateRunId, "succeeded", synthesisContract());
  await seedSynthesisRun(critiqueRunId, "succeeded", critiqueContract());
  // Runs persist output_json through canonicalRunOutput() (schema_version:
  // "run_output.v1" wrapping the actual result under `.result`); match that
  // shape so reconcileCompletedCritique's runOutputResult() unwrap finds it.
  await pool!.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [critiqueRunId, JSON.stringify({
    schema_version: "run_output.v1",
    status: "succeeded",
    summary: "",
    result: input.output,
    output_manifest: [],
  })]);
  const now = new Date().toISOString();
  await pool!.query(
    `INSERT INTO artifacts (
       id,space_id,run_id,project_id,artifact_type,surface_role,title,content,mime_type,
       exportable,export_formats_json,canonical_format,preview,created_at,updated_at,visibility,owner_user_id,trust_level
     ) VALUES ($1,$2,$3,$4,'research_report.archive.v1','system_archive','Draft',$5,'application/json',
       true,'["json"]'::jsonb,'json',false,$6,$6,'space_shared',$7,'high')`,
    [archiveArtifactId, SPACE, candidateRunId, PROJECT, JSON.stringify(report), now, OWNER],
  );
  await seedSynthesisOperation(critiqueRunId);
  await seedRelevantCorpus();
  await pool!.query(
    `UPDATE project_operations SET progress_json=progress_json || $2::jsonb WHERE id=$1`,
    [OPERATION, JSON.stringify({
      research_question: report.research_question,
      research_question_version: 1,
      report_depth: input.depth,
      question_refine_skipped: false,
      agent_id: AGENT,
      runtime_profile_id: RUNTIME_PROFILE,
      synthesis_critique: {
        status: "queued", run_id: critiqueRunId, report_run_id: candidateRunId,
        archive_artifact_id: archiveArtifactId, round: input.round, revision_count: input.revisionCount,
        issues: [], all_issues: [], artifact_ids: [],
      },
    })],
  );
  return { candidateRunId, critiqueRunId, archiveArtifactId };
}

// Seeds a single-provider query strategy bound to the workflow so the
// critique-completion join in synthesisCoordinator.ts (reconcileCompletedCritique)
// has a matching research_query_strategies row to pick up.
async function seedQueryStrategy(): Promise<string> {
  const now = new Date().toISOString();
  const contextVersionId = randomUUID();
  await pool!.query(
    `INSERT INTO project_research_context_versions (id,space_id,project_id,created_by_user_id,version,objective,context_json,created_at)
     VALUES ($1,$2,$3,$4,1,'Objective','{}'::jsonb,$5)`,
    [contextVersionId, SPACE, PROJECT, OWNER, now],
  );
  const strategyId = randomUUID();
  await pool!.query(
    `INSERT INTO research_query_strategies (id,space_id,project_id,research_context_version_id,created_by_user_id,question_snapshot,status,policy_version,version,created_at)
     VALUES ($1,$2,$3,$4,$5,'Does X improve Y?','materialized','v1',1,$6)`,
    [strategyId, SPACE, PROJECT, contextVersionId, OWNER, now],
  );
  const planId = randomUUID();
  await pool!.query(
    `INSERT INTO research_query_provider_plans (id,space_id,strategy_id,provider_key,status,coverage_warning,created_at,updated_at)
     VALUES ($1,$2,$3,'arxiv','selected',NULL,$4,$4)`,
    [planId, SPACE, strategyId, now],
  );
  const attemptId = randomUUID();
  await pool!.query(
    `INSERT INTO research_query_attempts (
       id,space_id,provider_plan_id,sequence,direction,semantic_query_json,compiled_query_json,
       query_fingerprint,provider_hit_count,accessible_hit_count,created_at
     ) VALUES ($1,$2,$3,1,'initial','{}'::jsonb,$4::jsonb,'fp-1',1047,1047,$5)`,
    [attemptId, SPACE, planId, JSON.stringify({ query: { search_query: "llm agent memory" } }), now],
  );
  await pool!.query(
    `INSERT INTO research_query_provider_selections (provider_plan_id,attempt_id,space_id,selected_at) VALUES ($1,$2,$3,$4)`,
    [planId, attemptId, SPACE, now],
  );
  await pool!.query(
    `UPDATE project_research_workflows SET state_json = state_json || $2::jsonb WHERE object_id=$1`,
    [WORKFLOW, JSON.stringify({ query_strategy_id: strategyId })],
  );
  return strategyId;
}

describe("ProjectResearchOrchestrator.reconcileOperation synthesis stage (real Postgres)", () => {
  it("materializes a report only after a passing critique", async () => {
    if (!available || !pool) return;
    const seeded = await seedCritiqueScenario({ depth: "full", round: 0, revisionCount: 0, output: { verdict: "pass", issues: [] } });

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool.query<{ status: string; progress_json: Record<string, unknown> }>(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION]);
    // Checkpoint reform: idea_review records the synthesis
    // result without gating on it, so the operation is still active here.
    expect(operation.rows[0]).toMatchObject({ status: "active", progress_json: { current_stage: "idea_review" } });
    const reports = await pool.query<{ synthesis_run_id: string }>(`SELECT synthesis_run_id FROM project_research_reports WHERE operation_id=$1`, [OPERATION]);
    expect(reports.rows).toEqual([{ synthesis_run_id: seeded.candidateRunId }]);
    const critiques = await pool.query<{ id: string; visibility: string; owner_user_id: string }>(
      `SELECT id,visibility,owner_user_id FROM artifacts WHERE run_id=$1 AND artifact_type='research_critique'`,
      [seeded.critiqueRunId],
    );
    expect(critiques.rows).toEqual([expect.objectContaining({ visibility: "private", owner_user_id: OWNER })]);
  });

  it("never leaks the provider query-strategy diagnostics into report.limitations", async () => {
    if (!available || !pool) return;
    await seedQueryStrategy();
    await seedCritiqueScenario({ depth: "full", round: 0, revisionCount: 0, output: { verdict: "pass", issues: [] } });

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const stored = await pool.query<{ content_json: { limitations: string[] } }>(`SELECT content_json FROM project_research_reports WHERE operation_id=$1`, [OPERATION]);
    expect(stored.rows[0]!.content_json.limitations).toEqual(["Coverage ends in 2026."]);
    expect(stored.rows[0]!.content_json.limitations.some((item) => item.includes("provider_plans"))).toBe(false);
  });

  it("keeps quick reports bounded by recording critical critique issues without a revision run", async () => {
    if (!available || !pool) return;
    await seedCritiqueScenario({ depth: "quick", round: 0, revisionCount: 0, output: {
      verdict: "revise",
      issues: [{ severity: "critical", kind: "unsupported_claim", detail: "The main claim is too strong.", affected_refs: ["ref-1"] }],
    } });

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const stored = await pool.query<{ content_json: { limitations: string[] } }>(`SELECT content_json FROM project_research_reports WHERE operation_id=$1`, [OPERATION]);
    expect(stored.rows[0]!.content_json.limitations.some((item) => item.includes("[unresolved critique]") && item.includes("too strong"))).toBe(true);
    // Square brackets, not parentheses — the reader only turns "[...ref-N...]"
    // groups into clickable citations (ReadOnlyTiptapReader.tsx), so a
    // parenthesized "(ref-1)" here would render as inert text.
    expect(stored.rows[0]!.content_json.limitations.some((item) => item.includes("[ref-1]"))).toBe(true);
    const revisionRuns = await pool.query(`SELECT id FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'project_research'->>'stage_key'='synthesis_revision'`);
    expect(revisionRuns.rows).toHaveLength(0);
  });

  it("stops after one full-report revision and records a still-critical second critique", async () => {
    if (!available || !pool) return;
    await seedCritiqueScenario({ depth: "full", round: 1, revisionCount: 1, output: {
      verdict: "revise",
      issues: [{ severity: "critical", kind: "missing_contradiction", detail: "Contradictory evidence remains omitted.", affected_refs: ["ref-1"] }],
    } });

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const stored = await pool.query<{ content_json: { limitations: string[] } }>(`SELECT content_json FROM project_research_reports WHERE operation_id=$1`, [OPERATION]);
    expect(stored.rows[0]!.content_json.limitations.some((item) => item.includes("[unresolved critique]") && item.includes("Contradictory evidence"))).toBe(true);
    const operation = await pool.query<{ progress_json: Record<string, unknown> }>(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION]);
    expect(operation.rows[0]!.progress_json).toMatchObject({ current_stage: "idea_review", synthesis_critique: { revision_count: 1, status: "completed" } });
  });

  it("queues exactly one full-report revision after the first critical critique", async () => {
    if (!available || !pool) return;
    await seedCritiqueScenario({ depth: "full", round: 0, revisionCount: 0, output: {
      verdict: "revise",
      issues: [{ severity: "critical", kind: "overreach", detail: "The conclusion exceeds the evidence.", affected_refs: ["ref-1"] }],
    } });

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const revisionRuns = await pool.query<{ id: string; contract_snapshot_json: Record<string, unknown> }>(
      `SELECT id,contract_snapshot_json FROM runs WHERE contract_snapshot_json->'workflow_input_json'->'project_research'->>'stage_key'='synthesis_revision'`,
    );
    expect(revisionRuns.rows).toHaveLength(1);
    const operation = await pool.query<{ progress_json: Record<string, unknown> }>(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION]);
    expect(operation.rows[0]!.progress_json).toMatchObject({
      current_stage: "synthesis",
      synthesis_run_id: revisionRuns.rows[0]!.id,
      synthesis_critique: { revision_count: 1, status: "queued", run_id: revisionRuns.rows[0]!.id },
    });
  });

  it("writes a live synthesis_progress read model while the run is still executing", async () => {
    if (!available || !pool) return;
    const runId = randomUUID();
    await seedSynthesisRun(runId, "running", synthesisContract());
    const now = new Date().toISOString();
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO jobs (
         id, space_id, user_id, agent_id, job_type, status, priority, payload_json,
         attempts, max_attempts, created_at, updated_at, heartbeat_at
       ) VALUES ($1,$2,$3,$4,'agent_run','running',0,$5::jsonb,1,3,$6,$6,$6)`,
      [jobId, SPACE, OWNER, AGENT, JSON.stringify({ run_id: runId }), now],
    );
    await pool.query(
      `INSERT INTO run_events (
         id, space_id, run_id, event_index, event_type, status, summary, created_at
       ) VALUES ($1,$2,$3,0,'adapter_invoked','running','Synthesis adapter invoked',$4)`,
      [randomUUID(), SPACE, runId, now],
    );
    await seedSynthesisOperation(runId);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { current_stage?: string; synthesis_progress?: Record<string, unknown> } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("active");
    expect(operation.rows[0]!.progress_json.current_stage).toBe("synthesis");
    expect(operation.rows[0]!.progress_json.synthesis_progress).toMatchObject({
      run_id: runId,
      run_status: "running",
      job_id: jobId,
      job_status: "running",
      job_attempts: 1,
      last_event_type: "adapter_invoked",
    });
    expect(operation.rows[0]!.progress_json.synthesis_progress!.started_at).toBeTruthy();
    expect(operation.rows[0]!.progress_json.synthesis_progress!.job_heartbeat_at).toBeTruthy();
    expect(operation.rows[0]!.progress_json.synthesis_progress!.last_event_at).toBeTruthy();
  });

  it("fails the operation with the run's actual error detail when the synthesis run already failed (missed one-shot projection)", async () => {
    if (!available || !pool) return;
    const runId = randomUUID();
    await seedSynthesisRun(runId, "failed", synthesisContract(), "provider_rate_limited: model quota exhausted");
    await seedSynthesisOperation(runId);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { error?: { message?: string } } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(String(operation.rows[0]!.progress_json.error?.message ?? "")).toContain("provider_rate_limited: model quota exhausted");
  });

  it("treats a model-side rejection for a non-empty corpus as invalid output", async () => {
    if (!available || !pool) return;
    const runId = randomUUID();
    await seedSynthesisRun(runId, "succeeded", synthesisContract());
    await pool.query(
      `UPDATE runs SET output_json=$2::jsonb WHERE id=$1 AND space_id=$3`,
      [runId, JSON.stringify({
        status: "rejected",
        artifacts: [],
        rejection: {
          code: "research_question_not_actionable",
          message: "The research question does not define an actionable synthesis target.",
          reason: "The value `test` is too vague to connect the approved papers into a defensible synthesis.",
          suggestions: ["Provide a specific research question or thematic lens."],
        },
        materialization: [],
      }), SPACE],
    );
    await seedSynthesisOperation(runId);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool.query<{
      status: string;
      progress_json: { error?: { code?: string; message?: string } };
    }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(operation.rows[0]!.progress_json.error).toMatchObject({
      code: "synthesis_output_invalid",
      message: "Synthesis output status must be succeeded",
    });
  });

  it("never leaves a terminal run silently stuck: a succeeded run whose output cannot be applied fails the operation with a retryable message", async () => {
    if (!available || !pool) return;
    const runId = randomUUID();
    // Contract missing the project_research block — reconcileCompletedRun
    // cannot project it, so the fallback guard must fail the operation
    // instead of waiting forever.
    await seedSynthesisRun(runId, "succeeded", {});
    await seedSynthesisOperation(runId);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { error?: { message?: string } } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(String(operation.rows[0]!.progress_json.error?.message ?? "")).toContain("could not be applied");
  });

  it("adopts the newest synthesis run for the operation when the binding was lost and applies its terminal state", async () => {
    if (!available || !pool) return;
    const staleRunId = randomUUID();
    const latestRunId = randomUUID();
    await seedSynthesisRun(staleRunId, "degraded", synthesisContract(), "Research artifact research_report.archive.v1 is not valid JSON");
    await pool.query(`UPDATE runs SET created_at=created_at - interval '1 hour' WHERE id=$1`, [staleRunId]);
    await seedSynthesisRun(latestRunId, "failed", synthesisContract(), "structured_output_invalid: stub tool call");
    // The binding write was lost (e.g. skipped as a stale transition), so the
    // operation sits in synthesis with no bound run and would otherwise only
    // ever refresh its heartbeat.
    await seedSynthesisOperation(null);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { synthesis_run_id?: string | null; error?: { message?: string } } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(operation.rows[0]!.progress_json.synthesis_run_id).toBe(latestRunId);
    expect(String(operation.rows[0]!.progress_json.error?.message ?? "")).toContain("structured_output_invalid: stub tool call");
  });

  it("fails the operation into a retryable state when the synthesis stage has no bound run and no synthesis run exists", async () => {
    if (!available || !pool) return;
    await seedSynthesisOperation(null);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { failed_stage?: string; error?: { message?: string } } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(operation.rows[0]!.progress_json.failed_stage).toBe("synthesis");
    expect(String(operation.rows[0]!.progress_json.error?.message ?? "")).toContain("no synthesis run bound");
  });

  it("fails the operation with a clear message when the queued synthesis run row no longer exists", async () => {
    if (!available || !pool) return;
    await seedSynthesisOperation(randomUUID());

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);

    const operation = await pool!.query<{ status: string; progress_json: { error?: { message?: string } } }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1`,
      [OPERATION],
    );
    expect(operation.rows[0]!.status).toBe("failed");
    expect(String(operation.rows[0]!.progress_json.error?.message ?? "")).toContain("no longer exists");
  });

  it("completes an incremental comparison and raises a contradiction Signal without editing the notebook", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString(); const runId = randomUUID(); const sourceItem = randomUUID();
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    const understandingId = await seedUnderstandingNote(now);
    await pool.query(
      `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
       VALUES ($1,$2,$3,'space_shared','feed_entry','Contradicting paper','No effect under stronger controls.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
      [sourceItem, SPACE, OWNER, now],
    );
    const corpusItemId = randomUUID();
    await pool.query(
      `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
      [corpusItemId, SPACE, PROJECT, sourceItem, now],
    );
    await pool.query(
      `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), corpusItemId, SPACE, PROJECT, sourceItem, now],
    );
    await pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, created_by_user_id,
         progress_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Monitor comparison', 'active', $4,
                 '{}'::jsonb, $5, $5)`,
      [OPERATION, SPACE, PROJECT, OWNER, now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );
    await seedSynthesisRun(runId, "succeeded", { workflow_input_json: { project_research: {
      workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "incremental", stage_key: "monitor_compare", source_item_ids: [sourceItem],
    } } });
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [runId, JSON.stringify({ comparisons: [
      { source_item_id: sourceItem, stance: "contradicts", detail: "No effect under stronger controls.", affected_sections: ["understanding"] },
    ] })]);
    const progress = {
      schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
      research_question: "Does X improve Y?", thread_scope: threadScope,
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
      current_stage: "comparison", stage_state: "running", comparison_run_id: runId,
      comparison_source_item_ids: [sourceItem], source_item_ids: [sourceItem], channel_ids: [], checkpoint_ids: [], artifact_ids: [],
      source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
      watermark: { before: null, after: now, overlap_hours: 48 },
    };
    await pool.query(
      `UPDATE project_operations
          SET progress_json = $4::jsonb, updated_at = $5
        WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [OPERATION, SPACE, PROJECT, JSON.stringify(progress), now],
    );
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileOperation(SPACE, OPERATION);
    const operation = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(operation).toMatchObject({ status: "completed", progress_json: { current_stage: "complete", monitoring_active: true } });
    expect((await pool.query(`SELECT stance,comparison_detail FROM research_evidence_cards WHERE source_item_id=$1`, [sourceItem])).rows[0]).toEqual({ stance: "contradicts", comparison_detail: "No effect under stronger controls." });
    // The notebook is untouched — monitoring no longer co-edits it directly;
    // disruptive comparisons instead raise an Evidence Signal (plan section 18.2).
    const section = (await pool.query(`SELECT version FROM notes WHERE object_id=$1`, [understandingId])).rows[0];
    expect(section).toMatchObject({ version: 1 });
    expect(await latestRefs(understandingId)).toEqual([]);
    const signal = (await pool.query<{ classification: string; corpus_item_id: string; status: string }>(
      `SELECT classification,corpus_item_id,status FROM inquiry_evidence_signals WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    )).rows[0];
    expect(signal).toEqual({ classification: "contradicts", corpus_item_id: corpusItemId, status: "consolidated" });
  });

  it("stops the comparison stage and names the missing role when the project has no baseline", async () => {
    if (!available || !pool) return;
    // NA: the baseline used to be resolved by note title, so a project with no
    // "Current understanding" compared every paper against an empty string and
    // reported nothing. The stage must now stop and say what is missing, with
    // the papers still queued for when a note is given the role.
    const now = new Date().toISOString();
    const items = Array.from({ length: 2 }, () => randomUUID());
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    const understandingId = await seedUnderstandingNote(now);
    // The note exists and still has its title — only the role is absent, which
    // is exactly the state a rename used to produce silently.
    await pool.query(`UPDATE notes SET project_role=NULL, role_project_id=NULL WHERE object_id=$1`, [understandingId]);
    for (const item of items) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry','Paper','Detail.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [item, SPACE, OWNER, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await pool.query(
        `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), corpusItemId, SPACE, PROJECT, item, now],
      );
    }
    await pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, created_by_user_id,
         progress_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Monitor comparison', 'active', $4,
                 '{}'::jsonb, $5, $5)`,
      [OPERATION, SPACE, PROJECT, OWNER, now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,2,2,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );
    await pool.query(
      `UPDATE project_operations SET progress_json = $4::jsonb, updated_at = $5 WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [OPERATION, SPACE, PROJECT, JSON.stringify({
        schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
        research_question: "Does X improve Y?", thread_scope: threadScope,
        agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
        current_stage: "comparison", stage_state: "running", comparison_run_id: null,
        comparison_source_item_ids: [], comparison_pending_source_item_ids: items, comparison_results_json: [],
        source_item_ids: items, channel_ids: [], checkpoint_ids: [], artifact_ids: [],
        source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
        watermark: { before: null, after: now, overlap_hours: 48 },
      }), now],
    );

    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileOperation(SPACE, OPERATION);

    const state = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(state.progress_json.comparison_missing_baseline_role).toBe("understanding");
    // No run was queued, and the papers were not consumed — the stage is
    // waiting, not finished. Finalizing here is what would have looked like a
    // successful scan that found nothing.
    expect(state.progress_json.comparison_run_id).toBeNull();
    expect(state.progress_json.comparison_pending_source_item_ids).toEqual(items);
    expect(state).toMatchObject({ status: "active", progress_json: { current_stage: "comparison" } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM research_evidence_cards WHERE source_item_id=ANY($1::text[])`, [items])).rows[0].n).toBe(0);

    // Giving a note the role releases the stage: the same reconcile now queues.
    await pool.query(
      `UPDATE notes SET project_role='understanding', role_project_id=$2 WHERE object_id=$1`,
      [understandingId, PROJECT],
    );
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileOperation(SPACE, OPERATION);
    const resumed = (await pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(resumed.progress_json.comparison_run_id).toBeTruthy();
    expect(resumed.progress_json.comparison_missing_baseline_role).toBeUndefined();
  });

  it("compares a large paper set in multiple batches, accumulating results until the last batch completes", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    // COMPARISON_BATCH_SIZE is 6 — 7 papers forces a second batch, which is
    // exactly the case that used to fail as one 7-paper structured-output
    // call (models drop/invent ids as the list grows).
    const items = Array.from({ length: 7 }, () => randomUUID());
    const [batch1, batch2] = [items.slice(0, 6), items.slice(6)];
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    const understandingId = await seedUnderstandingNote(now);
    for (const item of items) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry','Paper','Detail.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [item, SPACE, OWNER, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await pool.query(
        `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), corpusItemId, SPACE, PROJECT, item, now],
      );
    }
    await pool.query(
      `INSERT INTO project_operations (
         id, space_id, project_id, kind, title, status, created_by_user_id,
         progress_json, created_at, updated_at
       ) VALUES ($1, $2, $3, 'research', 'Monitor comparison', 'active', $4,
                 '{}'::jsonb, $5, $5)`,
      [OPERATION, SPACE, PROJECT, OWNER, now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,7,7,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );
    const run1 = randomUUID();
    await seedSynthesisRun(run1, "succeeded", { workflow_input_json: { project_research: {
      workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "incremental", stage_key: "monitor_compare", source_item_ids: batch1,
    } } });
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [run1, JSON.stringify({
      comparisons: batch1.map((item) => ({ source_item_id: item, stance: "supports", detail: "Replicates the effect.", affected_sections: ["understanding"] })),
    })]);
    const progress = {
      schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
      research_question: "Does X improve Y?", thread_scope: threadScope,
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
      current_stage: "comparison", stage_state: "running", comparison_run_id: run1,
      comparison_source_item_ids: batch1, comparison_pending_source_item_ids: batch2, comparison_results_json: [],
      source_item_ids: items, channel_ids: [], checkpoint_ids: [], artifact_ids: [],
      source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
      watermark: { before: null, after: now, overlap_hours: 48 },
    };
    await pool.query(
      `UPDATE project_operations SET progress_json = $4::jsonb, updated_at = $5 WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [OPERATION, SPACE, PROJECT, JSON.stringify(progress), now],
    );

    // First batch completes: results accumulate, but the operation must stay
    // in "comparison" — batch 2 hasn't run yet — with nothing persisted to
    // the scan summary or notebook.
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileOperation(SPACE, OPERATION);
    const afterFirstBatch = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(afterFirstBatch).toMatchObject({ status: "active", progress_json: { current_stage: "comparison" } });
    expect(afterFirstBatch.progress_json.comparison_run_id).toBeNull();
    expect(afterFirstBatch.progress_json.comparison_pending_source_item_ids).toEqual(batch2);
    expect(afterFirstBatch.progress_json.comparison_results_json).toHaveLength(6);
    expect((await pool.query(`SELECT comparisons_json FROM research_scan_summaries WHERE operation_id=$1`, [OPERATION])).rows[0].comparisons_json).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM research_evidence_cards WHERE source_item_id=ANY($1::text[])`, [items])).rows[0].n).toBe(0);

    // Second (final) batch completes: everything accumulated across both
    // batches is persisted together, exactly once.
    const run2 = randomUUID();
    await seedSynthesisRun(run2, "succeeded", { workflow_input_json: { project_research: {
      workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "incremental", stage_key: "monitor_compare", source_item_ids: batch2,
    } } });
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [run2, JSON.stringify({
      comparisons: batch2.map((item) => ({ source_item_id: item, stance: "contradicts", detail: "No effect under stronger controls.", affected_sections: ["understanding"] })),
    })]);
    // Simulates queueComparison having dequeued batch 2: it is the run in
    // flight now, and nothing is left pending behind it.
    await pool.query(
      `UPDATE project_operations
          SET progress_json = jsonb_set(jsonb_set(progress_json, '{comparison_run_id}', to_jsonb($2::text)), '{comparison_pending_source_item_ids}', '[]'::jsonb)
        WHERE id=$1`,
      [OPERATION, run2],
    );
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileOperation(SPACE, OPERATION);
    const final = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(final).toMatchObject({ status: "completed", progress_json: { current_stage: "complete", monitoring_active: true } });
    expect((await pool.query(`SELECT count(*)::int AS n FROM research_evidence_cards WHERE source_item_id=ANY($1::text[])`, [items])).rows[0].n).toBe(7);
    const scan = (await pool.query(`SELECT supports_count,contradicts_count,comparisons_json FROM research_scan_summaries WHERE operation_id=$1`, [OPERATION])).rows[0];
    expect(scan).toMatchObject({ supports_count: 6, contradicts_count: 1 });
    expect(scan.comparisons_json).toHaveLength(7);
    // The notebook is untouched — the batch-2 contradiction instead raises an Evidence Signal.
    const section = (await pool.query(`SELECT version FROM notes WHERE object_id=$1`, [understandingId])).rows[0];
    expect(section).toMatchObject({ version: 1 });
    expect(await latestRefs(understandingId)).toEqual([]);
    const signal = (await pool.query<{ classification: string }>(
      `SELECT classification FROM inquiry_evidence_signals
        WHERE space_id=$1 AND project_id=$2 AND classification='contradicts'`,
      [SPACE, PROJECT],
    )).rows[0];
    expect(signal).toEqual({ classification: "contradicts" });
  });

  it("retrying a failed comparison batch resumes instead of discarding earlier batches' results", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    // Same 7-paper/2-batch shape as the "multiple batches" test above, but
    // batch 2 (the run in flight) failed — e.g. the model returned a
    // duplicate/invented source_item_id (parseMonitorComparisons throws,
    // see monitorComparisonService.ts) — while batch 1 already succeeded.
    const items = Array.from({ length: 7 }, () => randomUUID());
    const [batch1, batch2] = [items.slice(0, 6), items.slice(6)];
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    await seedUnderstandingNote(now);
    for (const item of items) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry','Paper','Detail.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [item, SPACE, OWNER, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await pool.query(
        `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), corpusItemId, SPACE, PROJECT, item, now],
      );
    }
    const batch1Results = batch1.map((item) => ({ source_item_id: item, stance: "supports", detail: "Replicates the effect.", affected_sections: ["understanding"] }));
    const progress = {
      schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
      research_question: "Does X improve Y?", thread_scope: threadScope,
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
      current_stage: "failed", failed_stage: "comparison", stage_state: "failed",
      comparison_run_id: "stale-failed-run-id", comparison_source_item_ids: batch2,
      comparison_pending_source_item_ids: [], comparison_results_json: batch1Results,
      source_item_ids: items, channel_ids: [], checkpoint_ids: [], artifact_ids: [],
      source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
      watermark: { before: null, after: now, overlap_hours: 48 },
      error: { code: "research_operation_failed", message: "Monitoring comparison returned an unexpected or duplicate source_item_id", at: now },
    };
    await pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Monitor comparison','failed',$4,$5::jsonb,$6,$6)`,
      [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,7,7,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );

    await new ProjectResearchOrchestrator(pool!, CONFIG).retryFailedOperation(identity, PROJECT, OPERATION);

    const after = (await pool.query<{
      status: string;
      progress_json: {
        current_stage?: string; stage_state?: string; failed_stage?: string;
        comparison_run_id?: string | null; comparison_pending_source_item_ids?: string[];
        comparison_results_json?: unknown[];
      };
    }>(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0]!;
    expect(after.status).toBe("active");
    expect(after.progress_json.current_stage).toBe("comparison");
    expect(after.progress_json.stage_state).toBe("running");
    expect(after.progress_json.failed_stage).toBeUndefined();
    // Batch 2 (the one that failed) was re-queued as a fresh run, not left
    // stuck on the stale, now-abandoned run id.
    expect(after.progress_json.comparison_run_id).toBeTruthy();
    expect(after.progress_json.comparison_run_id).not.toBe("stale-failed-run-id");
    expect(after.progress_json.comparison_pending_source_item_ids).toEqual([]);
    // Batch 1's already-accumulated results must survive the retry — the bug
    // being fixed here wiped comparison_results_json back to [] on every
    // retry, silently discarding real LLM output over one bad batch.
    expect(after.progress_json.comparison_results_json).toEqual(batch1Results);

    const run = await pool.query<{ status: string; contract_snapshot_json: { workflow_input_json?: { project_research?: { source_item_ids?: string[] } } } }>(
      `SELECT status, contract_snapshot_json FROM runs WHERE id=$1 AND space_id=$2`,
      [after.progress_json.comparison_run_id, SPACE],
    );
    expect(run.rows[0]?.status).toBe("queued");
    expect(run.rows[0]?.contract_snapshot_json.workflow_input_json?.project_research?.source_item_ids).toEqual(batch2);
  });

  it("salvages the matched entries from a batch, retries only the unmatched papers one at a time, and drops a paper that still doesn't match its solo retry", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const items = Array.from({ length: 6 }, () => randomUUID());
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    await seedUnderstandingNote(now);
    for (const item of items) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry','Paper','Detail.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [item, SPACE, OWNER, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await pool.query(
        `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), corpusItemId, SPACE, PROJECT, item, now],
      );
    }
    const progress = {
      schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
      research_question: "Does X improve Y?", thread_scope: threadScope,
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
      current_stage: "comparison", stage_state: "running",
      comparison_run_id: "run-1", comparison_source_item_ids: items,
      comparison_pending_source_item_ids: [], comparison_results_json: [],
      source_item_ids: items, channel_ids: [], checkpoint_ids: [], artifact_ids: [],
      source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
      watermark: { before: null, after: now, overlap_hours: 48 },
    };
    await pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Monitor comparison','active',$4,$5::jsonb,$6,$6)`,
      [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,6,6,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );
    await seedSynthesisRun("run-1", "succeeded", { workflow_input_json: { project_research: {
      workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "incremental", stage_key: "monitor_compare", source_item_ids: items,
    } } });
    // 4 valid matches; item[4] gets a structurally invalid entry (stance
    // outside the enum); item[5] is simply missing from the response —
    // both must be salvaged as "retry solo", not sunk with the whole batch.
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, ["run-1", JSON.stringify({
      comparisons: [
        ...items.slice(0, 4).map((item) => ({ source_item_id: item, stance: "supports", detail: "Replicates the effect.", affected_sections: ["understanding"] })),
        { source_item_id: items[4], stance: "maybe", detail: "Invalid stance value.", affected_sections: ["understanding"] },
      ],
    })]);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);
    const afterBatch = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(afterBatch).toMatchObject({ status: "active", progress_json: { current_stage: "comparison" } });
    expect(afterBatch.progress_json.comparison_run_id).toBeNull();
    expect(afterBatch.progress_json.comparison_results_json).toHaveLength(4);
    expect(afterBatch.progress_json.comparison_failed_source_item_ids).toEqual([items[4], items[5]]);

    // Reconciling again with no run in flight dispatches the next chunk —
    // now the failed pool, one paper at a time.
    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);
    const soloQueued = (await pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0].progress_json;
    const soloRunId = soloQueued.comparison_run_id;
    expect(soloRunId).toBeTruthy();
    expect(soloQueued.comparison_source_item_ids).toEqual([items[4]]);
    expect(soloQueued.comparison_failed_source_item_ids).toEqual([items[5]]);
    await pool.query(`UPDATE runs SET status='succeeded', output_json=$2::jsonb WHERE id=$1`, [soloRunId, JSON.stringify({
      comparisons: [{ source_item_id: items[4], stance: "contradicts", detail: "Solo retry succeeded.", affected_sections: ["understanding"] }],
    })]);
    const soloContract = (await pool.query<{
      output_json: unknown;
      contract_snapshot_json: { workflow_input_json?: { project_research?: { source_item_ids?: string[] } } };
    }>(
      `SELECT output_json,contract_snapshot_json FROM runs WHERE id=$1`,
      [soloRunId],
    )).rows[0]!;
    expect(soloContract.contract_snapshot_json.workflow_input_json?.project_research?.source_item_ids).toEqual([items[4]]);
    expect(soloContract.output_json).toMatchObject({
      comparisons: [expect.objectContaining({ source_item_id: items[4], stance: "contradicts" })],
    });

    await settleDelegatedRun(soloRunId);
    const soloExecutions = await pool.query<{ status: string }>(
      `SELECT status FROM workflow_executions
        WHERE space_id=$1 AND research_operation_id=$2
        ORDER BY created_at`,
      [SPACE, OPERATION],
    );
    expect(soloExecutions.rows.length).toBeGreaterThan(1);
    expect(soloExecutions.rows.at(-1)?.status).not.toBe("failed");
    const afterSoloSuccess = (await pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0].progress_json;
    expect(afterSoloSuccess.comparison_results_json).toHaveLength(5);
    expect(afterSoloSuccess.comparison_failed_source_item_ids).toEqual([]);
    expect(afterSoloSuccess.comparison_source_item_ids).toEqual([items[5]]);

    // The bounded apply chain immediately dispatches item[5]'s solo retry.
    // Have it fail again — a paper that still doesn't match after its solo
    // retry is dropped for good, not requeued into another loop.
    const secondSoloRunId = afterSoloSuccess.comparison_run_id;
    expect(secondSoloRunId).toBeTruthy();
    await pool.query(`UPDATE runs SET status='succeeded', output_json=$2::jsonb WHERE id=$1`, [secondSoloRunId, JSON.stringify({ comparisons: [] })]);

    await settleDelegatedRun(secondSoloRunId);
    const final = (await pool.query(`SELECT status,progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0];
    expect(final).toMatchObject({ status: "completed", progress_json: { current_stage: "complete", monitoring_active: true } });
    expect(final.progress_json.comparison_pending_source_item_ids).toEqual([]);
    expect(final.progress_json.comparison_failed_source_item_ids).toEqual([]);
    const scan = (await pool.query(`SELECT comparisons_json FROM research_scan_summaries WHERE operation_id=$1`, [OPERATION])).rows[0];
    expect(scan.comparisons_json).toHaveLength(5);
    const cards = await pool.query(`SELECT source_item_id FROM research_evidence_cards WHERE source_item_id=ANY($1::text[])`, [items]);
    expect(cards.rows.map((row) => row.source_item_id).sort()).toEqual(items.slice(0, 5).sort());
  });

  it("drops to one-at-a-time for every remaining paper once a whole batch matches nothing", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const items = Array.from({ length: 12 }, () => randomUUID());
    const [batch1, rest] = [items.slice(0, 6), items.slice(6)];
    await pool.query(`UPDATE project_research_workflows SET current_stage='comparison' WHERE object_id=$1`, [WORKFLOW]);
    await seedUnderstandingNote(now);
    for (const item of items) {
      await pool.query(
        `INSERT INTO source_items (id,space_id,owner_user_id,visibility,item_type,title,excerpt,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
         VALUES ($1,$2,$3,'space_shared','feed_entry','Paper','Detail.',$4,$4,'excerpt_saved','summary_only',$4,$4)`,
        [item, SPACE, OWNER, now],
      );
      const corpusItemId = randomUUID();
      await pool.query(
        `INSERT INTO project_corpus_items (id,space_id,project_id,source_item_id,role,status,triage_status,triage_confirmed_by_user,read_status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'candidate','active','relevant',true,'unread',$5,$5)`,
        [corpusItemId, SPACE, PROJECT, item, now],
      );
      await pool.query(
        `INSERT INTO project_corpus_item_sources (id,corpus_item_id,space_id,project_id,source_item_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), corpusItemId, SPACE, PROJECT, item, now],
      );
    }
    const progress = {
      schema_version: "project_research_operation.v1", run_kind: "incremental", workflow_id: WORKFLOW,
      research_question: "Does X improve Y?", thread_scope: threadScope,
      agent_id: AGENT, runtime_profile_id: RUNTIME_PROFILE,
      current_stage: "comparison", stage_state: "running",
      comparison_run_id: "run-1", comparison_source_item_ids: batch1,
      comparison_pending_source_item_ids: rest, comparison_results_json: [],
      source_item_ids: items, channel_ids: [], checkpoint_ids: [], artifact_ids: [],
      source_backfill_plan_ids: [], source_backfill_plan_id: null, partial: false, monitoring_active: false,
      watermark: { before: null, after: now, overlap_hours: 48 },
    };
    await pool.query(
      `INSERT INTO project_operations (id, space_id, project_id, kind, title, status, created_by_user_id, progress_json, created_at, updated_at)
       VALUES ($1,$2,$3,'research','Monitor comparison','active',$4,$5::jsonb,$6,$6)`,
      [OPERATION, SPACE, PROJECT, OWNER, JSON.stringify(progress), now],
    );
    await pool.query(
      `INSERT INTO research_scan_summaries (id,space_id,project_id,workflow_id,operation_id,scan_key,scanned_at,new_item_count,relevant_count,maybe_count,excluded_count,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,12,12,0,0,$7)`,
      [randomUUID(), SPACE, PROJECT, WORKFLOW, OPERATION, `operation:${OPERATION}`, now],
    );
    await seedSynthesisRun("run-1", "succeeded", { workflow_input_json: { project_research: {
      workflow_id: WORKFLOW, operation_id: OPERATION, run_kind: "incremental", stage_key: "monitor_compare", source_item_ids: batch1,
    } } });
    // Every entry is fabricated — none of batch1's real ids appear anywhere
    // in the response (the MiniMax-M3 incident this models: a run returning
    // comparisons for papers that were never sent and don't exist).
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, ["run-1", JSON.stringify({
      comparisons: [
        { source_item_id: randomUUID(), stance: "supports", detail: "Fabricated paper unrelated to this batch.", affected_sections: ["understanding"] },
      ],
    })]);

    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);
    const afterZeroMatch = (await pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0].progress_json;
    expect(afterZeroMatch.comparison_degraded).toBe(true);
    expect(afterZeroMatch.comparison_failed_source_item_ids).toEqual(batch1);
    expect(afterZeroMatch.comparison_pending_source_item_ids).toEqual(rest);
    expect(afterZeroMatch.comparison_results_json).toEqual([]);

    // The next dispatch pulls from the (still non-empty) pending pool, but
    // degraded mode forces it to a single paper, not another 6-paper batch.
    await new ProjectResearchOrchestrator(pool!, CONFIG).reconcileOperation(SPACE, OPERATION);
    const nextDispatch = (await pool.query(`SELECT progress_json FROM project_operations WHERE id=$1`, [OPERATION])).rows[0].progress_json;
    expect(nextDispatch.comparison_source_item_ids).toEqual([rest[0]]);
    expect(nextDispatch.comparison_pending_source_item_ids).toEqual(rest.slice(1));
  });

  it("applies ad-hoc notebook ops on run completion and degrades to a labeled append after a conflict", async () => {
    if (!available || !pool) return;
    const now = new Date().toISOString();
    const understandingId = await seedUnderstandingNote(now, {
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Old claim" }] }, { type: "paragraph", content: [{ type: "text", text: "Kept block" }] }] },
      plainText: "Old claim\n\nKept block",
      version: 3,
    });
    const adhocContract = (baseVersion: number) => ({ workflow_input_json: { research_adhoc: {
      note_id: understandingId, base_version: baseVersion, source_item_ids: [],
    } } });
    const output = canonicalRunOutput({
      success: true,
      outputText: "",
      outputJson: { notebook_update: { refs: ["source-9"], ops: [
        { op: "replace", index: 0, count: 1, markdown: "Revised claim", },
      ] } },
    });
    const runId = randomUUID();
    await seedSynthesisRun(runId, "succeeded", adhocContract(3));
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [runId, JSON.stringify(output)]);
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileRun(SPACE, runId);
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileRun(SPACE, runId);
    const applied = (await pool.query(`SELECT version,plain_text FROM notes WHERE object_id=$1`, [understandingId])).rows[0];
    expect(applied).toMatchObject({ version: 4, plain_text: "Revised claim\n\nKept block" });
    expect(await latestRefs(understandingId)).toEqual(["source-9"]);
    expect(Number((await pool.query(`SELECT count(*) AS count FROM note_revisions WHERE note_id=$1`, [understandingId])).rows[0]?.count)).toBe(1);
    const staleRun = randomUUID();
    await seedSynthesisRun(staleRun, "succeeded", adhocContract(3));
    await pool.query(`UPDATE runs SET output_json=$2::jsonb WHERE id=$1`, [staleRun, JSON.stringify(output)]);
    await new ProjectResearchOrchestrator(pool, CONFIG).reconcileRun(SPACE, staleRun);
    const conflicted = (await pool.query(`SELECT version,plain_text FROM notes WHERE object_id=$1`, [understandingId])).rows[0];
    expect(conflicted?.version).toBe(5);
    expect(String(conflicted?.plain_text)).toContain("AI update (note changed since v3)");
    expect(String(conflicted?.plain_text)).toContain("Kept block");
    expect((await pool.query(`SELECT source,diff_json FROM note_revisions WHERE note_id=$1 AND version=5`, [understandingId])).rows[0])
      .toMatchObject({ source: "ai_adhoc", diff_json: { conflict: true } });
  });

});
