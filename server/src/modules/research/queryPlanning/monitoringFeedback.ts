export interface ResearchQueryPerformanceObservation {
  newCandidateCount: number;
  screenedCount: number;
  acceptedCount: number;
  duplicateRate: number;
  queueLatencyMs: number | null;
  coreConceptCoverage: number | null;
  observedAt: string;
}

export interface ResearchMonitoringFeedbackPolicy {
  minimumObservations: number;
  rollingWindow: number;
  cooldownMs: number;
  targetCandidatesPerScan: number;
  broadenArrivalRatio: number;
  narrowArrivalRatio: number;
  strongAcceptanceRate: number;
  lowAcceptanceLowerBound: number;
  minimumCoreConceptCoverage: number;
  maximumQueueLatencyMs: number;
}

export interface ResearchMonitoringFeedbackDecision {
  direction: "broaden" | "narrow" | null;
  reason: string;
  metrics: {
    observation_count: number;
    average_new_candidates: number;
    acceptance_rate: number;
    acceptance_lower_bound: number;
    average_duplicate_rate: number;
    average_queue_latency_ms: number | null;
    average_core_concept_coverage: number | null;
  };
}

export const DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY: ResearchMonitoringFeedbackPolicy = {
  minimumObservations: 3,
  rollingWindow: 5,
  cooldownMs: 14 * 24 * 60 * 60 * 1_000,
  targetCandidatesPerScan: 20,
  broadenArrivalRatio: 0.2,
  narrowArrivalRatio: 2,
  strongAcceptanceRate: 0.6,
  lowAcceptanceLowerBound: 0.35,
  minimumCoreConceptCoverage: 0.35,
  maximumQueueLatencyMs: 30 * 60 * 1_000,
};

/**
 * Evaluates only stable rolling evidence. The widen and narrow bands are
 * intentionally separated by a large healthy zone so one noisy scan cannot
 * make an active strategy oscillate between adjacent query levels.
 */
export function evaluateResearchMonitoringFeedback(input: {
  observations: ResearchQueryPerformanceObservation[];
  now: string;
  lastProposalOrActivationAt: string | null;
  policy?: ResearchMonitoringFeedbackPolicy;
}): ResearchMonitoringFeedbackDecision {
  const policy = input.policy ?? DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY;
  const observations = [...input.observations]
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .slice(0, policy.rollingWindow);
  const metrics = summarize(observations);
  if (observations.length < policy.minimumObservations) {
    return { direction: null, reason: `Waiting for ${policy.minimumObservations} comparable scans.`, metrics };
  }
  if (input.lastProposalOrActivationAt
    && Date.parse(input.now) - Date.parse(input.lastProposalOrActivationAt) < policy.cooldownMs) {
    return { direction: null, reason: "The query strategy is inside its adaptation cooldown.", metrics };
  }

  const lowArrival = metrics.average_new_candidates < policy.targetCandidatesPerScan * policy.broadenArrivalRatio;
  const noArrival = metrics.average_new_candidates === 0;
  const weakCoverage = metrics.average_core_concept_coverage !== null
    && metrics.average_core_concept_coverage < policy.minimumCoreConceptCoverage;
  if (noArrival || (lowArrival && metrics.acceptance_rate >= policy.strongAcceptanceRate) || weakCoverage) {
    return {
      direction: "broaden",
      reason: noArrival
        ? "Comparable rolling scans returned no new candidates."
        : weakCoverage
        ? "Rolling scans cover too few core concepts."
        : "Rolling scans find few candidates even though the candidates found are usually relevant.",
      metrics,
    };
  }

  const overloaded = metrics.average_new_candidates > policy.targetCandidatesPerScan * policy.narrowArrivalRatio;
  const noisy = metrics.acceptance_lower_bound < policy.lowAcceptanceLowerBound;
  const slowQueue = metrics.average_queue_latency_ms !== null
    && metrics.average_queue_latency_ms > policy.maximumQueueLatencyMs;
  if ((overloaded && noisy) || (overloaded && slowQueue)) {
    return {
      direction: "narrow",
      reason: slowQueue
        ? "Rolling candidate volume exceeds capacity and screening queues remain slow."
        : "Rolling candidate volume exceeds capacity while conservative screening acceptance is low.",
      metrics,
    };
  }
  return { direction: null, reason: "Rolling query performance remains inside the hysteresis band.", metrics };
}

function summarize(observations: ResearchQueryPerformanceObservation[]): ResearchMonitoringFeedbackDecision["metrics"] {
  const count = observations.length;
  const screened = observations.reduce((sum, item) => sum + item.screenedCount, 0);
  const accepted = observations.reduce((sum, item) => sum + item.acceptedCount, 0);
  const acceptanceRate = screened > 0 ? accepted / screened : 0;
  return {
    observation_count: count,
    average_new_candidates: average(observations.map((item) => item.newCandidateCount)),
    acceptance_rate: acceptanceRate,
    acceptance_lower_bound: wilsonLowerBound(accepted, screened),
    average_duplicate_rate: average(observations.map((item) => item.duplicateRate)),
    average_queue_latency_ms: nullableAverage(observations.map((item) => item.queueLatencyMs)),
    average_core_concept_coverage: nullableAverage(observations.map((item) => item.coreConceptCoverage)),
  };
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function nullableAverage(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? average(present) : null;
}

function wilsonLowerBound(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const centre = rate + z * z / (2 * total);
  const margin = z * Math.sqrt((rate * (1 - rate) + z * z / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}
