import { randomUUID } from "node:crypto";
import * as protocol from "@agent-space/protocol";
import type {
  ResearchCompiledQuery,
  ResearchPreviewObservation,
  ResearchProviderKey,
  ResearchQueryAttemptDirection,
  ResearchQueryDecision,
  ResearchSemanticQuery,
} from "@agent-space/protocol";
import {
  HttpError,
  type Queryable,
  type SpaceUserIdentity,
  dateIso,
  withQueryableTransaction,
} from "../../routeUtils/common.js";
import { MAX_RESEARCH_QUERY_ATTEMPTS } from "./queryPolicy.js";

export interface CreateResearchQueryStrategyInput {
  projectId: string;
  researchContextVersionId: string;
  providers: ResearchProviderKey[];
  policyVersion: string;
  policy: Record<string, unknown>;
  executionBudget: Record<string, unknown>;
  operationId?: string | null;
  parentStrategyId?: string | null;
  adaptationDirection?: "broaden" | "narrow" | "rollback" | null;
}

export interface CreateResearchQueryAttemptInput {
  providerPlanId: string;
  round: number;
  sequence: number;
  direction: ResearchQueryAttemptDirection;
  semanticQuery: ResearchSemanticQuery;
  compiledQuery: ResearchCompiledQuery;
}

export interface CompleteResearchQueryAttemptInput {
  observation?: ResearchPreviewObservation;
  score?: number;
  decision?: ResearchQueryDecision;
  decisionReason?: string;
  errorClass?: string;
}

export interface StoredResearchQueryStrategy {
  id: string;
  project_id: string;
  research_context_version_id: string;
  question_snapshot: string;
  status: string;
  policy_version: string;
  policy: Record<string, unknown>;
  execution_budget: Record<string, unknown>;
  version: number;
  parent_strategy_id: string | null;
  adaptation_direction: "broaden" | "narrow" | "rollback" | null;
  created_at: string;
  selected_at: string | null;
  materialized_at: string | null;
  provider_plans: StoredResearchQueryProviderPlan[];
}

export interface StoredResearchQueryProviderPlan {
  id: string;
  provider_key: ResearchProviderKey;
  status: string;
  selected_attempt_id: string | null;
  terminal_decision: ResearchQueryDecision | null;
  decision_reason: string | null;
  coverage_warning: string | null;
  attempts: StoredResearchQueryAttempt[];
}

export interface StoredResearchQueryAttempt {
  id: string;
  provider_plan_id: string;
  round: number;
  sequence: number;
  direction: ResearchQueryAttemptDirection;
  semantic_query: ResearchSemanticQuery;
  compiled_query: ResearchCompiledQuery;
  observation: ResearchPreviewObservation | null;
  score: number | null;
  decision: ResearchQueryDecision | null;
  decision_reason: string | null;
  error_class: string | null;
  created_at: string;
  completed_at: string | null;
}

interface StrategyRow {
  id: string;
  project_id: string;
  research_context_version_id: string;
  question_snapshot: string;
  status: string;
  policy_version: string;
  policy_json: unknown;
  execution_budget_json: unknown;
  version: number;
  parent_strategy_id: string | null;
  adaptation_direction: string | null;
  created_at: string;
  selected_at: string | null;
  materialized_at: string | null;
}

interface PlanRow {
  id: string;
  strategy_id: string;
  provider_key: string;
  status: string;
  terminal_decision: string | null;
  decision_reason: string | null;
  coverage_warning: string | null;
  selected_attempt_id: string | null;
}

interface AttemptRow {
  id: string;
  provider_plan_id: string;
  round: number;
  sequence: number;
  direction: string;
  semantic_query_json: unknown;
  compiled_query_json: unknown;
  provider_hit_count: number | null;
  accessible_hit_count: number | null;
  sample_summary_json: unknown;
  relevance_metrics_json: unknown;
  score: number | null;
  decision: string | null;
  decision_reason: string | null;
  error_class: string | null;
  created_at: string;
  completed_at: string | null;
}

