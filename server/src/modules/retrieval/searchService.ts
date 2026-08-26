import type {
  CreateSafety,
  RetrievalBriefResponse,
  RetrievalCreateSafetyResponse,
  RetrievalExplainResponse,
  RetrievalObjectType,
  RetrievalRuntimeRankingConfig,
  RetrievalSearchResponse,
  RetrievalSearchResult,
} from "@agent-space/protocol";
import type { Queryable } from "../routeUtils/common.js";
import { normalizeAlias, tokenizeSimple } from "./normalize.js";
import { normalizeTextForSearch } from "./normalize.js";
import { toVectorLiteral } from "./embeddingStore.js";
import { RetrievalFeedbackService } from "./feedback.js";
import { applyRankingSignals, newRankingTelemetry, type RankingSignalConfig } from "./ranking.js";
import { classifyIntent, rankingConfigForIntent } from "./intent.js";
import { parseRelationalIntent, type RelationalIntent } from "./relationalIntent.js";
import {
  applyAdaptiveReturn,
  armFetchLimit,
  boundRerankText,
  buildItems,
  candidateKey,
  clamp,
  collectVisibleCandidates,
  evidenceForAlias,
  fuseCandidates,
  maxPoolPerObject,
  pickGraphSeeds,
  scoreBucket,
  ANN_HALFVEC_DIMENSIONS,
  GRAPH_MAX_HOPS,
  resultFromCandidate,
  similarityFromDistance,
} from "./searchInternals.js";
import {
  applyRerank,
  rerankWindowSize,
  DEFAULT_RERANK_CONFIG,
  type Reranker,
  type RerankCandidate,
  type RerankConfig,
  type RerankScore,
} from "./reranker.js";
import { mergeRewriteVariants, type QueryRewriter } from "./queryRewrite.js";
import { ALLOW_ALL_EGRESS, type RetrievalEgressPolicy } from "./egress/egressPolicy.js";
import {
  assembleBrief,
  buildBriefCandidates,
  DEFAULT_SYNTHESIS_CONFIG,
  type SynthesisConfig,
  type SynthesisResult,
  type Synthesizer,
} from "./synthesis.js";
import {
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourceConnectionIdsFromJson,
  sourceEgressPoliciesForSnapshots,
  sourcePolicyAllowsRead,
} from "./sourcePolicy.js";
import type { RetrievalRegistry } from "./registry.js";
import {
  ContentAccessAuditService,
  contentResourceTypeForRetrievalObject,
} from "../contentAccess/audit.js";
import type {
  QueryEmbedder,
  RetrievalSearchMode,
  RetrievalTrace,
  RevalidatedObject,
  ScoredCandidate,
  SearchCandidate,
} from "./types.js";

interface SearchInput {
  spaceId: string;
  viewerUserId: string;
  objectTypes?: RetrievalObjectType[];
  objectProfiles?: string[];
  query: string;
  maxResults?: number;
  includeTrace?: boolean;
  feedbackSurface?: string;
  /**
   * Search-mode tier; defaults to `hybrid`. Selects which arms run and whether
   * the LLM rerank stage runs (only in `hybrid_rerank`). It is the primary
   * compute/token budget lever (`exact` cheapest → `hybrid_rerank` most).
   */
  mode?: RetrievalSearchMode;
  /**
   * Opt in to the pre-recall LLM query rewriter. Defaults to off, ignored in
   * `exact` mode, and a no-op when no rewriter is injected.
   */
  rewrite?: boolean;
  /**
   * Reuse the per-process query-embedding cache for the vector arm (default
   * true). `false` forces a fresh embedding.
   */
  useCache?: boolean;
  /** Managed-run agent id. Source connection consent may restrict agent access. */
  agentId?: string | null;
  /**
   * Opt in to conservative adaptive return (§2.4): trim the visible tail at a
   * sharp score cliff so a precise answer is not padded with weak results. Never
   * grows the set; defaults off (the caller/surface opts in).
   */
  adaptiveReturn?: boolean;
  /** Runtime ranking mechanics that have passed calibration and shipped for the space. */
  rankingConfig?: RetrievalRuntimeRankingConfig;
  /** Internal audit classification for callers that reuse search as a read subroutine. */
  auditAccessType?: string;
  auditReason?: string;
  /** Internal: caller will audit a stricter post-filtered subset. */
  skipAudit?: boolean;
}

/** Per-request control flags derived from the input + the query intent. */
interface RetrievalControls {
  objectTypes: RetrievalObjectType[];
  objectProfiles: string[];
  maxResults: number;
  query: string;
  normalized: string;
  mode: RetrievalSearchMode;
  runLexical: boolean;
  runVector: boolean;
  runRerankStage: boolean;
  doRewrite: boolean;
  useCache: boolean;
  adaptiveReturn: boolean;
  intent: string;
  rankingCfg: RankingSignalConfig;
  runtimeRankingConfig?: RetrievalRuntimeRankingConfig;
}

interface CreateSafetyInput {
  spaceId: string;
  viewerUserId: string;
  objectType: RetrievalObjectType;
  title?: string | null;
  slug?: string | null;
  aliases?: string[];
  uri?: string | null;
  excludeObjectId?: string | null;
  maxResults?: number;
}

interface ExplainInput extends SearchInput {
  targetObjectType: RetrievalObjectType;
  targetObjectId: string;
}

interface RetrievalCandidateRow {
  object_type: RetrievalObjectType;
  object_id: string;
  object_profile: string | null;
  object_profile_label: string | null;
  title: string;
  snippet: string | null;
  matched_text: string | null;
  matched_field: string | null;
  updated_at: string | null;
  source_connection_ids_json: unknown;
  rank: number | string;
}

interface GraphCandidateRow {
  object_type: RetrievalObjectType;
  object_id: string;
  object_profile: string | null;
  object_profile_label: string | null;
  title: string;
  snippet: string | null;
  link_type: string;
  edge_origin: string;
  edge_confidence: number | null;
  updated_at: string | null;
  source_connection_ids_json: unknown;
  rank: number | string;
}

interface VectorCandidateRow {
  object_type: RetrievalObjectType;
  object_id: string;
  object_profile: string | null;
  object_profile_label: string | null;
  title: string;
  snippet: string | null;
  distance: number | string;
  updated_at: string | null;
  source_connection_ids_json: unknown;
  rank: number | string;
}

interface GraphWalkResult {
  candidates: SearchCandidate[];
  hopsWalked: number;
}

interface GraphWalkOptions {
  spaceId: string;
  expandObjectTypes: RetrievalObjectType[];
  returnObjectTypes: RetrievalObjectType[];
  returnObjectProfiles: string[];
  seeds: SearchCandidate[];
  initialVisitedRefs: string[];
  maxResults: number;
  viewerUserId: string;
  cache: Map<string, RevalidatedObject | null>;
  arm: string;
  matchedFields: string[];
  returnRefs?: Set<string>;
  agentId?: string | null;
}

/**
 * Optional stages layered on top of the deterministic recall arms. Each is
 * injected by the app layer and is independently skippable; none is required for
 * correctness. Grouped into one options bag so the constructor does not grow a
 * long list of positional `undefined`s.
 */
export interface RetrievalSearchServiceOptions {
  // When present, the vector recall arm runs. The app layer injects a
  // provider-backed embedder; without one, search uses only the deterministic
  // arms (exact/lexical/graph). Either way the single read gate is unchanged.
  queryEmbedder?: QueryEmbedder;
  // Post-revalidation positive feedback boost. Omitted in tests and
  // create-safety so feedback never becomes a correctness dependency.
  feedbackService?: RetrievalFeedbackService;
  // Post-revalidate LLM reranker over the visible top-N. Injected by the app
  // layer only when the space setting enables it, and never for create-safety,
  // so rerank stays gated, skippable, and never a correctness dependency.
  // Its content is built from live-revalidated text (invariant 1).
  reranker?: Reranker;
  rerankConfig?: RerankConfig;
  // Pre-recall LLM query rewriter. Injected by the app layer only when the
  // space setting enables it, and never for create-safety. It only rephrases the
  // query string (no candidate content, no access surface); the original query
  // is always searched, so rewrite only adds recall and degrades safely.
  queryRewriter?: QueryRewriter;
  // Post-revalidate synthesizer for buildBrief (W6). Like the reranker, it only
  // ever sees live-revalidated content; when absent or failing, buildBrief still
  // returns the sources + the deterministic gap analysis (no LLM answer).
  synthesizer?: Synthesizer;
  synthesisConfig?: SynthesisConfig;
  // Base egress policy for optional provider stages. The search service enriches
  // it per request with source policy snapshots before handing payload content to
  // rerank/synthesis providers.
  egressPolicy?: RetrievalEgressPolicy;
}

/**
 * Generic, domain-agnostic search over the derived projection. The arms read
 * only the `retrieval_*` tables; live visibility revalidation is delegated to
 * the registered domain adapter, which is the single read-access gate.
 */
