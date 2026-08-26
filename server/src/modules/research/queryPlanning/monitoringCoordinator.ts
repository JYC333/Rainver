import { randomUUID } from "node:crypto";
import type { ServerConfig } from "../../../config.js";
import { insertProposalRow } from "../../proposals/reviewPackets.js";
import type { Queryable, SpaceUserIdentity } from "../../routeUtils/common.js";
import { AdaptiveQueryOrchestrator } from "./adaptiveQueryOrchestrator.js";
import {
  DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY,
  evaluateResearchMonitoringFeedback,
  type ResearchQueryPerformanceObservation,
} from "./monitoringFeedback.js";
import { ResearchQueryRepository } from "./repository.js";

interface ObservationRow {
  new_candidate_count: number;
  screened_count: number;
  accepted_count: number;
  duplicate_rate: number;
  queue_latency_ms: number | null;
  core_concept_coverage: number | null;
  observed_at: string;
}

export class ResearchMonitoringCoordinator {
  constructor(private readonly db: Queryable, private readonly config: ServerConfig) {}

  async recordAndMaybePropose(input: {
    identity: SpaceUserIdentity;
    projectId: string;
    strategyId: string;
    scanSummaryId: string;
    observedAt: string;
    newCandidateCount: number;
    relevantCount: number;
    maybeCount: number;
    excludedCount: number;
    duplicateRate?: number;
    queueLatencyMs?: number | null;
    coreConceptCoverage?: number | null;
  }): Promise<{ proposal_id: string | null; direction: "broaden" | "narrow" | null; reason: string }> {
    const screenedCount = input.relevantCount + input.maybeCount + input.excludedCount;
    const acceptedCount = input.relevantCount + input.maybeCount;
    await this.db.query(
      `INSERT INTO research_query_performance_observations
        (id,space_id,strategy_id,scan_summary_id,new_candidate_count,screened_count,accepted_count,
         duplicate_rate,queue_latency_ms,core_concept_coverage,observed_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       ON CONFLICT (scan_summary_id,strategy_id) DO NOTHING`,
      [randomUUID(), input.identity.spaceId, input.strategyId, input.scanSummaryId, input.newCandidateCount,
        screenedCount, acceptedCount, input.duplicateRate ?? 0, input.queueLatencyMs ?? null,
        input.coreConceptCoverage ?? null, input.observedAt],
    );
    const active = await this.db.query<{ active: boolean }>(
      `SELECT true AS active
         FROM research_query_strategy_activations
        WHERE space_id=$1 AND project_id=$2 AND strategy_id=$3 AND deactivated_at IS NULL
        LIMIT 1`,
      [input.identity.spaceId, input.projectId, input.strategyId],
    );
    if (!active.rows[0]) {
      return { proposal_id: null, direction: null, reason: "The observed query strategy is no longer active." };
    }
    const observations = await this.db.query<ObservationRow>(
      `SELECT new_candidate_count,screened_count,accepted_count,duplicate_rate,
              queue_latency_ms,core_concept_coverage,observed_at
         FROM research_query_performance_observations
        WHERE space_id=$1 AND strategy_id=$2
        ORDER BY observed_at DESC,id DESC
        LIMIT $3`,
      [input.identity.spaceId, input.strategyId, DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY.rollingWindow],
    );
    const lastChange = await this.db.query<{ changed_at: string | null }>(
      `SELECT max(changed_at) AS changed_at FROM (
         SELECT max(activated_at) AS changed_at
           FROM research_query_strategy_activations
          WHERE space_id=$1 AND strategy_id=$2
         UNION ALL
         SELECT max(created_at) AS changed_at
           FROM proposals
          WHERE space_id=$1 AND project_id=$3 AND proposal_type='research_query_strategy_activation'
         UNION ALL
         SELECT max(created_at) AS changed_at
           FROM research_query_strategies
          WHERE space_id=$1 AND parent_strategy_id=$2
       ) changes`,
      [input.identity.spaceId, input.strategyId, input.projectId],
    );
    const decision = evaluateResearchMonitoringFeedback({
      observations: observations.rows.map(mapObservation),
      now: input.observedAt,
      lastProposalOrActivationAt: lastChange.rows[0]?.changed_at ?? null,
    });
    if (!decision.direction) return { proposal_id: null, direction: null, reason: decision.reason };

    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM proposals
        WHERE space_id=$1 AND project_id=$2 AND proposal_type='research_query_strategy_activation'
          AND status='pending'
        LIMIT 1`,
      [input.identity.spaceId, input.projectId],
    );
    if (existing.rows[0]) return { proposal_id: existing.rows[0].id, direction: decision.direction, reason: "A query adaptation proposal is already pending." };

    const source = await new ResearchQueryRepository(this.db).getStrategy(input.identity.spaceId, input.projectId, input.strategyId);
    if (!source || source.status !== "materialized") return { proposal_id: null, direction: null, reason: "The observed query strategy is no longer materialized." };
    if (source.provider_plans.some((plan) => plan.selected_attempt_id && plan.provider_key === "web_search")) {
      return { proposal_id: null, direction: null, reason: "Managed web credentials require an explicit user-led query reassessment." };
    }
    const candidateBudget = Math.max(1, Math.min(10_000, Number(source.execution_budget.candidate_budget) || 1_000));
    const candidate = await new AdaptiveQueryOrchestrator(this.db, this.config).evaluateVersion(input.identity, {
      projectId: input.projectId,
      sourceStrategyId: input.strategyId,
      direction: decision.direction,
      candidateBudget,
    });
    if (!candidate.provider_plans.some((plan) => plan.status === "selected")) {
      return { proposal_id: null, direction: null, reason: "The replacement strategy produced no selectable provider query." };
    }
    try {
      const proposal = await insertProposalRow(this.db, {
        spaceId: input.identity.spaceId,
        proposalType: "research_query_strategy_activation",
        title: `${decision.direction === "broaden" ? "Broaden" : "Narrow"} monitored research queries`,
        summary: `${decision.reason} Review the evaluated replacement before activating it.`,
        payload: {
          proposal_type: "research_query_strategy_activation",
          project_id: input.projectId,
          source_strategy_id: input.strategyId,
          candidate_strategy_id: candidate.id,
          direction: decision.direction,
          observation_count: decision.metrics.observation_count,
          metrics: decision.metrics,
        },
        rationale: decision.reason,
        createdByUserId: input.identity.userId,
        visibility: "private",
        projectId: input.projectId,
        riskLevel: "medium",
        urgency: "normal",
      });
      return { proposal_id: proposal.id, direction: decision.direction, reason: decision.reason };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const concurrent = await this.db.query<{ id: string }>(
        `SELECT id FROM proposals
          WHERE space_id=$1 AND project_id=$2 AND proposal_type='research_query_strategy_activation' AND status='pending'
          LIMIT 1`,
        [input.identity.spaceId, input.projectId],
      );
      if (!concurrent.rows[0]) throw error;
      return { proposal_id: concurrent.rows[0].id, direction: decision.direction, reason: "A concurrent scan already created the query adaptation proposal." };
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

function mapObservation(row: ObservationRow): ResearchQueryPerformanceObservation {
  return {
    newCandidateCount: Number(row.new_candidate_count),
    screenedCount: Number(row.screened_count),
    acceptedCount: Number(row.accepted_count),
    duplicateRate: Number(row.duplicate_rate),
    queueLatencyMs: row.queue_latency_ms === null ? null : Number(row.queue_latency_ms),
    coreConceptCoverage: row.core_concept_coverage === null ? null : Number(row.core_concept_coverage),
    observedAt: new Date(row.observed_at).toISOString(),
  };
}
