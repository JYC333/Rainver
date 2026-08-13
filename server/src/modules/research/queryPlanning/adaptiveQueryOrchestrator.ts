import type {
  ResearchContextVersion,
  ResearchProviderKey,
  ResearchSemanticQuery,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../../config";
import { ResearchContextRepository } from "../../projectResearch/question/researchContextRepository";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../../routeUtils/common";
import { ProviderPreviewGateway } from "../discovery/providerPreviewGateway";
import { PreviewRelevanceAssessor } from "../discovery/previewRelevanceAssessor";
import { AdaptiveQueryEvaluator, type AdaptiveQueryEvaluation } from "./adaptiveQueryEvaluator";
import { ResearchIntentPlanner, type ResearchIntentExecution } from "./intentPlanner";
import { ResearchProviderCompiler } from "./providerCompiler";
import { ResearchQueryLadderBuilder, type ResearchQueryLadderStep } from "./queryLadderBuilder";
import {
  RESEARCH_QUERY_POLICY_VERSION,
  researchQueryPolicy,
  researchQueryPolicySnapshot,
} from "./queryPolicy";
import {
  ResearchQueryRepository,
  type StoredResearchQueryProviderPlan,
  type StoredResearchQueryStrategy,
} from "./repository";

export interface AdaptiveResearchQueryInput {
  projectId: string;
  researchContextVersionId: string;
  providers: ResearchProviderKey[];
  candidateBudget: number;
  credentials?: Partial<Record<ResearchProviderKey, string>>;
  execution?: ResearchIntentExecution;
  operationId?: string | null;
}

export interface AdaptiveResearchQueryVersionInput {
  projectId: string;
  sourceStrategyId: string;
  direction: "broaden" | "narrow";
  candidateBudget: number;
  credentials?: Partial<Record<ResearchProviderKey, string>>;
}

export interface AdaptiveResearchQueryProviderRetryInput {
  projectId: string;
  strategyId: string;
  providerKey: ResearchProviderKey;
  credentials?: Partial<Record<ResearchProviderKey, string>>;
  execution?: ResearchIntentExecution;
}

interface ResearchQueryStore {
  createStrategy: ResearchQueryRepository["createStrategy"];
  markStrategyEvaluating: ResearchQueryRepository["markStrategyEvaluating"];
  createAttempt: ResearchQueryRepository["createAttempt"];
  completeAttempt: ResearchQueryRepository["completeAttempt"];
  selectAttempt: ResearchQueryRepository["selectAttempt"];
  markProviderUnavailable: ResearchQueryRepository["markProviderUnavailable"];
  resetProviderPlan: ResearchQueryRepository["resetProviderPlan"];
  finalizeStrategy: ResearchQueryRepository["finalizeStrategy"];
  getStrategy: ResearchQueryRepository["getStrategy"];
}

interface AdaptiveResearchQueryDependencies {
  repository?: ResearchQueryStore;
  contextRepository?: Pick<ResearchContextRepository, "get">;
  intentPlanner?: { plan(identity: SpaceUserIdentity, context: ResearchContextVersion["context"], execution?: ResearchIntentExecution): Promise<ResearchSemanticQuery> };
  previewGateway?: Pick<ProviderPreviewGateway, "preview">;
  assessor?: PreviewRelevanceAssessor;
  evaluator?: AdaptiveQueryEvaluator;
  compiler?: ResearchProviderCompiler;
  ladder?: ResearchQueryLadderBuilder;
}

/**
 * The page size Sources history import requests (`Math.min(100, remaining)`).
 * Evaluation previews far fewer rows, so this is the shape that has to be
 * proven before a plan is called validated.
 */
const IMPORT_PAGE_SIZE = 100;

export class AdaptiveQueryOrchestrator {
  private readonly repository: ResearchQueryStore;
  private readonly contextRepository: Pick<ResearchContextRepository, "get">;
  private readonly intentPlanner: AdaptiveResearchQueryDependencies["intentPlanner"];
  private readonly previewGateway: Pick<ProviderPreviewGateway, "preview">;
  private readonly assessor: PreviewRelevanceAssessor;
  private readonly evaluator: AdaptiveQueryEvaluator;
  private readonly compiler: ResearchProviderCompiler;
  private readonly ladder: ResearchQueryLadderBuilder;

  constructor(
    db: Queryable,
    config: ServerConfig,
    dependencies: AdaptiveResearchQueryDependencies = {},
  ) {
    this.repository = dependencies.repository ?? new ResearchQueryRepository(db);
    this.contextRepository = dependencies.contextRepository ?? new ResearchContextRepository(db);
    this.intentPlanner = dependencies.intentPlanner ?? new ResearchIntentPlanner(db, config);
    this.previewGateway = dependencies.previewGateway ?? new ProviderPreviewGateway(db, config);
    this.assessor = dependencies.assessor ?? new PreviewRelevanceAssessor();
    this.evaluator = dependencies.evaluator ?? new AdaptiveQueryEvaluator();
    this.compiler = dependencies.compiler ?? new ResearchProviderCompiler();
    this.ladder = dependencies.ladder ?? new ResearchQueryLadderBuilder();
  }

  async evaluate(identity: SpaceUserIdentity, input: AdaptiveResearchQueryInput): Promise<StoredResearchQueryStrategy> {
    if (!Number.isInteger(input.candidateBudget) || input.candidateBudget < 1 || input.candidateBudget > 10_000) {
      throw new HttpError(422, "candidateBudget must be an integer between 1 and 10000");
    }
    const contextVersion = await this.contextRepository.get(identity.spaceId, input.projectId, input.researchContextVersionId);
    if (!contextVersion) throw new HttpError(404, "Research context version not found");
    assertContextAssessmentPassed(contextVersion.assessment);
    const providers = [...new Set(input.providers)];
    const providerBudget = Math.max(1, Math.ceil(input.candidateBudget / Math.max(1, providers.length)));
    const strategy = await this.repository.createStrategy(identity, {
      projectId: input.projectId,
      researchContextVersionId: contextVersion.id,
      providers,
      policyVersion: RESEARCH_QUERY_POLICY_VERSION,
      policy: researchQueryPolicySnapshot(providers, providerBudget),
      executionBudget: { candidate_budget: input.candidateBudget, provider_candidate_budget: providerBudget },
      operationId: input.operationId,
    });
    await this.repository.markStrategyEvaluating(identity.spaceId, strategy.id);
    let intent: ResearchSemanticQuery;
    try {
      intent = await this.intentPlanner!.plan(identity, contextVersion.context, input.execution);
    } catch (error) {
      await Promise.all(strategy.provider_plans.map((plan) => this.repository.markProviderUnavailable(identity.spaceId, plan.id, {
        failed: true,
        reason: `Semantic intent planning failed: ${errorMessage(error)}`,
      })));
      await this.repository.finalizeStrategy(identity.spaceId, strategy.id);
      throw error;
    }

    await Promise.all(strategy.provider_plans.map((plan) => this.evaluateProvider(
      identity,
      input,
      contextVersion,
      plan,
      intent,
      providerBudget,
    )));
    await this.repository.finalizeStrategy(identity.spaceId, strategy.id);
    return (await this.repository.getStrategy(identity.spaceId, input.projectId, strategy.id))!;
  }

  /** Builds an immutable replacement version from the semantic intent already
   * stored on the active strategy. Monitoring adaptation therefore never sends
   * the long research question back to a provider or requires a second LLM
   * interpretation of the same approved context. */
  async evaluateVersion(identity: SpaceUserIdentity, input: AdaptiveResearchQueryVersionInput): Promise<StoredResearchQueryStrategy> {
    if (!Number.isInteger(input.candidateBudget) || input.candidateBudget < 1 || input.candidateBudget > 10_000) {
      throw new HttpError(422, "candidateBudget must be an integer between 1 and 10000");
    }
    const source = await this.repository.getStrategy(identity.spaceId, input.projectId, input.sourceStrategyId);
    if (!source || source.status !== "materialized") throw new HttpError(409, "Only a materialized query strategy can be adapted");
    const selected = source.provider_plans.flatMap((plan) => {
      const attempt = plan.attempts.find((candidate) => candidate.id === plan.selected_attempt_id);
      return attempt ? [{ provider: plan.provider_key, intent: attempt.semantic_query }] : [];
    });
    if (selected.length === 0) throw new HttpError(409, "The active query strategy has no selected provider query");
    const contextVersion = await this.contextRepository.get(identity.spaceId, input.projectId, source.research_context_version_id);
    if (!contextVersion) throw new HttpError(404, "Research context version not found");
    const providerBudget = Math.max(1, Math.ceil(input.candidateBudget / selected.length));
    const strategy = await this.repository.createStrategy(identity, {
      projectId: input.projectId,
      researchContextVersionId: source.research_context_version_id,
      providers: selected.map((item) => item.provider),
      policyVersion: RESEARCH_QUERY_POLICY_VERSION,
      policy: researchQueryPolicySnapshot(selected.map((item) => item.provider), providerBudget),
      executionBudget: { candidate_budget: input.candidateBudget, provider_candidate_budget: providerBudget },
      parentStrategyId: source.id,
      adaptationDirection: input.direction,
    });
    await this.repository.markStrategyEvaluating(identity.spaceId, strategy.id);
    const intents = new Map(selected.map((item) => [item.provider, item.intent]));
    await Promise.all(strategy.provider_plans.map((plan) => this.evaluateProvider(
      identity,
      {
        projectId: input.projectId,
        researchContextVersionId: source.research_context_version_id,
        providers: selected.map((item) => item.provider),
        candidateBudget: input.candidateBudget,
        credentials: input.credentials,
      },
      contextVersion,
      plan,
      intents.get(plan.provider_key)!,
      providerBudget,
      input.direction,
    )));
    await this.repository.finalizeStrategy(identity.spaceId, strategy.id);
    return (await this.repository.getStrategy(identity.spaceId, input.projectId, strategy.id))!;
  }

  /** Retries evaluation for a single provider plan within an existing
   * strategy, leaving every other provider plan (including a different,
   * already-selected one) untouched. Eligible for a plan that is either
   * `unavailable` (nothing was ever selected) or already `selected` — in the
   * latter case the retry starts from the exact combination that was
   * selected and gives it a fresh ladder budget to keep adjusting from
   * there, rather than re-deriving a truncated baseline from raw intent.
   * Not eligible once the strategy has been materialized (resetProviderPlan
   * enforces this). */
  async retryProvider(identity: SpaceUserIdentity, input: AdaptiveResearchQueryProviderRetryInput): Promise<StoredResearchQueryStrategy> {
    const strategy = await this.repository.getStrategy(identity.spaceId, input.projectId, input.strategyId);
    if (!strategy) throw new HttpError(404, "Research query strategy not found");
    const plan = strategy.provider_plans.find((candidate) => candidate.provider_key === input.providerKey);
    if (!plan) throw new HttpError(404, "Research provider plan not found");
    const contextVersion = await this.contextRepository.get(identity.spaceId, input.projectId, strategy.research_context_version_id);
    if (!contextVersion) throw new HttpError(404, "Research context version not found");

    const { nextRound } = await this.repository.resetProviderPlan(identity.spaceId, plan.id);

    const lastAttempt = plan.attempts[plan.attempts.length - 1];
    const intent = lastAttempt
      ? lastAttempt.semantic_query
      : await this.intentPlanner!.plan(identity, contextVersion.context, input.execution);
    // Seed the new round with the last attempt's exact compiled combination
    // (not ladder.initial(intent), which re-ranks and truncates core/
    // expansions/qualifiers/exclusions from scratch and would silently
    // discard adaptations a prior narrow()/broaden() step already made).
    const startingStep: ResearchQueryLadderStep | undefined = lastAttempt
      ? { sequence: 1, direction: "initial", semanticQuery: lastAttempt.semantic_query }
      : undefined;
    const providerBudget = Math.max(1, Math.trunc(Number(strategy.execution_budget.provider_candidate_budget) || 1));

    await this.evaluateProvider(
      identity,
      {
        projectId: input.projectId,
        researchContextVersionId: strategy.research_context_version_id,
        providers: [plan.provider_key],
        candidateBudget: providerBudget,
        credentials: input.credentials,
        execution: input.execution,
      },
      contextVersion,
      plan,
      intent,
      providerBudget,
      undefined,
      nextRound,
      startingStep,
    );
    await this.repository.finalizeStrategy(identity.spaceId, strategy.id, { force: true });
    return (await this.repository.getStrategy(identity.spaceId, input.projectId, strategy.id))!;
  }

  private async evaluateProvider(
    identity: SpaceUserIdentity,
    input: AdaptiveResearchQueryInput,
    contextVersion: ResearchContextVersion,
    plan: StoredResearchQueryProviderPlan,
    intent: ResearchSemanticQuery,
    providerBudget: number,
    initialDirection?: "broaden" | "narrow",
    round = 0,
    startingStep?: ResearchQueryLadderStep,
  ): Promise<void> {
    const policy = researchQueryPolicy(plan.provider_key, providerBudget);
    const baseline = startingStep ?? this.ladder.initial(intent);
    let step = initialDirection
      ? { ...this.ladder.next(baseline, intent, initialDirection, plan.provider_key), sequence: 1 as const }
      : baseline;
    const observed: ObservedAttempt[] = [];
    const seenFingerprints = new Set<string>();
    for (let sequence = 1; sequence <= policy.maxAttempts; sequence += 1) {
      const compiled = this.compiler.compile(plan.provider_key, step.semanticQuery, { pageSize: policy.previewSampleSize });
      if (seenFingerprints.has(compiled.fingerprint)) {
        // The ladder walked back to a query already tried this evaluation —
        // e.g. narrow() adds the one available qualifier, then broaden()
        // removes that exact qualifier next, landing back on attempt 1's
        // query. With only one lever available this cycles forever instead
        // of converging; repeating an identical request wastes budget and
        // never changes the outcome, so stop with the best of what's
        // already been observed instead of re-running it.
        const best = bestObservedAttempt(observed);
        await this.selectVerifiedAttempt(identity, input, plan, best, {
          terminalDecision: "stop",
          decisionReason: best.evaluation.reason,
          coverageWarning: "Query evaluation stopped: adaptation converged back to a previously tried query.",
        });
        return;
      }
      seenFingerprints.add(compiled.fingerprint);
      const attempt = await this.repository.createAttempt(identity.spaceId, {
        providerPlanId: plan.id,
        round,
        sequence,
        direction: step.direction,
        semanticQuery: step.semanticQuery,
        compiledQuery: compiled,
      });
      let preview;
      try {
        preview = await this.previewGateway.preview(identity, {
          compiledQuery: compiled,
          accessibleResultCap: policy.accessibleResultCap,
          credentialId: input.credentials?.[plan.provider_key],
        });
      } catch (error) {
        await this.repository.completeAttempt(identity.spaceId, attempt.id, { errorClass: errorClass(error) });
        if (observed.length > 0) {
          const best = bestObservedAttempt(observed);
          await this.selectVerifiedAttempt(identity, input, plan, best, {
            terminalDecision: "stop",
            decisionReason: best.evaluation.reason,
            coverageWarning: `A later ${plan.provider_key} preview failed; the best previously observed query was retained. ${errorMessage(error)}`,
          });
          return;
        }
        await this.repository.markProviderUnavailable(identity.spaceId, plan.id, {
          failed: isPermanentProviderError(error),
          reason: errorMessage(error),
        });
        return;
      }
      const observation = this.assessor.assess(contextVersion.context, step.semanticQuery, preview);
      const evaluation = this.evaluator.evaluate(observation, policy, sequence);
      await this.repository.completeAttempt(identity.spaceId, attempt.id, {
        observation,
        score: evaluation.score,
        decision: evaluation.decision,
        decisionReason: evaluation.reason,
      });
      observed.push({ attemptId: attempt.id, evaluation, semanticQuery: step.semanticQuery });
      if (evaluation.decision === "accept") {
        await this.selectVerifiedAttempt(
          identity, input, plan,
          { attemptId: attempt.id, semanticQuery: step.semanticQuery },
          { terminalDecision: "accept", decisionReason: evaluation.reason },
        );
        return;
      }
      if (evaluation.decision === "stop") {
        const best = bestObservedAttempt(observed);
        await this.selectVerifiedAttempt(identity, input, plan, best, {
          terminalDecision: "stop",
          decisionReason: best.evaluation.reason,
          coverageWarning: evaluation.coverageWarning ?? undefined,
        });
        return;
      }
      step = this.ladder.next(step, intent, evaluation.decision, plan.provider_key);
    }
  }

  /**
   * Records the chosen query, having first checked it at the page size history
   * import will actually request.
   *
   * Evaluation previews 15 results; the import asks for 100. Those are
   * different requests to the provider, and a query can pass one while failing
   * the other — a broad boolean arXiv query answered 200 at 15 rows and 5xx at
   * 100, so a plan validated here imported nothing, and Research went on to
   * report "no relevant sources" over a corpus that was missing that provider
   * entirely. Verifying the shape that will be used is the only way the gap is
   * visible before the import runs.
   *
   * A failure here is recorded, not fatal: the import narrows its page size on
   * exactly this failure and may still succeed. The warning exists so the
   * reader is not told the query was validated when only a smaller form of it
   * was.
   */
  private async selectVerifiedAttempt(
    identity: SpaceUserIdentity,
    input: AdaptiveResearchQueryInput,
    plan: StoredResearchQueryProviderPlan,
    chosen: { attemptId: string; semanticQuery: ResearchSemanticQuery },
    selection: { terminalDecision: "accept" | "stop"; decisionReason: string; coverageWarning?: string },
  ): Promise<void> {
    const executionWarning = await this.executionShapeWarning(identity, input, plan, chosen.semanticQuery);
    const coverageWarning = [selection.coverageWarning, executionWarning].filter(Boolean).join(" ") || undefined;
    await this.repository.selectAttempt(identity.spaceId, plan.id, chosen.attemptId, {
      terminalDecision: selection.terminalDecision,
      decisionReason: selection.decisionReason,
      ...(coverageWarning ? { coverageWarning } : {}),
    });
  }

  private async executionShapeWarning(
    identity: SpaceUserIdentity,
    input: AdaptiveResearchQueryInput,
    plan: StoredResearchQueryProviderPlan,
    semanticQuery: ResearchSemanticQuery,
  ): Promise<string | null> {
    const compiled = this.compiler.compile(plan.provider_key, semanticQuery, { pageSize: IMPORT_PAGE_SIZE });
    try {
      await this.previewGateway.preview(identity, {
        compiledQuery: compiled,
        accessibleResultCap: IMPORT_PAGE_SIZE,
        credentialId: input.credentials?.[plan.provider_key],
      });
      return null;
    } catch (error) {
      return `The query was validated on a small preview but did not answer at the ${IMPORT_PAGE_SIZE}-result page size history import uses (${errorMessage(error)}). The import will retry at smaller pages; expect it to be slower, or narrow the query.`;
    }
  }
}

interface ObservedAttempt {
  attemptId: string;
  evaluation: AdaptiveQueryEvaluation;
  semanticQuery: ResearchSemanticQuery;
}

function bestObservedAttempt(observed: ObservedAttempt[]): ObservedAttempt {
  // An attempt whose own evaluation asked for more adaptation (narrow/broaden)
  // said, in effect, "this result isn't good enough as-is" — it must not
  // outrank a settled (stop/accept) attempt just because a saturated yield
  // score gave it a higher raw number. yieldScore caps at 1.0 once projected
  // yield clears the floor at all, so a wildly oversized, low-precision
  // result can hit the same ceiling as a well-scoped one while only paying a
  // capped overload penalty — score and decision can disagree.
  const settled = observed.filter((item) => item.evaluation.decision !== "narrow" && item.evaluation.decision !== "broaden");
  const pool = settled.length > 0 ? settled : observed;
  return [...pool].sort((left, right) => right.evaluation.score - left.evaluation.score)[0]!;
}

function assertContextAssessmentPassed(assessment: Record<string, unknown>): void {
  const finer = assessment.finer;
  if (assessment.answerable !== true || !finer || typeof finer !== "object" || Array.isArray(finer)) {
    throw new HttpError(422, "Research context has not passed question assessment");
  }
  const scores = ["feasible", "interesting", "novel", "ethical", "relevant"]
    .map((key) => Number((finer as Record<string, unknown>)[key]));
  if (scores.some((score) => !Number.isInteger(score) || score < 1 || score > 5)
    || scores.reduce((sum, score) => sum + score, 0) / scores.length < 3) {
    throw new HttpError(422, "Research context has not passed question assessment");
  }
}

export function errorClass(error: unknown): string {
  // ProviderPreviewGateway maps most non-retryable upstream failures to a
  // generic outward statusCode (502/422/503) since this catch block is its
  // only consumer, but preserves what actually happened in responseBody —
  // including the give-up-after-retry 503, whose second attempt could have
  // been a timeout, a fresh 429, or a real upstream 5xx — prefer that so
  // this reports the real cause (e.g. "http_400" or "timeout") instead of a
  // one-size-fits-all "http_502"/"http_503" for every failure.
  const upstreamStatus = upstreamStatusOf(error);
  if (upstreamStatus === "timeout") return "timeout";
  if (upstreamStatus !== null) return `http_${upstreamStatus}`;
  if (error && typeof error === "object" && "statusCode" in error) return `http_${String((error as { statusCode?: unknown }).statusCode)}`;
  return error instanceof Error ? error.name.slice(0, 64) : "provider_error";
}

function upstreamStatusOf(error: unknown): number | "timeout" | null {
  if (!error || typeof error !== "object" || !("responseBody" in error)) return null;
  const body = (error as { responseBody?: unknown }).responseBody;
  if (!body || typeof body !== "object" || !("upstream_status" in body)) return null;
  const status = (body as { upstream_status?: unknown }).upstream_status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  return status === "timeout" ? "timeout" : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
}

function isPermanentProviderError(error: unknown): boolean {
  const status = error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode)
    : 0;
  return status === 401 || status === 403 || status === 422;
}
