import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ResearchContext } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { ResearchContextRepository } from "../src/modules/projectResearch/question/researchContextRepository";
import { ResearchQueryRepository } from "../src/modules/research/queryPlanning/repository";
import { MAX_RESEARCH_QUERY_ATTEMPTS } from "../src/modules/research/queryPlanning/queryPolicy";
import { loadProtocol } from "../src/modules/providers/protocolRuntime";
import { getTestPostgres, isTestPostgresUnavailableError, type TestPostgresDatabase } from "./support/sharedPostgres";

const SPACE = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666";

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
    for (const [id, name] of [[PROJECT, "Project"], [OTHER_PROJECT, "Other"]]) {
      await pool.query(
        `INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$5)`,
        [id, SPACE, USER, name, now],
      );
    }
    available = true;
  } catch (error) {
    if (!isTestPostgresUnavailableError(error)) throw error;
    console.warn(`[research-query-repository-db] skipped — Docker/Postgres unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.stop();
});

describe("research query persistence (real Postgres)", () => {
  it("persists immutable context versions and an independently selected provider attempt", async () => {
    if (!available || !pool) return;
    const contexts = new ResearchContextRepository(pool);
    const context = await contexts.create({ spaceId: SPACE, userId: USER }, PROJECT, validContext(), {
      assessment: { answerable: true },
      provenance: { source: "question_assessment" },
    });
    const next = await contexts.create({ spaceId: SPACE, userId: USER }, PROJECT, {
      ...validContext(),
      objective: "How should durable agent memory be evaluated across sessions?",
    });
    expect([context.version, next.version]).toEqual([1, 2]);

    const queries = new ResearchQueryRepository(pool);
    const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["arxiv", "openalex", "arxiv"],
      policyVersion: "adaptive-recall.v1",
      policy: { max_attempts: 3 },
      executionBudget: { candidate_budget: 100 },
    });
    expect(strategy.provider_plans.map((plan) => plan.provider_key).sort()).toEqual(["arxiv", "openalex"]);
    await queries.markStrategyEvaluating(SPACE, strategy.id);

    const plan = strategy.provider_plans.find((item) => item.provider_key === "arxiv")!;
    const attempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("arxiv"),
    });
    await queries.completeAttempt(SPACE, attempt.id, {
      observation: previewObservation(),
      score: 0.82,
      decision: "accept",
      decisionReason: "Relevant yield meets the target.",
    });
    await queries.selectAttempt(SPACE, plan.id, attempt.id, { terminalDecision: "accept" });
    const otherPlan = strategy.provider_plans.find((item) => item.provider_key === "openalex")!;
    await queries.markProviderUnavailable(SPACE, otherPlan.id, { failed: false, reason: "Provider was unavailable." });
    await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("selected");

    const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
    // The route response is validated against this same schema; a raw pg
    // Date (instead of an ISO string) or a dropped field fails it, which a
    // toMatchObject check alone would miss.
    const protocol = await loadProtocol();
    expect(() => protocol.ResearchQueryStrategySchema.parse(stored)).not.toThrow();
    const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
    expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: attempt.id });
    expect(storedPlan?.attempts[0]).toMatchObject({
      sequence: 1,
      decision: "accept",
      score: 0.82,
      observation: { provider_hit_count: 42, accessible_hit_count: 42 },
    });
    expect(stored?.status).toBe("selected");
    expect(stored).toMatchObject({ version: 1, parent_strategy_id: null, adaptation_direction: null });

    const replacement = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["arxiv"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 100 },
      parentStrategyId: strategy.id,
      adaptationDirection: "broaden",
    });
    expect(replacement).toMatchObject({ version: 2, parent_strategy_id: strategy.id, adaptation_direction: "broaden" });
    const versions = await queries.listStrategies(SPACE, PROJECT);
    expect(versions.strategies.map((item) => item.version)).toEqual([2, 1]);
  });

  it("enforces sequential attempts, the attempt ceiling, and immutable selection", async () => {
    if (!available || !pool) return;
    const context = await new ResearchContextRepository(pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
    const queries = new ResearchQueryRepository(pool);
    const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["openalex"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 50 },
    });
    const plan = strategy.provider_plans[0]!;

    await expect(queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: 2,
      direction: "broaden",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("openalex"),
    })).rejects.toMatchObject({ statusCode: 409 });

    let selectedAttemptId = "";
    for (let sequence = 1; sequence <= MAX_RESEARCH_QUERY_ATTEMPTS; sequence += 1) {
      const attempt = await queries.createAttempt(SPACE, {
        providerPlanId: plan.id,
        round: 0,
        sequence,
        direction: sequence === 1 ? "initial" : "broaden",
        semanticQuery: semanticQuery(),
        compiledQuery: compiledQuery("openalex", sequence),
      });
      await queries.completeAttempt(SPACE, attempt.id, {
        observation: previewObservation(),
        score: sequence / 10,
        decision: sequence === MAX_RESEARCH_QUERY_ATTEMPTS ? "stop" : "broaden",
      });
      if (sequence === MAX_RESEARCH_QUERY_ATTEMPTS) selectedAttemptId = attempt.id;
    }
    await expect(queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: MAX_RESEARCH_QUERY_ATTEMPTS + 1,
      direction: "broaden",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("openalex", MAX_RESEARCH_QUERY_ATTEMPTS + 1),
    })).rejects.toMatchObject({ statusCode: 422 });

    await queries.selectAttempt(SPACE, plan.id, selectedAttemptId, { terminalDecision: "stop", coverageWarning: "Below target." });
    await expect(queries.selectAttempt(SPACE, plan.id, selectedAttemptId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("resets an unavailable provider plan for retry, scoping new attempts into a fresh round", async () => {
    if (!available || !pool) return;
    const context = await new ResearchContextRepository(pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
    const queries = new ResearchQueryRepository(pool);
    const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["openalex"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 50 },
    });
    const plan = strategy.provider_plans[0]!;

    // Only an `unavailable` plan is retry-eligible — a plan still `pending`
    // (never evaluated) must be rejected the same way `selected`/`evaluating`
    // would be.
    await expect(queries.resetProviderPlan(SPACE, plan.id)).rejects.toMatchObject({ statusCode: 409 });

    const round0Attempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("openalex", 1),
    });
    await queries.completeAttempt(SPACE, round0Attempt.id, { errorClass: "http_503" });
    await queries.markProviderUnavailable(SPACE, plan.id, { failed: false, reason: "Provider was unavailable." });
    // With the only provider unavailable, the strategy itself settles as failed.
    await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("failed");

    const reset = await queries.resetProviderPlan(SPACE, plan.id);
    expect(reset).toEqual({ nextRound: 1 });

    // The reset round's ladder starts back at sequence 1 — round-scoping means
    // this does not collide with round 0's own sequence-1 attempt.
    const round1Attempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: reset.nextRound,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("openalex", 2),
    });
    await queries.completeAttempt(SPACE, round1Attempt.id, {
      observation: previewObservation(),
      score: 0.9,
      decision: "accept",
      decisionReason: "Retry recovered acceptable coverage.",
    });
    await queries.selectAttempt(SPACE, plan.id, round1Attempt.id, { terminalDecision: "accept" });

    // finalizeStrategy's normal early-return would leave a `failed` strategy
    // stuck forever — the retry needs `force` to recompute status now that
    // the retried plan succeeded.
    await expect(queries.finalizeStrategy(SPACE, strategy.id)).resolves.toBe("failed");
    await expect(queries.finalizeStrategy(SPACE, strategy.id, { force: true })).resolves.toBe("selected");

    const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
    const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
    expect(storedPlan?.attempts.map((attempt) => ({ round: attempt.round, sequence: attempt.sequence }))).toEqual([
      { round: 0, sequence: 1 },
      { round: 1, sequence: 1 },
    ]);
    expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: round1Attempt.id });
  });

  it("resets an already-selected provider plan too, clearing its old selection so a retry can record its own — but refuses once the strategy is materialized", async () => {
    if (!available || !pool) return;
    const context = await new ResearchContextRepository(pool).create({ spaceId: SPACE, userId: USER }, PROJECT, validContext());
    const queries = new ResearchQueryRepository(pool);
    const strategy = await queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["arxiv"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: { candidate_budget: 50 },
    });
    const plan = strategy.provider_plans[0]!;
    const firstAttempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: 0,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("arxiv", 1),
    });
    await queries.completeAttempt(SPACE, firstAttempt.id, {
      observation: previewObservation(),
      score: 0.6,
      decision: "stop",
      decisionReason: "Below target yield but within the attempt budget.",
    });
    await queries.selectAttempt(SPACE, plan.id, firstAttempt.id, { terminalDecision: "stop", coverageWarning: "Yield is below target." });

    // Retrying a `selected` (not just `unavailable`) plan is allowed — the
    // user wants to keep iterating on a result they are not fully satisfied
    // with, not just recover from an outage.
    const reset = await queries.resetProviderPlan(SPACE, plan.id);
    expect(reset).toEqual({ nextRound: 1 });

    // The old provider_query_provider_selections row must be gone — otherwise
    // the retry's own selectAttempt would collide on the provider_plan_id
    // primary key.
    const secondAttempt = await queries.createAttempt(SPACE, {
      providerPlanId: plan.id,
      round: reset.nextRound,
      sequence: 1,
      direction: "initial",
      semanticQuery: semanticQuery(),
      compiledQuery: compiledQuery("arxiv", 2),
    });
    await queries.completeAttempt(SPACE, secondAttempt.id, {
      observation: previewObservation(),
      score: 0.85,
      decision: "accept",
      decisionReason: "Retry found better coverage.",
    });
    await expect(queries.selectAttempt(SPACE, plan.id, secondAttempt.id, { terminalDecision: "accept" })).resolves.toBeUndefined();

    const stored = await queries.getStrategy(SPACE, PROJECT, strategy.id);
    const storedPlan = stored?.provider_plans.find((item) => item.id === plan.id);
    expect(storedPlan).toMatchObject({ status: "selected", selected_attempt_id: secondAttempt.id, coverage_warning: null });

    // Once the strategy is materialized, no further retry is allowed on this
    // plan — a source channel/binding already references the selection.
    await pool!.query(`UPDATE research_query_strategies SET status='materialized', materialized_at=$2 WHERE id=$1`, [strategy.id, new Date().toISOString()]);
    await expect(queries.resetProviderPlan(SPACE, plan.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("does not allow a strategy to adopt a context from another project", async () => {
    if (!available || !pool) return;
    const context = await new ResearchContextRepository(pool).create({ spaceId: SPACE, userId: USER }, OTHER_PROJECT, validContext());
    const queries = new ResearchQueryRepository(pool);
    await expect(queries.createStrategy({ spaceId: SPACE, userId: USER }, {
      projectId: PROJECT,
      researchContextVersionId: context.id,
      providers: ["arxiv"],
      policyVersion: "adaptive-recall.v1",
      policy: {},
      executionBudget: {},
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

function validContext(): ResearchContext {
  return {
    schema_version: "research_context.v1" as const,
    objective: "How should long-lived agent memory be evaluated?",
    sub_questions: ["Which benchmarks measure cross-session recall?"],
    in_scope: ["LLM agent memory"],
    out_of_scope: ["Human autobiographical memory"],
    must_have: ["Reports an evaluation method"],
    nice_to_have: ["Includes a public benchmark"],
    time_window: { from: "2020-01-01", to: null },
    source_scope: { providers: ["arxiv", "openalex"], include_web: false },
  };
}

function semanticQuery() {
  return {
    schema_version: "research_semantic_query.v1" as const,
    core: [{ value: "agent memory", synonyms: ["memory-augmented agent"], weight: 1 }],
    expansions: [{ value: "long-term memory", synonyms: [], weight: 0.8 }],
    qualifiers: [{ value: "evaluation", synonyms: ["benchmark"], weight: 0.9 }],
    exclusions: [],
    time_window: { from: "2020-01-01", to: null },
  };
}

function compiledQuery(provider: "arxiv" | "openalex", sequence = 1) {
  return {
    schema_version: "research_compiled_query.v1" as const,
    provider_key: provider,
    query: provider === "arxiv" ? { search_query: "all:agent AND all:memory" } : { search: "agent memory" },
    fingerprint: `0123456789abcde${sequence}`,
  };
}

function previewObservation() {
  return {
    schema_version: "research_preview_observation.v1" as const,
    provider_hit_count: 42,
    accessible_hit_count: 42,
    samples: [{
      sample_id: "paper-1",
      title: "Evaluating Memory-Augmented Agents",
      source_uri: "https://example.test/paper-1",
      occurred_at: "2025-01-01T00:00:00.000Z",
      excerpt: "A benchmark for long-lived agent memory.",
      relevance: "relevant" as const,
      matched_core_concepts: ["agent memory"],
    }],
    relevance_rate: 0.8,
    relevance_lower_bound: 0.55,
    diversity_score: 0.7,
    duplicate_rate: 0,
  };
}