export class ResearchQueryRepository {
  constructor(private readonly db: Queryable) {}

  async createStrategy(
    identity: SpaceUserIdentity,
    input: CreateResearchQueryStrategyInput,
  ): Promise<StoredResearchQueryStrategy> {
    const providers = [...new Set(input.providers.map((provider) => protocol.ResearchProviderKeySchema.parse(provider)))];
    if (providers.length === 0 || providers.length > 4) throw new HttpError(422, "Between one and four research providers are required");
    if (!input.policyVersion.trim()) throw new HttpError(422, "policyVersion is required");

    const strategyId = randomUUID();
    const createdAt = new Date().toISOString();
    await withQueryableTransaction(this.db, async (db) => {
      const context = await db.query<{ objective: string }>(
        `SELECT objective
           FROM project_research_context_versions
          WHERE id=$1 AND project_id=$2 AND space_id=$3
          FOR UPDATE`,
        [input.researchContextVersionId, input.projectId, identity.spaceId],
      );
      if (!context.rows[0]) throw new HttpError(404, "Research context version not found");
      if (input.parentStrategyId) {
        const parent = await db.query(
          `SELECT 1 FROM research_query_strategies
            WHERE id=$1 AND project_id=$2 AND research_context_version_id=$3 AND space_id=$4`,
          [input.parentStrategyId, input.projectId, input.researchContextVersionId, identity.spaceId],
        );
        if (!parent.rows[0]) throw new HttpError(422, "Parent query strategy must belong to the same project and research context");
      }
      const versionResult = await db.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version),0) + 1 AS next_version
           FROM research_query_strategies
          WHERE space_id=$1 AND project_id=$2 AND research_context_version_id=$3`,
        [identity.spaceId, input.projectId, input.researchContextVersionId],
      );
      const version = Number(versionResult.rows[0]?.next_version ?? 1);

      await db.query(
        `INSERT INTO research_query_strategies
          (id,space_id,project_id,operation_id,research_context_version_id,created_by_user_id,question_snapshot,status,policy_version,policy_json,execution_budget_json,version,parent_strategy_id,adaptation_direction,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'planning',$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14)`,
        [strategyId, identity.spaceId, input.projectId, input.operationId ?? null, input.researchContextVersionId, identity.userId, context.rows[0].objective, input.policyVersion, JSON.stringify(input.policy), JSON.stringify(input.executionBudget), version, input.parentStrategyId ?? null, input.adaptationDirection ?? null, createdAt],
      );
      for (const provider of providers) {
        await db.query(
          `INSERT INTO research_query_provider_plans
            (id,space_id,strategy_id,provider_key,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,'pending',$5,$5)`,
          [randomUUID(), identity.spaceId, strategyId, provider, createdAt],
        );
      }
    });
    return (await this.getStrategy(identity.spaceId, input.projectId, strategyId))!;
  }

  async createAttempt(spaceId: string, input: CreateResearchQueryAttemptInput): Promise<StoredResearchQueryAttempt> {
    const direction = protocol.ResearchQueryAttemptDirectionSchema.parse(input.direction);
    const semanticQuery = protocol.ResearchSemanticQuerySchema.parse(input.semanticQuery);
    const compiledQuery = protocol.ResearchCompiledQuerySchema.parse(input.compiledQuery);
    if (input.sequence < 1 || input.sequence > MAX_RESEARCH_QUERY_ATTEMPTS) throw new HttpError(422, `Research query attempt sequence must be between 1 and ${MAX_RESEARCH_QUERY_ATTEMPTS}`);

    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await withQueryableTransaction(this.db, async (db) => {
      const plan = await db.query<{ provider_key: string }>(
        `SELECT provider_key
           FROM research_query_provider_plans
          WHERE id=$1 AND space_id=$2
          FOR UPDATE`,
        [input.providerPlanId, spaceId],
      );
      if (!plan.rows[0]) throw new HttpError(404, "Research provider plan not found");
      const sequenceResult = await db.query<{ next_sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM research_query_attempts
          WHERE provider_plan_id=$1 AND space_id=$2 AND round=$3`,
        [input.providerPlanId, spaceId, input.round],
      );
      if (Number(sequenceResult.rows[0]?.next_sequence ?? 1) !== input.sequence) throw new HttpError(409, "Research query attempt sequence is stale");
      if (plan.rows[0].provider_key !== compiledQuery.provider_key) throw new HttpError(422, "Compiled query provider does not match provider plan");

