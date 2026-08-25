import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";
import { resetTables } from "./support/resetTables";
import { loadConfig } from "../src/config";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { __setQuestionRefineInvokerForTests } from "../src/modules/projectResearch/questionRefineService";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import {
  ResearchAcquisitionPipelineRunner,
  RESEARCH_PIPELINE_START_JOB,
} from "../src/modules/projectResearch/pipeline/researchAcquisitionPipelineJob";
import { RESEARCH_OPERATION_FAILURE_NOTIFY_JOB } from "../src/modules/projectResearch/pipeline/researchOperationFailureNotifyJob";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator";
import type { JobEnvelopeForHandler } from "../src/modules/jobs/handlerRegistry";
import type { SpaceUserIdentity } from "../src/modules/routeUtils/common";

const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");

// Real-Postgres coverage for the background pipeline behind
// `research.start_acquisition` (room-advancement-reliability-plan Phase 4):
// bare accepted Thread -> a running Operation, with the FINER-assessment
// gate and the Room continuation events. Only the live LLM (question
// assessment) and live multi-provider search (query evaluation) are faked —
// everything else runs against real Postgres exactly as production does.

const SPACE = "31111111-1111-4111-8111-111111111111";
const OWNER = "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "35555555-5555-4555-8555-555555555555";
const AGENT = "39999999-9999-4999-8999-999999999999";
const AGENT_VERSION = "39999999-9999-4999-8999-999999999998";
const PROVIDER = "39999999-9999-4999-8999-999999999997";
const ROOM = "37777777-7777-4777-8777-777777777777";
const SESSION = "38888888-8888-4888-8888-888888888888";

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let config: ReturnType<typeof loadConfig> | undefined;
let available = false;

beforeAll(async () => {
  registerProjectResearchExecutionHandlers();
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });
    config = loadConfig({ SERVER_DATABASE_URL: container.getConnectionUri(), AGENT_SPACE_HOME: "/tmp/agent-space-research-acquisition-pipeline-test" });
    available = true;
  } catch (err) {
    if (!isTestPostgresUnavailableError(err)) throw err;
    console.warn(`[research-acquisition-pipeline-db] skipped — Docker/Postgres unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  __setQuestionRefineInvokerForTests(null);
  if (!available || !pool) return;
  await resetTables(
    pool,
    ["messages", "sessions", "room_user_members", "rooms", "jobs", "project_research_reports", "project_research_checkpoints", "research_query_strategies", "project_research_context_versions", "project_research_question_assessment_sessions", "project_operations", "project_research_workflows", "artifacts", "project_members", "projects", "space_memberships", "users", "spaces", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors"],
    { cascade: true },
  );
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO spaces (id, name, type, created_at, updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await pool.query(`INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1,$1,'active',$2,$2)`, [OWNER, now]);
  await pool.query(
    `INSERT INTO space_memberships (id, space_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO projects (id, space_id, owner_user_id, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'Research','active',$4,$4)`,
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
    `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
     VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
    [PROVIDER, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
    [randomUUID(), PROVIDER, SPACE, OWNER, now],
  );
  await pool.query(
    `INSERT INTO agent_runtime_profiles (id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
     VALUES ($1,$2,$3,'Default','model_api',$4,'test-model','{}'::jsonb,'{}'::jsonb,true,true,$5,$5)`,
    [randomUUID(), SPACE, AGENT, PROVIDER, now],
  );
  await syncBuiltinPrompts(pool, CATALOG_ROOT);
  for (const providerKey of ["arxiv", "openalex"]) {
    const connectorId = randomUUID();
    const mappingId = randomUUID();
    await pool.query(
      `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
       VALUES ($1,$2,$2,'external_feed','pull','active','{}'::jsonb,$3,$3)`,
      [connectorId, `${providerKey}_api`, now],
    );
    await pool.query(
      `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
       VALUES ($1,$2,$2,'named','academic','active','{}'::jsonb,$3,$3)`,
      [connectorId, providerKey, now],
    );
    await pool.query(
      `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
       VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
      [mappingId, connectorId, connectorId, now],
    );
  }
  await pool.query(
    `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'Room','active',$5,$5)`,
    [ROOM, SPACE, PROJECT, OWNER, now],
  );
  await pool.query(
    `INSERT INTO sessions (id, space_id, room_id, project_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$5)`,
    [SESSION, SPACE, ROOM, PROJECT, now],
  );
  await pool.query(
    `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
    [randomUUID(), SPACE, ROOM, OWNER, now],
  );
  await pool.query(
    `INSERT INTO room_agent_members (id, space_id, room_id, agent_id, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'manager','active',$5,$5)`,
    [randomUUID(), SPACE, ROOM, AGENT, now],
  );
});

