import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ResearchContext, ResearchSemanticQuery } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../src/config";
import { ResearchContextRepository } from "../src/modules/projectResearch/question/researchContextRepository";
import { ProjectResearchDiscoveryBridge } from "../src/modules/projectResearch/pipeline/researchDiscoveryBridge";
import { ResearchMonitorMaterializer } from "../src/modules/research/discovery/monitorMaterializer";
import { ResearchStrategyActivationService } from "../src/modules/research/discovery/strategyActivationService";
import { ResearchQueryRepository } from "../src/modules/research/queryPlanning/repository";
import { SourceChannelService } from "../src/modules/sources/channels/sourceChannelService";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const CONNECTOR = "66666666-6666-4666-8666-666666666666";

let database: TestPostgresDatabase | undefined;
let pool: Pool | undefined;
let available = false;

beforeAll(async () => {
  try {
    database = await getTestPostgres(__filename);
    pool = new Pool({ connectionString: database.getConnectionUri(), max: 3 });
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Research','personal',$2,$2)`, [SPACE, now]);
    await pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at) VALUES ($1,'Owner','active',$2,$2)`, [USER, now]);
    await pool.query(
      `INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at)
       VALUES ($1,$2,$3,'owner','active',$4,$4)`,
      [randomUUID(), SPACE, USER, now],
    );
    await pool.query(
      `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
       VALUES ($1,$2,$3,'Project','active',$4,$4)`,
      [PROJECT, SPACE, USER, now],
    );
    await pool.query(
      `INSERT INTO source_connectors (
         id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at
       ) VALUES ($1,'openalex_api','OpenAlex','external_feed','pull','active','{}'::jsonb,$2,$2)`,
      [CONNECTOR, now],
    );
    const providerId = randomUUID();
    await pool.query(
      `INSERT INTO source_providers (
         id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at
       ) VALUES ($1,'openalex','OpenAlex','generic','academic','active','{}'::jsonb,$2,$2)`,
      [providerId, now],
    );
    await pool.query(
      `INSERT INTO source_provider_connectors (
         id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'active',0,'{}'::jsonb,$4,$4)`,
      [randomUUID(), providerId, CONNECTOR, now],
    );
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[research-monitor-materializer-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

describe("research monitor materialization (real Postgres)", () => {
  it("atomically materializes the selected compiled query and is idempotent", async () => {
    if (!available || !pool) return;
    const identity = { spaceId: SPACE, userId: USER };
    const context = await new ResearchContextRepository(pool).create(identity, PROJECT, validContext());
    const queries = new ResearchQueryRepository(pool);
    const strategy = await queries.createStrategy(identity, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["openalex"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 100 },
    });
    await queries.markStrategyEvaluating(SPACE, strategy.id);
    const plan = strategy.provider_plans[0]!;
    const compiled = {
      schema_version: "research_compiled_query.v1" as const,
      provider_key: "openalex" as const,
      query: { search: "agent memory", per_page: 15 },
      fingerprint: "1234567890abcdef1234567890abcdef",
    };
    const attempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiled,
    });
    await queries.completeAttempt(SPACE, attempt.id, {
      observation: {
        schema_version: "research_preview_observation.v1",
        provider_hit_count: 20,
        accessible_hit_count: 20,
        samples: [],
        relevance_rate: 0.8,
        relevance_lower_bound: 0.6,
        diversity_score: 0.7,
        duplicate_rate: 0,
      },
      score: 0.8,
      decision: "accept",
    });
    await queries.selectAttempt(SPACE, plan.id, attempt.id, { terminalDecision: "accept" });
    await queries.finalizeStrategy(SPACE, strategy.id);

    const materializer = new ResearchMonitorMaterializer(pool, {} as ServerConfig);
    const first = await materializer.materialize(identity, strategy.id, { providerKeys: ["openalex"] });
    const second = await materializer.materialize(identity, strategy.id, { providerKeys: ["openalex"] });
    expect(second).toEqual(first);
    expect(first.sources).toHaveLength(1);
    await expect(new SourceChannelService(pool, {} as ServerConfig).update(
      identity,
      first.sources[0]!.source_channel_id,
      { status: "paused" },
    )).resolves.toMatchObject({ status: "paused", provider_query: compiled.query });

    const stored = await pool.query(
      `SELECT ch.query_json,ch.provider_query_json,ch.query_fingerprint AS legacy_query_fingerprint,
              ss.compiled_provider_query_json,ss.query_fingerprint AS spec_query_fingerprint,ss.research_query_attempt_id
         FROM source_channels ch
         JOIN source_search_specs ss ON ss.source_channel_id=ch.id
        WHERE ch.id=$1`,
      [first.sources[0]!.source_channel_id],
    );
    expect(stored.rows[0]).toMatchObject({
      query_json: null,
      provider_query_json: null,
      legacy_query_fingerprint: null,
      compiled_provider_query_json: compiled.query,
      spec_query_fingerprint: compiled.fingerprint,
      research_query_attempt_id: attempt.id,
    });
    const bridge = await new ProjectResearchDiscoveryBridge(pool).resolve(identity, PROJECT, strategy.id);
    expect(bridge).toEqual({
      question: validContext().objective,
      sourceChannelIds: [first.sources[0]!.source_channel_id],
      scope: {
        sub_questions: validContext().sub_questions,
        in: validContext().in_scope,
        out: validContext().out_of_scope,
        must_have: validContext().must_have,
        nice_to_have: validContext().nice_to_have,
      },
    });

    const replacement = await queries.createStrategy(identity, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["openalex"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 100 },
      parentStrategyId: strategy.id,
      adaptationDirection: "broaden",
    });
    await queries.markStrategyEvaluating(SPACE, replacement.id);
    const replacementPlan = replacement.provider_plans[0]!;
    const replacementAttempt = await queries.createAttempt(SPACE, {
      providerPlanId: replacementPlan.id,
      round: 0,
      sequence: 1,
      direction: "broaden",
      semanticQuery: semanticQuery(),
      compiledQuery: { ...compiled, query: { search: "agent memory evaluation", per_page: 15 }, fingerprint: "abcdef1234567890abcdef1234567890" },
    });
    await queries.completeAttempt(SPACE, replacementAttempt.id, { observation: {
      schema_version: "research_preview_observation.v1", provider_hit_count: 30, accessible_hit_count: 30,
      samples: [], relevance_rate: 0.7, relevance_lower_bound: 0.5, diversity_score: 0.7, duplicate_rate: 0,
    }, score: 0.75, decision: "accept" });
    await queries.selectAttempt(SPACE, replacementPlan.id, replacementAttempt.id, { terminalDecision: "accept" });
    await queries.finalizeStrategy(SPACE, replacement.id);
    const liveOperationId = randomUUID();
    await pool.query(
      `INSERT INTO project_operations (
         id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,created_at,updated_at
       ) VALUES ($1,$2,$3,'research','Active intake','active',$4,$5::jsonb,$6,$6)`,
      [liveOperationId, SPACE, PROJECT, USER, JSON.stringify({
        workflow_id: randomUUID(),
        channel_ids: [first.sources[0]!.source_channel_id],
        query: { source_channel_ids: [first.sources[0]!.source_channel_id] },
      }), new Date().toISOString()],
    );
    await expect(materializer.materialize(identity, replacement.id, {
      providerKeys: ["openalex"], activationReason: "monitoring_feedback",
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "Wait for the active research operation to finish before activating a replacement query strategy",
    });

    await pool.query(`UPDATE project_operations SET status='completed',updated_at=$2 WHERE id=$1`, [liveOperationId, new Date().toISOString()]);
    const replacementMaterialized = await materializer.materialize(identity, replacement.id, {
      providerKeys: ["openalex"], activationReason: "monitoring_feedback",
    });
    const switched = await pool.query<{ id: string; status: string; scheduler_status: string }>(
      `SELECT ch.id,ch.status,st.status AS scheduler_status
         FROM source_channels ch
         JOIN scheduler_tasks st ON st.space_id=ch.space_id AND st.task_type='source_channel_scan' AND st.task_key=ch.id
        WHERE ch.id=ANY($1::text[]) ORDER BY ch.id`,
      [[first.sources[0]!.source_channel_id, replacementMaterialized.sources[0]!.source_channel_id]],
    );
    expect(switched.rows.find((row) => row.id === first.sources[0]!.source_channel_id)?.status).toBe("archived");
    expect(switched.rows.find((row) => row.id === first.sources[0]!.source_channel_id)?.scheduler_status).toBe("archived");
    expect(switched.rows.find((row) => row.id === replacementMaterialized.sources[0]!.source_channel_id)?.status).toBe("active");

    await new ResearchStrategyActivationService(pool).activate({ identity, strategyId: strategy.id, reason: "rollback" });
    const history = await pool.query<{ strategy_id: string; reason: string; deactivated_at: string | null }>(
      `SELECT strategy_id,reason,deactivated_at FROM research_query_strategy_activations
        WHERE space_id=$1 AND project_id=$2 ORDER BY sequence`,
      [SPACE, PROJECT],
    );
    expect(history.rows).toHaveLength(3);
    expect(history.rows.at(-1)).toMatchObject({ strategy_id: strategy.id, reason: "rollback", deactivated_at: null });
    const rolledBack = await pool.query<{ channel_status: string; scheduler_status: string }>(
      `SELECT ch.status AS channel_status,st.status AS scheduler_status
         FROM source_channels ch
         JOIN scheduler_tasks st ON st.space_id=ch.space_id AND st.task_type='source_channel_scan' AND st.task_key=ch.id
        WHERE ch.id=$1`,
      [first.sources[0]!.source_channel_id],
    );
    expect(rolledBack.rows[0]).toEqual({ channel_status: "active", scheduler_status: "active" });
  });
});

function validContext(): ResearchContext {
  return {
    schema_version: "research_context.v1",
    objective: "How should durable agent memory be evaluated?",
    sub_questions: ["Which benchmarks measure recall?"],
    in_scope: ["LLM agent memory"],
    out_of_scope: ["Human memory"],
    must_have: [],
    nice_to_have: [],
    time_window: null,
    source_scope: { providers: ["openalex"], include_web: false },
  };
}

function semanticQuery(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [{ value: "agent memory", synonyms: [], weight: 1 }],
    expansions: [],
    qualifiers: [],
    exclusions: [],
    time_window: null,
  };
}