      await db.query(
        `INSERT INTO research_query_attempts
          (id,space_id,provider_plan_id,round,sequence,direction,semantic_query_json,compiled_query_json,query_fingerprint,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
        [id, spaceId, input.providerPlanId, input.round, input.sequence, direction, JSON.stringify(semanticQuery), JSON.stringify(compiledQuery), compiledQuery.fingerprint, createdAt],
      );
      await db.query(
        `UPDATE research_query_provider_plans SET status='evaluating',updated_at=$3 WHERE id=$1 AND space_id=$2`,
        [input.providerPlanId, spaceId, createdAt],
      );
    });
    return {
      id,
      provider_plan_id: input.providerPlanId,
      round: input.round,
      sequence: input.sequence,
      direction,
      semantic_query: semanticQuery,
      compiled_query: compiledQuery,
      observation: null,
      score: null,
      decision: null,
      decision_reason: null,
      error_class: null,
      created_at: createdAt,
      completed_at: null,
    };
  }

  async markStrategyEvaluating(spaceId: string, strategyId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE research_query_strategies
          SET status='evaluating'
        WHERE id=$1 AND space_id=$2 AND status='planning'`,
      [strategyId, spaceId],
    );
    if (result.rowCount !== 1) throw new HttpError(409, "Research query strategy is not ready for evaluation");
  }

  async completeAttempt(spaceId: string, attemptId: string, input: CompleteResearchQueryAttemptInput): Promise<void> {
    const observation = input.observation ? protocol.ResearchPreviewObservationSchema.parse(input.observation) : null;
    const decision = input.decision ? protocol.ResearchQueryDecisionSchema.parse(input.decision) : null;
    if (!observation && !input.errorClass) throw new HttpError(422, "An observation or error class is required");
    const completedAt = new Date().toISOString();
    const result = await this.db.query(
      `UPDATE research_query_attempts
          SET provider_hit_count=$3,accessible_hit_count=$4,sample_summary_json=$5::jsonb,
              relevance_metrics_json=$6::jsonb,score=$7,decision=$8,decision_reason=$9,error_class=$10,completed_at=$11
        WHERE id=$1 AND space_id=$2 AND completed_at IS NULL`,
      [
        attemptId,
        spaceId,
        observation?.provider_hit_count ?? null,
        observation?.accessible_hit_count ?? null,
        observation ? JSON.stringify({ samples: observation.samples }) : null,
        observation ? JSON.stringify({
          relevance_rate: observation.relevance_rate,
          relevance_lower_bound: observation.relevance_lower_bound,
          diversity_score: observation.diversity_score,
          duplicate_rate: observation.duplicate_rate,
        }) : null,
        input.score ?? null,
        decision,
        input.decisionReason?.slice(0, 1_000) ?? null,
        input.errorClass?.slice(0, 64) ?? null,
        completedAt,
      ],
    );
    if (result.rowCount !== 1) throw new HttpError(409, "Research query attempt is unavailable or already completed");
  }

  async selectAttempt(
    spaceId: string,
    providerPlanId: string,
    attemptId: string,
    input: { terminalDecision: ResearchQueryDecision; decisionReason?: string; coverageWarning?: string } = { terminalDecision: "accept" },
  ): Promise<void> {
    const terminalDecision = protocol.ResearchQueryDecisionSchema.parse(input.terminalDecision);
    await withQueryableTransaction(this.db, async (db) => {
      const attempt = await db.query<{ completed_at: string | null }>(
        `SELECT completed_at FROM research_query_attempts
          WHERE id=$1 AND provider_plan_id=$2 AND space_id=$3
          FOR UPDATE`,
        [attemptId, providerPlanId, spaceId],
      );
      if (!attempt.rows[0]) throw new HttpError(404, "Research query attempt not found");
      if (!attempt.rows[0].completed_at) throw new HttpError(409, "Research query attempt is not complete");
      const selectedAt = new Date().toISOString();
      try {
        await db.query(
          `INSERT INTO research_query_provider_selections (provider_plan_id,attempt_id,space_id,selected_at)
           VALUES ($1,$2,$3,$4)`,
          [providerPlanId, attemptId, spaceId, selectedAt],
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpError(409, "Research provider plan already has a selected attempt");
        throw error;
      }
      await db.query(
        `UPDATE research_query_provider_plans
            SET status='selected',terminal_decision=$3,decision_reason=$4,coverage_warning=$5,updated_at=$6
          WHERE id=$1 AND space_id=$2`,
        [providerPlanId, spaceId, terminalDecision, input.decisionReason?.slice(0, 1_000) ?? null, input.coverageWarning?.slice(0, 1_000) ?? null, selectedAt],
      );
    });
  }

  async markProviderUnavailable(
    spaceId: string,
    providerPlanId: string,
    input: { failed: boolean; reason: string },
  ): Promise<void> {
    const result = await this.db.query(
      `UPDATE research_query_provider_plans
          SET status=$3,terminal_decision='stop',decision_reason=$4,updated_at=$5
        WHERE id=$1 AND space_id=$2 AND status IN ('pending','evaluating')`,
      [providerPlanId, spaceId, input.failed ? "failed" : "unavailable", input.reason.slice(0, 1_000), new Date().toISOString()],
    );
    if (result.rowCount !== 1) throw new HttpError(409, "Research provider plan is already terminal");
  }

  async resetProviderPlan(spaceId: string, providerPlanId: string): Promise<{ nextRound: number }> {
    return withQueryableTransaction(this.db, async (db) => {
      const updatedAt = new Date().toISOString();
      const state = await db.query<{ status: string; materialized_at: string | null }>(
        `SELECT p.status, s.materialized_at
           FROM research_query_provider_plans p
           JOIN research_query_strategies s ON s.id=p.strategy_id AND s.space_id=p.space_id
          WHERE p.id=$1 AND p.space_id=$2
          FOR UPDATE OF p`,
        [providerPlanId, spaceId],
      );
      if (!state.rows[0]) throw new HttpError(404, "Research provider plan not found");
      // Once the strategy is materialized, a source channel/binding already
      // references this plan's selected attempt by id and fingerprint —
      // silently swapping the selection out from under it would desync what
      // the strategy shows from what is actually running. Retrying (either
      // an unavailable plan or one whose selection the user wants to keep
      // improving) is only safe before that point.
      if (state.rows[0].materialized_at !== null) throw new HttpError(409, "Cannot retry a provider plan once its query strategy has been materialized");
      if (!["unavailable", "selected"].includes(state.rows[0].status)) throw new HttpError(409, "Only an unavailable or already-selected research provider plan can be retried");

      await db.query(
        `UPDATE research_query_provider_plans
            SET status='pending',terminal_decision=NULL,decision_reason=NULL,coverage_warning=NULL,updated_at=$3
          WHERE id=$1 AND space_id=$2`,
        [providerPlanId, spaceId, updatedAt],
      );
      // A `selected` plan has a row here; clearing it makes room for the
      // retry's own selectAttempt call, which would otherwise 409 on the
      // provider_plan_id primary key.
      await db.query(
        `DELETE FROM research_query_provider_selections WHERE provider_plan_id=$1 AND space_id=$2`,
        [providerPlanId, spaceId],
      );
      const roundResult = await db.query<{ next_round: number }>(
        `SELECT COALESCE(MAX(round), -1) + 1 AS next_round
           FROM research_query_attempts
          WHERE provider_plan_id=$1 AND space_id=$2`,
        [providerPlanId, spaceId],
      );
      return { nextRound: Number(roundResult.rows[0]?.next_round ?? 0) };
    });
  }

  async finalizeStrategy(spaceId: string, strategyId: string, options: { force?: boolean } = {}): Promise<"selected" | "failed"> {
    return withQueryableTransaction(this.db, async (db) => {
      const strategy = await db.query<{ status: string }>(
        `SELECT status FROM research_query_strategies WHERE id=$1 AND space_id=$2 FOR UPDATE`,
        [strategyId, spaceId],
      );
      if (!strategy.rows[0]) throw new HttpError(404, "Research query strategy not found");
      if (!options.force) {
        if (strategy.rows[0].status === "selected") return "selected";
        if (strategy.rows[0].status === "failed") return "failed";
      }
      const plans = await db.query<{ status: string; selected: boolean }>(
        `SELECT p.status,(s.attempt_id IS NOT NULL) AS selected
           FROM research_query_provider_plans p
           LEFT JOIN research_query_provider_selections s ON s.provider_plan_id=p.id
          WHERE p.strategy_id=$1 AND p.space_id=$2
          FOR UPDATE OF p`,
        [strategyId, spaceId],
      );
      if (plans.rows.some((plan) => !["selected", "unavailable", "failed"].includes(plan.status))) {
        throw new HttpError(409, "Research query provider evaluation is still active");
      }
      const status = plans.rows.some((plan) => plan.selected) ? "selected" : "failed";
      const selectedAt = status === "selected" ? new Date().toISOString() : null;
      await db.query(
        `UPDATE research_query_strategies SET status=$3,selected_at=$4 WHERE id=$1 AND space_id=$2`,
        [strategyId, spaceId, status, selectedAt],
      );
      return status;
    });
  }

  async getStrategy(spaceId: string, projectId: string, strategyId: string): Promise<StoredResearchQueryStrategy | null> {
    const strategyResult = await this.db.query<StrategyRow>(
      `SELECT id,project_id,research_context_version_id,question_snapshot,status,policy_version,
              policy_json,execution_budget_json,version,parent_strategy_id,adaptation_direction,created_at,selected_at,materialized_at
         FROM research_query_strategies
        WHERE id=$1 AND space_id=$2 AND project_id=$3
        LIMIT 1`,
      [strategyId, spaceId, projectId],
    );
    const strategy = strategyResult.rows[0];
    if (!strategy) return null;

    const planResult = await this.db.query<PlanRow>(
      `SELECT p.id,p.strategy_id,p.provider_key,p.status,p.terminal_decision,p.decision_reason,p.coverage_warning,s.attempt_id AS selected_attempt_id
         FROM research_query_provider_plans p
         LEFT JOIN research_query_provider_selections s ON s.provider_plan_id=p.id
        WHERE p.strategy_id=$1 AND p.space_id=$2
        ORDER BY p.created_at,p.provider_key`,
      [strategyId, spaceId],
    );
    const planIds = planResult.rows.map((row) => row.id);
    const attempts = planIds.length
      ? await this.db.query<AttemptRow>(
        `SELECT id,provider_plan_id,round,sequence,direction,semantic_query_json,compiled_query_json,
                provider_hit_count,accessible_hit_count,sample_summary_json,relevance_metrics_json,
                score,decision,decision_reason,error_class,created_at,completed_at
           FROM research_query_attempts
          WHERE space_id=$1 AND provider_plan_id=ANY($2::text[])
          ORDER BY provider_plan_id,round,sequence`,
        [spaceId, planIds],
      )
      : { rows: [] as AttemptRow[] };

    return {
      id: strategy.id,
      project_id: strategy.project_id,
      research_context_version_id: strategy.research_context_version_id,
      question_snapshot: strategy.question_snapshot,
      status: strategy.status,
      policy_version: strategy.policy_version,
      policy: recordValue(strategy.policy_json),
      execution_budget: recordValue(strategy.execution_budget_json),
      version: Number(strategy.version),
      parent_strategy_id: strategy.parent_strategy_id,
      adaptation_direction: strategy.adaptation_direction === "broaden" || strategy.adaptation_direction === "narrow" || strategy.adaptation_direction === "rollback"
        ? strategy.adaptation_direction
        : null,
      created_at: dateIso(strategy.created_at) ?? new Date(0).toISOString(),
      selected_at: dateIso(strategy.selected_at),
      materialized_at: dateIso(strategy.materialized_at),
      provider_plans: planResult.rows.map((plan) => ({
        id: plan.id,
        provider_key: protocol.ResearchProviderKeySchema.parse(plan.provider_key),
        status: plan.status,
        selected_attempt_id: plan.selected_attempt_id,
        terminal_decision: plan.terminal_decision ? protocol.ResearchQueryDecisionSchema.parse(plan.terminal_decision) : null,
        decision_reason: plan.decision_reason,
        coverage_warning: plan.coverage_warning,
        attempts: attempts.rows.filter((attempt) => attempt.provider_plan_id === plan.id).map((attempt) => mapAttempt(attempt, protocol)),
      })),
    };
  }

  async listStrategies(spaceId: string, projectId: string): Promise<{ activeStrategyIds: string[]; strategies: StoredResearchQueryStrategy[] }> {
    const [ids, active] = await Promise.all([
      this.db.query<{ id: string }>(
        `SELECT id FROM research_query_strategies
          WHERE space_id=$1 AND project_id=$2
          ORDER BY research_context_version_id,version DESC`,
        [spaceId, projectId],
      ),
      this.db.query<{ strategy_id: string }>(
        `SELECT strategy_id FROM research_query_strategy_activations
          WHERE space_id=$1 AND project_id=$2 AND deactivated_at IS NULL
          ORDER BY activated_at DESC`,
        [spaceId, projectId],
      ),
    ]);
    const strategies = await Promise.all(ids.rows.map((row) => this.getStrategy(spaceId, projectId, row.id)));
    return {
      activeStrategyIds: active.rows.map((row) => row.strategy_id),
      strategies: strategies.filter((strategy): strategy is StoredResearchQueryStrategy => strategy !== null),
    };
  }
}

