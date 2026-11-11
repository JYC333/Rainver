import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildModuleServer } from "./support/moduleServer.js";
import { researchModule } from "../src/modules/research/index.js";
import { projectResearchModule } from "../src/modules/projectResearch/index.js";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity.js";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins.js";
import { __setQuestionRefineInvokerForTests } from "../src/modules/projectResearch/questionRefineService.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { useTestDatabase } from "./support/testDatabase.js";
import { JobHandlerRegistry, type JobEnvelopeForHandler } from "../src/modules/jobs/handlerRegistry.js";
import { registerProjectResearchHandler } from "../src/modules/projectResearch/orchestrator.js";
import { QUESTION_REFINE_JOB_TYPE, settleAbandonedQuestionRefineTurns } from "../src/modules/projectResearch/questionRefineService.js";
import { PgJobQueueRepository } from "../src/modules/jobs/repository.js";
import { seedMainlineRoomsForAllProjects } from "./support/domainSeeds.js";

const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "99999999-9999-4999-8999-999999999999";
let THREAD = "";
const refinementOutput = {
  reply: "The topic is too broad; choose a runtime and measurable outcome.",
  recommended_question: "How do tool-using coding agents recover from failed API calls?",
  assessment: {
    answerable: false,
    finer: { feasible: 1, interesting: 3, novel: 1, ethical: 3, relevant: 1 },
    issues: ["The query is not a question."],
  },
  suggested_questions: [
    "How do tool-using coding agents recover from failed API calls?",
    "Which retry strategies improve completion rates for tool-using agents?",
    "How does tool failure observability affect agent recovery time?",
  ],
  sub_questions: ["Which failure classes are in scope?"],
  scope: { in: ["tool-using coding agents"], out: ["general intelligence"] },
  clarifying_questions: [{ question: "Which runtime should be studied?", options: ["Sandboxed CLI", "Managed API"], allow_multiple: false }],
};
// Typed to the shape the runtime actually invokes it with, so assertions on the
// recorded call arguments type-check instead of indexing an empty tuple. The
// return type is widened with the optional repair fields the failure-path tests
// mock, rather than left inferred from one happy-path literal.
type RefinementInvocation = { system?: string; messages: { role: string; content: string }[] };
type RefinementResult = Partial<typeof refinementOutput> & {
  reply: string;
  repairs?: { source_index: number; replacements: string[] }[];
};
const invoke = vi.fn(async (_request: RefinementInvocation): Promise<RefinementResult> => refinementOutput);

let app: FastifyInstance | undefined;
let config: ReturnType<typeof loadConfig>;
/**
 * Admits one refinement turn through the formal URL (no model call), performs
 * its Job through the registered handler, then reads the durable session —
 * the outcome the browser observes.
 */
