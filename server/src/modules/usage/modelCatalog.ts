import { ACP_RUNTIME_MANAGED_CATALOG_VERSION } from "@rainver/protocol";
import { modelSpec } from "../providers/modelSpecs.js";

export interface ModelWindowSpec {
  model: string | null;
  contextWindowTokens: number | null;
  defaultOutputReserveTokens: number;
  providerOverheadTokens: number;
  catalogVersion: string;
  tokenizerVersion: string;
}

export interface ModelWindowOverride {
  contextWindowTokens: number | null;
  defaultOutputReserveTokens: number;
  providerOverheadTokens: number;
  catalogVersion: string;
  tokenizerVersion?: string;
}

const CATALOG_VERSION = "model-catalog.2026-09-25";
const TOKENIZER_VERSION = "utf8-byte-upper-bound.v1";
/** ACP does not advertise a model's context limit; the runtime owns that check. */
export const ACP_RUNTIME_MANAGED_WINDOW: ModelWindowOverride = {
  contextWindowTokens: null,
  defaultOutputReserveTokens: 4_096,
  providerOverheadTokens: 0,
  catalogVersion: ACP_RUNTIME_MANAGED_CATALOG_VERSION,
};
// For Rainver-managed Provider calls whose model is not in the shared registry.
// Native ACP sessions use a null window instead; this deliberately conservative
// fallback must never become an invented CLI capacity. A Provider model with
// verified limits can still be registered in modelSpecs.
const GENERIC_MODEL_WINDOW = {
  contextWindowTokens: 16_384,
  defaultOutputReserveTokens: 4_096,
  providerOverheadTokens: 512,
} as const;

export function resolveModelWindow(model: string | null): ModelWindowSpec & { contextWindowTokens: number };
export function resolveModelWindow(model: string | null, override: ModelWindowOverride | null | undefined): ModelWindowSpec;
export function resolveModelWindow(model: string | null, override?: ModelWindowOverride | null): ModelWindowSpec {
  const normalized = model?.trim() || null;
  const matched = normalized ? modelSpec(normalized) ?? GENERIC_MODEL_WINDOW : GENERIC_MODEL_WINDOW;
  const resolved = override ?? {
    contextWindowTokens: matched.contextWindowTokens,
    defaultOutputReserveTokens: matched.defaultOutputReserveTokens,
    providerOverheadTokens: matched.providerOverheadTokens,
    catalogVersion: CATALOG_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
  };
  for (const [key, value] of Object.entries({
    defaultOutputReserveTokens: resolved.defaultOutputReserveTokens,
    providerOverheadTokens: resolved.providerOverheadTokens,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid model window field ${key}`);
    }
  }
  if (resolved.contextWindowTokens !== null
    && (!Number.isInteger(resolved.contextWindowTokens) || resolved.contextWindowTokens <= 0)) {
    throw new Error("Invalid model window field contextWindowTokens");
  }
  return {
    model: normalized,
    contextWindowTokens: resolved.contextWindowTokens,
    defaultOutputReserveTokens: resolved.defaultOutputReserveTokens,
    providerOverheadTokens: resolved.providerOverheadTokens,
    catalogVersion: resolved.catalogVersion,
    tokenizerVersion: resolved.tokenizerVersion ?? TOKENIZER_VERSION,
  };
}

/** Shared deterministic fallback used by Runtime Context and Usage estimates. */
export function estimateModelTokens(text: string): number {
  if (!text) return 0;
  return Buffer.byteLength(text, "utf8");
}

export function trimTextToModelTokens(text: string, maximumTokens: number): string {
  if (!Number.isInteger(maximumTokens) || maximumTokens < 0) {
    throw new Error("maximumTokens must be a non-negative integer");
  }
  let used = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maximumTokens) break;
    result += character;
    used += size;
  }
  return result;
}

/**
 * `text`, cut to `budget` tokens with `marker` appended when it was cut.
 *
 * Beside the estimator because it is the estimator's counterpart, and owned by
 * neither of the two modules that clip text to a budget — the Room's summary
 * and an imported session's — so that neither has to import the other for it.
 */
export function fitTextToTokenBudget(
  text: string,
  budget: number,
  marker: string,
  estimateTokens: (text: string) => number = estimateModelTokens,
): string {
  const normalized = text.trim();
  if (estimateTokens(normalized) <= budget) return normalized;
  const suffix = `\n${marker}`;
  const prefix = trimUtf8(normalized, Math.max(0, budget - estimateTokens(suffix)), estimateTokens);
  return `${prefix.trimEnd()}${suffix}`.trim();
}

function trimUtf8(text: string, maxTokens: number, estimateTokens: (text: string) => number): string {
  // Tokenizer implementations are intentionally injectable. The shared
  // fallback is conservative and character-boundary safe; provider-specific
  // implementations can replace it without changing cursor semantics.
  let result = "";
  for (const character of text) {
    const candidate = result + character;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result;
}