const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

// `recommended_question` must echo the Thread's own statement:
// `resolveResearchThreadScope` requires the materialized question to exactly
// match the pinned Thread, so a fake assessment can never rephrase it.
function passingAssessmentInvoker() {
  return async (input: { messages: Array<{ content: string }> }) => {
    const lastMessage = JSON.parse(input.messages[input.messages.length - 1]!.content) as { candidate_research_question: string };
    return {
      reply: "Assessed.",
      recommended_question: lastMessage.candidate_research_question,
      assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 5 }, issues: [] },
      suggested_questions: [lastMessage.candidate_research_question],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: [],
    };
  };
}

function failingAssessmentInvoker() {
  return async (input: { messages: Array<{ content: string }> }) => {
    const lastMessage = JSON.parse(input.messages[input.messages.length - 1]!.content) as { candidate_research_question: string };
    return {
      reply: "Assessed.",
      recommended_question: lastMessage.candidate_research_question,
      assessment: { answerable: true, finer: { feasible: 1, interesting: 1, novel: 1, ethical: 1, relevant: 1 }, issues: ["Too broad to answer."] },
      suggested_questions: [lastMessage.candidate_research_question],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: [],
    };
  };
}

const FAKE_QUERY_DEPENDENCIES = {
  intentPlanner: {
    plan: async () => ({
      schema_version: "research_semantic_query.v1" as const,
      core: [{ value: "agent memory", synonyms: [], weight: 1 }],
      expansions: [
        { value: "persistent memory", synonyms: [], weight: 0.7 },
        { value: "long-term context", synonyms: [], weight: 0.6 },
      ],
      qualifiers: [{ value: "evaluation", synonyms: [], weight: 0.8 }],
      exclusions: [],
      time_window: null,
    }),
  },
  previewGateway: {
    preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }),
  },
};

async function makeJob(threadId: string, overrides: Partial<Record<string, unknown>> = {}): Promise<JobEnvelopeForHandler> {
  return {
    job_id: randomUUID(),
    space_id: SPACE,
    user_id: OWNER,
    job_type: RESEARCH_PIPELINE_START_JOB,
    attempts: 0,
    max_attempts: 3,
    worker_id: "test-worker",
    payload: {
      thread_id: threadId,
      project_id: PROJECT,
      origin_room_id: ROOM,
      origin_session_id: SESSION,
      ...overrides,
    },
  };
}