function mapAttempt(row: AttemptRow, protocol: typeof import("@agent-space/protocol")): StoredResearchQueryAttempt {
  const sampleSummary = recordValue(row.sample_summary_json);
  const metrics = recordValue(row.relevance_metrics_json);
  const observation = row.provider_hit_count === null || row.accessible_hit_count === null
    ? null
    : protocol.ResearchPreviewObservationSchema.parse({
      schema_version: "research_preview_observation.v1",
      provider_hit_count: Number(row.provider_hit_count),
      accessible_hit_count: Number(row.accessible_hit_count),
      samples: Array.isArray(sampleSummary.samples) ? sampleSummary.samples : [],
      relevance_rate: Number(metrics.relevance_rate ?? 0),
      relevance_lower_bound: Number(metrics.relevance_lower_bound ?? 0),
      diversity_score: Number(metrics.diversity_score ?? 0),
      duplicate_rate: Number(metrics.duplicate_rate ?? 0),
    });
  return {
    id: row.id,
    provider_plan_id: row.provider_plan_id,
    round: Number(row.round),
    sequence: Number(row.sequence),
    direction: protocol.ResearchQueryAttemptDirectionSchema.parse(row.direction),
    semantic_query: protocol.ResearchSemanticQuerySchema.parse(row.semantic_query_json),
    compiled_query: protocol.ResearchCompiledQuerySchema.parse(row.compiled_query_json),
    observation,
    score: row.score === null ? null : Number(row.score),
    decision: row.decision ? protocol.ResearchQueryDecisionSchema.parse(row.decision) : null,
    decision_reason: row.decision_reason,
    error_class: row.error_class,
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    completed_at: dateIso(row.completed_at),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}
