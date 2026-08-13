import { modelSpec } from "../providers/modelSpecs";

export interface ModelWindowSpec {
  model: string;
  contextWindowTokens: number;
  defaultOutputReserveTokens: number;
  providerOverheadTokens: number;
  catalogVersion: string;
  tokenizerVersion: string;
}

export interface ModelWindowOverride {
  contextWindowTokens: number;
  defaultOutputReserveTokens: number;
  providerOverheadTokens: number;
  catalogVersion: string;
  tokenizerVersion?: string;
}

const CATALOG_VERSION = "model-catalog.2026-08-11";
const TOKENIZER_VERSION = "utf8-byte-upper-bound.v1";
// Used when a model is not in the shared registry. Deliberately conservative:
// planning a large window for an unknown model would push the overflow to the
// provider instead of the planner. Add the model to `modelSpecs` rather than
// raising this.
const GENERIC_MODEL_WINDOW = {
  contextWindowTokens: 16_384,
  defaultOutputReserveTokens: 4_096,
  providerOverheadTokens: 512,
} as const;

export function resolveModelWindow(model: string, override?: ModelWindowOverride | null): ModelWindowSpec {
  const normalized = model.trim();
  if (!normalized) throw new Error("A model is required for context-window planning");
  const matched = modelSpec(normalized) ?? GENERIC_MODEL_WINDOW;
  const resolved = override ?? {
    contextWindowTokens: matched.contextWindowTokens,
    defaultOutputReserveTokens: matched.defaultOutputReserveTokens,
    providerOverheadTokens: matched.providerOverheadTokens,
    catalogVersion: CATALOG_VERSION,
    tokenizerVersion: TOKENIZER_VERSION,
  };
  for (const [key, value] of Object.entries({
    contextWindowTokens: resolved.contextWindowTokens,
    defaultOutputReserveTokens: resolved.defaultOutputReserveTokens,
    providerOverheadTokens: resolved.providerOverheadTokens,
  })) {
    if (!Number.isInteger(value) || value < 0 || (key === "contextWindowTokens" && value === 0)) {
      throw new Error(`Invalid model window field ${key}`);
    }
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
