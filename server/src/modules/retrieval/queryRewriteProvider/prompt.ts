import { QUERY_REWRITE_MAX_VARIANTS, QUERY_REWRITE_MAX_VARIANT_CHARS } from "./config.js";

/**
 * Prompt construction + response parsing for the LLM query rewriter. The model
 * is asked to produce a few intent-preserving rephrasings of the query (synonyms,
 * expanded acronyms, related terms) as a JSON array of strings. Parsing is
 * defensive — any non-JSON or empty result yields `null`, and the caller then
 * searches the original query alone.
 */

/**
 * Parse the rewrite JSON. Tolerates surrounding prose/code fences by extracting
 * the outermost array. Keeps only non-empty trimmed strings, truncates overlong
 * ones, dedupes, and caps the count. Returns `null` when nothing usable parses.
 */
export function parseQueryRewriteVariants(text: string): string[] | null {
  const json = extractJsonArray(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, QUERY_REWRITE_MAX_VARIANT_CHARS).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(trimmed);
    if (variants.length >= QUERY_REWRITE_MAX_VARIANTS) break;
  }
  return variants.length ? variants : null;
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
