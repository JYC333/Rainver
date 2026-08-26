import type { QueryRewriter } from "../index.js";
import { getDbPool } from "../../../db/pool.js";
import { completeProviderText } from "../../providers/invocation/invocation.js";
import type { ProviderCommandStore } from "../../providers/commands/store.js";
import { writePolicyAudit } from "../../policy/auditWriter.js";
import type { RetrievalEgressPolicy } from "../egress/egressPolicy.js";
import { resolveRetrievalQueryRewritePrompt, type ResolvedQueryRewritePrompt } from "../promptRegistry.js";
import { RETRIEVAL_QUERY_REWRITE_TASK } from "./config.js";
import { parseQueryRewriteVariants } from "./prompt.js";

export type QueryRewritePromptResolver = (
  spaceId: string,
  viewerUserId: string,
  query: string,
) => Promise<ResolvedQueryRewritePrompt | null>;

export interface ProviderQueryRewriterOptions {
  /** Caller's own provider; the task chain is tried first, this is the safety net. */
  providerId?: string | null;
  /** When set, a best-effort provider-egress audit row is written per rewrite call. */
  databaseUrl?: string | null;
  /** Search surface tag recorded in the audit metadata (never the query text). */
  surface?: string | null;
  /** Test/integration seam for resolving the registry-backed prompt. */
  promptResolver?: QueryRewritePromptResolver | null;
  /** Space/provider egress policy. External providers are blocked when disabled. */
  egressPolicy?: RetrievalEgressPolicy | null;
}

/**
 * Production query rewriter. Routes the rephrasing call through the
 * `retrieval_query_rewrite` provider task policy (ADR 0008 credential channel),
 * exactly like the embedding and rerank auxiliary tasks. It is deliberately
 * resilient: any provider failure, missing provider, or unparseable response
 * returns `null`, so search degrades to the original query alone.
 *
 * The query string is the only content sent — there is no candidate-content
 * per-row egress gate — but the provider destination still obeys the space
 * external-egress policy. The audit records counts only, never the query.
 */
export class ProviderQueryRewriter implements QueryRewriter {
  private readonly providerId: string | null;
  private readonly databaseUrl: string | null;
  private readonly surface: string | null;
  private readonly promptResolver: QueryRewritePromptResolver | null;
  private readonly egressPolicy: RetrievalEgressPolicy | null;

  constructor(
    private readonly store: ProviderCommandStore,
    options: ProviderQueryRewriterOptions = {},
  ) {
    this.providerId = options.providerId ?? null;
    this.databaseUrl = options.databaseUrl ?? null;
    this.surface = options.surface ?? null;
    this.promptResolver = options.promptResolver ?? defaultPromptResolver(this.databaseUrl);
    this.egressPolicy = options.egressPolicy ?? null;
  }

  async rewrite(spaceId: string, viewerUserId: string, query: string): Promise<string[] | null> {
    const trimmed = query.trim();
    if (!trimmed) return null;
    const prompt = await this.promptResolver?.(spaceId, viewerUserId, trimmed);
    if (!prompt) return null;
    let completion: { text: string; model: string };
    try {
      completion = await completeProviderText(this.store, spaceId, {
        provider_id: this.providerId ?? "",
        system: prompt.system,
        user: prompt.user,
        task: RETRIEVAL_QUERY_REWRITE_TASK,
        egressPolicy: this.egressPolicy,
        metering: { subject_user_id: viewerUserId },
      });
    } catch {
      return null;
    }
    const variants = parseQueryRewriteVariants(completion.text);
    if (!variants) return null;
    await this.writeAudit(spaceId, viewerUserId, completion.model, variants.length);
    return variants;
  }

  /**
   * Best-effort durable audit that a query was sent to a model provider for
   * rewriting. Records pointer/aggregate metadata only (task, model, variant
   * count, surface) — never the query or the produced variants. Attributed to the
   * requesting user. A failure here must not fail the search.
   */
  private async writeAudit(
    spaceId: string,
    viewerUserId: string,
    model: string,
    variantCount: number,
  ): Promise<void> {
    if (!this.databaseUrl) return;
    try {
      await writePolicyAudit(this.databaseUrl, {
        space_id: spaceId,
        actor_type: "user",
        actor_id: viewerUserId,
        actor_ref_json: { service: "retrieval_query_rewrite" },
        action: "retrieval.query_rewrite",
        resource_type: "retrieval_query",
        resource_id: null,
        decision: "allow",
        risk_level: "low",
        required_approver_role: null,
        approval_capability: null,
        policy_rule_id: "retrieval_query_rewrite",
        policy_source: "retrieval_query_rewrite",
        policy_id: null,
        audit_code: "retrieval_query_rewrite.expand",
        run_id: null,
        proposal_id: null,
        metadata_json: {
          task: RETRIEVAL_QUERY_REWRITE_TASK,
          model,
          variant_count: variantCount,
          surface: this.surface,
        },
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      process.stderr.write(
        `[retrieval.query_rewrite] policy audit write failed: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }
}

function defaultPromptResolver(databaseUrl: string | null): QueryRewritePromptResolver | null {
  if (!databaseUrl) return null;
  return async (spaceId, viewerUserId, query) =>
    resolveRetrievalQueryRewritePrompt(getDbPool(databaseUrl), { spaceId, userId: viewerUserId, query });
}
