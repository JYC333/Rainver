import { HttpError } from "../../routeUtils/common.js";
import {
  isRelevanceScreeningEnabled,
  type SourcePostProcessingActions,
  type SourcePostProcessingInputConfig,
  type SourcePostProcessingItemDecision,
} from "./repository.js";

export interface ParsedItemSummary {
  source_item_id: string;
  summary_markdown: string;
}

export interface ParsedEvidenceCandidate {
  source_item_id: string;
  title: string;
  content_excerpt: string;
  confidence: number | null;
  matched_context_refs: Record<string, unknown>[];
}

export interface ParsedPostProcessingResult {
  digest_markdown: string;
  item_summaries: ParsedItemSummary[];
  item_decisions: SourcePostProcessingItemDecision[];
  evidence_candidates: ParsedEvidenceCandidate[];
  proposal_markdown: string | null;
}

export function parsePostProcessingResult(
  output: string,
  actions: SourcePostProcessingActions,
  inputConfig: SourcePostProcessingInputConfig,
  sourceItemIds: string[],
  allowedContextRefs?: string[],
): ParsedPostProcessingResult {
  const value = parseModelJsonObject(output);
  const record = normalizeResultEnvelope(value);
  if (record.schema !== "source_post_processing.result.v1") {
    throw new HttpError(422, "Post-processing agent output schema must be source_post_processing.result.v1");
  }
  const allowedItemIds = new Set(sourceItemIds);
  let digestMarkdown = optionalText(record.digest_markdown, "digest_markdown", 200_000) ?? "";
  const itemSummaries = arrayValue(record.item_summaries, "item_summaries").map((entry, index) =>
    parseItemSummary(entry, index, allowedItemIds),
  );
  const itemDecisions = arrayValue(record.item_decisions, "item_decisions").map((entry, index) =>
    parseItemDecision(entry, index, allowedItemIds, allowedContextRefs),
  );
  const evidenceCandidates = arrayValue(record.evidence_candidates, "evidence_candidates").map((entry, index) =>
    parseEvidenceCandidate(entry, index, allowedItemIds, allowedContextRefs),
  );
  const proposalMarkdown = optionalText(record.proposal_markdown, "proposal_markdown", 200_000) ?? "";

  requireUniqueItemIds(itemSummaries.map((item) => item.source_item_id), "item_summaries");
  requireUniqueItemIds(itemDecisions.map((item) => item.source_item_id), "item_decisions");
  if (actions.batch_digest && !digestMarkdown.trim()) {
    const fallbackDigest = deterministicBatchDigest(itemDecisions, sourceItemIds);
    if (fallbackDigest) {
      digestMarkdown = fallbackDigest;
    } else {
      throw new HttpError(422, "digest_markdown is required when batch_digest is enabled");
    }
  }
  if (actions.per_item_summary && sourceItemIds.length > 0 && itemSummaries.length !== sourceItemIds.length) {
    throw new HttpError(422, "item_summaries must include every input item when per_item_summary is enabled");
  }
  if (
    isRelevanceScreeningEnabled(actions, inputConfig) &&
    sourceItemIds.length > 0 &&
    itemDecisions.length !== sourceItemIds.length
  ) {
    throw new HttpError(
      422,
      "item_decisions must include every input item when mark_items or relevance_profile screening is enabled",
    );
  }
  if (actions.create_proposals && !proposalMarkdown.trim() && !digestMarkdown.trim()) {
    throw new HttpError(422, "proposal_markdown or digest_markdown is required when create_proposals is enabled");
  }
  return {
    digest_markdown: digestMarkdown,
    item_summaries: itemSummaries,
    item_decisions: itemDecisions,
    evidence_candidates: evidenceCandidates,
    proposal_markdown: proposalMarkdown.trim() ? proposalMarkdown : null,
  };
}