export class RetrievalSearchService {
  private readonly queryEmbedder?: QueryEmbedder;
  private readonly feedbackService?: RetrievalFeedbackService;
  private readonly reranker?: Reranker;
  private readonly rerankConfig: RerankConfig;
  private readonly queryRewriter?: QueryRewriter;
  private readonly synthesizer?: Synthesizer;
  private readonly synthesisConfig: SynthesisConfig;
  private readonly egressPolicy: RetrievalEgressPolicy;

  constructor(
    private readonly db: Queryable,
    private readonly registry: RetrievalRegistry,
    options: RetrievalSearchServiceOptions = {},
  ) {
    this.queryEmbedder = options.queryEmbedder;
    this.feedbackService = options.feedbackService;
    this.reranker = options.reranker;
    this.rerankConfig = options.rerankConfig ?? DEFAULT_RERANK_CONFIG;
    this.queryRewriter = options.queryRewriter;
    this.synthesizer = options.synthesizer;
    this.synthesisConfig = options.synthesisConfig ?? DEFAULT_SYNTHESIS_CONFIG;
    this.egressPolicy = options.egressPolicy ?? ALLOW_ALL_EGRESS;
  }

  async search(input: SearchInput): Promise<RetrievalSearchResponse> {
    const c = this.deriveControls(input);
    const trace: RetrievalTrace = { arms: {}, dropped: 0, dropped_reasons: {}, mode: c.mode, intent: c.intent };

    // The full recall → fuse → rank → revalidate → rerank → feedback pipeline is
    // shared with buildBrief() via collectRankedVisible so the single revalidate
    // read gate is never duplicated.
    const { visible, revalidationCache } = await this.collectRankedVisible(input, c, trace);
    const items = buildItems(visible, revalidationCache, c.query, c.maxResults, input.includeTrace);

    // ── Rewrite section: variants searched SEPARATELY and returned apart from
    // `items` — never blended into or co-ranked with the primary results.
    let rewriteItems: RetrievalSearchResult[] = [];
    if (c.doRewrite && this.queryRewriter) {
      const primaryKeys = new Set(items.map((item) => `${item.object_type}:${item.object_id}`));
      rewriteItems = await this.runRewriteSection(
        input,
        c.query,
        c.objectTypes,
        c.objectProfiles,
        c.maxResults,
        c.runVector,
        c.useCache,
        primaryKeys,
        c.rankingCfg,
        trace,
      );
    }
    if (!input.skipAudit) {
      await this.recordReturnedReads(
        input,
        [...items, ...rewriteItems],
        input.auditAccessType ?? "search_hit",
        input.auditReason ?? "retrieval search",
      );
    }

    return {
      items,
      total: items.length,
      ...(rewriteItems.length
        ? { rewrite_items: rewriteItems, rewrite_total: rewriteItems.length }
        : {}),
      ...(input.includeTrace ? { trace: trace as unknown as Record<string, unknown> } : {}),
    };
  }

  /**
   * Build a Context Brief (W6): the same revalidated, ranked sources as `search`,
   * plus an optional synthesized + cited answer and a gap analysis. The synthesis
   * stage is optional and skippable — with no synthesizer (or on failure) the
   * brief still returns the sources and the deterministic gap analysis. Citations
   * are validated against the surfaced sources; gap findings are advisory output
   * (W7 consumes them as review candidates), never silent canonical writes.
   */
  async buildBrief(input: SearchInput): Promise<RetrievalBriefResponse> {
    const c = this.deriveControls(input);
    const trace: RetrievalTrace = { arms: {}, dropped: 0, dropped_reasons: {}, mode: c.mode, intent: c.intent };
    const { visible, revalidationCache } = await this.collectRankedVisible(input, c, trace);

    // Brief candidates carry ONLY live-revalidated title/text (invariant 1/2): a
    // redacted object contributes its visible title with null text, so no
    // unreadable content reaches the synthesizer or the gap analysis.
    const candidates = buildBriefCandidates(
      visible,
      revalidationCache,
      Math.min(this.synthesisConfig.sourceWindow, c.maxResults),
    );
    let synth: SynthesisResult | null = null;
    if (this.synthesizer && c.query && candidates.length > 0) {
      try {
        synth = await this.synthesizer.synthesize(
          input.spaceId,
          input.viewerUserId,
          c.query,
          candidates,
          await this.egressPolicyForSourcePayload(input.spaceId, candidates),
        );
      } catch {
        synth = null;
      }
    }
    const brief = assembleBrief(candidates, synth, Date.now(), this.synthesisConfig);
    trace.synthesis = { sources: candidates.length, synthesized: brief.synthesized };

    const items = buildItems(visible, revalidationCache, c.query, c.maxResults, input.includeTrace);
    await this.recordReturnedReads(input, items, "search_hit", "retrieval brief");
    return {
      brief,
      items,
      total: items.length,
      ...(input.includeTrace ? { trace: trace as unknown as Record<string, unknown> } : {}),
    };
  }

  async explainTarget(input: ExplainInput): Promise<RetrievalExplainResponse | null> {
    const targetProjection = await this.loadProjectedTarget(
      input.spaceId,
      input.targetObjectType,
      input.targetObjectId,
    );
    if (!targetProjection) return null;

    const c = this.deriveControls(input);
    const trace: RetrievalTrace = { arms: {}, dropped: 0, dropped_reasons: {}, mode: c.mode, intent: c.intent };
    const { visible, revalidationCache } = await this.collectRankedVisible(input, c, trace);
    await this.revalidateCandidates(
      [targetProjection],
      input.viewerUserId,
      input.spaceId,
      revalidationCache,
      input.agentId,
      trace,
    );
    const target = revalidationCache.get(candidateKey(targetProjection));
    if (!target) return null;

    const items = buildItems(visible, revalidationCache, c.query, c.maxResults, true);
    const index = items.findIndex((item) =>
      item.object_type === input.targetObjectType && item.object_id === input.targetObjectId
    );
    const returned = index >= 0 ? items[index] : null;
    const targetTypeRequested = c.objectTypes.includes(input.targetObjectType);
    const codes = explainDiagnosticCodes(returned, trace, targetTypeRequested, items.length);

    return {
      target: {
        object_type: input.targetObjectType,
        object_id: input.targetObjectId,
        title: target.title,
        visible: true,
        returned: Boolean(returned),
        ...(returned ? {
          rank: index + 1,
          score: returned.score,
          score_bucket: explainScoreBucket(returned.score),
        } : {}),
      },
      match: {
        matched_fields: returned?.matched_fields ?? [],
        ...(returned?.evidence.kind ? { evidence_kind: returned.evidence.kind } : {}),
        ...(returned?.evidence.field ? { evidence_field: returned.evidence.field } : {}),
        ...(returned?.evidence.source ? { evidence_source: returned.evidence.source } : {}),
        ...(typeof returned?.evidence.confidence === "number" ? { evidence_confidence: returned.evidence.confidence } : {}),
        ...(returned?.create_safety ? { create_safety: returned.create_safety } : {}),
      },
      trace: trace as unknown as RetrievalExplainResponse["trace"],
      diagnostic_codes: codes,
    };
  }

  /**
   * Derive the per-request control flags (which arms/stages run, the budget, the
   * access-neutral ranking config from the query intent). Shared by `search` and
   * `buildBrief` so both make identical recall decisions.
   */
  private deriveControls(input: SearchInput): RetrievalControls {
    const objectTypes = this.sanitizeObjectTypes(input.objectTypes);
    const objectProfiles = sanitizeObjectProfiles(input.objectProfiles);
    const maxResults = clamp(input.maxResults ?? 10, 1, 50);
    const query = input.query.trim();
    const normalized = normalizeAlias(query);
    const mode: RetrievalSearchMode = input.mode ?? "hybrid";
    const runLexical = mode !== "exact"; // lexical + graph belong to the lexical tier
    const runVector = mode === "hybrid" || mode === "hybrid_rerank";
    const runRerankStage = mode === "hybrid_rerank";
    const doRewrite = (input.rewrite ?? false) && runLexical;
    const useCache = input.useCache ?? true;
    const adaptiveReturn = input.adaptiveReturn ?? false;
    // Deterministic, query-only intent classification selects access-neutral
    // ranking knobs (it never changes which arms run or which rows are eligible).
    const intent = classifyIntent(query);
    const rankingCfg = rankingConfigForIntent(intent);
    const runtimeRankingConfig = input.rankingConfig;
    return {
      objectTypes, objectProfiles, maxResults, query, normalized, mode,
      runLexical, runVector, runRerankStage, doRewrite, useCache, adaptiveReturn, intent, rankingCfg, runtimeRankingConfig,
    };
  }

