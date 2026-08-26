import { describe, expect, it } from "vitest";
import type {
  ResearchContextVersion,
  ResearchPreviewObservation,
  ResearchProviderKey,
  ResearchQueryDecision,
  ResearchSemanticQuery,
} from "@agent-space/protocol";
import type { ServerConfig } from "../src/config.js";
import { AdaptiveQueryOrchestrator, errorClass } from "../src/modules/research/queryPlanning/adaptiveQueryOrchestrator.js";
import type {
  CreateResearchQueryAttemptInput,
  CreateResearchQueryStrategyInput,
  StoredResearchQueryStrategy,
} from "../src/modules/research/queryPlanning/repository.js";
import { HttpError, type Queryable } from "../src/modules/routeUtils/common.js";

describe("AdaptiveQueryOrchestrator", () => {
  it("evaluates providers independently and selects after different attempt counts", async () => {
    const store = new FakeStore(["arxiv", "openalex"]);
    const calls: Record<string, number> = {};
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async (_identity, input) => {
        const provider = input.compiledQuery.provider_key;
        calls[provider] = (calls[provider] ?? 0) + 1;
        return { providerHitCount: provider === "arxiv" && calls[provider] === 1 ? 0 : 50, accessibleHitCount: provider === "arxiv" && calls[provider] === 1 ? 0 : 50, candidates: [] };
      } },
      assessor: { assess: (_context, _semantic, preview) => observation(preview.providerHitCount) },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv", "openalex"]));
    // Evaluation previews, plus one final check per provider at the page size
    // history import actually requests — a query can pass the small preview and
    // fail the large page, which is how a plan used to be "validated" and then
    // import nothing.
    expect(calls).toEqual({ arxiv: 3, openalex: 2 });
    expect(store.selected.map((item) => item.providerKey).sort()).toEqual(["arxiv", "openalex"]);
    expect(store.finalized).toBe(true);
  });

  /**
   * The real failure: a broad boolean arXiv query answered 200 at the 15-row
   * preview and 5xx at the 100-row page history import uses. The plan was
   * recorded as validated, imported nothing, and Research reported "no relevant
   * sources" over a corpus missing that provider entirely.
   */
  it("warns when the selected query fails at the page size history import uses", async () => {
    const store = new FakeStore(["arxiv"]);
    const pageSizes: unknown[] = [];
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async (_identity, input) => {
        const pageSize = (input.compiledQuery.query as { max_results?: number }).max_results;
        pageSizes.push(pageSize);
        if (pageSize === 100) throw new HttpError(503, "The source provider is temporarily unavailable or rate limiting; try again shortly.");
        return { providerHitCount: 50, accessibleHitCount: 50, candidates: [] };
      } },
      assessor: { assess: (_context, _semantic, preview) => observation(preview.providerHitCount) },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"]));

    expect(pageSizes).toContain(100);
    const selected = store.selected[0];
    expect(selected?.coverageWarning ?? "").toContain("did not answer at the 100-result page size");
    // The plan is still selected: the import narrows its page and may succeed,
    // so this is a warning about what was proven, not a rejection.
    expect(store.selected).toHaveLength(1);
    expect(store.unavailable).toEqual([]);
  });

  it("never exceeds three attempts and selects the settled (stop) attempt over a higher-scoring broaden/narrow one", async () => {
    const store = new FakeStore(["arxiv"]);
    let calls = 0;
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async () => ({ providerHitCount: 0, accessibleHitCount: 0, candidates: [] }) },
      assessor: { assess: () => observation(0) },
      evaluator: { evaluate: (_observation, _policy, sequence) => {
        calls += 1;
        const decision: ResearchQueryDecision = sequence === 3 ? "stop" : "broaden";
        // attempt 2's own decision says it isn't good enough yet (broaden),
        // but scores higher than the settled attempt 3 — a saturated
        // yieldScore can do this in production (see queryPolicy). The
        // settled attempt must still win the fallback pick.
        return { decision, score: sequence === 2 ? 0.8 : 0.2, reason: `attempt ${sequence}`, coverageWarning: decision === "stop" ? "weak coverage" : null, projectedRelevantYield: 0, loadRatio: 0 };
      } },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"]));
    expect(calls).toBe(3);
    expect(store.attempts).toHaveLength(3);
    expect(store.selected[0]?.attemptId).toBe(store.attempts[2]?.id);
    expect(store.selected[0]?.coverageWarning).toBe("weak coverage");
  });

  it("falls back to the highest score when every observed attempt is still broaden/narrow (a mid-adaptation preview failure)", async () => {
    const store = new FakeStore(["arxiv"]);
    let previewCalls = 0;
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async () => {
        previewCalls += 1;
        if (previewCalls === 3) throw new Error("temporary provider outage");
        return { providerHitCount: 2, accessibleHitCount: 2, candidates: [] };
      } },
      assessor: { assess: () => observation(2) },
      evaluator: { evaluate: (_observation, _policy, sequence) => ({
        decision: "broaden", score: sequence === 1 ? 0.3 : 0.9, reason: `attempt ${sequence}`, coverageWarning: null,
        projectedRelevantYield: 1, loadRatio: 0.02,
      }) },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"]));
    // Both observed attempts are still "broaden" (neither settled) — with no
    // settled attempt to prefer, the fallback must still pick the higher score.
    expect(store.attempts).toHaveLength(3);
    expect(store.selected[0]?.attemptId).toBe(store.attempts[1]?.id);
  });

  it("stops early when the ladder converges back to a previously tried query instead of re-running it", async () => {
    // openalex has no boolean operators (see providers/openAlex.ts), so once
    // core is exhausted the only lever is the one qualifier: narrow() adds
    // it, broaden() drops it — landing right back on attempt 1's exact
    // query. Left unchecked this cycles for the rest of the attempt budget.
    const store = new FakeStore(["openalex"]);
    let previewCalls = 0;
    let evaluateCalls = 0;
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => oscillatingIntent() },
      previewGateway: { preview: async () => {
        previewCalls += 1;
        return { providerHitCount: 50, accessibleHitCount: 50, candidates: [] };
      } },
      assessor: { assess: () => observation(50) },
      evaluator: { evaluate: (_observation, _policy, sequence) => {
        evaluateCalls += 1;
        const decision: ResearchQueryDecision = sequence === 1 ? "narrow" : "broaden";
        return { decision, score: sequence === 1 ? 0.3 : 0.6, reason: `attempt ${sequence}`, coverageWarning: null, projectedRelevantYield: 0, loadRatio: 0 };
      } },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["openalex"]));

    // The third compiled query would be identical to the first — the
    // orchestrator must detect that before spending a third preview request
    // or evaluator call, not after exhausting all four attempts. The trailing
    // call is the import-shape verification of whichever query was selected.
    expect(previewCalls).toBe(3);
    expect(evaluateCalls).toBe(2);
    expect(store.attempts).toHaveLength(2);
    expect(store.selected[0]?.attemptId).toBe(store.attempts[1]?.id);
    expect(store.selected[0]?.coverageWarning).toContain("converged back to a previously tried query");
  });

  it("does not disguise repository failures as provider unavailability", async () => {
    const store = new FakeStore(["arxiv"]);
    store.completeAttempt = async () => { throw new Error("database write failed"); };
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
      assessor: { assess: () => observation(50) },
    });

    await expect(orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"])))
      .rejects.toThrow("database write failed");
    expect(store.unavailable).toHaveLength(0);
  });

  it("retains the best observed query when a later provider preview fails", async () => {
    const store = new FakeStore(["arxiv"]);
    let previewCalls = 0;
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async () => {
        previewCalls += 1;
        if (previewCalls === 2) throw new Error("temporary provider outage");
        return { providerHitCount: 2, accessibleHitCount: 2, candidates: [] };
      } },
      assessor: { assess: () => observation(2) },
      evaluator: { evaluate: () => ({
        decision: "broaden", score: 0.65, reason: "Yield is below target.", coverageWarning: null,
        projectedRelevantYield: 1, loadRatio: 0.02,
      }) },
    });

    await orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"]));

    expect(store.attempts).toHaveLength(2);
    expect(store.selected).toEqual([expect.objectContaining({
      providerKey: "arxiv",
      attemptId: store.attempts[0]!.id,
      coverageWarning: expect.stringContaining("best previously observed query was retained"),
    })]);
    expect(store.unavailable).toHaveLength(0);
  });

  it("does not spend preview budget for a context that failed assessment", async () => {
    const store = new FakeStore(["arxiv"]);
    const failed = contextVersion();
    failed.assessment = { answerable: false, finer: { feasible: 1, interesting: 3, novel: 1, ethical: 5, relevant: 2 } };
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => failed },
      intentPlanner: { plan: async () => semanticIntent() },
      previewGateway: { preview: async () => { throw new Error("must not run"); } },
    });
    await expect(orchestrator.evaluate({ spaceId: "space", userId: "user" }, input(["arxiv"])))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(store.attempts).toHaveLength(0);
  });

  describe("errorClass", () => {
    it("reports the real upstream status ProviderPreviewGateway preserved, not the generic outward statusCode", () => {
      const error = new HttpError(502, "arXiv preview request failed (400)", { upstream_status: 400 });
      expect(errorClass(error)).toBe("http_400");
    });

    it("falls back to statusCode when there is no preserved upstream status at all", () => {
      expect(errorClass(new HttpError(503, "unavailable"))).toBe("http_503");
    });

    it("reports 'timeout' for the give-up-after-retry 503 whose second attempt also timed out, instead of a generic http_503", () => {
      const error = new HttpError(503, "unavailable", { upstream_status: "timeout" });
      expect(errorClass(error)).toBe("timeout");
    });

    it("reports the real upstream status for the give-up-after-retry 503 whose second attempt got a fresh 429 or a real 5xx", () => {
      expect(errorClass(new HttpError(503, "unavailable", { upstream_status: 429 }))).toBe("http_429");
      expect(errorClass(new HttpError(503, "unavailable", { upstream_status: 500 }))).toBe("http_500");
    });

    it("ignores a malformed responseBody instead of throwing", () => {
      expect(errorClass(new HttpError(502, "failed", { upstream_status: "not-a-number" }))).toBe("http_502");
      expect(errorClass(new HttpError(502, "failed", "not an object"))).toBe("http_502");
    });

    it("falls back to the error name for a non-HTTP error", () => {
      expect(errorClass(new TypeError("boom"))).toBe("TypeError");
      expect(errorClass("not an error")).toBe("provider_error");
    });
  });

  it("evaluates a versioned replacement from stored semantic intent without invoking the intent planner", async () => {
    const store = new FakeStore(["arxiv"]);
    store.seedMaterialized();
    const intentPlanner = { plan: async () => { throw new Error("must not reinterpret the question"); } };
    const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
      repository: store,
      contextRepository: { get: async () => contextVersion() },
      intentPlanner,
      previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
      assessor: { assess: () => observation(50) },
    });
    await orchestrator.evaluateVersion({ spaceId: "space", userId: "user" }, {
      projectId: "project", sourceStrategyId: "strategy", direction: "broaden", candidateBudget: 100,
    });
    expect(store.createdStrategyInput).toMatchObject({ parentStrategyId: "strategy", adaptationDirection: "broaden" });
    expect(store.attempts[0]?.direction).toBe("broaden");
  });

  describe("retryProvider", () => {
    it("retries only the unavailable provider, leaving an already-selected provider's plan and attempts untouched", async () => {
      const store = new FakeStore(["arxiv", "openalex"]);
      store.seedSelected("arxiv");
      store.seedUnavailable("openalex");
      const arxivAttemptsBefore = [...store.attempts.filter((attempt) => attempt.providerPlanId === "plan-0")];

      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
        intentPlanner: { plan: async () => { throw new Error("must not reinterpret the question — a retry reuses the plan's last attempt"); } },
        previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
        assessor: { assess: () => observation(50) },
      });

      const result = await orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "openalex",
      });

      expect(store.attempts.filter((attempt) => attempt.providerPlanId === "plan-0")).toEqual(arxivAttemptsBefore);
      const arxivPlan = result.provider_plans.find((plan) => plan.provider_key === "arxiv")!;
      expect(arxivPlan.status).toBe("selected");
      expect(arxivPlan.selected_attempt_id).toBe("seed-attempt-arxiv");

      const openalexPlan = result.provider_plans.find((plan) => plan.provider_key === "openalex")!;
      expect(openalexPlan.status).toBe("selected");
      const retriedAttempt = store.attempts.find((attempt) => attempt.providerPlanId === "plan-1" && attempt.round === 1);
      expect(retriedAttempt).toBeTruthy();
    });

    it("continues a retried plan's attempts in a new round instead of colliding with round 0's sequence", async () => {
      const store = new FakeStore(["openalex"]);
      store.seedUnavailable("openalex");

      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
        intentPlanner: { plan: async () => { throw new Error("must not run"); } },
        previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
        assessor: { assess: () => observation(50) },
      });

      await orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "openalex",
      });

      const retried = store.attempts.filter((attempt) => attempt.round === 1);
      expect(retried).toHaveLength(1);
      expect(retried[0]?.sequence).toBe(1);
    });

    it("rejects retrying a provider plan that has never been evaluated (still pending)", async () => {
      const store = new FakeStore(["arxiv"]);
      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
      });

      await expect(orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "arxiv",
      })).rejects.toMatchObject({ statusCode: 409 });
    });

    it("retries an already-selected provider plan, starting the new round from the exact combination that was selected", async () => {
      const store = new FakeStore(["arxiv", "openalex"]);
      store.seedSelected("arxiv");
      store.seedSelected("openalex");
      const openalexAttemptsBefore = [...store.attempts.filter((attempt) => attempt.providerPlanId === "plan-1")];

      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
        intentPlanner: { plan: async () => { throw new Error("must not reinterpret the question — a retry reuses the plan's own selected query"); } },
        previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
        assessor: { assess: () => observation(50) },
      });

      await orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "arxiv",
      });

      // openalex's own selection is a different provider plan and must stay untouched.
      expect(store.attempts.filter((attempt) => attempt.providerPlanId === "plan-1")).toEqual(openalexAttemptsBefore);

      const retriedRoundAttempt = store.attempts.find((attempt) => attempt.providerPlanId === "plan-0" && attempt.round === 1);
      expect(retriedRoundAttempt).toBeTruthy();
      // The new round's first attempt reuses the previously-selected combination
      // verbatim (bypassing ladder.initial()'s re-ranking/truncation).
      expect(retriedRoundAttempt?.semanticQuery).toEqual(semanticIntent());
    });

    it("rejects retrying a provider plan once the strategy has been materialized", async () => {
      const store = new FakeStore(["arxiv"]);
      store.seedSelected("arxiv");
      store.markMaterialized();
      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
      });

      await expect(orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "arxiv",
      })).rejects.toMatchObject({ statusCode: 409 });
    });

    it("falls back to the intent planner when the unavailable plan has no prior attempt to reuse", async () => {
      const store = new FakeStore(["arxiv"]);
      const plan = store.provider_plans()[0]!;
      plan.status = "unavailable";
      let planned = false;
      const orchestrator = new AdaptiveQueryOrchestrator({} as Queryable, {} as ServerConfig, {
        repository: store,
        contextRepository: { get: async () => contextVersion() },
        intentPlanner: { plan: async () => { planned = true; return semanticIntent(); } },
        previewGateway: { preview: async () => ({ providerHitCount: 50, accessibleHitCount: 50, candidates: [] }) },
        assessor: { assess: () => observation(50) },
      });

      await orchestrator.retryProvider({ spaceId: "space", userId: "user" }, {
        projectId: "project", strategyId: "strategy", providerKey: "arxiv",
      });

      expect(planned).toBe(true);
    });
  });
});

