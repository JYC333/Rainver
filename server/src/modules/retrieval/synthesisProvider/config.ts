/**
 * Context Brief synthesis (W6) configuration.
 *
 * Synthesis is a skippable LLM stage routed through the provider task-policy +
 * credential channel (ADR 0008) under its own task name, so a space can point it
 * at a capable chat model independent of the reranker/rewriter. When no
 * `retrieval_synthesis` policy is configured the provider call fails and the
 * brief degrades to the deterministic gap analysis (no LLM answer) — the task
 * policy is therefore the gate; no extra space-setting flag is required.
 */

/** Provider task policy used to route synthesis (ADR 0008 channel). */
export const RETRIEVAL_SYNTHESIS_TASK = "retrieval_synthesis";

/**
 * Per-source text budget sent to the synthesizer. Bounds the prompt so a large
 * window of long documents cannot blow up the payload; the model only needs a
 * representative excerpt of each source to ground its answer.
 */
export const SYNTHESIS_SNIPPET_MAX_CHARS = 1200;

/**
 * Total document-text budget across all sources in one synthesis prompt (§2.6).
 * Composes with the per-source cap so the payload is bounded in tokens, not just
 * by row count: once the running total is reached, later sources keep their title
 * (so their citation index stays valid) but contribute no body text.
 */
export const SYNTHESIS_TOTAL_TEXT_MAX_CHARS = 12000;
