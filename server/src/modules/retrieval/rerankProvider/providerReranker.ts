import type { RerankCandidate, RerankScore, Reranker } from "..";
import { getDbPool } from "../../../db/pool";
import {
  completeProviderRerank,
  completeProviderText,
  ProviderInvocationError,
} from "../../providers/invocation/invocation";
import type { ProviderCommandStore } from "../../providers/commands/store";
import { retrievalEgressAllowed, ALLOW_ALL_EGRESS, type RetrievalEgressPolicy } from "../egress/egressPolicy";
import { writePolicyAudit } from "../../policy/auditWriter";
import { resolveRetrievalRerankSystemPrompt } from "../promptRegistry";
import { RETRIEVAL_RERANK_TASK } from "./config";
import { buildRerankPrompt, parseRerankScores } from "./prompt";

export type RerankSystemPromptResolver = (
  spaceId: string,
  viewerUserId: string,
) => Promise<string | null>;

export interface ProviderRerankerOptions {
  /** Caller's own provider; the task chain is tried first, this is the safety net. */
  providerId?: string | null;
  /** When set, a best-effort provider-egress audit row is written per rerank call. */
  databaseUrl?: string | null;
  /** Search surface tag recorded in the audit metadata (never content). */
  surface?: string | null;
  /** Test/integration seam for resolving the registry-backed system prompt. */
  systemPromptResolver?: RerankSystemPromptResolver | null;
  /** W9 egress policy; when egress is disabled the reranker sends nothing. */
  egressPolicy?: RetrievalEgressPolicy;
}

/**
 * Production reranker. Routes the relevance-judging call through the
 * `retrieval_rerank` provider task policy (ADR 0008 credential channel), exactly
 * like the embedding and public-summary auxiliary tasks. It is deliberately
 * resilient: any provider failure, missing provider, or unparseable response
 * returns `null` so search degrades to the deterministic fused order.
 *
 * Egress: the same reserved `retrievalEgressAllowed` seam the embedding backfill
 * consults gates each candidate before it is sent, so a future memory-egress
 * deny excludes a row from BOTH embedding and reranking without re-architecting.
 */
export class ProviderReranker implements Reranker {
  private readonly providerId: string | null;
  private readonly databaseUrl: string | null;
  private readonly surface: string | null;
  private readonly systemPromptResolver: RerankSystemPromptResolver | null;
  private readonly egressPolicy: RetrievalEgressPolicy;

  constructor(
    private readonly store: ProviderCommandStore,
    options: ProviderRerankerOptions = {},
  ) {
    this.providerId = options.providerId ?? null;
    this.databaseUrl = options.databaseUrl ?? null;
    this.surface = options.surface ?? null;
    this.systemPromptResolver = options.systemPromptResolver ?? defaultSystemPromptResolver(this.databaseUrl);
    this.egressPolicy = options.egressPolicy ?? ALLOW_ALL_EGRESS;
  }

  async rerank(
    spaceId: string,
    viewerUserId: string,
    query: string,
    candidates: readonly RerankCandidate[],
    egressPolicy?: RetrievalEgressPolicy,
  ): Promise<RerankScore[] | null> {
    if (candidates.length === 0) return null;
    const effectivePolicy = egressPolicy ?? policyWithCandidateSourcePayload(this.egressPolicy, candidates);
    // Row-level egress gate. Provider destination is enforced separately at the
    // provider invocation layer so local providers can still be used when
    // external provider egress is disabled.
    const contentPolicy: RetrievalEgressPolicy = {
      ...effectivePolicy,
      destination: "internal_process",
    };
    const eligible = candidates.filter((candidate) =>
      retrievalEgressAllowed({
        object_type: candidate.objectType,
        object_id: candidate.objectId,
        source_connection_ids: candidate.sourceConnectionIds,
      }, contentPolicy),
    );
    if (eligible.length === 0) return null;

    const nativeScores = await this.tryNativeRerank(spaceId, viewerUserId, query, eligible, effectivePolicy);
    if (nativeScores !== "unsupported") return nativeScores;

    const systemPrompt = await this.systemPromptResolver?.(spaceId, viewerUserId);
    if (!systemPrompt) return null;
    const prompt = buildRerankPrompt(query, eligible, systemPrompt);
    let completion: { text: string; model: string };
    try {
      completion = await completeProviderText(this.store, spaceId, {
        provider_id: this.providerId ?? "",
        system: prompt.system,
        user: prompt.user,
        task: RETRIEVAL_RERANK_TASK,
        egressPolicy: effectivePolicy,
        metering: { subject_user_id: viewerUserId },
      });
    } catch {
      return null;
    }

    const parsed = parseRerankScores(completion.text, eligible.length);
    const scores: RerankScore[] = parsed
      ? parsed.map((entry) => ({
          objectType: eligible[entry.index]!.objectType,
          objectId: eligible[entry.index]!.objectId,
          score: entry.score,
        }))
      : [];
    await this.writeAudit(spaceId, viewerUserId, completion.model, eligible.length, scores.length);
    if (!parsed) return null;
    return scores;
  }