class FakeStore {
  readonly attempts: Array<CreateResearchQueryAttemptInput & { id: string; providerKey: ResearchProviderKey }> = [];
  readonly selected: Array<{ providerKey: ResearchProviderKey; attemptId: string; coverageWarning?: string }> = [];
  readonly unavailable: string[] = [];
  finalized = false;
  createdStrategyInput: CreateResearchQueryStrategyInput | null = null;
  private readonly strategy: StoredResearchQueryStrategy;

  constructor(providers: ResearchProviderKey[]) {
    this.strategy = {
      id: "strategy", project_id: "project", research_context_version_id: "11111111-1111-4111-8111-111111111111",
      question_snapshot: "question", status: "planning", policy_version: "adaptive-recall.v1", policy: {}, execution_budget: {},
      version: 1, parent_strategy_id: null, adaptation_direction: null,
      created_at: new Date().toISOString(), selected_at: null, materialized_at: null,
      provider_plans: providers.map((provider, index) => ({
        id: `plan-${index}`, provider_key: provider, status: "pending", selected_attempt_id: null,
        terminal_decision: null, decision_reason: null, coverage_warning: null, attempts: [],
      })),
    };
  }

  provider_plans() { return this.strategy.provider_plans; }

  /** Seeds a plan as already `selected` from a prior evaluation round, the
   * way an accepted-and-reviewed provider looks before a sibling provider's
   * retry runs — used to assert a retry leaves it byte-for-byte alone. */
  seedSelected(providerKey: ResearchProviderKey) {
    const plan = this.strategy.provider_plans.find((item) => item.provider_key === providerKey)!;
    const id = `seed-attempt-${providerKey}`;
    const semantic = semanticIntent();
    const compiled = { schema_version: "research_compiled_query.v1" as const, provider_key: providerKey, query: { q: "agent memory" }, fingerprint: `seed-${providerKey}-selected` };
    this.attempts.push({ id, providerPlanId: plan.id, round: 0, sequence: 1, direction: "initial", semanticQuery: semantic, compiledQuery: compiled, providerKey });
    plan.attempts = [{
      id, provider_plan_id: plan.id, round: 0, sequence: 1, direction: "initial", semantic_query: semantic, compiled_query: compiled,
      observation: observation(50), score: 0.8, decision: "accept", decision_reason: null, error_class: null,
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    }];
    plan.selected_attempt_id = id;
    plan.status = "selected";
  }