  /**
   * The shared recall pipeline behind both `search` and `buildBrief`: run the
   * arms, max-pool + fuse + rank, then the SINGLE live revalidate gate, then the
   * optional rerank and feedback stages. Returns the visible (already
   * revalidated) candidates and the revalidation cache (authoritative
   * title/text). Keeping this in one place means the read gate is never
   * duplicated across the two callers.
   */
  private async collectRankedVisible(
    input: SearchInput,
    controls: RetrievalControls,
    trace: RetrievalTrace,
  ): Promise<{ visible: ScoredCandidate[]; revalidationCache: Map<string, RevalidatedObject | null> }> {
    const { objectTypes, objectProfiles, maxResults, query, normalized, runLexical, runVector, runRerankStage, useCache, rankingCfg } = controls;

    const exact = normalized
      ? await this.exactAliasArm(input.spaceId, objectTypes, objectProfiles, normalized, maxResults)
      : [];

    const lexical = runLexical
      ? await this.lexicalArm(input.spaceId, objectTypes, objectProfiles, query, maxResults)
      : [];

    // Vector recall (hybrid tiers only, and only when an embedder is injected). It
    // is just another candidate source: results still pass the same `revalidate`
    // gate below, so an embedded-but-unreadable object can never be returned. Run
    // it before the graph arm so a semantic match can also seed graph traversal.
    const vector = runVector
      ? await this.vectorArm(input.spaceId, input.viewerUserId, objectTypes, objectProfiles, query, maxResults, useCache)
      : [];

    // Graph recall seeds from every DIRECT match the viewer can actually read
    // (exact + lexical + vector), not just exact-title hits — so relational recall
    // works for free-text queries too (W4). Seeds are revalidated here and the
    // traversal revalidates every hop, so a non-visible seed/intermediate node can
    // never surface its neighbors (invariant 4); expansion starts only from
    // visible nodes. The cache is reused by the post-fusion revalidation below.
    const revalidationCache = await this.revalidateCandidates(
      [...exact, ...lexical, ...vector],
      input.viewerUserId,
      input.spaceId,
      undefined,
      input.agentId,
      trace,
    );
    const visibleSeeds = pickGraphSeeds([...exact, ...lexical, ...vector], revalidationCache);
    const graph = runLexical && visibleSeeds.length
      ? await this.graphArm(
          input.spaceId,
          objectTypes,
          objectProfiles,
          visibleSeeds,
          maxResults,
          input.viewerUserId,
          revalidationCache,
          input.agentId,
          trace,
      )
      : [];

    const relationalIntent = runLexical ? parseRelationalIntent(query) : null;
    const relational = relationalIntent
      ? await this.relationalArm(
          input,
          controls,
          relationalIntent,
          revalidationCache,
          trace,
      )
      : [];

    // Per-arm max-pool collapses chunk multiplicity to one entry per object per
    // arm (so chunk count cannot inflate an object's score), then cross-arm RRF
    // fuses. The single live read/source-policy gate runs before deterministic
    // ranking signals that depend on the visible-set top score, so a hidden
    // high-score candidate cannot calibrate floor-ratio boosts.
    const rankingTelemetry = newRankingTelemetry();
    const fused = fuseCandidates([
      ...maxPoolPerObject(exact),
      ...maxPoolPerObject(lexical),
      ...maxPoolPerObject(graph),
      ...maxPoolPerObject(relational),
      ...maxPoolPerObject(vector),
    ]);
    await this.revalidateCandidates(fused, input.viewerUserId, input.spaceId, revalidationCache, input.agentId, trace);
    let visible = applyRankingSignals(
      collectVisibleCandidates(fused, revalidationCache, trace),
      query,
      Date.now(),
      rankingCfg,
      rankingTelemetry,
    );
    visible = await this.applyRuntimeRankingMechanics(
      input.spaceId,
      visible,
      controls.runtimeRankingConfig,
      trace,
    );
    // §2.8 aggregate telemetry: the ranking-stage score distribution over the
    // visible set, plus boost-axis attribution. Counts only — no ids/titles.
    trace.score_buckets = scoreBucketHistogram(visible);
    if (Object.keys(rankingTelemetry.boost_attribution).length > 0) {
      trace.boost_attribution = rankingTelemetry.boost_attribution;
    }
    // Reranker: a post-fusion, post-revalidate LLM stage over the visible top-N.
    // It only runs in `hybrid_rerank` mode, only ever sees already-readable
    // content (revalidate ran above), and degrades to the fused order on failure.
    if (this.reranker && runRerankStage && query) {
      visible = await this.runRerank(
        input.spaceId,
        input.viewerUserId,
        query,
        visible,
        revalidationCache,
        maxResults,
        trace,
      );
    }
    if (input.feedbackSurface && this.feedbackService) {
      visible = await this.feedbackService.applyBoosts({
        spaceId: input.spaceId,
        viewerUserId: input.viewerUserId,
        surface: input.feedbackSurface,
        query,
        candidates: visible,
      });
    }
    // Adaptive return (§2.4): opt-in trim of the visible tail at a sharp score
    // cliff, after rerank/feedback have settled the final order.
    if (controls.adaptiveReturn) {
      visible = applyAdaptiveReturn(visible, trace);
    }
    trace.arms = visibleArmCounts(visible);
    return { visible, revalidationCache };
  }

  private async applyRuntimeRankingMechanics(
    spaceId: string,
    visible: ScoredCandidate[],
    config: RetrievalRuntimeRankingConfig | undefined,
    trace: RetrievalTrace,
  ): Promise<ScoredCandidate[]> {
    if (visible.length === 0 || !config) return visible;
    let ranked = visible;
    const boostedAxes: Record<string, number> = {};

    if (runtimeMechanicShipped(config, "candidate_owned_salience")) {
      ranked = ranked.map((candidate) => {
        const boost = candidateOwnedSalienceBoost(candidate);
        if (boost === 1) return candidate;
        boostedAxes.candidate_owned_salience = (boostedAxes.candidate_owned_salience ?? 0) + 1;
        return {
          ...candidate,
          score: candidate.score * boost,
          matchedFields: [...new Set([...candidate.matchedFields, "candidate_owned_salience"])],
        };
      });
    }

    if (runtimeMechanicShipped(config, "visible_edge_backlink")) {
      const counts = await this.visibleEdgeCounts(spaceId, ranked);
      ranked = ranked.map((candidate) => {
        const count = counts.get(candidateKey(candidate)) ?? 0;
        if (count <= 0) return candidate;
        boostedAxes.visible_edge_backlink = (boostedAxes.visible_edge_backlink ?? 0) + 1;
        return {
          ...candidate,
          score: candidate.score * (1 + Math.min(0.12, count * 0.03)),
          matchedFields: [...new Set([...candidate.matchedFields, "visible_edge_backlink"])],
        };
      });
    }

    ranked = ranked
      .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

    if (runtimeMechanicShipped(config, "richer_dedup")) {
      const deduped: ScoredCandidate[] = [];
      const seen = new Set<string>();
      for (const candidate of ranked) {
        const key = richerDedupKey(candidate);
        if (key && seen.has(key)) {
          trace.dropped += 1;
          trace.dropped_reasons.richer_dedup = (trace.dropped_reasons.richer_dedup ?? 0) + 1;
          continue;
        }
        if (key) seen.add(key);
        deduped.push(candidate);
      }
      ranked = deduped.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
    }

    if (Object.keys(boostedAxes).length > 0) {
      trace.boost_attribution = {
        ...(trace.boost_attribution ?? {}),
        ...Object.fromEntries(
          Object.entries(boostedAxes).map(([key, value]) => [
            key,
            (trace.boost_attribution?.[key] ?? 0) + value,
          ]),
        ),
      };
    }
    return ranked;
  }

  private async visibleEdgeCounts(
    spaceId: string,
    visible: readonly ScoredCandidate[],
  ): Promise<Map<string, number>> {
    const refs = visible.map((candidate) => ({
      key: candidateKey(candidate),
      objectType: candidate.objectType,
      objectId: candidate.objectId,
    }));
    if (refs.length < 2) return new Map();
    const refKeys = new Set(refs.map((ref) => ref.key));
    const objectTypes = refs.map((ref) => ref.objectType);
    const objectIds = refs.map((ref) => ref.objectId);
    const result = await this.db.query<{
      from_object_type: RetrievalObjectType;
      from_object_id: string;
      to_object_type: RetrievalObjectType;
      to_object_id: string;
    }>(
      `SELECT from_object_type, from_object_id, to_object_type, to_object_id
         FROM retrieval_edges
        WHERE space_id = $1
          AND from_object_type = ANY($2::retrieval_object_type[])
          AND from_object_id = ANY($3::varchar[])
          AND to_object_type = ANY($2::retrieval_object_type[])
          AND to_object_id = ANY($3::varchar[])
          AND edge_status IN ('derived', 'suggested')`,
      [spaceId, objectTypes, objectIds],
    );
    const counts = new Map<string, number>();
    for (const row of result.rows) {
      const from = `${row.from_object_type}:${row.from_object_id}`;
      const to = `${row.to_object_type}:${row.to_object_id}`;
      if (!refKeys.has(from) || !refKeys.has(to)) continue;
      counts.set(from, (counts.get(from) ?? 0) + 1);
      counts.set(to, (counts.get(to) ?? 0) + 1);
    }
    return counts;
  }

