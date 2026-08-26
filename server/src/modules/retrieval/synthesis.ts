import type {
  RetrievalBrief,
  RetrievalCitation,
  RetrievalGapAnalysis,
  RetrievalObjectType,
} from "@agent-space/protocol";
import type { RetrievalEgressPolicy } from "./egress/egressPolicy.js";
import { candidateKey } from "./searchInternals.js";
import type { RevalidatedObject, ScoredCandidate } from "./types.js";

/**
 * Context Brief synthesis (W6 of the context-layer roadmap).
 *
 * Ask Space is the context layer over raw retrieval: a synthesized, CITED
 * answer plus a gap analysis ("what the compiled context does not cover"). agent-space
 * mirrors that as a brief, with the same safety contracts as the reranker:
 *
 *  - **revalidate-before-synthesis (invariant 1/2).** The synthesizer only ever
 *    sees candidates that already passed the adapter `revalidate` gate, and their
 *    text comes from the live-revalidated content (never the raw projection
 *    chunk). A redacted object contributes its visible title with null text.
 *  - **never required for correctness.** Synthesis is optional and skippable:
 *    with no synthesizer (or on failure / `null`) the brief still returns the
 *    sources and the DETERMINISTIC gap analysis; only the LLM answer is missing.
 *  - **citations resolve to surfaced sources only.** A citation index the model
 *    invents (out of range) is dropped — the brief never points at an object the
 *    viewer did not already receive.
 *  - **advisory only (invariant 6).** Gap findings are returned, not written:
 *    the context review cycle (W7) turns them into batched review candidates; the brief
 *    never makes a canonical write.
 *
 * The engine owns the access-safe seam + the deterministic assembly; the provider
 * call, prompt, and audit live in the app layer (`modules/retrieval/synthesisProvider`).
 */
export interface BriefCandidate {
  objectType: RetrievalObjectType;
  objectId: string;
  objectProfile?: string | null;
  objectProfileLabel?: string | null;
  /** Live-revalidated title (authoritative, viewer-readable). */
  title: string;
  /** Live-revalidated text. `null` when the adapter redacted it for the viewer. */
  text: string | null;
  /** The candidate's own last-update timestamp (ISO), for the staleness signal. */
  updatedAt: string | null;
  sourceConnectionIds?: string[];
}

/** What the (LLM) synthesizer returns. Citations are INDICES into the candidate list. */
export interface SynthesisResult {
  answer: string;
  citations: number[];
  uncitedClaims: string[];
  contradictions: string[];
  missingTopics: string[];
}

export interface Synthesizer {
  /**
   * Synthesize a cited answer + gap signals from the (already-visible) candidates.
   * `viewerUserId` attributes the provider-egress audit. Returns `null` to signal
   * the stage is unavailable, disabled, or failed — the caller then produces a
   * deterministic-only brief. Implementations must never throw for an ordinary
   * provider failure; they degrade to `null`.
   */
  synthesize(
    spaceId: string,
    viewerUserId: string,
    query: string,
    candidates: readonly BriefCandidate[],
    egressPolicy?: RetrievalEgressPolicy,
  ): Promise<SynthesisResult | null>;
}

export interface SynthesisConfig {
  /** Max number of top sources fed to the synthesizer / scanned for gaps. */
  sourceWindow: number;
  /** A source not updated in more than this many days is flagged stale. */
  staleAfterDays: number;
  /** A source with fewer readable characters than this is flagged thin. */
  thinTextChars: number;
  /** Fewer than this many surfaced sources sets the low-coverage gap flag. */
  lowCoverageMin: number;
}

export const DEFAULT_SYNTHESIS_CONFIG: SynthesisConfig = {
  sourceWindow: 12,
  staleAfterDays: 180,
  thinTextChars: 200,
  lowCoverageMin: 2,
};

/**
 * Build the brief's source candidates from the ranked visible set, taking text
 * ONLY from the revalidation cache (invariant 1/2). Bounded to `limit`. A visible
 * candidate without a cache entry is skipped defensively (it should never happen,
 * since collectVisible kept exactly the cached ones).
 */