  /** Seeds a plan as `unavailable` after one failed attempt, matching what a
   * plan looks like right before a manual retry. */
  seedUnavailable(providerKey: ResearchProviderKey) {
    const plan = this.strategy.provider_plans.find((item) => item.provider_key === providerKey)!;
    const id = `seed-attempt-${providerKey}-unavailable`;
    const semantic = semanticIntent();
    const compiled = { schema_version: "research_compiled_query.v1" as const, provider_key: providerKey, query: { q: "agent memory" }, fingerprint: `seed-${providerKey}-unavailable` };
    this.attempts.push({ id, providerPlanId: plan.id, round: 0, sequence: 1, direction: "initial", semanticQuery: semantic, compiledQuery: compiled, providerKey });
    plan.attempts = [{
      id, provider_plan_id: plan.id, round: 0, sequence: 1, direction: "initial", semantic_query: semantic, compiled_query: compiled,
      observation: null, score: null, decision: null, decision_reason: null, error_class: "http_503",
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    }];
    plan.status = "unavailable";
  }

  seedMaterialized() {
    const plan = this.strategy.provider_plans[0]!;
    const attempt = {
      id: "selected-attempt", provider_plan_id: plan.id, round: 0, sequence: 1, direction: "initial" as const, semantic_query: semanticIntent(),
      compiled_query: { schema_version: "research_compiled_query.v1" as const, provider_key: plan.provider_key, query: { q: "agent memory" }, fingerprint: "1234567890abcdef" },
      observation: observation(50), score: 0.8, decision: "accept" as const, decision_reason: null, error_class: null,
      created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    };
    plan.attempts = [attempt];
    plan.selected_attempt_id = attempt.id;
    plan.status = "selected";
    this.strategy.status = "materialized";
    this.strategy.materialized_at = new Date().toISOString();
  }

