import type { StructuredOutputContract } from "../projectResearch/outputSchemas.js";
import { domainKeys, isKnownDomain } from "./domainSkeleton.js";
import {
  ANNOTATION_DEPTHS,
  ANNOTATION_GENRES,
  MAX_TOPIC_CANDIDATES,
  MAX_TOPIC_CANDIDATE_LENGTH,
  isAnnotationDepth,
  isAnnotationGenre,
  type AnnotationDepth,
  type AnnotationGenre,
} from "./vocabulary.js";

export const SOURCE_ANNOTATION_SCHEMA_ID = "source_annotation.result.v2";

export type AnnotationStancePolarity = "supports" | "opposes" | "mixed" | "neutral";

export interface ParsedItemAnnotation {
  source_item_id: string;
  domain_key: string;
  depth: AnnotationDepth;
  genre: AnnotationGenre;
  summary: string;
  topic_candidates: string[];
  stance_target: string | null;
  stance_target_key: string | null;
  stance_polarity: AnnotationStancePolarity;
  stance_confidence: number;
}

/**
 * The contract is built from the registries rather than repeating their members
 * as literals: a domain added to the skeleton that the prompt schema still
 * rejects would fail every annotation naming it, and the failure would look
 * like a model problem.
 */
export function sourceAnnotationOutputContract(): StructuredOutputContract {
  return {
    type: "json_schema",
    schema_id: SOURCE_ANNOTATION_SCHEMA_ID,
    strict: true,
    stage: "source_annotation",
    schema: {
      type: "object",
      properties: {
        schema: { enum: [SOURCE_ANNOTATION_SCHEMA_ID] },
        annotations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source_item_id: { type: "string" },
              domain_key: { enum: [...domainKeys()].sort() },
              depth: { enum: [...ANNOTATION_DEPTHS] },
              genre: { enum: [...ANNOTATION_GENRES] },
              summary: { type: "string" },
              topic_candidates: { type: "array", items: { type: "string" } },
              stance_target: { type: ["string", "null"] },
              stance_polarity: { enum: ["supports", "opposes", "mixed", "neutral"] },
              stance_confidence: { type: "integer", minimum: 0, maximum: 100 },
            },
            required: ["source_item_id", "domain_key", "depth", "genre", "summary", "topic_candidates", "stance_target", "stance_polarity", "stance_confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["schema", "annotations"],
      additionalProperties: false,
    },
  };
}

export class SourceAnnotationParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceAnnotationParseError";
  }
}

/**
 * Parses a structured annotation result, keeping only annotations for items
 * that were actually sent.
 *
 * An unknown `source_item_id` is dropped rather than failing the batch: the
 * pass is best-effort per item and one hallucinated id must not cost the other
 * nine their annotation. An unknown domain/depth/genre *is* dropped for that
 * item too — writing it would put a value in the coverage distribution that no
 * gap computation can interpret, and a missing annotation is recoverable while
 * a wrong one is not.
 */
export function parseSourceAnnotationResult(
  output: string,
  requestedItemIds: readonly string[],
): { annotations: ParsedItemAnnotation[]; rejected: { source_item_id: string; reason: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new SourceAnnotationParseError("invalid_json", "annotation output is not valid JSON");
  }
  const root = recordValue(parsed);
  if (root.schema !== undefined && root.schema !== SOURCE_ANNOTATION_SCHEMA_ID) {
    throw new SourceAnnotationParseError(
      "unexpected_schema",
      `annotation output declares schema ${JSON.stringify(root.schema)}`,
    );
  }
  if (!Array.isArray(root.annotations)) {
    throw new SourceAnnotationParseError("missing_annotations", "annotation output has no annotations array");
  }
  const requested = new Set(requestedItemIds);
  const seen = new Set<string>();
  const annotations: ParsedItemAnnotation[] = [];
  const rejected: { source_item_id: string; reason: string }[] = [];
  for (const raw of root.annotations) {
    const entry = recordValue(raw);
    const itemId = typeof entry.source_item_id === "string" ? entry.source_item_id.trim() : "";
    if (!itemId || !requested.has(itemId)) {
      rejected.push({ source_item_id: itemId || "(missing)", reason: "unrequested_item" });
      continue;
    }
    if (seen.has(itemId)) {
      rejected.push({ source_item_id: itemId, reason: "duplicate_item" });
      continue;
    }
    seen.add(itemId);
    if (!isKnownDomain(entry.domain_key)) {
      rejected.push({ source_item_id: itemId, reason: "unknown_domain" });
      continue;
    }
    if (!isAnnotationDepth(entry.depth)) {
      rejected.push({ source_item_id: itemId, reason: "unknown_depth" });
      continue;
    }
    if (!isAnnotationGenre(entry.genre)) {
      rejected.push({ source_item_id: itemId, reason: "unknown_genre" });
      continue;
    }
    const stance = normalizeStance(entry);
    if (!stance) {
      rejected.push({ source_item_id: itemId, reason: "invalid_stance" });
      continue;
    }
    annotations.push({
      source_item_id: itemId,
      domain_key: entry.domain_key,
      depth: entry.depth,
      genre: entry.genre,
      summary: typeof entry.summary === "string" ? entry.summary.trim().slice(0, 2000) : "",
      topic_candidates: normalizeTopicCandidates(entry.topic_candidates),
      ...stance,
    });
  }
  return { annotations, rejected };
}

function normalizeStance(entry: Record<string, unknown>): Pick<ParsedItemAnnotation, "stance_target" | "stance_target_key" | "stance_polarity" | "stance_confidence"> | null {
  const polarity = entry.stance_polarity;
  if (!(["supports", "opposes", "mixed", "neutral"] as unknown[]).includes(polarity)) return null;
  const confidence = Number(entry.stance_confidence);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) return null;
  const target = typeof entry.stance_target === "string" ? entry.stance_target.trim().replace(/\s+/g, " ").slice(0, 256) : "";
  if (polarity === "supports" || polarity === "opposes") {
    if (!target) return null;
    const targetKey = stanceTargetKey(target);
    if (!targetKey) return null;
    return { stance_target: target, stance_target_key: targetKey, stance_polarity: polarity, stance_confidence: confidence };
  }
  return { stance_target: null, stance_target_key: null, stance_polarity: polarity as "mixed" | "neutral", stance_confidence: confidence };
}

export function stanceTargetKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 256);
}

export function normalizeTopicCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const phrase = entry.trim().replace(/\s+/g, " ").slice(0, MAX_TOPIC_CANDIDATE_LENGTH);
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= MAX_TOPIC_CANDIDATES) break;
  }
  return out;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