  async assessCreateSafety(input: CreateSafetyInput): Promise<RetrievalCreateSafetyResponse> {
    const maxResults = clamp(input.maxResults ?? 5, 1, 20);
    const normalized = [
      input.title,
      input.slug,
      input.uri,
      ...(input.aliases ?? []),
    ].map((value) => normalizeAlias(value)).filter(Boolean);
    const exactMatches = normalized.length
      ? await this.exactAliasArm(input.spaceId, [input.objectType], [], normalized[0]!, maxResults, normalized)
      : [];
    const excludeSelf = (item: RetrievalSearchResult): boolean =>
      !(input.excludeObjectId && item.object_id === input.excludeObjectId);
    const exactItems: RetrievalSearchResult[] = [];
    const revalidated = await this.revalidateCandidates(
      exactMatches,
      input.viewerUserId,
      input.spaceId,
    );
    for (const candidate of exactMatches) {
      const row = revalidated.get(candidateKey(candidate));
      const result = row
        ? resultFromCandidate(candidate, row.title, row.text, input.title ?? input.uri ?? "")
        : null;
      if (result && excludeSelf(result)) exactItems.push(result);
    }
    if (exactItems.length > 0) {
      await this.recordReturnedReads(
        { spaceId: input.spaceId, viewerUserId: input.viewerUserId },
        exactItems,
        "create_safety_hit",
        "retrieval create-safety",
      );
      return {
        create_safety: "exists",
        matches: exactItems,
        evidence: exactItems.map((item) => item.evidence),
      };
    }

    const query = input.title ?? input.uri ?? input.slug ?? "";
    if (!query.trim()) return { create_safety: "unknown", matches: [], evidence: [] };
    const search = await this.search({
      spaceId: input.spaceId,
      viewerUserId: input.viewerUserId,
      objectTypes: [input.objectType],
      objectProfiles: [],
      query,
      maxResults,
      // Duplicate detection stays on the deterministic tier: no vector/rerank/
      // rewrite even if this service was constructed with those stages.
      mode: "lexical",
      auditAccessType: "create_safety_hit",
      auditReason: "retrieval create-safety",
      skipAudit: true,
    });
    const matches = search.items.filter(excludeSelf);
    await this.recordReturnedReads(
      { spaceId: input.spaceId, viewerUserId: input.viewerUserId },
      matches,
      "create_safety_hit",
      "retrieval create-safety",
    );
    const createSafety: CreateSafety = matches.length > 0 ? "probable_duplicate" : "unknown";
    return {
      create_safety: createSafety,
      matches,
      evidence: matches.map((item) => item.evidence),
    };
  }

  private async recordReturnedReads(
    input: Pick<SearchInput, "spaceId" | "viewerUserId" | "agentId">,
    items: readonly Pick<RetrievalSearchResult, "object_type" | "object_id">[],
    accessType: string,
    reason: string,
  ): Promise<void> {
    const grouped = new Map<string, string[]>();
    for (const item of items) {
      const resourceType = contentResourceTypeForRetrievalObject(item.object_type);
      if (!resourceType) continue;
      grouped.set(resourceType, [...(grouped.get(resourceType) ?? []), item.object_id]);
    }
    const audit = new ContentAccessAuditService(this.db);
    for (const [resourceType, resourceIds] of grouped) {
      await audit.recordReads({
        spaceId: input.spaceId,
        resourceType,
        resourceIds,
        viewerUserId: input.viewerUserId,
        agentId: input.agentId ?? null,
        accessType,
        reason,
      });
    }
  }

  private async exactAliasArm(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    normalized: string,
    maxResults: number,
    normalizedMany?: string[],
  ): Promise<SearchCandidate[]> {
    const aliases = normalizedMany?.length ? [...new Set(normalizedMany)] : [normalized];
    const objectProfileParam = objectProfileFilterParam(objectProfiles);
    const result = await this.db.query<RetrievalCandidateRow>(
      `WITH matches AS (
         SELECT ro.object_type, ro.object_id,
                CASE WHEN sok.id IS NULL THEN NULL ELSE ro.object_profile END AS object_profile,
                sok.label AS object_profile_label,
                ro.title, ro.source_connection_ids_json,
                rc.plain_text AS snippet,
                ra.alias AS matched_text,
                ra.alias_kind AS matched_field,
                COALESCE(ro.source_updated_at, ro.updated_at) AS updated_at,
                ra.confidence
           FROM retrieval_aliases ra
           JOIN retrieval_objects ro
             ON ro.space_id = ra.space_id
            AND ro.object_type = ra.object_type
            AND ro.object_id = ra.object_id
           LEFT JOIN space_object_profiles sok
             ON sok.space_id = ro.space_id
            AND sok.base_object_type = ro.object_type
            AND sok.key = ro.object_profile
            AND sok.status = 'active'
           LEFT JOIN LATERAL (
             SELECT plain_text
               FROM retrieval_chunks
              WHERE retrieval_object_id = ro.id
              ORDER BY chunk_index ASC
              LIMIT 1
           ) rc ON true
          WHERE ra.space_id = $1
            AND ro.object_type = ANY($2::retrieval_object_type[])
            AND ra.normalized_alias = ANY($3::text[])
            AND ($4::varchar[] IS NULL OR (ro.object_profile = ANY($4::varchar[]) AND sok.id IS NOT NULL))
       ),
       best AS (
         SELECT DISTINCT ON (object_type, object_id)
                object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, matched_text, matched_field, updated_at, confidence
           FROM matches
          ORDER BY object_type, object_id, confidence DESC, updated_at DESC, object_id ASC
       )
       SELECT object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, matched_text, matched_field, updated_at,
              row_number() OVER (
                ORDER BY confidence DESC, updated_at DESC, object_id ASC
              ) AS rank
         FROM best
        ORDER BY rank
        LIMIT $5`,
      [spaceId, objectTypes, aliases, objectProfileParam, armFetchLimit(maxResults)],
    );
    return result.rows.map((row) => ({
      objectType: row.object_type,
      objectId: row.object_id,
      objectProfile: row.object_profile ?? null,
      objectProfileLabel: row.object_profile_label ?? null,
      title: row.title,
      snippet: row.snippet,
      matchedFields: [row.matched_field ?? "alias"],
      evidence: evidenceForAlias(row.matched_field, row.matched_text),
      rank: Number(row.rank),
      arm: "exact",
      updatedAt: row.updated_at ?? null,
      sourceConnectionIds: sourceConnectionIdsFromJson(row.source_connection_ids_json),
    }));
  }

  private async lexicalArm(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    query: string,
    maxResults: number,
  ): Promise<SearchCandidate[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const tokens = tokenizeSimple(query);
    const like = `%${trimmed}%`;
    const objectProfileParam = objectProfileFilterParam(objectProfiles);
    // ts_rank_cd normalization flag 1 divides the rank by 1 + log(document
    // length): a BM25-style length penalty so a long page that merely mentions
    // the terms does not outrank a focused page (W5 interim BM25 stance — full
    // BM25 via pg_search is deferred, see the roadmap doc). It composes with the
    // per-arm max-pool and the title-phrase boost.
    const result = await this.db.query<RetrievalCandidateRow>(
      `WITH matches AS (
         SELECT ro.object_type, ro.object_id,
                CASE WHEN sok.id IS NULL THEN NULL ELSE ro.object_profile END AS object_profile,
                sok.label AS object_profile_label,
                ro.title, ro.source_connection_ids_json,
                rc.plain_text AS snippet,
                rc.plain_text AS matched_text,
                'plain_text' AS matched_field,
                COALESCE(ro.source_updated_at, ro.updated_at) AS updated_at,
                ts_rank_cd(rc.tsv, plainto_tsquery('simple', $4), 1) AS lexical_score
           FROM retrieval_chunks rc
           JOIN retrieval_objects ro
             ON ro.id = rc.retrieval_object_id
            AND ro.space_id = rc.space_id
           LEFT JOIN space_object_profiles sok
             ON sok.space_id = ro.space_id
            AND sok.base_object_type = ro.object_type
            AND sok.key = ro.object_profile
            AND sok.status = 'active'
          WHERE rc.space_id = $1
            AND ro.object_type = ANY($2::retrieval_object_type[])
            AND ($5::varchar[] IS NULL OR (ro.object_profile = ANY($5::varchar[]) AND sok.id IS NOT NULL))
            AND (
              rc.tsv @@ plainto_tsquery('simple', $4)
              OR rc.plain_text ILIKE $3
            )
       ),
       best AS (
         SELECT DISTINCT ON (object_type, object_id)
                object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, matched_text, matched_field, updated_at, lexical_score
           FROM matches
          ORDER BY object_type, object_id, lexical_score DESC, updated_at DESC, object_id ASC
       )
       SELECT object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, matched_text, matched_field, updated_at,
              row_number() OVER (
                ORDER BY lexical_score DESC, updated_at DESC, object_id ASC
              ) AS rank
         FROM best
        ORDER BY rank
        LIMIT $6`,
      [spaceId, objectTypes, like, tokens.join(" "), objectProfileParam, armFetchLimit(maxResults)],
    );
    return result.rows.map((row) => ({
      objectType: row.object_type,
      objectId: row.object_id,
      objectProfile: row.object_profile ?? null,
      objectProfileLabel: row.object_profile_label ?? null,
      title: row.title,
      snippet: row.snippet,
      matchedFields: ["plain_text"],
      evidence: {
        kind: row.matched_text ? "lexical_match" : "weak_match",
        field: "plain_text",
        matched_text: query,
        source: "lexical",
        confidence: row.matched_text ? 0.7 : 0.4,
      },
      rank: Number(row.rank),
      arm: "lexical",
      updatedAt: row.updated_at ?? null,
      sourceConnectionIds: sourceConnectionIdsFromJson(row.source_connection_ids_json),
    }));
  }

