import type { RerankCandidate } from "../index.js";
import { RERANK_SNIPPET_MAX_CHARS } from "./config.js";

/**
 * Prompt construction + response parsing for the LLM reranker. The model is used
 * as a relevance judge: given the query and a numbered list of candidate
 * documents, it returns a JSON array scoring how well each document answers the
 * query. Parsing is defensive — any non-JSON or empty result yields `null`, and
 * the caller then keeps the deterministic fused order.
 */

export interface RerankPrompt {
  system: string;
  user: string;
}

export interface ParsedRerankScore {
  index: number;
  score: number;
}

export function buildRerankPrompt(
  query: string,
  candidates: readonly RerankCandidate[],
  systemPrompt: string,
): RerankPrompt {
  // Each document's untrusted title/text is wrapped in explicit delimiters so an
  // injected instruction reads as document content, not as part of the prompt.
  const documents = candidates
    .map((candidate, index) => {
      const snippet = (candidate.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, RERANK_SNIPPET_MAX_CHARS);
      const title = candidate.title.replace(/\s+/g, " ").trim();
      const body = snippet ? `${title}\n${snippet}` : title;
      return `[${index}] <<<DOCUMENT\n${body}\nDOCUMENT`;
    })
    .join("\n\n");
  const user = `Query: ${query.trim()}\n\nDocuments (each delimited by <<<DOCUMENT … DOCUMENT):\n${documents}\n\nReturn the JSON array now.`;
  return { system: systemPrompt, user };
}

/**
 * Parse the reranker JSON. Tolerates surrounding prose/code fences by extracting
 * the outermost array. Drops entries with an out-of-range or non-integer index
 * and clamps scores to [0,1]. Returns `null` when nothing usable parses.
 */
export function parseRerankScores(text: string, candidateCount: number): ParsedRerankScore[] | null {
  const json = extractJsonArray(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const seen = new Set<number>();
  const scores: ParsedRerankScore[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const index = Number(record.index);
    const score = Number(record.score);
    if (!Number.isInteger(index) || index < 0 || index >= candidateCount) continue;
    if (!Number.isFinite(score) || seen.has(index)) continue;
    seen.add(index);
    scores.push({ index, score: Math.max(0, Math.min(1, score)) });
  }
  return scores.length ? scores : null;
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
