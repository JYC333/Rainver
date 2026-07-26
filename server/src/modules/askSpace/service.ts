import type {
  AskSpaceClaimTrajectory,
  AskSpaceDomain,
  AskSpaceDomainSection,
  AskSpaceProvenanceItem,
  AskSpaceResponse,
  RetrievalBriefResponse,
  RetrievalObjectType,
  RetrievalSearchMode,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { dbPool, type Queryable } from "../routeUtils/common";
import type { BriefCandidate, SynthesisResult } from "../retrieval";
import type { RetrievalRegistry } from "../retrieval/registry";
import { RetrievalSearchService, persistRetrievalBriefArtifact } from "../retrieval";
import { readSpaceRetrievalSettings } from "../retrieval/settings";
import type { RetrievalEgressPolicy } from "../retrieval/egress/egressPolicy";
import { ProviderQueryEmbedder } from "../retrieval/embedding/queryEmbedder";
import { ProviderReranker } from "../retrieval/rerankProvider/providerReranker";
import { ProviderSynthesizer } from "../retrieval/synthesisProvider/providerSynthesizer";
import { resolveProviderCommandStore } from "../providers/commands/store";
import { loadSourcePolicySnapshots, sourceEgressPoliciesForSnapshots } from "../retrieval/sourcePolicy";
import { knowledgeRetrievalRegistry } from "../knowledge/retrievalAdapter";
import { memoryRetrievalRegistry } from "../memory/retrievalAdapter";
import { projectRetrievalRegistry } from "../projects/retrievalAdapter";
import { sourceRetrievalRegistry } from "../sources/retrievalAdapter";
import { inquiryRetrievalRegistry } from "../inquiry/retrievalAdapter";
import { PgMemoryReadRepository } from "../memory/repository";
import { canInitiateContextOpsScan } from "../contextOps/reviewPolicy";
import { buildClaimTrajectory } from "../knowledge/claimReviewLoop";
import { persistAskSpaceSessionArtifact } from "./sessionArtifact";
import { aggregateGaps, buildFollowUps, collectProvenance, dedupeDomains } from "./aggregate";

export interface AskSpaceInput {
  spaceId: string;
  userId: string;
  query: string;
  domains?: AskSpaceDomain[];
  maxResultsPerDomain?: number;
  mode?: RetrievalSearchMode;
  includeTrace?: boolean;
  adaptiveReturn?: boolean;
  persist?: boolean;
  combine?: boolean;
  combineIncludeMemory?: boolean;
  includeClaimTrajectory?: boolean;
}

interface DomainConfig {
  registry: RetrievalRegistry;
  /** undefined ⇒ all of the registry's object types (Knowledge). */
  objectTypes?: RetrievalObjectType[];
  /** Provider audit/egress surface; reuse the existing per-domain brief surfaces. */
  surface: string;
  /** Memory keeps trace out of its private artifact, matching the brief route. */
  persistTrace: boolean;
}

const DOMAIN_CONFIG: Record<AskSpaceDomain, DomainConfig> = {
  knowledge: { registry: knowledgeRetrievalRegistry, objectTypes: undefined, surface: "knowledge_brief", persistTrace: true },
  memory: { registry: memoryRetrievalRegistry, objectTypes: ["memory_entry"], surface: "memory_retrieval_brief", persistTrace: false },
  project: {
    registry: projectRetrievalRegistry,
    objectTypes: ["project_public_summary"],
    surface: "project_public_summary_brief",
    persistTrace: false,
  },
  source: {
    registry: sourceRetrievalRegistry,
    objectTypes: ["source_item", "extracted_evidence"],
    surface: "source_brief",
    persistTrace: false,
  },
  inquiry: {
    registry: inquiryRetrievalRegistry,
    objectTypes: ["inquiry_thread"],
    surface: "inquiry_brief",
    persistTrace: true,
  },
};

/**
 * Think / Ask Space orchestrator (Slice A). Runs each requested domain's own
 * Context Brief pipeline (reusing the per-domain registry + read gate; the
 * domains are never merged into one retrieval pass), then rolls the per-domain
 * cited answers into one gap summary + provenance + proposal-first follow-ups.
 * Read-only for canonical state: it may persist owner-private artifacts but never
 * writes claims/relations/Knowledge/Memory.
 */
interface DomainCtx {
  maxResults: number;
  mode: RetrievalSearchMode;
  includeTrace: boolean;
  adaptiveReturn: boolean;
  useCache: boolean;
  egressPolicy: { externalEgressEnabled: boolean };
  store: ReturnType<typeof resolveProviderCommandStore>;
  rerankEnabled: boolean;
  embeddingDimensions: number;
  settings: Awaited<ReturnType<typeof readSpaceRetrievalSettings>>;
}

interface DomainBriefArgs {
  domain: AskSpaceDomain;
  cfg: DomainConfig;
  ctx: DomainCtx;
  input: AskSpaceInput;
}

/**
 * Injectable seams (all optional, with production defaults) so the orchestration
 * — multi-domain fan-out, persistence, Memory access logging, partial-domain
 * failure, follow-up gating — can be unit-tested without a live retrieval index
 * or provider. Production wiring uses the defaults.
 */
export interface AskSpaceDeps {
  runDomainBrief?: (args: DomainBriefArgs) => Promise<RetrievalBriefResponse>;
  runCombinedSynthesis?: (args: {
    spaceId: string;
    userId: string;
    query: string;
    candidates: BriefCandidate[];
    egressPolicy: RetrievalEgressPolicy;
    ctx: DomainCtx;
  }) => Promise<SynthesisResult | null>;
  recordMemoryReads?: (ids: string[], spaceId: string, userId: string) => Promise<void>;
  canRunActions?: (spaceId: string, userId: string) => Promise<boolean>;
  loadClaimTrajectory?: (claimId: string, spaceId: string, userId: string) => Promise<AskSpaceClaimTrajectory | null>;
}

export class AskSpaceService {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
    private readonly deps: AskSpaceDeps = {},
  ) {}

  static fromConfig(config: ServerConfig): AskSpaceService {
    return new AskSpaceService(dbPool(config), config);
  }

  async think(input: AskSpaceInput): Promise<AskSpaceResponse> {
    const now = new Date();
    // dedupeDomains falls back to the default domain set when the list is empty.
    const requestedDomains = dedupeDomains(input.domains ?? []);
    const settings = await readSpaceRetrievalSettings(this.db, input.spaceId);
    const maxResults = input.maxResultsPerDomain ?? settings.maxResultsDefault;
    const mode = input.mode ?? settings.defaultSearchMode;
    const includeTrace = input.includeTrace ?? settings.includeTrace;
    const adaptiveReturn = input.adaptiveReturn ?? settings.rankingConfig.mechanics.autocut.state === "shipped";
    const egressPolicy = { externalEgressEnabled: settings.externalEgressEnabled };
    const store = resolveProviderCommandStore(this.config);

    const sections = await Promise.all(
      requestedDomains.map((domain) =>
        this.buildDomainSection(domain, input, {
          maxResults,
          mode,
          includeTrace,
          adaptiveReturn,
          useCache: settings.useQueryCache,
          egressPolicy,
          store,
          rerankEnabled: settings.rerankEnabled,
          embeddingDimensions: settings.embeddingDimensions,
          settings,
        }),
      ),
    );

    const gapSummary = aggregateGaps(sections);
    const provenance = collectProvenance(sections);
    const synthesized = sections.some((section) => section.brief?.synthesized === true);
    const combinedAnswer = input.combine
      ? await this.buildCombinedAnswer(input, sections, {
          maxResults,
          mode,
          includeTrace,
          adaptiveReturn,
          useCache: settings.useQueryCache,
          egressPolicy,
          store,
          rerankEnabled: settings.rerankEnabled,
          embeddingDimensions: settings.embeddingDimensions,
          settings,
        })
      : null;

    const briefArtifactRefs = sections
      .filter((section): section is AskSpaceDomainSection & { artifact_id: string } =>
        typeof section.artifact_id === "string" && section.artifact_id.length > 0)
      .map((section) => ({ domain: section.domain, artifact_id: section.artifact_id }));

    // Both follow-up routes (claim candidate packets, maintenance scan) require
    // Context Ops scan authority, so only offer them when the viewer actually has
    // it — otherwise the buttons would 403.
    const canRunActions = await (this.deps.canRunActions
      ? this.deps.canRunActions(input.spaceId, input.userId)
      : canInitiateContextOpsScan(this.db, input.spaceId, input.userId));
    const followUps = buildFollowUps(briefArtifactRefs.map((ref) => ref.artifact_id), gapSummary, canRunActions);

    const claimTrajectories = input.includeClaimTrajectory
      ? await this.collectClaimTrajectories(input, provenance)
      : [];

    let sessionArtifactId: string | undefined;
    let sessionArtifactError: string | undefined;
    if (input.persist) {
      try {
        sessionArtifactId = await persistAskSpaceSessionArtifact(this.db, {
          spaceId: input.spaceId,
          ownerUserId: input.userId,
          query: input.query,
          requestedDomains,
          briefArtifactRefs,
          gapSummary,
          provenance,
          synthesized,
          combinedAnswer,
        });
      } catch {
        sessionArtifactError = "ask_space_session_persist_failed";
      }
    }

    return {
      generated_at: now.toISOString(),
      space_id: input.spaceId,
      query: input.query,
      requested_domains: requestedDomains,
      domains: sections,
      synthesized,
      combined_answer: combinedAnswer,
      gap_summary: gapSummary,
      provenance,
      claim_trajectories: claimTrajectories,
      follow_ups: followUps,
      ...(sessionArtifactId ? { session_artifact_id: sessionArtifactId } : {}),
      ...(sessionArtifactError ? { session_artifact_error: sessionArtifactError } : {}),
      canonical_write_performed: false,
    };
  }

  /**
   * Advisory claim trajectory for each distinct claim the answer cited. Uses the
   * Slice E read gate (only viewer-visible sibling claims) and dedupes by claim
   * id; no canonical writes. A per-claim failure is swallowed so trajectory never
   * sinks the answer.
   */
  private async collectClaimTrajectories(
    input: AskSpaceInput,
    provenance: readonly AskSpaceProvenanceItem[],
  ): Promise<AskSpaceClaimTrajectory[]> {
    const claimIds: string[] = [];
    for (const item of provenance) {
      if (item.object_type === "claim" && !claimIds.includes(item.object_id)) claimIds.push(item.object_id);
    }
    const out: AskSpaceClaimTrajectory[] = [];
    for (const claimId of claimIds) {
      try {
        const trajectory = this.deps.loadClaimTrajectory
          ? await this.deps.loadClaimTrajectory(claimId, input.spaceId, input.userId)
          : await this.defaultLoadClaimTrajectory(claimId, input.spaceId, input.userId);
        if (trajectory) out.push(trajectory);
      } catch {
        // ignore a single claim's trajectory failure
      }
    }
    return out;
  }

  private async defaultLoadClaimTrajectory(
    claimId: string,
    spaceId: string,
    userId: string,
  ): Promise<AskSpaceClaimTrajectory | null> {
    const trajectory = await buildClaimTrajectory(this.db, { spaceId, userId, claimId, limit: 100 });
    if (trajectory.signals.length === 0) return null;
    return {
      claim_id: claimId,
      subject_object_id: trajectory.subject_object_id,
      subject_text: trajectory.subject_text,
      signals: trajectory.signals,
    };
  }

  private async buildCombinedAnswer(
    input: AskSpaceInput,
    sections: readonly AskSpaceDomainSection[],
    ctx: DomainCtx,
  ): Promise<string | null> {
    const candidates = combinedSynthesisCandidates(sections, Boolean(input.combineIncludeMemory));
    if (candidates.length < 2) return null;
    const egressPolicy = await this.egressPolicyForCombinedPayload(input.spaceId, candidates, ctx.egressPolicy);
    try {
      const synth = this.deps.runCombinedSynthesis
        ? await this.deps.runCombinedSynthesis({
            spaceId: input.spaceId,
            userId: input.userId,
            query: input.query,
            candidates,
            egressPolicy,
            ctx,
          })
        : await new ProviderSynthesizer(ctx.store, {
            databaseUrl: this.config.databaseUrl,
            surface: "ask_space_combined",
            egressPolicy: ctx.egressPolicy,
          }).synthesize(input.spaceId, input.userId, input.query, candidates, egressPolicy);
      return synth?.answer ?? null;
    } catch {
      return null;
    }
  }

  private async egressPolicyForCombinedPayload(
    spaceId: string,
    candidates: readonly BriefCandidate[],
    basePolicy: RetrievalEgressPolicy,
  ): Promise<RetrievalEgressPolicy> {
    const sourceIds = uniqueSourceConnectionIds(candidates);
    if (sourceIds.length === 0) return basePolicy;
    const snapshots = await loadSourcePolicySnapshots(this.db, spaceId, sourceIds);
    return {
      ...basePolicy,
      sourcePolicies: sourceEgressPoliciesForSnapshots(snapshots),
      payloadSourceConnectionIds: sourceIds,
    };
  }

  /** Default per-domain brief: build the domain's search service and synthesize. */
  private async defaultRunDomainBrief({ cfg, ctx, input }: DomainBriefArgs): Promise<RetrievalBriefResponse> {
    const search = new RetrievalSearchService(this.db, cfg.registry, {
      egressPolicy: ctx.egressPolicy,
      queryEmbedder: new ProviderQueryEmbedder(
        ctx.store,
        null,
        undefined,
        ctx.embeddingDimensions,
        ctx.egressPolicy,
      ),
      reranker: ctx.rerankEnabled
        ? new ProviderReranker(ctx.store, {
            databaseUrl: this.config.databaseUrl,
            surface: cfg.surface,
            egressPolicy: ctx.egressPolicy,
          })
        : undefined,
      synthesizer: new ProviderSynthesizer(ctx.store, {
        databaseUrl: this.config.databaseUrl,
        surface: cfg.surface,
        egressPolicy: ctx.egressPolicy,
      }),
    });
    return search.buildBrief({
      spaceId: input.spaceId,
      viewerUserId: input.userId,
      objectTypes: cfg.objectTypes,
      query: input.query,
      maxResults: ctx.maxResults,
      includeTrace: ctx.includeTrace,
      mode: ctx.mode,
      useCache: ctx.useCache,
      adaptiveReturn: ctx.adaptiveReturn,
      rankingConfig: ctx.settings.rankingConfig,
    });
  }

  private async buildDomainSection(
    domain: AskSpaceDomain,
    input: AskSpaceInput,
    ctx: DomainCtx,
  ): Promise<AskSpaceDomainSection> {
    const cfg = DOMAIN_CONFIG[domain];
    const objectTypes = cfg.objectTypes ?? cfg.registry.objectTypes();
    try {
      const runner = this.deps.runDomainBrief ?? ((args) => this.defaultRunDomainBrief(args));
      const response = await runner({ domain, cfg, ctx, input });

      // Memory reads are access-logged exactly like the Memory brief route, so
      // Think never weakens Memory provenance (invariant 14).
      if (domain === "memory") {
        const ids = response.items.map((item) => item.object_id);
        if (ids.length > 0) {
          await (this.deps.recordMemoryReads
            ? this.deps.recordMemoryReads(ids, input.spaceId, input.userId)
            : PgMemoryReadRepository.fromConfig(this.config).recordRetrievalSearchReads(
                ids,
                input.spaceId,
                input.userId,
              ));
        }
      }

      let artifactId: string | undefined;
      let artifactError: string | undefined;
      if (input.persist) {
        try {
          artifactId = await persistRetrievalBriefArtifact(this.db, {
            spaceId: input.spaceId,
            ownerUserId: input.userId,
            runId: null,
            projectId: null,
            query: input.query,
            objectTypes: cfg.objectTypes,
            maxResults: ctx.maxResults,
            includeTrace: ctx.includeTrace,
            mode: ctx.mode,
            surface: cfg.surface,
            response,
            persistTrace: cfg.persistTrace,
            egressPolicySnapshot: { external_egress_enabled: ctx.settings.externalEgressEnabled },
            settingsSnapshot: {
              default_search_mode: ctx.settings.defaultSearchMode,
              rerank_enabled: ctx.settings.rerankEnabled,
              query_rewrite_enabled: ctx.settings.queryRewriteEnabled,
              use_query_cache: ctx.settings.useQueryCache,
              embedding_dimensions: ctx.settings.embeddingDimensions,
              max_results_default: ctx.settings.maxResultsDefault,
            },
          });
        } catch {
          artifactError = "retrieval_brief_persist_failed";
        }
      }

      return {
        domain,
        object_types: objectTypes,
        brief: response.brief,
        items: response.items,
        total: response.total,
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(artifactError ? { artifact_error: artifactError } : {}),
      };
    } catch {
      // One domain failing (e.g. a DB/adapter error) must not sink the others.
      return {
        domain,
        object_types: objectTypes,
        brief: null,
        items: [],
        total: 0,
        error_code: "domain_failed",
      };
    }
  }
}