  /**
   * Bounded, breadth-first multi-hop graph recall (W4). Starting from the visible
   * seeds, it walks typed `retrieval_edges` up to `GRAPH_MAX_HOPS`, surfacing each
   * neighbor as a first-class candidate (fused into RRF, not just a boost).
   *
   * Invariant 4 is enforced per hop: every neighbor is revalidated BEFORE it is
   * used, and only neighbors the viewer can read become the next hop's frontier —
   * so a non-visible intermediate node can never expand to surface ITS neighbors,
   * and a non-visible neighbor is never returned. Closer hops outrank farther ones
   * (the global rank increases monotonically with hop distance) and the evidence
   * carries the relation type and hop count for explanation.
   */
  private async graphArm(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    seeds: SearchCandidate[],
    maxResults: number,
    viewerUserId: string,
    cache: Map<string, RevalidatedObject | null>,
    agentId: string | null | undefined,
    trace: RetrievalTrace,
  ): Promise<SearchCandidate[]> {
    const walked = await this.walkGraph({
      spaceId,
      expandObjectTypes: objectTypes,
      returnObjectTypes: objectTypes,
      returnObjectProfiles: objectProfiles,
      seeds,
      initialVisitedRefs: seeds.map(candidateKey),
      maxResults,
      viewerUserId,
      cache,
      arm: "graph",
      matchedFields: ["retrieval_edge"],
      agentId,
    });
    if (walked.candidates.length > 0) trace.graph = { hops: maxVisibleGraphHop(walked.candidates) };
    return walked.candidates;
  }

  /**
   * Relation-intent recall uses the same edge substrate as the generic graph arm,
   * but resolves seed phrases separately from the full query and can traverse
   * readable intermediate object types while returning only the requested target
   * type (for example `source` for "sources for X").
   */
  private async relationalArm(
    input: SearchInput,
    controls: RetrievalControls,
    intent: RelationalIntent,
    cache: Map<string, RevalidatedObject | null>,
    trace: RetrievalTrace,
  ): Promise<SearchCandidate[]> {
    const registeredTypes = this.registry.objectTypes();
    const returnObjectTypes = this.relationalReturnTypes(intent, controls.objectTypes, registeredTypes);
    const seedTypes = this.relationalSeedTypes(intent, registeredTypes);
    if (returnObjectTypes.length === 0) {
      trace.relational = {
        intent: intent.kind,
        seed_phrases: intent.seedPhrases.length + intent.focusPhrases.length,
        seeds: 0,
        results: 0,
        hops: 0,
      };
      return [];
    }

    const seeds = await this.resolveRelationalSeedPhrases(
      input.spaceId,
      input.viewerUserId,
      input.agentId,
      seedTypes,
      [],
      intent.seedPhrases,
      controls.maxResults,
      cache,
    );
    if (seeds.length === 0) {
      trace.relational = {
        intent: intent.kind,
        seed_phrases: intent.seedPhrases.length + intent.focusPhrases.length,
        seeds: 0,
        results: 0,
        hops: 0,
      };
      return [];
    }

    const targetOnlySeedSearch = this.usesOnlyTargetSeedTypes(intent, seedTypes);
    if (targetOnlySeedSearch) {
      const directTargets = seeds
        .filter((seed) => returnObjectTypes.includes(seed.objectType) && objectProfileMatches(seed, controls.objectProfiles))
        .map((seed, index) => ({
          ...seed,
          arm: "relational",
          matchedFields: [
            ...new Set([
              ...seed.matchedFields,
              "relational_intent",
              `relational:${intent.kind}`,
              "relational_direct_target",
            ]),
          ],
          rank: index + 1,
        }));
      trace.relational = {
        intent: intent.kind,
        seed_phrases: intent.seedPhrases.length + intent.focusPhrases.length,
        seeds: seeds.length,
        results: directTargets.length,
        hops: 0,
      };
      return directTargets;
    }

    const requiresFocus = intent.kind === "connection" && intent.focusPhrases.length > 0;
    const focus = requiresFocus
      ? await this.resolveRelationalSeedPhrases(
          input.spaceId,
          input.viewerUserId,
          input.agentId,
          seedTypes,
          [],
          intent.focusPhrases,
          controls.maxResults,
          cache,
        )
      : [];
    if (requiresFocus && focus.length === 0) {
      trace.relational = {
        intent: intent.kind,
        seed_phrases: intent.seedPhrases.length + intent.focusPhrases.length,
        seeds: seeds.length,
        results: 0,
        hops: 0,
      };
      return [];
    }
    const focusRefs = focus.length ? new Set(focus.map(candidateKey)) : undefined;
    const walked = await this.walkGraph({
      spaceId: input.spaceId,
      expandObjectTypes: registeredTypes,
      returnObjectTypes,
      returnObjectProfiles: controls.objectProfiles,
      seeds,
      initialVisitedRefs: seeds.map(candidateKey),
      maxResults: controls.maxResults,
      viewerUserId: input.viewerUserId,
      cache,
      arm: "relational",
      matchedFields: ["retrieval_edge", "relational_intent", `relational:${intent.kind}`],
      returnRefs: focusRefs,
      agentId: input.agentId,
    });
    trace.relational = {
      intent: intent.kind,
      seed_phrases: intent.seedPhrases.length + intent.focusPhrases.length,
      seeds: seeds.length + focus.length,
      results: walked.candidates.length,
      hops: walked.candidates.length > 0 ? maxVisibleGraphHop(walked.candidates) : 0,
    };
    return walked.candidates;
  }

  private relationalReturnTypes(
    intent: RelationalIntent,
    requestedTypes: RetrievalObjectType[],
    registeredTypes: RetrievalObjectType[],
  ): RetrievalObjectType[] {
    const requested = new Set(requestedTypes);
    const registered = new Set(registeredTypes);
    const targets = intent.targetObjectTypes ?? requestedTypes;
    return targets.filter((type) => requested.has(type) && registered.has(type));
  }

  private relationalSeedTypes(
    intent: RelationalIntent,
    registeredTypes: RetrievalObjectType[],
  ): RetrievalObjectType[] {
    if (!intent.targetObjectTypes?.length) return registeredTypes;
    const targets = new Set(intent.targetObjectTypes);
    const nonTargets = registeredTypes.filter((type) => !targets.has(type));
    return nonTargets.length ? nonTargets : registeredTypes;
  }

  private usesOnlyTargetSeedTypes(
    intent: RelationalIntent,
    seedTypes: RetrievalObjectType[],
  ): boolean {
    if (!intent.targetObjectTypes?.length) return false;
    const targets = new Set(intent.targetObjectTypes);
    return seedTypes.length > 0 && seedTypes.every((type) => targets.has(type));
  }

  private async resolveRelationalSeedPhrases(
    spaceId: string,
    viewerUserId: string,
    agentId: string | null | undefined,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    phrases: string[],
    maxResults: number,
    cache: Map<string, RevalidatedObject | null>,
  ): Promise<SearchCandidate[]> {
    const candidates: SearchCandidate[] = [];
    for (const phrase of phrases) {
      const normalized = normalizeAlias(phrase);
      if (normalized) {
        candidates.push(...await this.exactAliasArm(spaceId, objectTypes, objectProfiles, normalized, maxResults));
      }
      candidates.push(...await this.lexicalArm(spaceId, objectTypes, objectProfiles, phrase, maxResults));
    }
    await this.revalidateCandidates(candidates, viewerUserId, spaceId, cache, agentId);
    return pickGraphSeeds(candidates, cache);
  }

