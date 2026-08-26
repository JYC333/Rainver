import { modelSpec } from "./modelSpecs.js";

/**
 * Recommended max output (completion) tokens for known models.
 *
 * `max_tokens` caps the completion, not the context window. Reasoning models
 * spend their thinking inside the same completion budget, so a small cap
 * silently starves outputs: the model burns the whole budget thinking and is
 * truncated before the answer starts (observed as MiniMax-M3 emitting stub
 * synthesis tool calls under an 8k cap, and refine failing schema validation
 * under 1800). The figures live in the shared model registry alongside each
 * model's context window — see {@link modelSpec} — because keeping them apart
 * is what let a model have output guidance and no window. A recommendation is
 * only a default: an explicit caller budget is part of the run/request contract
 * and must never be widened here.
 */
export function recommendedMaxOutputTokens(model: string | null | undefined): number | null {
  return modelSpec(model)?.recommendedMaxOutputTokens ?? null;
}

/**
 * Effective completion budget for a request. Explicit caller limits always
 * win; model guidance is used only when the caller leaves the budget unset.
 * A null result is deliberate: it means rainver supplies no stream-level
 * override, so the Pi adapter's resolved Model remains authoritative. For a
 * catalog match that is pi-ai's catalog `maxTokens`; for an uncatalogued model
 * it is the adapter fallback stored on that Model. Do not copy catalog limits
 * into modelSpecs merely to avoid this fallback — modelSpecs owns only limits
 * rainver has independently sourced and uses for Runtime Context planning.
 */
export function effectiveMaxOutputTokens(model: string | null | undefined, requested: number | null | undefined): number | null {
  if (requested !== null && requested !== undefined) return requested;
  return recommendedMaxOutputTokens(model);
}