  markMaterialized() {
    this.strategy.status = "materialized";
    this.strategy.materialized_at = new Date().toISOString();
  }

  async createStrategy(_identity?: unknown, input?: CreateResearchQueryStrategyInput) {
    this.createdStrategyInput = input ?? null;
    return this.strategy;
  }
  async markStrategyEvaluating() { this.strategy.status = "evaluating"; }
  async createAttempt(_spaceId: string, attempt: CreateResearchQueryAttemptInput) {
    const plan = this.strategy.provider_plans.find((item) => item.id === attempt.providerPlanId)!;
    const stored = { ...attempt, id: `attempt-${this.attempts.length + 1}`, providerKey: plan.provider_key };
    this.attempts.push(stored);
    return {
      id: stored.id, provider_plan_id: attempt.providerPlanId, round: attempt.round, sequence: attempt.sequence, direction: attempt.direction, semantic_query: attempt.semanticQuery,
      compiled_query: attempt.compiledQuery, observation: null, score: null, decision: null, decision_reason: null,
      error_class: null, created_at: new Date().toISOString(), completed_at: null,
    };
  }
  async completeAttempt() {}
  async selectAttempt(_spaceId: string, planId: string, attemptId: string, value?: { terminalDecision: ResearchQueryDecision; decisionReason?: string; coverageWarning?: string }) {
    const plan = this.strategy.provider_plans.find((item) => item.id === planId)!;
    this.selected.push({ providerKey: plan.provider_key, attemptId, coverageWarning: value?.coverageWarning });
    plan.status = "selected";
  }
  async markProviderUnavailable(_spaceId: string, planId: string) {
    this.unavailable.push(planId);
    const plan = this.strategy.provider_plans.find((item) => item.id === planId)!;
    plan.status = "unavailable";
  }
  async resetProviderPlan(_spaceId: string, planId: string) {
    const plan = this.strategy.provider_plans.find((item) => item.id === planId)!;
    if (this.strategy.materialized_at !== null) throw new HttpError(409, "Cannot retry a provider plan once its query strategy has been materialized");
    if (!["unavailable", "selected"].includes(plan.status)) throw new HttpError(409, "Only an unavailable or already-selected research provider plan can be retried");
    plan.status = "pending";
    plan.terminal_decision = null;
    plan.decision_reason = null;
    plan.coverage_warning = null;
    plan.selected_attempt_id = null;
    const priorRounds = this.attempts.filter((attempt) => attempt.providerPlanId === planId).map((attempt) => attempt.round);
    return { nextRound: priorRounds.length > 0 ? Math.max(...priorRounds) + 1 : 0 };
  }
  async finalizeStrategy() { this.finalized = true; this.strategy.status = "selected"; return "selected" as const; }
  async getStrategy() { return this.strategy; }
}

