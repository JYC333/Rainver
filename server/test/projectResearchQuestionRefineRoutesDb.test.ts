import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "../src/config";
import { migrate } from "../src/db/migrator";
import { buildServer } from "../src/server";
import { __setAuthIdentityForTests } from "../src/modules/auth/identity";
import { syncBuiltinPrompts } from "../src/modules/prompts/builtins";
import { __setQuestionRefineInvokerForTests } from "../src/modules/projectResearch/questionRefineService";
import { InquiryThreadService } from "../src/modules/inquiry/threadService";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
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

let container: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let app: FastifyInstance | undefined;
let available = false;

beforeAll(async () => {
  try {
    container = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 3 });
    await migrate(pool, MIGRATIONS_DIR);
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Main','personal',$2,$2)`, [SPACE, now]);
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [OWNER, now]);
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, OWNER, now],
    );
    await pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,description,status,created_at,updated_at) VALUES ($1,$2,$3,'Research','A project about reliable tool use.','active',$4,$4)`,
      [PROJECT, SPACE, OWNER, now],
    );
    const thread = await new InquiryThreadService(pool).createThread(
      { spaceId: SPACE, userId: OWNER }, PROJECT, { kind: "question", statement: "agent" },
    );
    THREAD = String(thread.id);
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
    await syncBuiltinPrompts(pool, CATALOG_ROOT);
    __setAuthIdentityForTests({ spaceId: SPACE, userId: OWNER });
    __setQuestionRefineInvokerForTests(invoke);
    app = buildServer(loadConfig({
      SERVER_DATABASE_URL: container.getConnectionUri(),
      SERVER_INTERNAL_TOKEN: "test-internal-token",
      AGENT_SPACE_HOME: "/tmp/agent-space-question-refine-test",
    }), { logger: false });
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[project-research-question-refine-routes-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  __setQuestionRefineInvokerForTests(null);
  __setAuthIdentityForTests(null);
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("POST /projects/:id/research/question/refine (real Postgres)", () => {
  it("returns an actionable structured assessment for an unanswerable query", async () => {
    if (!available || !app) return;
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/refine`,
      payload: {
        thread_id: THREAD,
        research_question: "agent",
        message: "Assess this question and help me make it researchable.",
        execution: { model_provider_id: PROVIDER },
      },
    });

    expect(response.statusCode).toBe(200);
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
    expect(response.json()).toMatchObject({
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
    const managedAgent = await pool!.query(`SELECT id FROM agents WHERE space_id=$1 AND agent_kind='system_research'`, [SPACE]);
    expect(managedAgent.rows).toHaveLength(1);
    const contexts = await pool!.query(`SELECT objective,context_json,assessment_json FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
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
    const persisted = await pool!.query(
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
    const followUp = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/refine`,
      payload: {
        thread_id: THREAD,
        research_question: "How do tool-using coding agents recover from failed API calls?",
        message: "Focus on Managed API runtimes.",
        execution: { model_provider_id: PROVIDER },
      },
    });
    expect(followUp.statusCode).toBe(200);
    expect(invoke.mock.calls[1]![0].messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
    expect(invoke.mock.calls[1]![0].messages[1]?.content).toContain('"assessment"');
    expect(invoke.mock.calls[1]![0].messages[2]?.content).toContain("Focus on Managed API runtimes.");
    expect(followUp.json()).toMatchObject({
      reply: repairedReply,
      sub_questions: repairedSubQuestions,
      scope: followUpOutput.scope,
      assessment_session: {
        latest_refinement: { scope: followUpOutput.scope },
        assessment_baseline: { scope: refinementOutput.scope },
      },
    });
    const repairedTurn = followUp.json().assessment_session.messages.find(
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
    const reassessment = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/refine`,
      payload: {
        thread_id: THREAD,
        research_question: followUpOutput.recommended_question,
        message: "Reassess the current changed framework.",
        establish_assessment_baseline: true,
        execution: { model_provider_id: PROVIDER },
      },
    });
    expect(reassessment.statusCode).toBe(200);
    expect(reassessment.json()).toMatchObject({
      assessment_session: {
        latest_refinement: { scope: followUpOutput.scope },
        assessment_baseline: { scope: followUpOutput.scope },
      },
    });

    const confirmation = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirm`,
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
    expect(confirmation.json()).toMatchObject({
      research_context_version_id: expect.any(String),
      scope: { in: ["tool-using coding agents", "Managed API runtimes"], out: [] },
      confirmation: {
        question: refinementOutput.recommended_question,
        manually_adjusted: true,
      },
    });
    const confirmedId = confirmation.json().confirmation.id;

    const repeatedConfirmation = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/assessment/confirm`,
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
    expect(repeatedConfirmation.json()).toMatchObject({
      research_context_version_id: confirmedId,
      confirmation: { id: confirmedId },
    });

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
    const confirmedContext = await pool!.query(
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

    const contextsBeforeInvalidOutput = await pool!.query<{ count: string }>(
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
    const invalidOutput = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${PROJECT}/research/question/refine`,
      payload: {
        thread_id: THREAD,
        research_question: refinementOutput.recommended_question,
        message: "Return an excessively long sub-question.",
        execution: { model_provider_id: PROVIDER },
      },
    });
    expect(invalidOutput.statusCode).toBe(502);
    expect(invalidOutput.json()).toMatchObject({
      code: "question_refinement_repair_failed",
      message: "The model could not split the overlong sub-questions into supported lengths.",
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
    const contextsAfterInvalidOutput = await pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_research_context_versions
        WHERE space_id=$1 AND project_id=$2`,
      [SPACE, PROJECT],
    );
    expect(contextsAfterInvalidOutput.rows[0]?.count).toBe(contextsBeforeInvalidOutput.rows[0]?.count);
  });
});