async function refine(options: { payload: Record<string, unknown> }) {
  const admitted = await app!.inject({ method: "POST", url: `/api/v1/projects/${PROJECT}/research/question/refine`, headers: { "idempotency-key": randomUUID() }, payload: options.payload });
  expect(admitted.statusCode, admitted.body).toBe(202);
  const receipt = admitted.json().data;
  expect(admitted.body).not.toContain(String(options.payload.message));
  const registry = new JobHandlerRegistry();
  registerProjectResearchHandler(registry, config);
  const calls = invoke.mock.calls.length;
  let failure: (Error & { code?: string }) | null = null;
  await registry.get(QUESTION_REFINE_JOB_TYPE)!(await claimRefineJob(receipt))
    .catch((error: Error & { code?: string }) => { failure = error; });
  expect(invoke.mock.calls.length).toBeGreaterThan(calls);
  const session = (await app!.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/research/question/assessment?thread_id=${THREAD}` })).json();
  return { failure: failure as (Error & { code?: string }) | null, result: failure ? null : { ...session.latest_refinement, assessment_session: session } };
}

const db = useTestDatabase(import.meta.filename);

/**
 * Claims and starts this one admitted Job as a worker does (status, claim,
 * attempt), and returns the envelope the worker hands its handler. The
 * shared file leaves other turns' Jobs pending, so the claim is targeted.
 */
async function claimRefineJob(receipt: { id: string; job_id: string }): Promise<JobEnvelopeForHandler> {
  const workerId = `question-refine-test-${randomUUID()}`;
  const claimed = await db.pool.query<{ attempts: number }>(
    `UPDATE jobs SET status='claimed',claimed_by=$2,claimed_at=now(),heartbeat_at=NULL,attempts=attempts+1,updated_at=now()
      WHERE id=$1 AND status='pending' AND attempts<max_attempts RETURNING attempts`,
    [receipt.job_id, workerId],
  );
  const last = (await db.pool.query<{ claimed_by: string | null; attempts: number }>("SELECT claimed_by,attempts FROM jobs WHERE id=$1", [receipt.job_id])).rows[0]!;
  if (claimed.rows.length) expect(await new PgJobQueueRepository(db.pool).startJob(receipt.job_id, workerId)).toBe(true);
  return {
    job_id: receipt.job_id, space_id: SPACE, user_id: OWNER, job_type: QUESTION_REFINE_JOB_TYPE,
    payload: { message_id: receipt.id, project_id: PROJECT }, attempts: last.attempts, max_attempts: 1,
    worker_id: claimed.rows.length ? workerId : last.claimed_by ?? workerId,
  };
}

// Files share a worker: an identity or invoker left in a module-level
// seam would leak into whichever file runs next.
afterAll(() => {
  __setAuthIdentityForTests(null);
  __setQuestionRefineInvokerForTests(null);
});

beforeAll(async () => {
  if (!db.available) return;
  const now = new Date().toISOString();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at, email, registration_source) VALUES ($1,'Owner','active',$2,$2, lower(gen_random_uuid()::text || '@test.invalid'), 'system')`, [OWNER, now]);
  await db.pool.query(
    `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
    [randomUUID(), SPACE, OWNER, now],
  );
  await db.pool.query(
    `INSERT INTO projects (id,space_id,owner_user_id,name,description,status,created_at,updated_at) VALUES ($1,$2,$3,'Research','A project about reliable tool use.','active',$4,$4)`,
    [PROJECT, SPACE, OWNER, now],
  );
  await seedMainlineRoomsForAllProjects(db.pool);
  const thread = await new InquiryThreadService(db.pool).createThread(
    { spaceId: SPACE, userId: OWNER }, PROJECT, { kind: "question", statement: "agent" },
  );
  THREAD = String(thread.id);
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
  await syncBuiltinPrompts(db.pool, CATALOG_ROOT);
  __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
  __setQuestionRefineInvokerForTests(invoke);
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri,
    SERVER_INTERNAL_TOKEN: "test-internal-token",
    RAINVER_HOME: "/tmp/rainver-question-refine-test",
  });
  app = buildModuleServer(config, [projectResearchModule, researchModule]);
});

describe("POST /projects/:id/research/question/refine (real Postgres)", () => {
  it("answers a submitted framework outside the limits as the person's error, not the model's", async () => {
    if (!db.available || !app) return;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirm`,
      headers:{"idempotency-key":randomUUID()},
      payload: {
        thread_id: THREAD,
        refinement: { ...refinementOutput, sub_questions: ["x".repeat(250)] },
        manually_adjusted: true,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({error:{code:"operation_invalid_input"}});
  });

  it("returns an actionable structured assessment for an unanswerable query", async () => {
    if (!db.available || !app) return;
    const response = await refine({
      payload: {
        thread_id: THREAD,
        research_question: "agent",
        message: "Assess this question and help me make it researchable.",
        execution: { model_provider_id: PROVIDER },
      },
    });

    expect(response.failure).toBeNull();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringMatching(/^You facilitate an ongoing research-question assessment conversation/),
      messages: [
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining('"candidate_research_question":"agent"'),
        }),
      ],
    }));
    expect(invoke.mock.calls[0]![0].system).not.toContain("Conversation so far");
    expect(invoke.mock.calls[0]![0].system).not.toContain("Project: Research");
    expect(response.result!).toMatchObject({
      research_context_version_id: expect.any(String),
      reply: expect.stringContaining("too broad"),
      recommended_question: expect.stringContaining("tool-using coding agents"),
      assessment: { answerable: false },
      assessment_session: {
        thread_id: THREAD,
        assessment_baseline: expect.objectContaining({
          recommended_question: expect.stringContaining("tool-using coding agents"),
        }),
        messages: [
          expect.objectContaining({ turn_index: 1, role: "user", status: "complete" }),
          expect.objectContaining({ turn_index: 1, role: "assistant", status: "complete" }),
        ],
      },
      suggested_questions: expect.arrayContaining([expect.stringContaining("tool-using coding agents")]),
      clarifying_questions: [{ question: "Which runtime should be studied?", options: ["Sandboxed CLI", "Managed API"], allow_multiple: false }],
    });
    // ADR 0022 §2/§3: question refinement is an incidental bounded call. It
    // selects a provider and nothing else. Do not manufacture a managed
    // Research Agent and a Runtime Profile just to hand an `agentId` to the
    // prompt resolver.
    const managedAgent = await db.pool.query(`SELECT id FROM agents WHERE space_id=$1 AND agent_kind='system_research'`, [SPACE]);
    expect(managedAgent.rows).toHaveLength(0);
    const profiles = await db.pool.query(`SELECT id FROM agent_runtime_profiles WHERE space_id=$1`, [SPACE]);
    expect(profiles.rows).toHaveLength(0);
    const contexts = await db.pool.query(`SELECT objective,context_json,assessment_json FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    expect(contexts.rows).toHaveLength(1);
    expect(contexts.rows[0]).toMatchObject({
      objective: "How do tool-using coding agents recover from failed API calls?",
      assessment_json: { answerable: false },
    });
    expect(contexts.rows[0].context_json).toMatchObject({ in_scope: ["tool-using coding agents"] });

    const restored = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment?thread_id=${THREAD}`,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      thread_id: THREAD,
      recommended_question: "How do tool-using coding agents recover from failed API calls?",
      messages: [
        expect.objectContaining({ role: "user", content: "Assess this question and help me make it researchable." }),
        expect.objectContaining({ role: "assistant", content: expect.stringContaining("too broad") }),
      ],
    });
    const persisted = await db.pool.query(
      `SELECT role,status,turn_index FROM project_research_question_assessment_messages
        WHERE space_id=$1 ORDER BY turn_index,role`,
      [SPACE],
    );
    expect(persisted.rows).toEqual([
      { role: "assistant", status: "complete", turn_index: 1 },
      { role: "user", status: "complete", turn_index: 1 },
    ]);

    const followUpOutput = {
      ...refinementOutput,
      reply: "Managed API runtimes are now in scope.",
      sub_questions: [
        "Which failure classes are in scope?",
        `How do ${"long-horizon memory mechanisms ".repeat(8)}affect recovery after failed tool calls?`,
        "Which recovery outcomes should be compared?",
      ],
      scope: { in: ["tool-using coding agents", "Managed API runtimes"], out: ["general intelligence"] },
    };
    const repairedItems = [
      "Which long-horizon memory mechanisms are evaluated?",
      "How do those mechanisms affect recovery after failed tool calls?",
    ];
    const repairedSubQuestions = [
      followUpOutput.sub_questions[0]!,
      ...repairedItems,
      followUpOutput.sub_questions[2]!,
    ];
    const repairedReply = "I split 1 overlong item into 2 concise sub-questions; the final list contains 4 items.";
    expect(followUpOutput.sub_questions[1]!.length).toBeGreaterThan(200);
    invoke
      .mockResolvedValueOnce(followUpOutput)
      .mockResolvedValueOnce({
        reply: repairedReply,
        repairs: [{ source_index: 1, replacements: repairedItems }],
      });
    const followUp = await refine({
      payload: {
        thread_id: THREAD,
        research_question: "How do tool-using coding agents recover from failed API calls?",
        message: "Focus on Managed API runtimes.",
        execution: { model_provider_id: PROVIDER },
      },
    });
    expect(followUp.failure).toBeNull();
    expect(invoke.mock.calls[1]![0].messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(invoke.mock.calls[1]![0].messages[1]?.content).toContain('"assessment"');
    expect(invoke.mock.calls[1]![0].messages[2]?.content).toContain("Focus on Managed API runtimes.");
    expect(followUp.result!).toMatchObject({
      reply: repairedReply,
      sub_questions: repairedSubQuestions,
      scope: followUpOutput.scope,
      assessment_session: {
        latest_refinement: { scope: followUpOutput.scope },
        assessment_baseline: { scope: refinementOutput.scope },
      },
    });
    const repairedTurn = followUp.result!.assessment_session.messages.find(
      (message: { turn_index: number; role: string }) => message.turn_index === 2 && message.role === "user",
    );
    expect(repairedTurn.processing_events).toMatchObject([
      { stage: "subquestion_repair", status: "detected", message: expect.stringContaining("200-character limit") },
      { stage: "subquestion_repair", status: "running", message: expect.stringContaining("separate structured request") },
      { stage: "subquestion_repair", status: "completed", message: expect.stringContaining("replaced by 2 concise sub-questions; the final list contains 4") },
    ]);
    const repairRequest = JSON.parse(invoke.mock.calls[2]![0].messages[0]!.content);
    expect(repairRequest).toMatchObject({
      latest_user_message: "Focus on Managed API runtimes.",
      original_reply: followUpOutput.reply,
      overlong_items: [{ source_index: 1, text: followUpOutput.sub_questions[1] }],
      unchanged_item_count: 2,
      max_replacement_items: 8,
    });
    expect(repairRequest).not.toHaveProperty("sub_questions");
    expect(invoke.mock.calls[2]![0].messages[0]!.content).not.toContain(followUpOutput.sub_questions[0]!);
    expect(invoke.mock.calls[2]![0].messages[0]!.content).not.toContain(followUpOutput.sub_questions[2]!);
    expect(invoke.mock.calls[2]![0]).toMatchObject({
      system: expect.stringMatching(/^You locally repair research sub-questions/),
      messages: [{ role: "user", content: expect.any(String) }],
      task: "project_research_question_subquestion_repair",
      outputFormat: expect.objectContaining({
        schema_id: "project_research.question_subquestion_repair.v1",
      }),
    });

    const repairedFollowUpOutput = { ...followUpOutput, sub_questions: repairedSubQuestions };
    invoke.mockResolvedValueOnce(repairedFollowUpOutput);
    const reassessment = await refine({
      payload: {
        thread_id: THREAD,
        research_question: followUpOutput.recommended_question,
        message: "Reassess the current changed framework.",
        establish_assessment_baseline: true,
        execution: { model_provider_id: PROVIDER },
      },
    });
    expect(reassessment.failure).toBeNull();
    expect(reassessment.result!).toMatchObject({
      assessment_session: {
        latest_refinement: { scope: followUpOutput.scope },
        assessment_baseline: { scope: followUpOutput.scope },
      },
    });

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirm`,
      headers:{"idempotency-key":randomUUID()},
      payload: {
        thread_id: THREAD,
        refinement: {
          ...refinementOutput,
          scope: { in: ["tool-using coding agents", "Managed API runtimes"], out: [] },
        },
        manually_adjusted: true,
      },
    });
    expect(confirmation.statusCode).toBe(201);
    expect(confirmation.json()).toMatchObject({status:'succeeded',data:{id:expect.any(String),thread_id:THREAD,project_id:PROJECT,space_id:SPACE}});
    expect(confirmation.body).not.toContain(refinementOutput.recommended_question);
    const confirmedId = confirmation.json().data.id;
    const currentAssessment=await app.inject({method:'GET',url:`/api/v1/projects/${PROJECT}/research/question/assessment?thread_id=${THREAD}`});
    expect(currentAssessment.json()).toMatchObject({latest_refinement:{research_context_version_id:confirmedId,scope:{in:['tool-using coding agents','Managed API runtimes'],out:[]}}});

    const repeatedConfirmation = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirm`,
      headers:{"idempotency-key":randomUUID()},
      payload: {
        thread_id: THREAD,
        refinement: {
          ...refinementOutput,
          scope: { in: ["tool-using coding agents", "Managed API runtimes"], out: [] },
        },
        manually_adjusted: true,
      },
    });
    expect(repeatedConfirmation.statusCode).toBe(201);
    expect(repeatedConfirmation.json()).toMatchObject({status:'succeeded',data:{id:confirmedId}});

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirmations?thread_id=${THREAD}`,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([
      expect.objectContaining({
        question: refinementOutput.recommended_question,
        scope: { in: ["tool-using coding agents", "Managed API runtimes"], out: [] },
        manually_adjusted: true,
      }),
    ]);
    const confirmedContext = await db.pool.query(
      `SELECT provenance_json FROM project_research_context_versions
        WHERE space_id=$1 AND project_id=$2
          AND provenance_json->>'source'='question_assessment_confirmation'`,
      [SPACE, PROJECT],
    );
    expect(confirmedContext.rows).toEqual([
      expect.objectContaining({
        provenance_json: expect.objectContaining({ thread_id: THREAD, manually_adjusted: true }),
      }),
    ]);

    const contextsBeforeInvalidOutput = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_research_context_versions
        WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    invoke
      .mockResolvedValueOnce({
        ...refinementOutput,
        sub_questions: ["x".repeat(2_001)],
      })
      .mockResolvedValueOnce({
        reply: "I split the overlong item.",
        repairs: [{ source_index: 0, replacements: ["x".repeat(2_001)] }],
      });
    const invalidOutput = await refine({
      payload: {
        thread_id: THREAD,
        research_question: refinementOutput.recommended_question,
        message: "Return an excessively long sub-question.",
        execution: { model_provider_id: PROVIDER },
      },
    });
    // The worker raises the same domain failure; the person sees it on the failed turn.
    expect(invalidOutput.failure).toMatchObject({
      statusCode: 502,
      responseBody: { code: "question_refinement_repair_failed", message: "The model could not split the overlong sub-questions into supported lengths." },
    });
    const failedConversation = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment?thread_id=${THREAD}`,
    });
    const failedTurn = [...failedConversation.json().messages].reverse().find(
      (message: { role: string }) => message.role === "user",
    );
    expect(failedTurn).toMatchObject({
      status: "failed",
      processing_events: expect.arrayContaining([
        expect.objectContaining({ stage: "subquestion_repair", status: "failed", message: expect.stringContaining("not saved") }),
      ]),
    });
    const contextsAfterInvalidOutput = await db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_research_context_versions
        WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(contextsAfterInvalidOutput.rows[0]?.count).toBe(contextsBeforeInvalidOutput.rows[0]?.count);
  });

  // Admission alone: the turn is pending and its single-attempt Job is queued.
  async function admit(message: string) {
    const admitted = await app!.inject({ method: "POST", url: `/api/v1/projects/${PROJECT}/research/question/refine`, headers: { "idempotency-key": randomUUID() },
      payload: { thread_id: THREAD, research_question: "agent", message, execution: { model_provider_id: PROVIDER } } });
    expect(admitted.statusCode, admitted.body).toBe(202);
    return admitted.json().data as { id: string; job_id: string };
  }
  // Delivers the Job to its handler as the worker would; a Job no longer
  // claimable is delivered under its last recorded claim, as a late or
  // replayed delivery would be.
  const perform = async (receipt: { id: string; job_id: string }) => {
    const registry = new JobHandlerRegistry();
    registerProjectResearchHandler(registry, config);
    return registry.get(QUESTION_REFINE_JOB_TYPE)!(await claimRefineJob(receipt));
  };
  const session = async () => (await app!.inject({ method: "GET", url: `/api/v1/projects/${PROJECT}/research/question/assessment?thread_id=${THREAD}` })).json();
  const turnStatus = async (id: string) => (await session()).messages.find((message: { id: string }) => message.id === id)?.status;

  it("fails a turn whose Job was cancelled before it ran, once, without calling the provider", async () => {
    if (!db.available || !app) return;
    const calls = invoke.mock.calls.length;
    const receipt = await admit("Cancelled before a worker claimed it.");
    expect(await new PgJobQueueRepository(db.pool).cancelJob(receipt.job_id, null, new Date(), ["pending", "claimed"])).toBe(true);
    expect(await turnStatus(receipt.id)).toBe("pending");
    expect(await settleAbandonedQuestionRefineTurns(db.pool)).toBe(1);
    expect(await turnStatus(receipt.id)).toBe("failed");
    expect(await settleAbandonedQuestionRefineTurns(db.pool)).toBe(0);
    // A replayed delivery of the cancelled Job finds no pending turn and spends nothing.
    await expect(perform(receipt)).resolves.toEqual({ status: "skipped" });
    expect(invoke.mock.calls.length).toBe(calls);
  });

  it("fails a turn whose worker process died mid-run when reclaim exhausts its single attempt, without re-consuming the provider", async () => {
    if (!db.available || !app) return;
    const calls = invoke.mock.calls.length;
    const receipt = await admit("The worker process exits while assessing this.");
    // The claimed attempt is spent and its heartbeat went stale with the process.
    await db.pool.query(
      `UPDATE jobs SET status='running',attempts=1,claimed_by='dead-worker',claimed_at=now()-interval '1 hour',
              started_at=now()-interval '1 hour',heartbeat_at=now()-interval '1 hour' WHERE id=$1`,
      [receipt.job_id],
    );
    const queue = new PgJobQueueRepository(db.pool);
    await queue.reclaimStuckJobs(60);
    expect((await db.pool.query("SELECT status FROM jobs WHERE id=$1", [receipt.job_id])).rows[0].status).toBe("failed");
    // A turn with a live Job is never touched by the sweep.
    const live = await admit("Still queued.");
    await settleAbandonedQuestionRefineTurns(db.pool);
    expect(await turnStatus(receipt.id)).toBe("failed");
    expect(await turnStatus(live.id)).toBe("pending");
    expect(invoke.mock.calls.length).toBe(calls);
    // Nothing re-queued the dead turn; a late completion from the dead process cannot answer it.
    expect((await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload_json->>'message_id'=$1 AND status IN ('pending','claimed','running')", [receipt.id])).rows[0].n).toBe(0);
    await expect(perform(receipt)).resolves.toEqual({ status: "skipped" });
    await perform(live);
  });

  it("keeps each concurrent turn's own answer and never lets an earlier turn finishing late replace the newer projection", async () => {
    if (!db.available || !app) return;
    const earlier = await admit("Earlier turn.");
    const later = await admit("Later turn.");
    invoke.mockImplementationOnce(async () => ({ ...refinementOutput, recommended_question: "Which recovery strategies do later agents use?" }));
    await perform(later);
    invoke.mockImplementationOnce(async () => ({ ...refinementOutput, recommended_question: "Which recovery strategies did earlier agents use?" }));
    await perform(earlier);
    const current = await session();
    expect(current.latest_refinement.recommended_question).toBe("Which recovery strategies do later agents use?");
    expect(current.recommended_question).toBe("Which recovery strategies do later agents use?");
    const answerFor = (id: string) => {
      const turn = current.messages.find((message: { id: string }) => message.id === id);
      return current.messages.find((message: { role: string; turn_index: number }) => message.role === "assistant" && message.turn_index === turn.turn_index)?.refinement;
    };
    expect(answerFor(earlier.id)?.recommended_question).toBe("Which recovery strategies did earlier agents use?");
    expect(answerFor(later.id)?.recommended_question).toBe("Which recovery strategies do later agents use?");
  });
  // The provider call is held open while the Job loses its execution, then
  // released before any recovery sweep runs: the late call must not answer.
  it.each([
    ["reclaimed as failed after its heartbeat went stale", async (jobId: string): Promise<string> => {
      await db.pool.query("UPDATE jobs SET heartbeat_at=now()-interval '1 hour',updated_at=now()-interval '1 hour' WHERE id=$1", [jobId]);
      await new PgJobQueueRepository(db.pool).reclaimStuckJobs(60);
      return "failed";
    }],
    ["cancelled by the person", async (jobId: string): Promise<string> => {
      expect(await new PgJobQueueRepository(db.pool).cancelJob(jobId, null, new Date(), ["running"])).toBe(true);
      return "cancelled";
    }],
  ] as const)("refuses the answer of a provider call that returns after its Job was %s", async (_label, endJob) => {
    if (!db.available || !app) return;
    const before = await session();
    const contexts = async () => (await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2", [SPACE, PROJECT])).rows[0]!.n;
    const contextsBefore = await contexts();
    const receipt = await admit("Assess this while the worker loses its claim.");
    let entered!: () => void, release!: () => void;
    const inProvider = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    invoke.mockImplementationOnce(async () => {
      entered();
      await released;
      return { ...refinementOutput, recommended_question: "A late answer that must not land?" };
    });
    const calls = invoke.mock.calls.length;
    const running = perform(receipt).then(() => null, (error: { statusCode?: number }) => error);
    await inProvider;
    expect(await endJob(receipt.job_id)).toBe((await db.pool.query("SELECT status FROM jobs WHERE id=$1", [receipt.job_id])).rows[0].status);
    release();
    expect(await running).toMatchObject({ statusCode: 409 });
    expect(invoke.mock.calls.length).toBe(calls + 1);
    const after = await session();
    expect(after.messages.find((message: { id: string }) => message.id === receipt.id)?.status).toBe("failed");
    const turnIndex = after.messages.find((message: { id: string }) => message.id === receipt.id)?.turn_index;
    expect(after.messages.some((message: { role: string; turn_index: number }) => message.role === "assistant" && message.turn_index === turnIndex)).toBe(false);
    expect(after.recommended_question).toBe(before.recommended_question);
    expect(after.latest_refinement).toEqual(before.latest_refinement);
    expect(await contexts()).toBe(contextsBefore);
    // The later sweep finds nothing left to settle and nothing re-queued the turn.
    expect(await settleAbandonedQuestionRefineTurns(db.pool)).toBe(0);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE payload_json->>'message_id'=$1 AND status IN ('pending','claimed','running')", [receipt.id])).rows[0].n).toBe(0);
    expect(invoke.mock.calls.length).toBe(calls + 1);
  });
});