function input(providers: ResearchProviderKey[]) {
  return {
    projectId: "project",
    researchContextVersionId: "11111111-1111-4111-8111-111111111111",
    providers,
    candidateBudget: 100,
  };
}

function contextVersion(): ResearchContextVersion {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    project_id: "project",
    version: 1,
    context: {
      schema_version: "research_context.v1", objective: "Agent memory evaluation", sub_questions: [],
      in_scope: ["agent memory"], out_of_scope: [], must_have: [], nice_to_have: [], time_window: null,
      source_scope: { providers: ["arxiv", "openalex"], include_web: false },
    },
    assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 5 } }, provenance: {}, created_at: new Date().toISOString(),
  };
}

// Enough vocabulary depth (more expansions than initial() uses) that
// broaden() has a genuine move available for a few consecutive attempts
// instead of immediately exhausting into a no-op/duplicate query.
function semanticIntent() {
  return {
    schema_version: "research_semantic_query.v1" as const,
    core: [{ value: "agent memory", synonyms: [], weight: 1 }],
    expansions: [
      { value: "persistent memory", synonyms: [], weight: 0.7 },
      { value: "long-term context", synonyms: [], weight: 0.6 },
      { value: "episodic memory", synonyms: [], weight: 0.5 },
    ],
    qualifiers: [{ value: "evaluation", synonyms: [], weight: 0.8 }],
    exclusions: [], time_window: null,
  };
}

// One core concept (already fully used by initial()) and two qualifiers of
// differing weight — the minimal shape that makes narrow() add the second
// qualifier and broaden() immediately drop it again, landing back on
// initial()'s exact query.
function oscillatingIntent(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [{ value: "agent memory", synonyms: [], weight: 1 }],
    expansions: [],
    qualifiers: [
      { value: "evaluation", synonyms: [], weight: 0.9 },
      { value: "recent", synonyms: [], weight: 0.8 },
    ],
    exclusions: [],
    time_window: null,
  };
}

function observation(hits: number): ResearchPreviewObservation {
  return {
    schema_version: "research_preview_observation.v1", provider_hit_count: hits, accessible_hit_count: hits,
    samples: [], relevance_rate: hits ? 0.9 : 0, relevance_lower_bound: hits ? 0.7 : 0,
    diversity_score: hits ? 1 : 0, duplicate_rate: 0,
  };
}
