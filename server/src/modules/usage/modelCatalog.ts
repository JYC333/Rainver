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
const TOKENIZER_VERSION = "char-class-estimate.v1";
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

/**
 * Shared deterministic estimate used by Runtime Context, Room replay and Usage.
 *
 * A character-class estimate, not a tokenizer. Runs of ASCII letters (words,
 * identifiers) and whitespace cost a quarter token a character, since BPE
 * vocabularies merge them into ~4-character pieces; a run of ASCII letters and
 * digits that contains a digit — a number, a hash, a UUID segment, base64 —
 * costs three quarters a character, since such runs split into short pieces;
 * other ASCII punctuation half a token; CJK and any other character one token.
 * Measured against the o200k and cl100k tokenizers it stays at or above the
 * real count on English, code, Markdown, numbers, hashes, UUIDs, JSON with ids
 * and base64 (CJK on cl100k within 5 % under), and needs no dependency. It is
 * an upper bound only approximately: planners keep a margin
 * (`runtimeContext/windowPlanner.ts`).
 */
export function estimateModelTokens(text: string): number {
  if (!text) return 0;
  let quarters = 0;
  let run = 0;
  let runHasDigit = false;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isAsciiAlphanumeric(code)) {
      run += 1;
      runHasDigit ||= isAsciiDigit(code);
      continue;
    }
    quarters += runQuarters(run, runHasDigit) + otherQuarters(code);
    run = 0;
    runHasDigit = false;
  }
  return Math.ceil((quarters + runQuarters(run, runHasDigit)) / 4);
}

/**
 * The longest prefix of `text` whose estimate is at most `maximumTokens`. It
 * follows the prefix's own estimate — a run is charged as it stands in the
 * prefix, re-charged when a digit joins it — so the estimate grows with the
 * prefix and cutting again to a cut's own estimate returns the same cut.
 */
export function trimTextToModelTokens(text: string, maximumTokens: number): string {
  if (!Number.isInteger(maximumTokens) || maximumTokens < 0) {
    throw new Error("maximumTokens must be a non-negative integer");
  }
  const limit = maximumTokens * 4;
  let settled = 0;
  let run = 0;
  let runHasDigit = false;
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isAsciiAlphanumeric(code)) {
      const digit: boolean = runHasDigit || isAsciiDigit(code);
      if (settled + runQuarters(run + 1, digit) > limit) break;
      run += 1;
      runHasDigit = digit;
    } else {
      const next = settled + runQuarters(run, runHasDigit) + otherQuarters(code);
      if (next > limit) break;
      settled = next;
      run = 0;
      runHasDigit = false;
    }
    length += character.length;
  }
  return text.slice(0, length);
}

/** A run of ASCII letters and digits: a quarter token a character, three quarters once it holds a digit. */
function runQuarters(length: number, hasDigit: boolean): number {
  return length * (hasDigit ? 3 : 1);
}

/** Any other code point: whitespace a quarter, ASCII punctuation half, anything else one token. */
function otherQuarters(code: number): number {
  return code >= 0x80 ? 4 : code <= 0x20 ? 1 : 2;
}

function isAsciiAlphanumeric(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
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
  // Tokenizer implementations are intentionally injectable, so the cut is a
  // search over code-point prefixes that only assumes the estimate grows with
  // the prefix. Binary rather than linear: a per-character re-estimate of a
  // growing prefix is quadratic, and Room budgets derived from a 200k window
  // clip tens of thousands of characters.
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(characters.slice(0, middle).join("")) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}