  private async walkGraph(options: GraphWalkOptions): Promise<GraphWalkResult> {
    const fetchLimit = armFetchLimit(options.maxResults);
    const returnTypes = new Set(options.returnObjectTypes);
    const visited = new Set<string>(options.initialVisitedRefs);
    let frontier = options.seeds.map(candidateKey);
    const out: SearchCandidate[] = [];
    let rank = 0;
    let hopsWalked = 0;

    for (let hop = 1; hop <= GRAPH_MAX_HOPS && frontier.length > 0 && out.length < fetchLimit; hop += 1) {
      const neighbors = await this.graphNeighborsOneHop(
        options.spaceId,
        options.expandObjectTypes,
        frontier,
        [...visited],
        fetchLimit,
      );
      if (neighbors.length === 0) break;
      // Revalidate before a neighbor can be returned OR expanded from (invariant 4).
      await this.revalidateCandidates(
        neighbors,
        options.viewerUserId,
        options.spaceId,
        options.cache,
        options.agentId,
      );
      const nextFrontier: string[] = [];
      for (const neighbor of neighbors) {
        const key = candidateKey(neighbor);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!options.cache.get(key)) continue; // not readable ⇒ not returned, not expanded

        const canReturn =
          returnTypes.has(neighbor.objectType) &&
          objectProfileMatches(neighbor, options.returnObjectProfiles) &&
          (!options.returnRefs || options.returnRefs.has(key));
        if (canReturn && out.length < fetchLimit) {
          rank += 1;
          out.push({
            ...neighbor,
            arm: options.arm,
            matchedFields: [...new Set([...options.matchedFields, ...neighbor.matchedFields])],
            rank,
            // Decay confidence with hop distance; closer relations are stronger.
            evidence: {
              ...neighbor.evidence,
              graph_hop: hop,
              confidence: clamp(neighbor.evidence.confidence ?? 0.65, 0, 1) / hop,
            },
          });
        }
        nextFrontier.push(key);
      }
      if (nextFrontier.length > 0) hopsWalked = hop;
      frontier = nextFrontier;
    }

