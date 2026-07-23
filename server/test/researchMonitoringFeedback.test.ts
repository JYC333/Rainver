import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY,
  evaluateResearchMonitoringFeedback,
  type ResearchQueryPerformanceObservation,
} from "../src/modules/research/queryPlanning/monitoringFeedback";

const NOW = "2026-07-20T12:00:00.000Z";

describe("research monitoring feedback", () => {
  it("waits for three comparable observations and respects the cooldown", () => {
    expect(evaluateResearchMonitoringFeedback({ observations: observations([2, 2]), now: NOW, lastProposalOrActivationAt: null }).direction).toBeNull();
    const cooling = evaluateResearchMonitoringFeedback({
      observations: observations([2, 2, 2]), now: NOW, lastProposalOrActivationAt: "2026-07-19T12:00:00.000Z",
    });
    expect(cooling.direction).toBeNull();
    expect(cooling.reason).toContain("cooldown");
  });

  it("proposes broadening after stable low-volume high-relevance scans", () => {
    const decision = evaluateResearchMonitoringFeedback({ observations: observations([2, 3, 2]), now: NOW, lastProposalOrActivationAt: null });
    expect(decision.direction).toBe("broaden");
    expect(decision.metrics.acceptance_rate).toBe(0.75);
  });

  it("proposes broadening after three comparable zero-result scans", () => {
    const decision = evaluateResearchMonitoringFeedback({ observations: observations([0, 0, 0], 0, 0), now: NOW, lastProposalOrActivationAt: null });
    expect(decision).toMatchObject({ direction: "broaden", reason: "Comparable rolling scans returned no new candidates." });
  });

  it("proposes narrowing only for overloaded noisy scans", () => {
    const noisy = observations([60, 55, 70], 2, 20);
    const decision = evaluateResearchMonitoringFeedback({ observations: noisy, now: NOW, lastProposalOrActivationAt: null });
    expect(decision.direction).toBe("narrow");
    expect(decision.metrics.acceptance_lower_bound).toBeLessThan(DEFAULT_RESEARCH_MONITORING_FEEDBACK_POLICY.lowAcceptanceLowerBound);
  });

  it("accepts slightly broad high-relevance scans inside the hysteresis band", () => {
    const useful = observations([35, 38, 36], 16, 20);
    expect(evaluateResearchMonitoringFeedback({ observations: useful, now: NOW, lastProposalOrActivationAt: null })).toMatchObject({
      direction: null,
      reason: "Rolling query performance remains inside the hysteresis band.",
    });
  });
});

function observations(candidateCounts: number[], acceptedCount = 15, screenedCount = 20): ResearchQueryPerformanceObservation[] {
  return candidateCounts.map((newCandidateCount, index) => ({
    newCandidateCount,
    screenedCount,
    acceptedCount,
    duplicateRate: 0.1,
    queueLatencyMs: 60_000,
    coreConceptCoverage: 0.8,
    observedAt: new Date(Date.parse(NOW) - index * 24 * 60 * 60 * 1_000).toISOString(),
  }));
}
