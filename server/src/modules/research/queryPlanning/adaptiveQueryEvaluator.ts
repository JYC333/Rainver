import type { ResearchPreviewObservation, ResearchQueryDecision } from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ResearchQueryPolicy } from "./queryPolicy";

export interface AdaptiveQueryEvaluation {
  decision: ResearchQueryDecision;
  score: number;
  reason: string;
  coverageWarning: string | null;
  projectedRelevantYield: number;
  loadRatio: number;
}

export class AdaptiveQueryEvaluator {
  evaluate(
    observation: ResearchPreviewObservation,
    policy: ResearchQueryPolicy,
    attemptSequence: number,
  ): AdaptiveQueryEvaluation {
    const load = Math.min(observation.provider_hit_count, observation.accessible_hit_count, policy.accessibleResultCap);
    const projectedRelevantYield = load * observation.relevance_lower_bound;
    const loadRatio = load / policy.candidateBudget;
    const slightlyLow = projectedRelevantYield >= policy.relevantEvidenceFloor * policy.slightlyLowRatio
      && observation.relevance_rate >= policy.strongRelevanceRate;
    const noisyOverload = loadRatio > policy.narrowLoadRatio
      && observation.relevance_lower_bound < policy.lowRelevanceLowerBound;
    const poorCoverage = observation.diversity_score < policy.minimumDiversity;

    let preferred: ResearchQueryDecision;
    let reason: string;
    if (load === 0) {
      preferred = "broaden";
      reason = "The provider returned no candidates.";
    } else if (noisyOverload) {
      preferred = "narrow";
      reason = "Projected screening load is high while preview relevance is low.";
    } else if (projectedRelevantYield < policy.relevantEvidenceFloor && !slightlyLow) {
      preferred = "broaden";
      reason = poorCoverage
        ? "Projected relevant yield and core-concept coverage are below target."
        : "Projected relevant yield is below target.";
    } else if (poorCoverage) {
      preferred = "broaden";
      reason = "Preview samples cover too few core concepts.";
    } else {
      preferred = "accept";
      reason = loadRatio > policy.narrowLoadRatio
        ? "The result set is broad but preview relevance is strong; pagination will cap screening load."
        : slightlyLow && projectedRelevantYield < policy.relevantEvidenceFloor
          ? "Yield is slightly below target but preview relevance is strong."
          : "Projected relevant yield and screening load are within policy.";
    }

    const exhausted = attemptSequence >= policy.maxAttempts && preferred !== "accept";
    const decision = exhausted ? "stop" : preferred;
    const coverageWarning = decision === "stop"
      ? `Query evaluation stopped after ${policy.maxAttempts} attempts: ${reason}`
      : null;
    return {
      decision,
      score: queryScore(observation, policy, projectedRelevantYield, loadRatio),
      reason,
      coverageWarning,
      projectedRelevantYield,
      loadRatio,
    };
  }
}

function queryScore(
  observation: ResearchPreviewObservation,
  policy: ResearchQueryPolicy,
  projectedRelevantYield: number,
  loadRatio: number,
): number {
  const yieldScore = Math.min(1, projectedRelevantYield / policy.relevantEvidenceFloor);
  // yieldScore saturates at 1.0 as soon as projected yield clears the floor —
  // 17x over the floor scores the same as barely over it. Uncapped (beyond
  // the final Math.max(0, ...) clamp below) and steeper than the old
  // min(0.35, ratio*0.05): a query overloaded 3x past narrowLoadRatio with
  // weak relevance must lose more than the 0.4 a saturated yieldScore can
  // hand it, or an oversized, low-precision result mathematically outscores
  // a well-scoped one.
  const overloadPenalty = loadRatio > policy.narrowLoadRatio && observation.relevance_lower_bound < policy.lowRelevanceLowerBound
    ? (loadRatio - policy.narrowLoadRatio) * 0.1
    : 0;
  const score = yieldScore * 0.4
    + observation.relevance_rate * 0.3
    + observation.diversity_score * 0.2
    + (1 - observation.duplicate_rate) * 0.1
    - overloadPenalty;
  return Math.max(0, Math.min(1, Number(score.toFixed(6))));
}
