import { normalizeAlias } from "./normalize.js";

/**
 * Pre-recall query rewriting stage (Phase 2, step 8).
 *
 * Query rewriting is a NON-deterministic LLM stage that operates on the query
 * STRING ONLY — it never touches candidate content, so it has no access-control
 * surface (the query is already user-typed text, sent to a provider exactly like
 * query embedding). It is space-setting-gated, skippable, and never required for
 * correctness: the original query is always searched, variants are only ADDED,
 * and any failure degrades to the original query alone.
 *
 * The engine owns only the seam + the deterministic merge bound; the provider
 * call, prompt, and audit live in the app layer (`modules/retrieval/queryRewriteProvider`).
 */
export interface QueryRewriter {
  /**
   * Produce up to a few intent-preserving rephrasings of the query (synonyms,
   * expanded acronyms, related terms). `viewerUserId` is the requesting user,
   * passed so the provider-egress audit can attribute the call. Returns the
   * ADDITIONAL variants (not the original), or `null` to signal the stage is
   * unavailable/failed.
   */
  rewrite(spaceId: string, viewerUserId: string, query: string): Promise<string[] | null>;
}

/** Max rewrite variants searched alongside the original query (bounds fan-out). */
export const MAX_REWRITE_VARIANTS = 3;

/**
 * Merge the original query with the reranker variants into the bounded, deduped
 * query set to search. The original is ALWAYS first so disabling/failing the
 * rewriter is exactly the single-query behavior. Variants are trimmed, dropped
 * when empty or a normalized duplicate of an already-included query, and capped.
 */
export function mergeRewriteVariants(
  original: string,
  variants: readonly string[],
  max: number = MAX_REWRITE_VARIANTS,
): string[] {
  const queries = [original];
  const seen = new Set<string>([normalizeAlias(original)]);
  for (const variant of variants) {
    if (queries.length >= max + 1) break;
    const trimmed = typeof variant === "string" ? variant.trim() : "";
    if (!trimmed) continue;
    const key = normalizeAlias(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queries.push(trimmed);
  }
  return queries;
}