  private async tryNativeRerank(
    spaceId: string,
    viewerUserId: string,
    query: string,
    eligible: readonly RerankCandidate[],
    egressPolicy: RetrievalEgressPolicy,
  ): Promise<RerankScore[] | null | "unsupported"> {
    try {
      const result = await completeProviderRerank(this.store, spaceId, {
        provider_id: this.providerId ?? "",
        query,
        documents: eligible.map(rerankDocument),
        topN: eligible.length,
        task: RETRIEVAL_RERANK_TASK,
        egressPolicy,
        metering: { subject_user_id: viewerUserId },
      });
      const scores: RerankScore[] = [];
      const seen = new Set<number>();
      for (const entry of result.scores) {
        if (seen.has(entry.index)) continue;
        const candidate = eligible[entry.index];
        if (!candidate) continue;
        seen.add(entry.index);
        scores.push({
          objectType: candidate.objectType,
          objectId: candidate.objectId,
          score: entry.score,
        });
      }
      await this.writeAudit(spaceId, viewerUserId, result.model, eligible.length, scores.length);
      if (scores.length === 0) return null;
      return scores;
    } catch (error) {
      if (
        error instanceof ProviderInvocationError &&
        error.statusCode === 400 &&
        error.message.includes("does not support native rerank")
      ) {
        return "unsupported";
      }
      return null;
    }
  }

  /**
   * Best-effort durable audit that visible content was sent to a model provider
   * for reranking. Records pointer/aggregate metadata only (task, model, counts,
   * surface) — never the query or document content. Attributed to the requesting
   * user. A failure here must not fail the search.
   */
  private async writeAudit(
    spaceId: string,
    viewerUserId: string,
    model: string,
    candidateCount: number,
    scoredCount: number,
  ): Promise<void> {
    if (!this.databaseUrl) return;
    try {
      await writePolicyAudit(this.databaseUrl, {
        space_id: spaceId,
        actor_type: "user",
        actor_id: viewerUserId,
        actor_ref_json: { service: "retrieval_rerank" },
        action: "retrieval.rerank",
        resource_type: "retrieval_objects",
        resource_id: null,
        decision: "allow",
        risk_level: "low",
        required_approver_role: null,
        approval_capability: null,
        policy_rule_id: "retrieval_rerank",
        policy_source: "retrieval_rerank",
        policy_id: null,
        audit_code: "retrieval_rerank.score",
        run_id: null,
        proposal_id: null,
        metadata_json: {
          task: RETRIEVAL_RERANK_TASK,
          model,
          candidate_count: candidateCount,
          scored_count: scoredCount,
          surface: this.surface,
        },
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      process.stderr.write(
        `[retrieval.rerank] policy audit write failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

function rerankDocument(candidate: RerankCandidate): string {
  return [candidate.title, candidate.text].filter(Boolean).join("\n\n");
}

function policyWithCandidateSourcePayload(
  policy: RetrievalEgressPolicy,
  candidates: readonly RerankCandidate[],
): RetrievalEgressPolicy {
  const sourceIds = uniqueSourceConnectionIds(candidates);
  return sourceIds.length ? { ...policy, payloadSourceConnectionIds: sourceIds } : policy;
}

function uniqueSourceConnectionIds(candidates: readonly RerankCandidate[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    for (const sourceId of candidate.sourceConnectionIds ?? []) {
      if (sourceId && !out.includes(sourceId)) out.push(sourceId);
    }
  }
  return out;
}

function defaultSystemPromptResolver(databaseUrl: string | null): RerankSystemPromptResolver | null {
  if (!databaseUrl) return null;
  return async (spaceId, viewerUserId) =>
    resolveRetrievalRerankSystemPrompt(getDbPool(databaseUrl), { spaceId, userId: viewerUserId });
}