    return { candidates: out, hopsWalked };
  }

  /** One hop of graph expansion: neighbors of `frontierRefs`, excluding `excludeRefs`. */
  private async graphNeighborsOneHop(
    spaceId: string,
    objectTypes: RetrievalObjectType[],
    frontierRefs: string[],
    excludeRefs: string[],
    limit: number,
  ): Promise<SearchCandidate[]> {
    const result = await this.db.query<GraphCandidateRow>(
      `WITH neighbors AS (
         SELECT ro.object_type, ro.object_id,
                CASE WHEN sok.id IS NULL THEN NULL ELSE ro.object_profile END AS object_profile,
                sok.label AS object_profile_label,
                ro.title, ro.source_connection_ids_json,
                rc.plain_text AS snippet,
                e.link_type,
                e.edge_origin,
                e.confidence AS edge_confidence,
                COALESCE(ro.source_updated_at, ro.updated_at) AS updated_at
           FROM retrieval_edges e
           JOIN retrieval_objects ro
             ON ro.space_id = e.space_id
            AND (
              (ro.object_type = e.to_object_type AND ro.object_id = e.to_object_id)
              OR (ro.object_type = e.from_object_type AND ro.object_id = e.from_object_id)
            )
           LEFT JOIN space_object_profiles sok
             ON sok.space_id = ro.space_id
            AND sok.base_object_type = ro.object_type
            AND sok.key = ro.object_profile
            AND sok.status = 'active'
           LEFT JOIN LATERAL (
             SELECT plain_text
               FROM retrieval_chunks
              WHERE retrieval_object_id = ro.id
              ORDER BY chunk_index ASC
              LIMIT 1
           ) rc ON true
          WHERE e.space_id = $1
            AND ro.object_type = ANY($2::retrieval_object_type[])
            AND e.edge_status <> 'rejected'
            AND (
              (e.from_object_type || ':' || e.from_object_id) = ANY($3::text[])
              OR (e.to_object_type || ':' || e.to_object_id) = ANY($3::text[])
            )
            AND NOT ((ro.object_type || ':' || ro.object_id) = ANY($4::text[]))
       ),
       best AS (
         SELECT DISTINCT ON (object_type, object_id)
                object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, link_type, edge_origin, edge_confidence, updated_at
           FROM neighbors
          ORDER BY object_type, object_id, edge_confidence DESC NULLS LAST, updated_at DESC, object_id ASC
       )
       SELECT object_type, object_id, object_profile, object_profile_label, title, source_connection_ids_json, snippet, link_type, edge_origin, edge_confidence, updated_at,
              row_number() OVER (
                ORDER BY edge_confidence DESC NULLS LAST, updated_at DESC, object_id ASC
              ) AS rank
         FROM best
        ORDER BY rank
        LIMIT $5`,
      [spaceId, objectTypes, frontierRefs, excludeRefs, limit],
    );
    return result.rows.map((row) => ({
      objectType: row.object_type,
      objectId: row.object_id,
      objectProfile: row.object_profile ?? null,
      objectProfileLabel: row.object_profile_label ?? null,
      title: row.title,
      snippet: row.snippet,
      matchedFields: ["retrieval_edge", `relation:${row.link_type}`],
      evidence: {
        kind: "graph_neighbor",
        field: row.link_type,
        source: row.edge_origin,
        confidence: typeof row.edge_confidence === "number" ? row.edge_confidence : 0.65,
      },
      rank: Number(row.rank),
      arm: "graph",
      updatedAt: row.updated_at ?? null,
      sourceConnectionIds: sourceConnectionIdsFromJson(row.source_connection_ids_json),
    }));
  }

  private async vectorArm(
    spaceId: string,
    viewerUserId: string,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    query: string,
    maxResults: number,
    useCache: boolean,
  ): Promise<SearchCandidate[]> {
    if (!this.queryEmbedder || !query) return [];
    let queryVector: number[] | null = null;
    try {
      queryVector = await this.queryEmbedder.embedQuery(spaceId, query, {
        cache: useCache,
        subjectUserId: viewerUserId,
      });
    } catch {
      queryVector = null;
    }
    if (!queryVector || queryVector.length === 0) return [];
    const queryDimensions = queryVector.length;
    const fetchLimit = armFetchLimit(maxResults);
    // The `nearest` CTE computes pgvector cosine distance, narrowing by space,
    // object type, and embedding_dimensions, over-fetches chunks, dedups to the
    // best chunk per object, then joins retrieval_objects only for the final
    // set's title. For ANN-indexed dimensions (W5) it casts to `halfvec` with a
    // CONSTANT dimension and a literal `embedding_dimensions = D` predicate so the
    // partial HNSW index (ix_retrieval_chunks_embedding_hnsw_D) is used; other
    // dimensions fall back to the exact `vector` scan. `queryDimensions` is a
    // vector length (trusted integer), and only inlined when it is a registered
    // ANN dimension, so the cast/predicate literals are not user-controlled.
    const useAnn = ANN_HALFVEC_DIMENSIONS.has(queryDimensions);
    const distanceExpr = useAnn
      ? `rc.embedding::halfvec(${queryDimensions}) <=> $3::halfvec(${queryDimensions})`
      : `rc.embedding <=> $3::vector`;
    const dimPredicate = useAnn ? `rc.embedding_dimensions = ${queryDimensions}` : `rc.embedding_dimensions = $4`;
    const objectProfileParamIndex = useAnn ? "$4" : "$5";
    const limitParam = useAnn ? "$5" : "$6";
    const objectProfileParam = objectProfileFilterParam(objectProfiles);
    const params = useAnn
      ? [spaceId, objectTypes, toVectorLiteral(queryVector), objectProfileParam, fetchLimit]
      : [spaceId, objectTypes, toVectorLiteral(queryVector), queryDimensions, objectProfileParam, fetchLimit];
    const result = await this.db.query<VectorCandidateRow>(
       `WITH nearest AS (
         SELECT rc.retrieval_object_id, rc.object_type, rc.object_id, rc.plain_text,
                ${distanceExpr} AS distance
           FROM retrieval_chunks rc
           JOIN retrieval_objects ro_filter
             ON ro_filter.id = rc.retrieval_object_id
            AND ro_filter.space_id = rc.space_id
           LEFT JOIN space_object_profiles sok_filter
             ON sok_filter.space_id = ro_filter.space_id
            AND sok_filter.base_object_type = ro_filter.object_type
            AND sok_filter.key = ro_filter.object_profile
            AND sok_filter.status = 'active'
          WHERE rc.space_id = $1
            AND rc.object_type = ANY($2::retrieval_object_type[])
            AND rc.embedding IS NOT NULL
            AND ${dimPredicate}
            AND (${objectProfileParamIndex}::varchar[] IS NULL OR (ro_filter.object_profile = ANY(${objectProfileParamIndex}::varchar[]) AND sok_filter.id IS NOT NULL))
          ORDER BY ${distanceExpr}
          LIMIT ${limitParam}
       ),
       best AS (
         SELECT DISTINCT ON (object_type, object_id)
                retrieval_object_id, object_type, object_id, plain_text, distance
           FROM nearest
          ORDER BY object_type, object_id, distance ASC
       )
       SELECT b.object_type, b.object_id,
              CASE WHEN sok.id IS NULL THEN NULL ELSE ro.object_profile END AS object_profile,
              sok.label AS object_profile_label,
              ro.title, ro.source_connection_ids_json, b.plain_text AS snippet, b.distance,
              COALESCE(ro.source_updated_at, ro.updated_at) AS updated_at,
              row_number() OVER (ORDER BY b.distance ASC, b.object_id ASC) AS rank
         FROM best b
         JOIN retrieval_objects ro
           ON ro.id = b.retrieval_object_id AND ro.space_id = $1
         LEFT JOIN space_object_profiles sok
           ON sok.space_id = ro.space_id
          AND sok.base_object_type = ro.object_type
          AND sok.key = ro.object_profile
          AND sok.status = 'active'
        WHERE (${objectProfileParamIndex}::varchar[] IS NULL OR (ro.object_profile = ANY(${objectProfileParamIndex}::varchar[]) AND sok.id IS NOT NULL))
        ORDER BY rank`,
      params,
    );
    return result.rows.map((row) => ({
      objectType: row.object_type,
      objectId: row.object_id,
      objectProfile: row.object_profile ?? null,
      objectProfileLabel: row.object_profile_label ?? null,
      title: row.title,
      snippet: row.snippet,
      matchedFields: ["embedding"],
      evidence: {
        kind: "vector_match",
        field: "embedding",
        source: "vector",
        confidence: similarityFromDistance(Number(row.distance)),
      },
      rank: Number(row.rank),
      arm: "vector",
      updatedAt: row.updated_at ?? null,
      sourceConnectionIds: sourceConnectionIdsFromJson(row.source_connection_ids_json),
      // Carried separately from evidence.confidence for the post-RRF cosine blend
      // (§2.3), since fusion may overwrite this candidate's evidence.
      vectorSimilarity: similarityFromDistance(Number(row.distance)),
    }));
  }

  private async loadProjectedTarget(
    spaceId: string,
    objectType: RetrievalObjectType,
    objectId: string,
  ): Promise<SearchCandidate | null> {
    if (!this.registry.objectTypes().includes(objectType)) return null;
    const result = await this.db.query<RetrievalCandidateRow>(
      `SELECT ro.object_type, ro.object_id,
              CASE WHEN sok.id IS NULL THEN NULL ELSE ro.object_profile END AS object_profile,
              sok.label AS object_profile_label,
              ro.title, ro.source_connection_ids_json,
              rc.plain_text AS snippet,
              NULL::text AS matched_text,
              NULL::text AS matched_field,
              COALESCE(ro.source_updated_at, ro.updated_at) AS updated_at,
              1 AS rank
         FROM retrieval_objects ro
         LEFT JOIN space_object_profiles sok
           ON sok.space_id = ro.space_id
          AND sok.base_object_type = ro.object_type
          AND sok.key = ro.object_profile
          AND sok.status = 'active'
         LEFT JOIN LATERAL (
           SELECT plain_text
             FROM retrieval_chunks
            WHERE retrieval_object_id = ro.id
            ORDER BY chunk_index ASC
            LIMIT 1
         ) rc ON true
        WHERE ro.space_id = $1
          AND ro.object_type = $2
          AND ro.object_id = $3
        LIMIT 1`,
      [spaceId, objectType, objectId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      objectType: row.object_type,
      objectId: row.object_id,
      objectProfile: row.object_profile ?? null,
      objectProfileLabel: row.object_profile_label ?? null,
      title: row.title,
      snippet: row.snippet,
      matchedFields: [],
      evidence: { kind: "weak_match", source: "diagnose", confidence: 0 },
      rank: 1,
      arm: "diagnose",
      updatedAt: row.updated_at ?? null,
      sourceConnectionIds: sourceConnectionIdsFromJson(row.source_connection_ids_json),
    };
  }

  /**
   * Query-rewrite "discovery" results, kept SEPARATE from the primary list. The
   * rewriter rephrases the original query; each variant is searched through the
   * free-text arms (lexical, + vector in hybrid tiers), fused, revalidated,
   * visible-set ranked, and returned.
   * Results already in the primary list are excluded so this section only surfaces
   * ADDITIONAL matches. It is deliberately NOT reranked or feedback-boosted and is
   * never co-ranked with the primary results (the caller shows it apart). Only the
   * query string is sent to the rewriter; no candidate content.
   */
  private async runRewriteSection(
    input: SearchInput,
    query: string,
    objectTypes: RetrievalObjectType[],
    objectProfiles: string[],
    maxResults: number,
    runVector: boolean,
    useCache: boolean,
    excludeKeys: Set<string>,
    rankingCfg: RankingSignalConfig,
    trace: RetrievalTrace,
  ): Promise<RetrievalSearchResult[]> {
    let variants: string[] | null = null;
    try {
      variants = await this.queryRewriter!.rewrite(input.spaceId, input.viewerUserId, query);
    } catch {
      variants = null;
    }
    // Drop the original (index 0) — the primary list already covers it.
    const variantQueries = mergeRewriteVariants(query, variants ?? []).slice(1);
    trace.rewrite = { variants: variantQueries.length, applied: variantQueries.length > 0 };
    if (variantQueries.length === 0) return [];

    const lexical = (
      await Promise.all(
        variantQueries.map((q) => this.lexicalArm(input.spaceId, objectTypes, objectProfiles, q, maxResults)),
      )
    ).flat();
    const vector = runVector
      ? (
          await Promise.all(
            variantQueries.map((q) => this.vectorArm(
              input.spaceId,
              input.viewerUserId,
              objectTypes,
              objectProfiles,
              q,
              maxResults,
              useCache,
            )),
          )
        ).flat()
      : [];
    const fused = fuseCandidates([...maxPoolPerObject(lexical), ...maxPoolPerObject(vector)]);
    const cache = await this.revalidateCandidates(fused, input.viewerUserId, input.spaceId, undefined, input.agentId, trace);
    const visible = applyRankingSignals(
      collectVisibleCandidates(fused, cache, trace),
      query,
      Date.now(),
      rankingCfg,
    );
    return buildItems(visible, cache, query, maxResults, input.includeTrace, excludeKeys);
  }

  /**
   * Rerank the visible candidates with the injected LLM reranker. Only the
   * already-revalidated top-N window is sent, and each candidate's text comes
   * from the live-revalidated content in `cache` (never the raw projection
   * chunk), so a redacted object contributes its visible title with null text
   * and no unreadable content can ever leave the process (invariant 1). Any
   * failure or empty result keeps the prior fused order.
   */
  private async runRerank(
    spaceId: string,
    viewerUserId: string,
    query: string,
    visible: ScoredCandidate[],
    cache: Map<string, RevalidatedObject | null>,
    maxResults: number,
    trace: RetrievalTrace,
  ): Promise<ScoredCandidate[]> {
    if (!this.reranker || visible.length === 0) return visible;
    const windowSize = rerankWindowSize(visible.length, maxResults, this.rerankConfig);
    // Build from the live-revalidated title/text only — never the projection chunk
    // (invariant 1). `visible` should always have a cache entry (collectVisible kept
    // exactly those); the guard is defensive so a future cache change can't leak the
    // projection text or throw mid-search.
    // §2.6 token budget: truncate per-candidate text and stop sending text once the
    // running total reaches the payload cap, so a few very long revalidated texts
    // cannot blow the provider payload. Truncates only already-visible text.
    const perItemCap = this.rerankConfig.maxCandidateTextChars;
    const payloadCap = this.rerankConfig.maxPayloadChars;
    let payloadChars = 0;
    let truncated = 0;
    const rerankCandidates: RerankCandidate[] = [];
    for (const candidate of visible.slice(0, windowSize)) {
      const revalidated = cache.get(candidateKey(candidate));
      if (!revalidated) continue;
      const boundedText = boundRerankText(revalidated.text, perItemCap, payloadCap, payloadChars);
      if (boundedText.truncated) truncated += 1;
      payloadChars += boundedText.text?.length ?? 0;
      rerankCandidates.push({
        objectType: candidate.objectType,
        objectId: candidate.objectId,
        title: revalidated.title,
        text: boundedText.text,
        sourceConnectionIds: candidate.sourceConnectionIds,
      });
    }
    let scores: RerankScore[] | null = null;
    try {
      scores = await this.reranker.rerank(
        spaceId,
        viewerUserId,
        query,
        rerankCandidates,
        await this.egressPolicyForSourcePayload(spaceId, rerankCandidates),
      );
    } catch {
      scores = null;
    }
    const applied = Boolean(scores && scores.length);
    trace.rerank = { sent: rerankCandidates.length, applied, ...(truncated ? { truncated } : {}) };
    if (!scores || scores.length === 0) return visible;
    const reranked = applyRerank(visible, scores, windowSize);
    trace.rerank.moved = countMoved(visible, reranked, windowSize);
    return reranked;
  }

  private async revalidateCandidates(
    candidates: readonly SearchCandidate[],
    viewerUserId: string,
    spaceId: string,
    cache: Map<string, RevalidatedObject | null> = new Map(),
    agentId?: string | null,
    trace?: RetrievalTrace,
  ): Promise<Map<string, RevalidatedObject | null>> {
    const byType = new Map<RetrievalObjectType, string[]>();
    const seen = new Set<string>();
    const pending: SearchCandidate[] = [];
    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      if (cache.has(key) || seen.has(key)) continue;
      seen.add(key);
      pending.push(candidate);
      const ids = byType.get(candidate.objectType) ?? [];
      ids.push(candidate.objectId);
      byType.set(candidate.objectType, ids);
    }

    for (const [objectType, objectIds] of byType) {
      const adapter = this.registry.adapterFor(objectType);
      if (!adapter) {
        for (const objectId of objectIds) cache.set(`${objectType}:${objectId}`, null);
        continue;
      }

      if (adapter.revalidateMany) {
        const readable = await adapter.revalidateMany(
          this.db,
          spaceId,
          objectType,
          objectIds,
          viewerUserId,
        );
        for (const objectId of objectIds) {
          cache.set(`${objectType}:${objectId}`, readable.get(objectId) ?? null);
        }
        continue;
      }

      for (const objectId of objectIds) {
        cache.set(
          `${objectType}:${objectId}`,
          await adapter.revalidate(this.db, spaceId, objectType, objectId, viewerUserId),
        );
      }
    }
    await this.enforceSourceReadPolicy(pending, viewerUserId, spaceId, agentId, cache, trace);
    return cache;
  }

  private async enforceSourceReadPolicy(
    candidates: readonly SearchCandidate[],
    viewerUserId: string,
    spaceId: string,
    agentId: string | null | undefined,
    cache: Map<string, RevalidatedObject | null>,
    trace?: RetrievalTrace,
  ): Promise<void> {
    const sourceIds = uniqueSourceConnectionIds(candidates);
    if (sourceIds.length === 0) return;
    const [snapshots, viewerSpaceRole] = await Promise.all([
      loadSourcePolicySnapshots(this.db, spaceId, sourceIds),
      loadViewerSpaceRole(this.db, spaceId, viewerUserId),
    ]);
    for (const candidate of candidates) {
      const key = candidateKey(candidate);
      const candidateSourceIds = candidate.sourceConnectionIds ?? [];
      if (!cache.get(key) || candidateSourceIds.length === 0) continue;
      const allowed = candidateSourceIds.every((sourceId) => {
        const snapshot = snapshots.get(sourceId);
        return snapshot
          ? sourcePolicyAllowsRead(snapshot, { viewerUserId, agentId, viewerSpaceRole })
          : false;
      });
      if (allowed) continue;
      cache.set(key, null);
    }
  }

  private async egressPolicyForSourcePayload(
    spaceId: string,
    candidates: readonly { sourceConnectionIds?: readonly string[] }[],
  ): Promise<RetrievalEgressPolicy> {
    const sourceIds = uniqueSourceConnectionIds(candidates);
    if (sourceIds.length === 0) return this.egressPolicy;
    const snapshots = await loadSourcePolicySnapshots(this.db, spaceId, sourceIds);
    return {
      ...this.egressPolicy,
      sourcePolicies: sourceEgressPoliciesForSnapshots(snapshots),
      payloadSourceConnectionIds: sourceIds,
    };
  }

  private sanitizeObjectTypes(objectTypes: RetrievalObjectType[] | undefined): RetrievalObjectType[] {
    const registered = this.registry.objectTypes();
    if (!objectTypes?.length) return registered;
    return registered.filter((type) => objectTypes.includes(type));
  }
}

