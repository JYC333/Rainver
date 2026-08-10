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

const CATALOG_VERSION = "model-catalog.2026-08-09";
const TOKENIZER_VERSION = "utf8-byte-upper-bound.v1";
const GENERIC_MODEL_WINDOW = {
  contextWindowTokens: 16_384,
  outputReserveTokens: 4_096,
  providerOverheadTokens: 512,
} as const;

const MODEL_WINDOWS = new Map<string, {
  contextWindowTokens: number;
  outputReserveTokens: number;
  providerOverheadTokens: number;
}>([
  ["gpt-4o", { contextWindowTokens: 128_000, outputReserveTokens: 16_384, providerOverheadTokens: 512 }],
  ["gpt-4o-mini", { contextWindowTokens: 128_000, outputReserveTokens: 16_384, providerOverheadTokens: 512 }],
  ["claude-3-5-sonnet-latest", { contextWindowTokens: 200_000, outputReserveTokens: 16_384, providerOverheadTokens: 512 }],
  ["claude-sonnet-4-6", { contextWindowTokens: 200_000, outputReserveTokens: 16_384, providerOverheadTokens: 512 }],
]);

export function resolveModelWindow(model: string, override?: ModelWindowOverride | null): ModelWindowSpec {
  const normalized = model.trim();
  if (!normalized) throw new Error("A model is required for context-window planning");
  const matched = MODEL_WINDOWS.get(normalized.toLowerCase());
  const resolved = override ?? {
    contextWindowTokens: (matched ?? GENERIC_MODEL_WINDOW).contextWindowTokens,
    defaultOutputReserveTokens: (matched ?? GENERIC_MODEL_WINDOW).outputReserveTokens,
    providerOverheadTokens: (matched ?? GENERIC_MODEL_WINDOW).providerOverheadTokens,
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
