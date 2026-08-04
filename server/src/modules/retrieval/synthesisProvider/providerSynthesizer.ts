import type { BriefCandidate, SynthesisResult, Synthesizer } from "..";
import { getDbPool } from "../../../db/pool";
import { completeProviderText } from "../../providers/invocation/invocation";
import type { ProviderCommandStore } from "../../providers/commands/store";
import { retrievalEgressAllowed, ALLOW_ALL_EGRESS, type RetrievalEgressPolicy } from "../egress/egressPolicy";
import { writePolicyAudit } from "../../policy/auditWriter";
import { resolveRetrievalSynthesisSystemPrompt } from "../promptRegistry";
import { RETRIEVAL_SYNTHESIS_TASK } from "./config";
import { buildSynthesisPrompt, parseSynthesis, type SynthesisDoc } from "./prompt";

const TASK_POLICY_REQUIRED_PROVIDER_ID = "__retrieval_synthesis_task_policy_required__";

export type SynthesisSystemPromptResolver = (
  spaceId: string,
  viewerUserId: string,
) => Promise<string | null>;

export interface ProviderSynthesizerOptions {
  /** Explicit fallback provider after the task chain. Omit to require the task policy. */
  providerId?: string | null;
  /** When set, a best-effort provider-egress audit row is written per synthesis call. */
  databaseUrl?: string | null;
  /** Brief surface tag recorded in the audit metadata (never content). */
  surface?: string | null;
  /** Test/integration seam for resolving the registry-backed system prompt. */
  systemPromptResolver?: SynthesisSystemPromptResolver | null;
  /** W9 egress policy; when egress is disabled the synthesizer sends nothing. */
  egressPolicy?: RetrievalEgressPolicy;
}

/**
 * Production Context Brief synthesizer. Routes the answer-generation call through
 * the `retrieval_synthesis` provider task policy (ADR 0008 credential channel).
 * Resilient by design: any provider failure, missing task policy, missing provider,
 * or unparseable response returns `null` so buildBrief degrades to a
 * deterministic-only brief.
 *
 * The candidate title/text it receives is ALREADY live-revalidated by the engine
 * (invariant 1/2). It additionally consults the shared `retrievalEgressAllowed`
 * seam — an egress-denied source is omitted from the prompt entirely (so it is
 * never sent and can never be cited), and the surviving docs keep their ORIGINAL
 * candidate index so the engine can map citations back faithfully.
 */
export class ProviderSynthesizer implements Synthesizer {
  private readonly providerId: string | null;
  private readonly databaseUrl: string | null;
  private readonly surface: string | null;
  private readonly systemPromptResolver: SynthesisSystemPromptResolver | null;
  private readonly egressPolicy: RetrievalEgressPolicy;

  constructor(
    private readonly store: ProviderCommandStore,
    options: ProviderSynthesizerOptions = {},
  ) {
    this.providerId = options.providerId ?? null;
    this.databaseUrl = options.databaseUrl ?? null;
    this.surface = options.surface ?? null;
    this.systemPromptResolver = options.systemPromptResolver ?? defaultSystemPromptResolver(this.databaseUrl);
    this.egressPolicy = options.egressPolicy ?? ALLOW_ALL_EGRESS;
  }

  async synthesize(
    spaceId: string,
    viewerUserId: string,
    query: string,
    candidates: readonly BriefCandidate[],
    egressPolicy?: RetrievalEgressPolicy,
  ): Promise<SynthesisResult | null> {
    if (candidates.length === 0) return null;
    const effectivePolicy = egressPolicy ?? policyWithCandidateSourcePayload(this.egressPolicy, candidates);
    // Row-level egress gate. Provider destination is enforced separately at the
    // provider invocation layer so local providers can still be used when
    // external provider egress is disabled.
    const contentPolicy: RetrievalEgressPolicy = {
      ...effectivePolicy,
      destination: "internal_process",
    };
    const docs: SynthesisDoc[] = [];
    candidates.forEach((candidate, index) => {
      if (!retrievalEgressAllowed({
        object_type: candidate.objectType,
        object_id: candidate.objectId,
        source_connection_ids: candidate.sourceConnectionIds,
      }, contentPolicy)) return;
      docs.push({ index, title: candidate.title, text: candidate.text });
    });
    if (docs.length === 0) return null;

    const systemPrompt = await this.systemPromptResolver?.(spaceId, viewerUserId);
    if (!systemPrompt) return null;
    const prompt = buildSynthesisPrompt(query, docs, systemPrompt);
    let completion: { text: string; model: string };
    try {
      completion = await completeProviderText(this.store, spaceId, {
        provider_id: this.providerId ?? TASK_POLICY_REQUIRED_PROVIDER_ID,
        system: prompt.system,
        user: prompt.user,
        task: RETRIEVAL_SYNTHESIS_TASK,
        egressPolicy: effectivePolicy,
        metering: { subject_user_id: viewerUserId },
      });
    } catch {
      return null;
    }

    const parsed = parseSynthesis(completion.text);
    const allowedCitationIndices = new Set(docs.map((doc) => doc.index));
    const citations = parsed?.citations.filter((index) => allowedCitationIndices.has(index)) ?? [];
    await this.writeAudit(spaceId, viewerUserId, completion.model, docs.length, citations.length);
    if (!parsed) return null;
    return { ...parsed, citations };
  }

  /**
   * Best-effort durable audit that visible content was sent to a model provider
   * for synthesis. Pointer/aggregate metadata only (task, model, counts, surface)
   * — never the query or document content. A failure here must not fail the brief.
   */
  private async writeAudit(
    spaceId: string,
    viewerUserId: string,
    model: string,
    sourceCount: number,
    citationCount: number,
  ): Promise<void> {
    if (!this.databaseUrl) return;
    try {
      await writePolicyAudit(this.databaseUrl, {
        space_id: spaceId,
        actor_type: "user",
        actor_id: viewerUserId,
        actor_ref_json: { service: "retrieval_synthesis" },
        action: "retrieval.synthesis",
        resource_type: "retrieval_objects",
        resource_id: null,
        decision: "allow",
        risk_level: "low",
        required_approver_role: null,
        approval_capability: null,
        policy_rule_id: "retrieval_synthesis",
        policy_source: "retrieval_synthesis",
        policy_id: null,
        audit_code: "retrieval_synthesis.brief",
        run_id: null,
        proposal_id: null,
        metadata_json: {
          task: RETRIEVAL_SYNTHESIS_TASK,
          model,
          source_count: sourceCount,
          citation_count: citationCount,
          surface: this.surface,
        },
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      process.stderr.write(
        `[retrieval.synthesis] policy audit write failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

function policyWithCandidateSourcePayload(
  policy: RetrievalEgressPolicy,
  candidates: readonly BriefCandidate[],
): RetrievalEgressPolicy {
  const sourceIds = uniqueSourceConnectionIds(candidates);
  return sourceIds.length ? { ...policy, payloadSourceConnectionIds: sourceIds } : policy;
}

function uniqueSourceConnectionIds(candidates: readonly BriefCandidate[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    for (const sourceId of candidate.sourceConnectionIds ?? []) {
      if (sourceId && !out.includes(sourceId)) out.push(sourceId);
    }
  }
  return out;
}

function defaultSystemPromptResolver(databaseUrl: string | null): SynthesisSystemPromptResolver | null {
  if (!databaseUrl) return null;
  return async (spaceId, viewerUserId) =>
    resolveRetrievalSynthesisSystemPrompt(getDbPool(databaseUrl), { spaceId, userId: viewerUserId });
}