function sanitizeObjectProfiles(objectProfiles: string[] | undefined): string[] {
  if (!objectProfiles?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of objectProfiles) {
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 20) break;
  }
  return out;
}

function objectProfileFilterParam(objectProfiles: readonly string[]): string[] | null {
  return objectProfiles.length > 0 ? [...objectProfiles] : null;
}

function objectProfileMatches(
  candidate: Pick<SearchCandidate, "objectProfile">,
  objectProfiles: readonly string[],
): boolean {
  if (objectProfiles.length === 0) return true;
  return Boolean(candidate.objectProfile && objectProfiles.includes(candidate.objectProfile));
}

/** Aggregate-safe histogram of the visible candidates' final scores (§2.8). */
function scoreBucketHistogram(visible: readonly ScoredCandidate[]): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const candidate of visible) {
    const bucket = scoreBucket(candidate.score);
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }
  return buckets;
}

/** Count windowed candidates whose position changed after rerank (§2.8 aggregate). */
function countMoved(
  before: readonly ScoredCandidate[],
  after: readonly ScoredCandidate[],
  windowSize: number,
): number {
  const beforeIndex = new Map<string, number>();
  before.slice(0, windowSize).forEach((candidate, index) => beforeIndex.set(candidateKey(candidate), index));
  let moved = 0;
  after.slice(0, windowSize).forEach((candidate, index) => {
    const prior = beforeIndex.get(candidateKey(candidate));
    if (prior !== undefined && prior !== index) moved += 1;
  });
  return moved;
}

function uniqueSourceConnectionIds(
  refs: readonly { sourceConnectionIds?: readonly string[] }[],
): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    for (const sourceId of ref.sourceConnectionIds ?? []) {
      if (sourceId && !out.includes(sourceId)) out.push(sourceId);
    }
  }
  return out;
}

function runtimeMechanicShipped(
  config: RetrievalRuntimeRankingConfig,
  mechanic: "visible_edge_backlink" | "candidate_owned_salience" | "richer_dedup" | "autocut",
): boolean {
  return config.mechanics[mechanic]?.state === "shipped";
}

function candidateOwnedSalienceBoost(candidate: ScoredCandidate): number {
  const confidence = typeof candidate.evidence.confidence === "number" && Number.isFinite(candidate.evidence.confidence)
    ? Math.max(0, Math.min(1, candidate.evidence.confidence))
    : 0.5;
  const confidenceLift = Math.max(0, confidence - 0.5) * 0.08;
  const fieldLift = Math.min(0.04, new Set(candidate.matchedFields).size * 0.01);
  const vectorLift = typeof candidate.vectorSimilarity === "number"
    ? Math.max(0, candidate.vectorSimilarity - 0.5) * 0.04
    : 0;
  const boost = 1 + confidenceLift + fieldLift + vectorLift;
  return boost > 1 && Number.isFinite(boost) ? boost : 1;
}

function richerDedupKey(candidate: ScoredCandidate): string | null {
  const title = normalizeTextForSearch(candidate.title);
  if (!title || title.length < 4) return null;
  return `${candidate.objectType}:${title}`;
}

function explainDiagnosticCodes(
  returned: RetrievalSearchResult | null,
  trace: RetrievalTrace,
  targetTypeRequested: boolean,
  returnedCount: number,
): string[] {
  const codes: string[] = [];
  if (returned) {
    codes.push("target_returned");
    if (returned.matched_fields.includes("embedding")) codes.push("vector_match");
    if (returned.matched_fields.some((field) => field.includes("relation") || field.includes("retrieval_edge"))) {
      codes.push("relation_signal");
    }
  } else {
    codes.push("visible_target_missed");
  }
  if (!targetTypeRequested) codes.push("target_type_not_requested");
  if (returnedCount === 0) codes.push("no_visible_results");
  if ((trace.arms.vector ?? 0) > 0) codes.push("vector_available");
  if ((trace.arms.graph ?? 0) > 0) codes.push("graph_available");
  if ((trace.arms.relational ?? 0) > 0) codes.push("relational_available");
  if (trace.rerank?.applied) codes.push("rerank_applied");
  return [...new Set(codes)].slice(0, 50);
}

function visibleArmCounts(visible: readonly ScoredCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {
    exact: 0,
    lexical: 0,
    vector: 0,
    graph: 0,
    relational: 0,
  };
  for (const candidate of visible) {
    if (candidate.arm === "exact") counts.exact += 1;
    if (candidate.arm === "lexical") counts.lexical += 1;
    if (candidate.matchedFields.includes("embedding")) counts.vector += 1;
    if (candidate.matchedFields.includes("retrieval_edge")) counts.graph += 1;
    if (candidate.matchedFields.includes("relational_intent")) counts.relational += 1;
  }
  return counts;
}

function maxVisibleGraphHop(candidates: readonly SearchCandidate[]): number {
  let max = 0;
  for (const candidate of candidates) {
    const hop = Number(candidate.evidence.graph_hop ?? candidate.evidence.hop);
    if (Number.isFinite(hop) && hop > max) max = Math.floor(hop);
  }
  return max > 0 ? max : candidates.length > 0 ? 1 : 0;
}

function explainScoreBucket(score: number): string {
  if (score >= 0.75) return "ge_0_75";
  if (score >= 0.5) return "ge_0_50";
  if (score >= 0.25) return "ge_0_25";
  return "lt_0_25";
}
