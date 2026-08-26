import type { ResearchProviderKey } from "@rainver/protocol";

export const RESEARCH_QUERY_POLICY_VERSION = "adaptive-recall.v1";

// broaden() now applies one relaxation per step (see queryLadderBuilder.ts)
// instead of dropping a qualifier and adding an expansion in the same jump,
// so the ladder needs one more attempt of room than before to actually reach
// a well-scoped result. Extra attempts cost provider request latency and
// rate-limit headroom, not LLM budget — the semantic query is generated once
// per evaluate() call and reused across every attempt and provider.
// Kept in sync with the protocol package's ResearchQueryAttemptSchema.sequence
// and ResearchQueryProviderPlanSchema.attempts bounds (packages/protocol/src/researchDiscovery.ts),
// which the protocol package cannot import this constant to enforce itself.
export const MAX_RESEARCH_QUERY_ATTEMPTS = 4;

export interface ResearchQueryPolicy {
  version: typeof RESEARCH_QUERY_POLICY_VERSION;
  maxAttempts: typeof MAX_RESEARCH_QUERY_ATTEMPTS;
  previewSampleSize: number;
  candidateBudget: number;
  relevantEvidenceFloor: number;
  slightlyLowRatio: number;
  narrowLoadRatio: number;
  lowRelevanceLowerBound: number;
  strongRelevanceRate: number;
  minimumDiversity: number;
  accessibleResultCap: number;
}

const PROVIDER_ACCESSIBLE_CAPS: Record<ResearchProviderKey, number> = {
  arxiv: 2_000,
  openalex: 10_000,
  semantic_scholar: 1_000,
  web_search: 200,
};

export function researchQueryPolicy(providerKey: ResearchProviderKey, candidateBudget: number): ResearchQueryPolicy {
  const budget = Math.min(10_000, Math.max(1, Math.trunc(candidateBudget)));
  return {
    version: RESEARCH_QUERY_POLICY_VERSION,
    maxAttempts: MAX_RESEARCH_QUERY_ATTEMPTS,
    previewSampleSize: 15,
    candidateBudget: budget,
    relevantEvidenceFloor: Math.max(5, Math.min(20, Math.ceil(budget * 0.2))),
    slightlyLowRatio: 0.6,
    narrowLoadRatio: 2,
    lowRelevanceLowerBound: 0.35,
    strongRelevanceRate: 0.6,
    minimumDiversity: 0.35,
    accessibleResultCap: PROVIDER_ACCESSIBLE_CAPS[providerKey],
  };
}

export function researchQueryPolicySnapshot(providers: ResearchProviderKey[], candidateBudget: number): Record<string, unknown> {
  return Object.fromEntries(providers.map((provider) => [provider, researchQueryPolicy(provider, candidateBudget)]));
}
