import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import type { JobEnvelopeForHandler } from "../src/modules/jobs/handlerRegistry.js";
import { registerProjectResearchExecutionHandlers } from "../src/modules/projectResearch/executionRegistration.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { RESEARCH_PIPELINE_START_JOB, ResearchAcquisitionPipelineRunner } from "../src/modules/projectResearch/pipeline/researchAcquisitionPipelineJob.js";
import { ResearchAcquisitionService } from "../src/modules/projectResearch/pipeline/researchAcquisitionService.js";
import { RESEARCH_OPERATION_FAILURE_NOTIFY_JOB } from "../src/modules/projectResearch/pipeline/researchOperationFailureNotifyJob.js";
import { __setQuestionRefineInvokerForTests } from "../src/modules/projectResearch/questionRefineService.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import { HttpError, type SpaceUserIdentity } from "../src/modules/routeUtils/common.js";
import { seedAgentWithVersion, seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { useTestDatabase } from "./support/testDatabase.js";

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setQuestionRefineInvokerForTests(null);
});

describe("researchAcquisitionPipelineDb", () => {
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

  let config: ReturnType<typeof loadConfig> | undefined;

  const db = useTestDatabase(`${import.meta.filename}#researchAcquisitionPipelineDb`, { max: 5 });

  beforeAll(async () => {
    if (!db.available) return;
    registerProjectResearchExecutionHandlers();
    config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri, AGENT_SPACE_HOME: "/tmp/agent-space-research-acquisition-pipeline-test" });
  });

  beforeEach(async () => {
    __setQuestionRefineInvokerForTests(null);
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["messages", "sessions", "room_user_members", "rooms", "jobs", "project_research_reports", "project_research_checkpoints", "research_query_strategies", "project_research_context_versions", "project_research_question_assessment_sessions", "project_operations", "project_research_workflows", "artifacts", "project_members", "projects", "space_memberships", "users", "spaces", "source_channels", "source_connections", "source_provider_connectors", "source_providers", "source_connectors"],
      { cascade: true },
    );
    const { now } = await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
    await seedAgentWithVersion(db.pool, { agent: AGENT, version: AGENT_VERSION, space: SPACE, owner: OWNER, now });
    await db.pool.query(
      `INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,base_url,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
       VALUES ($1,$2,$3,'Test Provider','openai','https://example.invalid/v1','test-model',true,'{}'::jsonb,'{}'::jsonb,$4,$4)`,
      [PROVIDER, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO model_provider_space_grants (id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$4,true,true,$5,$5)`,
      [randomUUID(), PROVIDER, SPACE, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO agent_runtime_profiles (id,space_id,agent_id,name,adapter_type,model_provider_id,model_name,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
       VALUES ($1,$2,$3,'Default','model_api',$4,'test-model','{}'::jsonb,'{}'::jsonb,true,true,$5,$5)`,
      [randomUUID(), SPACE, AGENT, PROVIDER, now],
    );
    await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
    for (const providerKey of ["arxiv", "openalex"]) {
      const connectorId = randomUUID();
      const mappingId = randomUUID();
      await db.pool.query(
        `INSERT INTO source_connectors (id, connector_key, display_name, connector_type, ingestion_mode, status, capabilities_json, created_at, updated_at)
         VALUES ($1,$2,$2,'external_feed','pull','active','{}'::jsonb,$3,$3)`,
        [connectorId, `${providerKey}_api`, now],
      );
      await db.pool.query(
        `INSERT INTO source_providers (id, provider_key, display_name, provider_kind, category, status, capabilities_json, created_at, updated_at)
         VALUES ($1,$2,$2,'named','academic','active','{}'::jsonb,$3,$3)`,
        [connectorId, providerKey, now],
      );
      await db.pool.query(
        `INSERT INTO source_provider_connectors (id, provider_id, connector_id, status, priority, capabilities_json, created_at, updated_at)
         VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
        [mappingId, connectorId, connectorId, now],
      );
    }
    await db.pool.query(
      `INSERT INTO rooms (id, space_id, project_id, created_by_user_id, title, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'Room','active',$5,$5)`,
      [ROOM, SPACE, PROJECT, OWNER, now],
    );
    await db.pool.query(
      `INSERT INTO sessions (id, space_id, room_id, project_id, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'active',$5,$5)`,
      [SESSION, SPACE, ROOM, PROJECT, now],
    );
    await db.pool.query(
      `INSERT INTO room_user_members (id, space_id, room_id, user_id, role, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'member','active',$5,$5)`,
      [randomUUID(), SPACE, ROOM, OWNER, now],
    );
    await db.pool.query(
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
      if (!db.available) return;
      __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "How should agents remember across sessions?",
      });

      const runner = new ResearchAcquisitionPipelineRunner(db.pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
      const result = await runner.run(await makeJob(String(thread.id)));
      expect(result).toMatchObject({ status: "started", thread_id: String(thread.id) });
      const operationId = (result as { operation_id: string }).operation_id;

      const operation = await db.pool.query<{ status: string; progress_json: Record<string, unknown> }>(
        `SELECT status, progress_json FROM project_operations WHERE id=$1 AND space_id=$2`,
        [operationId, SPACE],
      );
      expect(operation.rows[0]!.status).toBe("active");
      expect(operation.rows[0]!.progress_json).toMatchObject({ origin_room_id: ROOM, origin_session_id: SESSION });
    });

    it("reports assessment_not_passed and does not create an Operation when FINER scores fail the gate", async () => {
      if (!db.available) return;
      __setQuestionRefineInvokerForTests(failingAssessmentInvoker());
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "Tell me everything about everything.",
      });

      const runner = new ResearchAcquisitionPipelineRunner(db.pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
      const result = await runner.run(await makeJob(String(thread.id)));
      expect(result).toMatchObject({ status: "assessment_not_passed", thread_id: String(thread.id) });

      const operations = await db.pool.query(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research'`, [SPACE, PROJECT]);
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
      if (!db.available) return;
      __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "What drives agent reliability?",
      });
      const runner = new ResearchAcquisitionPipelineRunner(db.pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
      const first = await runner.run(await makeJob(String(thread.id)));
      expect(first).toMatchObject({ status: "started" });

      const second = await runner.run(await makeJob(String(thread.id)));
      expect(second).toMatchObject({ status: "started", operation_id: (first as { operation_id: string }).operation_id });

      const operations = await db.pool.query(`SELECT id FROM project_operations WHERE space_id=$1 AND project_id=$2 AND kind='research'`, [SPACE, PROJECT]);
      expect(operations.rows).toHaveLength(1);

      const strategies = await db.pool.query(`SELECT id FROM research_query_strategies WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
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
      if (!db.available) return;
      __setQuestionRefineInvokerForTests(passingAssessmentInvoker());
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "Does checkpoint rejection notify the Room atomically?",
      });
      const runner = new ResearchAcquisitionPipelineRunner(db.pool, config!, { adaptiveQueryDependencies: FAKE_QUERY_DEPENDENCIES });
      const started = await runner.run(await makeJob(String(thread.id)));
      expect(started).toMatchObject({ status: "started" });
      const operationId = (started as { operation_id: string }).operation_id;

      const operationRow = await db.pool.query<{ progress_json: { workflow_id: string } }>(
        `SELECT progress_json FROM project_operations WHERE id=$1 AND space_id=$2`,
        [operationId, SPACE],
      );
      const workflowId = operationRow.rows[0]!.progress_json.workflow_id;
      const checkpointId = randomUUID();
      const now = new Date().toISOString();
      await db.pool.query(
        `INSERT INTO project_research_checkpoints (
           id, space_id, project_id, workflow_id, stage_key, checkpoint_type, status,
           machine_result_json, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'screening','screening_gate','pending',$5::jsonb,$6,$6)`,
        [checkpointId, SPACE, PROJECT, workflowId, JSON.stringify({ operation_id: operationId }), now],
      );

      const orchestrator = new ProjectResearchOrchestrator(db.pool, config!);
      await orchestrator.decideCheckpoint(identity, PROJECT, workflowId, checkpointId, { decision: "rejected" });

      const operationAfter = await db.pool.query<{ status: string }>(
        `SELECT status FROM project_operations WHERE id=$1 AND space_id=$2`,
        [operationId, SPACE],
      );
      expect(operationAfter.rows[0]!.status).toBe("failed");

      const notifyJobs = await db.pool.query<{ payload_json: Record<string, unknown>; status: string }>(
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
});

describe("researchAcquisitionServiceDb", () => {
  // Real-Postgres coverage for the synchronous half of `research.start_acquisition`
  // (room-advancement-reliability-plan Phase 4): Thread validation, the
  // "already starting" idempotency guard, and the enqueued job payload shape.
  // The pipeline itself (assessment -> evaluate -> activate -> startInitialIntake)
  // is covered in researchAcquisitionPipelineDb.test.ts.

  const SPACE = "21111111-1111-4111-8111-111111111111";
  const OWNER = "2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROJECT = "25555555-5555-4555-8555-555555555555";


  const db = useTestDatabase(`${import.meta.filename}#researchAcquisitionServiceDb`);

  beforeEach(async () => {
    if (!db.available) return;
    await resetTables(
      db.pool,
      ["jobs", "project_members", "projects", "space_memberships", "users", "spaces"],
      { cascade: true },
    );
    await seedSpaceOwnerProject(db.pool, { space: SPACE, owner: OWNER, project: PROJECT });
  });

  const identity: SpaceUserIdentity = { spaceId: SPACE, userId: OWNER };

  describe("ResearchAcquisitionService (real Postgres)", () => {
    it("rejects a thread id that is not an active Question Thread", async () => {
      if (!db.available) return;
      await expect(
        new ResearchAcquisitionService(db.pool).startAcquisition(identity, PROJECT, {
          threadId: randomUUID(),
          originRoomId: null,
          originSessionId: null,
        }),
      ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    });

    it("enqueues a research_pipeline_start job carrying the Thread and Room origin", async () => {
      if (!db.available) return;
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "How should agents remember?",
      });
      const result = await new ResearchAcquisitionService(db.pool).startAcquisition(identity, PROJECT, {
        threadId: String(thread.id),
        intentNote: "test kickoff",
        originRoomId: "room-1",
        originSessionId: "session-1",
      });
      expect(result).toEqual({ status: "queued", thread_id: String(thread.id) });

      const jobs = await db.pool.query<{ payload_json: Record<string, unknown>; status: string }>(
        `SELECT payload_json, status FROM jobs WHERE space_id=$1 AND job_type=$2`,
        [SPACE, RESEARCH_PIPELINE_START_JOB],
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]!.status).toBe("pending");
      expect(jobs.rows[0]!.payload_json).toMatchObject({
        thread_id: String(thread.id),
        project_id: PROJECT,
        intent_note: "test kickoff",
        origin_room_id: "room-1",
        origin_session_id: "session-1",
      });
    });

    it("no-ops with already_starting when a pipeline job for the Thread is already pending", async () => {
      if (!db.available) return;
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "What drives agent reliability?",
      });
      const service = new ResearchAcquisitionService(db.pool);
      const first = await service.startAcquisition(identity, PROJECT, {
        threadId: String(thread.id),
        originRoomId: null,
        originSessionId: null,
      });
      expect(first.status).toBe("queued");

      const second = await service.startAcquisition(identity, PROJECT, {
        threadId: String(thread.id),
        originRoomId: null,
        originSessionId: null,
      });
      expect(second).toEqual({ status: "already_starting", thread_id: String(thread.id) });

      const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2`, [SPACE, RESEARCH_PIPELINE_START_JOB]);
      expect(jobs.rows).toHaveLength(1);
    });

    // Regression test for the discovery-review finding: without an advisory
    // lock serializing the "already starting" check against the enqueue, two
    // concurrent calls can both observe no active job and both enqueue one —
    // duplicating real LLM-assessment/live-search pipeline cost. Same idiom as
    // InquiryThreadProposalService's coalesce lock.
    it("serializes concurrent calls for the same Thread so only one job is enqueued", async () => {
      if (!db.available) return;
      const thread = await new InquiryThreadService(db.pool).createThread(identity, PROJECT, {
        kind: "question",
        statement: "Does concurrent start_acquisition enqueue exactly one job?",
      });
      const service = new ResearchAcquisitionService(db.pool);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.startAcquisition(identity, PROJECT, { threadId: String(thread.id), originRoomId: null, originSessionId: null }),
        ),
      );
      expect(results.filter((result) => result.status === "queued")).toHaveLength(1);
      expect(results.filter((result) => result.status === "already_starting")).toHaveLength(4);

      const jobs = await db.pool.query(`SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2`, [SPACE, RESEARCH_PIPELINE_START_JOB]);
      expect(jobs.rows).toHaveLength(1);
    });
  });
});