export function buildBriefCandidates(
  visible: readonly ScoredCandidate[],
  cache: Map<string, RevalidatedObject | null>,
  limit: number,
): BriefCandidate[] {
  const out: BriefCandidate[] = [];
  for (const candidate of visible) {
    const revalidated = cache.get(candidateKey(candidate));
    if (!revalidated) continue;
    out.push({
      objectType: candidate.objectType,
      objectId: candidate.objectId,
      objectProfile: candidate.objectProfile ?? null,
      objectProfileLabel: candidate.objectProfileLabel ?? null,
      title: revalidated.title,
      text: revalidated.text,
      updatedAt: candidate.updatedAt,
      sourceConnectionIds: candidate.sourceConnectionIds,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Assemble the brief from the candidates and the optional synthesis result. The
 * deterministic gap analysis (stale / thin / low-coverage) is computed from each
 * candidate's OWN metadata, so it is access-neutral; the LLM gap signals
 * (uncited claims, contradictions, missing topics) come from `synth` when
 * present. Citations are mapped from `synth.citations` indices and validated
 * against the candidate list.
 */
export function assembleBrief(
  candidates: readonly BriefCandidate[],
  synth: SynthesisResult | null,
  nowMs: number,
  cfg: SynthesisConfig,
): RetrievalBrief {
  const citations = synth ? resolveCitations(synth.citations, candidates) : [];
  const gapAnalysis: RetrievalGapAnalysis = {
    stale: staleSources(candidates, nowMs, cfg),
    thin: thinSources(candidates, cfg),
    uncited_claims: synth ? dedupeStrings(synth.uncitedClaims) : [],
    contradictions: synth ? dedupeStrings(synth.contradictions) : [],
    missing_topics: synth ? dedupeStrings(synth.missingTopics) : [],
    low_coverage: candidates.length < cfg.lowCoverageMin,
  };
  return {
    answer: synth?.answer ?? null,
    synthesized: Boolean(synth),
    citations,
    gap_analysis: gapAnalysis,
  };
}

/** Map cited indices to surfaced source refs, dropping out-of-range/duplicate indices. */
function resolveCitations(
  indices: readonly number[],
  candidates: readonly BriefCandidate[],
): RetrievalCitation[] {
  const seen = new Set<number>();
  const citations: RetrievalCitation[] = [];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || seen.has(index)) continue;
    seen.add(index);
    const candidate = candidates[index]!;
    citations.push({
      object_type: candidate.objectType,
      object_id: candidate.objectId,
      object_profile: candidate.objectProfile ?? null,
      object_profile_label: candidate.objectProfileLabel ?? null,
      title: candidate.title,
    });
  }
  return citations;
}

function staleSources(candidates: readonly BriefCandidate[], nowMs: number, cfg: SynthesisConfig) {
  const out = [];
  for (const candidate of candidates) {
    if (!candidate.updatedAt) continue;
    const updatedMs = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(updatedMs)) continue;
    const ageDays = (nowMs - updatedMs) / 86_400_000;
    if (ageDays > cfg.staleAfterDays) {
      out.push({
        object_type: candidate.objectType,
        object_id: candidate.objectId,
        object_profile: candidate.objectProfile ?? null,
        object_profile_label: candidate.objectProfileLabel ?? null,
        title: candidate.title,
        reason: `not updated in over ${cfg.staleAfterDays} days`,
      });
    }
  }
  return out;
}

function thinSources(candidates: readonly BriefCandidate[], cfg: SynthesisConfig) {
  const out = [];
  for (const candidate of candidates) {
    const length = candidate.text?.trim().length ?? 0;
    if (length < cfg.thinTextChars) {
      out.push({
        object_type: candidate.objectType,
        object_id: candidate.objectId,
        object_profile: candidate.objectProfile ?? null,
        object_profile_label: candidate.objectProfileLabel ?? null,
        title: candidate.title,
        reason: "sparse content (few searchable characters)",
      });
    }
  }
  return out;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