/**
 * A screening batch can legitimately contain no relevant papers. In that
 * case an empty model narrative should not make the whole intake fail. Once
 * every item has a validated decision, a count-only digest is a complete and
 * honest batch digest and keeps the formal output contract useful downstream.
 */
function deterministicBatchDigest(
  decisions: SourcePostProcessingItemDecision[],
  sourceItemIds: string[],
): string | null {
  if (sourceItemIds.length === 0 || decisions.length !== sourceItemIds.length) return null;
  const counts = { relevant: 0, maybe: 0, not_relevant: 0 };
  for (const decision of decisions) counts[decision.relevance] += 1;
  return [
    "### Batch screening summary",
    `- Input items: ${sourceItemIds.length}`,
    `- Relevant: ${counts.relevant}`,
    `- Maybe: ${counts.maybe}`,
    `- Not relevant: ${counts.not_relevant}`,
    "- No narrative digest was returned; this summary was generated from the validated item decisions.",
  ].join("\n");
}

const POST_PROCESSING_RESULT_SCHEMA = "source_post_processing.result.v1";
const RESULT_PAYLOAD_FIELDS = [
  "digest_markdown",
  "item_summaries",
  "item_decisions",
  "evidence_candidates",
  "proposal_markdown",
] as const;

/**
 * Runtime adapters expose model output differently. Keep the durable source
 * contract strict while normalizing the small set of unambiguous envelopes
 * produced by model/CLI runtimes. Semantic validation still happens in the
 * caller below, including completeness, item ownership, and evidence refs.
 */
function normalizeResultEnvelope(value: unknown): Record<string, unknown> {
  const record = recordObject(value, "post_processing_result");
  const candidates = [
    record,
    ...["result", "output", "structured_output", "data"]
      .map((key) => record[key])
      .filter((candidate): candidate is Record<string, unknown> => isRecord(candidate)),
  ];

  for (const candidate of candidates) {
    if (candidate.schema === POST_PROCESSING_RESULT_SCHEMA) return candidate;
  }

  const inferred = candidates.find((candidate) =>
    candidate.schema === undefined && RESULT_PAYLOAD_FIELDS.some((field) => Object.hasOwn(candidate, field)),
  );
  if (inferred) {
    return {
      ...inferred,
      schema: POST_PROCESSING_RESULT_SCHEMA,
    };
  }

  return record;
}

function parseModelJsonObject(output: string): unknown {
  const candidates = jsonCandidates(output);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate. The final error is intentionally generic to
      // avoid storing model output text in the exception message.
    }
  }
  throw new HttpError(422, "Post-processing agent output must be valid JSON");
}

function jsonCandidates(output: string): string[] {
  const text = output.trim();
  if (!text) return [];
  const candidates: string[] = [text];
  const fenced = text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g);
  for (const match of fenced) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
  }
  candidates.push(...jsonObjectCandidates(text));
  return [...new Set(candidates)];
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let searchFrom = 0;
  while (candidates.length < 8) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) break;
    const end = matchingObjectEnd(text, start);
    if (end === null) {
      searchFrom = start + 1;
      continue;
    }
    candidates.push(text.slice(start, end + 1).trim());
    searchFrom = end + 1;
  }
  return candidates;
}

function matchingObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return null;
    }
  }
  return null;
}

export function resultSummary(result: ParsedPostProcessingResult): string {
  return result.digest_markdown || result.proposal_markdown || result.item_summaries[0]?.summary_markdown || "";
}

function parseItemSummary(
  value: unknown,
  index: number,
  allowedItemIds: Set<string>,
): ParsedItemSummary {
  const record = recordObject(value, `item_summaries[${index}]`);
  const itemId = requiredKnownItemId(record.source_item_id, `item_summaries[${index}].source_item_id`, allowedItemIds);
  return {
    source_item_id: itemId,
    summary_markdown: requiredText(record.summary_markdown, `item_summaries[${index}].summary_markdown`, 100_000),
  };
}

