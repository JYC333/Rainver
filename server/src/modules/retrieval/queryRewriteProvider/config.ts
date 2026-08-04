/**
 * Hybrid-retrieval (Phase 2, step 8) query-rewrite configuration.
 *
 * Query rewriting is a space-setting-gated, skippable LLM stage that operates on the query
 * string only. It routes through the provider task-policy + credential channel
 * (ADR 0008) under a dedicated task name so a space can point it at a cheap /
 * fast model.
 */

/** Provider task policy used to route query rewriting (ADR 0008 channel). */
export const RETRIEVAL_QUERY_REWRITE_TASK = "retrieval_query_rewrite";

/** Max variants requested from / accepted out of the model (bounds fan-out). */
export const QUERY_REWRITE_MAX_VARIANTS = 3;

/** Drop any single variant longer than this (a runaway model response guard). */
export const QUERY_REWRITE_MAX_VARIANT_CHARS = 200;