function combinedSynthesisCandidates(
  sections: readonly AskSpaceDomainSection[],
  includeMemory: boolean,
): BriefCandidate[] {
  const out: BriefCandidate[] = [];
  for (const section of sections) {
    if (section.domain === "memory" && !includeMemory) continue;
    const answer = section.brief?.answer?.trim();
    if (!answer || section.brief?.synthesized !== true) continue;
    out.push({
      objectType: primaryObjectType(section),
      objectId: `ask-space-${section.domain}`,
      title: `${domainLabel(section.domain)} answer`,
      text: combinedCandidateText(section, answer),
      updatedAt: null,
      sourceConnectionIds: sourceConnectionIdsFromItems(section.items),
    });
  }
  return out;
}

function combinedCandidateText(section: AskSpaceDomainSection, answer: string): string {
  const citedTitles = (section.brief?.citations ?? [])
    .map((citation, index) => `${index + 1}. ${citation.title}`)
    .join("\n");
  return citedTitles
    ? `Domain: ${domainLabel(section.domain)}\nAnswer:\n${answer}\n\nCited sources:\n${citedTitles}`
    : `Domain: ${domainLabel(section.domain)}\nAnswer:\n${answer}`;
}

function primaryObjectType(section: AskSpaceDomainSection): RetrievalObjectType {
  const first = section.object_types[0];
  if (first) return first;
  if (section.domain === "memory") return "memory_entry";
  if (section.domain === "project") return "project_public_summary";
  if (section.domain === "source") return "source_item";
  if (section.domain === "inquiry") return "inquiry_thread";
  return "knowledge_item";
}

function domainLabel(domain: AskSpaceDomain): string {
  if (domain === "memory") return "Memory";
  if (domain === "project") return "Project summaries";
  if (domain === "source") return "Source";
  if (domain === "inquiry") return "Inquiry";
  return "Knowledge";
}

function sourceConnectionIdsFromItems(items: readonly AskSpaceDomainSection["items"][number][]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    for (const ref of item.source_refs ?? []) {
      const sourceId = sourceConnectionIdFromRef(ref);
      if (sourceId && !ids.includes(sourceId)) ids.push(sourceId);
    }
  }
  return ids;
}

function sourceConnectionIdFromRef(ref: unknown): string {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return "";
  const record = ref as Record<string, unknown>;
  const direct = stringValue(record.source_connection_id);
  if (direct) return direct;
  return stringValue(record.source_type) === "source_connection"
    ? stringValue(record.source_id)
    : "";
}

function uniqueSourceConnectionIds(candidates: readonly BriefCandidate[]): string[] {
  const ids: string[] = [];
  for (const candidate of candidates) {
    for (const sourceId of candidate.sourceConnectionIds ?? []) {
      if (sourceId && !ids.includes(sourceId)) ids.push(sourceId);
    }
  }
  return ids;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}
