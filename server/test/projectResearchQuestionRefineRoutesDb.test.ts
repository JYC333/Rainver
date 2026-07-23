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
import { getTestPostgres, type TestPostgresDatabase } from "./support/sharedPostgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const CATALOG_ROOT = resolve(process.cwd(), "..", "catalog");
const SPACE = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "99999999-9999-4999-8999-999999999999";

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
    const invoke = vi.fn(async () => ({
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
    }));
    __setQuestionRefineInvokerForTests(invoke);
    app = buildServer(loadConfig({
      SERVER_DATABASE_URL: container.getConnectionUri(),
      SERVER_INTERNAL_TOKEN: "test-internal-token",
      AGENT_SPACE_HOME: "/tmp/agent-space-question-refine-test",
    }), { logger: false });
    available = true;
  } catch (error) {
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
        research_question: "agent",
        history: [],
        execution: { model_provider_id: PROVIDER },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      research_context_version_id: expect.any(String),
      assessment: { answerable: false },
      suggested_questions: expect.arrayContaining([expect.stringContaining("tool-using coding agents")]),
      clarifying_questions: [{ question: "Which runtime should be studied?", options: ["Sandboxed CLI", "Managed API"], allow_multiple: false }],
    });
    const managedAgent = await pool!.query(`SELECT id FROM agents WHERE space_id=$1 AND agent_kind='system_research'`, [SPACE]);
    expect(managedAgent.rows).toHaveLength(1);
    const contexts = await pool!.query(`SELECT objective,context_json,assessment_json FROM project_research_context_versions WHERE space_id=$1 AND project_id=$2`, [SPACE, PROJECT]);
    expect(contexts.rows).toHaveLength(1);
    expect(contexts.rows[0]).toMatchObject({ objective: "agent", assessment_json: { answerable: false } });
    expect(contexts.rows[0].context_json).toMatchObject({ in_scope: ["tool-using coding agents"] });
  });
});
