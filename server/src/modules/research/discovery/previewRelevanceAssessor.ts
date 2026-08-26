import type {
  ResearchContext,
  ResearchPreviewObservation,
  ResearchPreviewSample,
  ResearchSemanticQuery,
} from "@agent-space/protocol";

export interface ResearchPreviewCandidate {
  sampleId: string;
  title: string;
  sourceUri: string | null;
  occurredAt: string | null;
  excerpt: string | null;
}

export interface ResearchPreviewBatch {
  providerHitCount: number;
  accessibleHitCount: number;
  candidates: ResearchPreviewCandidate[];
}

export class PreviewRelevanceAssessor {
  assess(
    context: ResearchContext,
    semanticQuery: ResearchSemanticQuery,
    preview: ResearchPreviewBatch,
  ): ResearchPreviewObservation {
    const core = semanticQuery.core.map((concept) => ({
      name: concept.value,
      alternatives: [concept.value, ...concept.synonyms].map(normalizedTokens).filter((tokens) => tokens.size > 0),
    }));
    const qualifiers = [...semanticQuery.qualifiers, ...context.must_have.map((value) => ({ value, synonyms: [], weight: 1 }))]
      .flatMap((concept) => [concept.value, ...concept.synonyms])
      .map(normalizedTokens)
      .filter((tokens) => tokens.size > 0);
    const exclusions = [...semanticQuery.exclusions, ...context.out_of_scope.map((value) => ({ value, synonyms: [], weight: 1 }))]
      .flatMap((concept) => [concept.value, ...concept.synonyms])
      .map(normalizedTokens)
      .filter((tokens) => tokens.size > 0);

    const samples = preview.candidates.slice(0, 20).map((candidate) => classify(candidate, core, qualifiers, exclusions));
    const weightedRelevant = samples.reduce((total, sample) => total + (sample.relevance === "relevant" ? 1 : sample.relevance === "maybe" ? 0.5 : 0), 0);
    const relevanceRate = samples.length ? weightedRelevant / samples.length : 0;
    const matchedCore = new Set(samples.flatMap((sample) => sample.matched_core_concepts));
    return {
      schema_version: "research_preview_observation.v1",
      provider_hit_count: Math.max(0, Math.trunc(preview.providerHitCount)),
      accessible_hit_count: Math.max(0, Math.trunc(preview.accessibleHitCount)),
      samples,
      relevance_rate: rounded(relevanceRate),
      relevance_lower_bound: rounded(wilsonLowerBound(relevanceRate, samples.length)),
      diversity_score: rounded(core.length ? matchedCore.size / core.length : 0),
      duplicate_rate: rounded(duplicateRate(samples)),
    };
  }
}

function classify(
  candidate: ResearchPreviewCandidate,
  core: Array<{ name: string; alternatives: Set<string>[] }>,
  qualifiers: Set<string>[],
  exclusions: Set<string>[],
): ResearchPreviewSample {
  const haystack = normalizedTokens(`${candidate.title} ${candidate.excerpt ?? ""}`);
  const matchedCore = core.filter((concept) => concept.alternatives.some((tokens) => containsAll(haystack, tokens))).map((concept) => concept.name);
  const qualifierMatched = qualifiers.length === 0 || qualifiers.some((tokens) => containsAll(haystack, tokens));
  const excluded = exclusions.some((tokens) => containsAll(haystack, tokens));
  const coreRatio = core.length ? matchedCore.length / core.length : 0;
  const relevance = excluded
    ? "not_relevant"
    : coreRatio >= 0.5 && qualifierMatched
      ? "relevant"
      : coreRatio > 0
        ? "maybe"
        : "not_relevant";
  return {
    sample_id: candidate.sampleId.slice(0, 512),
    title: candidate.title.slice(0, 1_024),
    source_uri: candidate.sourceUri,
    occurred_at: candidate.occurredAt,
    excerpt: candidate.excerpt?.slice(0, 2_048) ?? null,
    relevance,
    matched_core_concepts: matchedCore.slice(0, 4),
  };
}

function normalizedTokens(value: string): Set<string> {
  const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(value.normalize("NFKC").toLocaleLowerCase());
  return new Set([...segments].filter((segment) => segment.isWordLike).map((segment) => segment.segment));
}

function containsAll(haystack: Set<string>, needle: Set<string>): boolean {
  return needle.size > 0 && [...needle].every((token) => haystack.has(token));
}

function wilsonLowerBound(rate: number, sampleSize: number): number {
  if (sampleSize === 0) return 0;
  const z = 1.96;
  const denominator = 1 + z ** 2 / sampleSize;
  const center = rate + z ** 2 / (2 * sampleSize);
  const margin = z * Math.sqrt((rate * (1 - rate) + z ** 2 / (4 * sampleSize)) / sampleSize);
  return Math.max(0, (center - margin) / denominator);
}

function duplicateRate(samples: ResearchPreviewSample[]): number {
  if (samples.length < 2) return 0;
  const unique = new Set(samples.map((sample) => sample.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()));
  return 1 - unique.size / samples.length;
}

function rounded(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}
