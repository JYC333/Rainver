import type { SynthesisResult } from "../index.js";
import { SYNTHESIS_SNIPPET_MAX_CHARS, SYNTHESIS_TOTAL_TEXT_MAX_CHARS } from "./config.js";

/**
 * Prompt construction + response parsing for the Context Brief synthesizer. The
 * model is given the query and a numbered list of source documents (each labelled
 * with its ORIGINAL candidate index) and must answer ONLY from those sources,
 * citing them as [index], plus report what the sources do not cover. Parsing is
 * defensive: any non-JSON / missing answer yields `null`, and the caller then
 * returns a deterministic-only brief.
 */

export interface SynthesisPrompt {
  system: string;
  user: string;
}

/** A source paired with its ORIGINAL index in the brief candidate list. */
export interface SynthesisDoc {
  index: number;
  title: string;
  text: string | null;
}

export function buildSynthesisPrompt(
  query: string,
  docs: readonly SynthesisDoc[],
  systemPrompt: string,
): SynthesisPrompt {
  // §2.6 token budget: per-source cap PLUS a running total cap so a wide window of
  // long sources cannot blow the payload. Once the total is spent, later sources
  // keep only their title (citation index stays valid).
  let totalUsed = 0;
  const documents = docs
    .map((doc) => {
      const remaining = Math.max(0, SYNTHESIS_TOTAL_TEXT_MAX_CHARS - totalUsed);
      const cap = Math.min(SYNTHESIS_SNIPPET_MAX_CHARS, remaining);
      const snippet = cap <= 0
        ? ""
        : (doc.text ?? "").replace(/\s+/g, " ").trim().slice(0, cap);
      totalUsed += snippet.length;
      const title = doc.title.replace(/\s+/g, " ").trim();
      const body = snippet ? `${title}\n${snippet}` : title;
      return `[${doc.index}] <<<DOCUMENT\n${body}\nDOCUMENT`;
    })
    .join("\n\n");
  const user = `Query: ${query.trim()}\n\nSources (each delimited by <<<DOCUMENT … DOCUMENT):\n${documents}\n\nReturn the JSON object now.`;
  return { system: systemPrompt, user };
}

/**
 * Parse the synthesis JSON. Tolerates surrounding prose/code fences by extracting
 * the outermost object. Requires a non-empty `answer`; everything else defaults to
 * empty. Citation indices are kept as integers (range-validated later by the
 * engine against the candidate list). Returns `null` when nothing usable parses.
 */
export function parseSynthesis(text: string): SynthesisResult | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const answer = typeof record.answer === "string" ? record.answer.trim() : "";
  if (!answer) return null;
  return {
    answer,
    citations: intArray(record.citations),
    uncitedClaims: stringArray(record.uncited_claims),
    contradictions: stringArray(record.contradictions),
    missingTopics: stringArray(record.missing_topics),
  };
}

function intArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const n = Number(entry);
    if (Number.isInteger(n)) out.push(n);
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
