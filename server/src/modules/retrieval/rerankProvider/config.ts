/**
 * Hybrid-retrieval (Phase 2, step 8) reranking configuration.
 *
 * The reranker is a space-setting-gated, skippable LLM stage. It routes through the same
 * provider task-policy + credential channel (ADR 0008) as the other auxiliary
 * model tasks, under a dedicated task name so a space can point it at a cheaper
 * / faster model than chat.
 */

/** Provider task policy used to route reranking (ADR 0008 channel). */
export const RETRIEVAL_RERANK_TASK = "retrieval_rerank";

/**
 * Per-candidate text budget sent to the reranker. Bounds the prompt size so a
 * large window of long documents cannot blow up the provider payload; the
 * reranker only needs a representative snippet to judge relevance.
 */
export const RERANK_SNIPPET_MAX_CHARS = 600;