function parseItemDecision(
  value: unknown,
  index: number,
  allowedItemIds: Set<string>,
  allowedContextRefs: string[] | undefined,
): SourcePostProcessingItemDecision {
  const record = recordObject(value, `item_decisions[${index}]`);
  const itemId = requiredKnownItemId(record.source_item_id, `item_decisions[${index}].source_item_id`, allowedItemIds);
  const relevance = requiredText(record.relevance, `item_decisions[${index}].relevance`, 32);
  if (relevance !== "relevant" && relevance !== "maybe" && relevance !== "not_relevant") {
    throw new HttpError(422, `item_decisions[${index}].relevance must be relevant, maybe, or not_relevant`);
  }
  return {
    source_item_id: itemId,
    relevance,
    confidence: optionalConfidence(record.confidence, `item_decisions[${index}].confidence`),
    reason: optionalText(record.reason, `item_decisions[${index}].reason`, 2000) ?? null,
    matched_context_refs: contextRefRecords(
      record.matched_context_refs,
      `item_decisions[${index}].matched_context_refs`,
      allowedContextRefs,
    ),
  };
}

function parseEvidenceCandidate(
  value: unknown,
  index: number,
  allowedItemIds: Set<string>,
  allowedContextRefs: string[] | undefined,
): ParsedEvidenceCandidate {
  const record = recordObject(value, `evidence_candidates[${index}]`);
  const itemId = requiredKnownItemId(record.source_item_id, `evidence_candidates[${index}].source_item_id`, allowedItemIds);
  return {
    source_item_id: itemId,
    title: requiredText(record.title, `evidence_candidates[${index}].title`, 240),
    content_excerpt: requiredText(record.content_excerpt, `evidence_candidates[${index}].content_excerpt`, 4000),
    confidence: optionalConfidence(record.confidence, `evidence_candidates[${index}].confidence`),
    matched_context_refs: contextRefRecords(
      record.matched_context_refs,
      `evidence_candidates[${index}].matched_context_refs`,
      allowedContextRefs,
    ),
  };
}

function recordObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(422, `${field} must be an array`);
  return value;
}

function requiredKnownItemId(value: unknown, field: string, allowedItemIds: Set<string>): string {
  const itemId = requiredText(value, field, 64);
  if (!allowedItemIds.has(itemId)) throw new HttpError(422, `${field} must reference an input source item`);
  return itemId;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, field, maxLength);
  if (!text) throw new HttpError(422, `${field} is required`);
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(422, `${field} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maxLength) throw new HttpError(422, `${field} must be at most ${maxLength} characters`);
  return text;
}

function optionalConfidence(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(422, `${field} must be a number between 0 and 1`);
  }
  return value;
}

function contextRefRecords(
  value: unknown,
  field: string,
  allowedContextRefs: string[] | undefined,
): Record<string, unknown>[] {
  const allowed = allowedContextRefs ? new Set(allowedContextRefs) : null;
  return arrayValue(value, field).map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      const ref = entry.trim();
      validateContextRef(ref, `${field}[${index}]`, allowed);
      return { ref };
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const ref = optionalText(record.ref, `${field}[${index}].ref`, 256);
      if (allowed) {
        if (!ref) throw new HttpError(422, `${field}[${index}].ref is required when retrieval context refs are supplied`);
        validateContextRef(ref, `${field}[${index}].ref`, allowed);
      }
      return record;
    }
    throw new HttpError(422, `${field}[${index}] must be a context ref string or object`);
  });
}

function validateContextRef(ref: string, field: string, allowed: Set<string> | null): void {
  if (allowed && !allowed.has(ref)) throw new HttpError(422, `${field} must reference a supplied retrieval context ref`);
}

function requireUniqueItemIds(itemIds: string[], field: string): void {
  const seen = new Set<string>();
  for (const itemId of itemIds) {
    if (seen.has(itemId)) throw new HttpError(422, `${field} contains duplicate source_item_id ${itemId}`);
    seen.add(itemId);
  }
}