describe("ResearchAcquisitionPipelineRunner (real Postgres)", () => {
  // The Room-message assertion the plan's verification section also calls
  // for (one posted `research_pipeline_outcome` continuation) is covered
  // separately in researchAcquisitionContinuation.test.ts, which exercises
  // `registerResearchAcquisitionContinuation`'s handlers directly — full
  // Room message dispatch additionally requires a working conversation
  // backend (agent runtime profile + credential eligibility), a Room-module
  // prerequisite this fixture does not attempt to reproduce; `postOutcome`'s
  // try/catch swallowing that failure without disturbing the pipeline result
  // is exercised implicitly by every test below succeeding despite it.
  it("runs a bare accepted Thread through to a running Operation, Room-linked in progress_json", async () => {
    if (!available || !pool) return;
    __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
    const thread = await new InquiryThreadService(pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "How should agents remember across sessions?",
    });

    const runner = new ResearchAcquisitionPipelineRunner(pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
    const result = await runner.run(await makeJob(String(thread.id)));
    expect(result).toMatchObject({ status: "started", thread_id: String(thread.id) });
    const operationId = (result as { operation_id: string }).operation_id;

    const operation = await pool.query<{ status: string; progress_json: Record<string, unknown> }>(
      `SELECT status, progress_json FROM project_operations WHERE id=$1 AND space_id=$2`,
      [operationId, SPACE],
    );
    expect(operation.rows[0]!.status).toBe("active");
    expect(operation.rows[0]!.progress_json).toMatchObject({ origin_room_id: ROOM, origin_session_id: SESSION });
  });

  it("reports assessment_not_passed and does not create an Operation when FINER scores fail the gate", async () => {
    if (!available || !pool) return;
    __setQuestionRefineInvokerForTests(failingAssessmentInvoker());
    const thread = await new InquiryThreadService(pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "Tell me everything about everything.",
    });

    const runner = new ResearchAcquisitionPipelineRunner(pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
    const result = await runner.run(await makeJob(String(thread.id)));
    expect(result).toMatchObject({ status: "assessment_not_passed", thread_id: String(thread.id) });

    const operations = await pool.query(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research'`, [SPACE, PROJECT]);
    expect(operations.rows).toHaveLength(0);
  });

  // Advance-to-done idempotency: a second, identical invocation reuses the
  // already-materialized strategy (resolveStrategy's reuse query) and then
  // coalesces onto the same Operation via startInitialIntake's own
  // idempotency-key fingerprint match — not a 409 conflict. The 409/
  // "already active" stage_failed path this pipeline also handles is for a
  // *different* concurrent start on the same Thread (different strategy/
  // fingerprint), not a verbatim repeat.
  it("is idempotent: a second identical run coalesces onto the same Operation instead of duplicating it", async () => {
    if (!available || !pool) return;
    __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
    const thread = await new InquiryThreadService(pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "What drives agent reliability?",
    });
    const runner = new ResearchAcquisitionPipelineRunner(pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
    const first = await runner.run(await makeJob(String(thread.id)));
    expect(first).toMatchObject({ status: "started" });

    const second = await runner.run(await makeJob(String(thread.id)));
    expect(second).toMatchObject({ status: "started", operation_id: (first as { operation_id: string }).operation_id });

    const operations = await pool.query(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research'`, [SPACE, PROJECT]);
    expect(operations.rows).toHaveLength(1);

    const strategies = await pool.query(`SELECT id FROM research_query_strategies WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    expect(strategies.rows).toHaveLength(1);
  });

  // Regression test for the discovery-review finding: `failOperation` can run
  // inside a `WorkflowExecutionService` SAVEPOINT that gets rolled back on
  // rethrow, so `notifyRoomOfOperationFailure` must enqueue its Room
  // notification through the same `Queryable` `failOperation` is already
  // using (sharing its commit/rollback fate) rather than posting the Room
  // message directly through an independent connection. This test exercises
  // `decideCheckpoint`'s "rejected" path — a real, public `failOperation`
  // call site — and asserts the state write and the notify-job enqueue
  // land together.
  it("failOperation enqueues the Room failure-notify job atomically with the operation's failed state (checkpoint rejected)", async () => {
    if (!available || !pool) return;
    __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
    const thread = await new InquiryThreadService(pool).createThread(identity, PROJECT, {
      kind: "question",
      statement: "Does checkpoint rejection notify the Room atomically?",
    });
    const runner = new ResearchAcquisitionPipelineRunner(pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
    const started = await runner.run(await makeJob(String(thread.id)));
    expect(started).toMatchObject({ status: "started" });
    const operationId = (started as { operation_id: string }).operation_id;

    const operationRow = await pool.query<{ progress_json: { workflow_id: string } }>(
      `SELECT progress_json FROM project_operations WHERE id=$1 AND space_id=$2`,
      [operationId, SPACE],
    );
    const workflowId = operationRow.rows[0]!.progress_json.workflow_id;
    const checkpointId = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO project_research_checkpoints (
         id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
         machine_result_json, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'screening','screening_gate','pending',$5::jsonb,$6,$6)`,
      [checkpointId, SPACE, PROJECT, workflowId, JSON.stringify({ operation_id: operationId }), now],
    );

    const orchestrator = new ProjectResearchOrchestrator(pool, config!);
    await orchestrator.decideCheckpoint(identity, PROJECT, workflowId, checkpointId, { decision: "rejected" });

    const operationAfter = await pool.query<{ status: string }>(
      `SELECT status FROM project_operations WHERE id=$1 AND space_id=$2`,
      [operationId, SPACE],
    );
    expect(operationAfter.rows[0]!.status).toBe("failed");

    const notifyJobs = await pool.query<{ payload_json: Record<string, unknown>; status: string }>(
      `SELECT payload_json, status FROM jobs WHERE space_id=$1 AND job_type=$2`,
      [SPACE, RESEARCH_OPERATION_FAILURE_NOTIFY_JOB],
    );
    expect(notifyJobs.rows).toHaveLength(1);
    expect(notifyJobs.rows[0]!.status).toBe("pending");
    expect(notifyJobs.rows[0]!.payload_json).toMatchObject({
      operation_id: operationId,
      room_id: ROOM,
      session_id: SESSION,
      reason: "Checkpoint rejected by user",
    });
  });
});
