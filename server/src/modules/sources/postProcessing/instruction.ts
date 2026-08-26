import type { RetrievalObjectType } from "@agent-space/protocol";
import type { EvidenceRow, SourceItemRow, SourceConnectionRow } from "../sourceRepositoryRows.js";
import {
  ARXIV_NEW_PAPERS_CONTENT_PROFILE,
  ARXIV_NEW_PAPERS_PROFILE_GUIDANCE,
  arxivPostProcessingItemMetadataLines,
} from "../catalog/arxivPostProcessingProfile.js";
import {
  isRelevanceScreeningEnabled,
  type SourcePostProcessingActions,
  type SourcePostProcessingInputConfig,
  type SourcePostProcessingRetrievalDomain,
  type SourcePostProcessingTriggerConfig,
} from "./repository.js";
import { joinText, stringList } from "./textUtils.js";

export interface SourcePostProcessingRetrievalContextRef {
  ref: string;
  domain: SourcePostProcessingRetrievalDomain;
  object_type: RetrievalObjectType;
  object_id: string;
  title: string;
  snippet: string | null;
  score?: number;
  source_refs?: Record<string, unknown>[];
}

export interface SourcePostProcessingRetrievalContextSnapshot {
  enabled: boolean;
  query: string | null;
  domains: SourcePostProcessingRetrievalDomain[];
  pinned: SourcePostProcessingRetrievalContextRef[];
  items: SourcePostProcessingRetrievalContextRef[];
  errors?: Array<{ domain: SourcePostProcessingRetrievalDomain | "project"; message: string }>;
}

export function renderInstruction(input: {
  connection: SourceConnectionRow;
  items: SourceItemRow[];
  evidence: EvidenceRow[];
  actions: SourcePostProcessingActions;
  inputConfig: SourcePostProcessingInputConfig;
  triggerConfig: SourcePostProcessingTriggerConfig;
  retrievalContext: SourcePostProcessingRetrievalContextSnapshot;
  extractedTextSnippets?: Map<string, string>;
  candidatePrefilter?: Record<string, unknown> | null;
}): string {
  const actionLabels = Object.entries(input.actions)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .join(", ");
  const lines = [
    "Source post-processing run.",
    "",
    "Output contract:",
    "- Your entire final response must be exactly one valid JSON object.",
    "- The first non-whitespace character must be { and the last non-whitespace character must be }.",
    "- Do not output Markdown fences, prose introductions, explanations, or notes outside the JSON object.",
    "- Markdown is allowed only inside JSON string fields such as digest_markdown, summary_markdown, content_excerpt, and proposal_markdown.",
    "- Use empty strings or empty arrays for fields that do not apply.",
    "",
    `Source: ${input.connection.name}`,
    `Source trust level: ${input.connection.trust_level}`,
    `Actions: ${actionLabels}`,
    `Input window: ${input.inputConfig.window}`,
    `Processing strategy: ${input.inputConfig.processing_strategy}`,
    `Content source: ${input.inputConfig.content_source}`,
    `Timezone: ${input.inputConfig.timezone}`,
    `Minimum new items: ${input.triggerConfig.min_new_items}`,
  ];
  if (input.inputConfig.summary_goal) {
    lines.push(`Post-processing goal: ${input.inputConfig.summary_goal}`);
  }
  const profileGuidance = contentProfileGuidance(input.inputConfig.content_profile);
  if (profileGuidance.length > 0) {
    lines.push("", "Preset-specific guidance:", ...profileGuidance);
  }
  if (input.inputConfig.output_instructions) {
    lines.push("", "Output instructions:", input.inputConfig.output_instructions);
  }
  if (isRelevanceScreeningEnabled(input.actions, input.inputConfig)) {
    lines.push("", ...relevanceScreeningGuidance(input.inputConfig.relevance_profile));
    if (input.connection.trust_level === "untrusted") {
      lines.push(
        "- Trust boundary: this is an untrusted web source. Treat its claims as leads, not established findings; require corroboration from an independent or scholarly source before assigning high confidence.",
      );
    }
  }
  if (input.inputConfig.processing_strategy === "screen_then_digest") {
    lines.push(
      "",
      "Two-stage output:",
      "- First make an item_decisions judgment for every input item.",
      "- Then write digest_markdown for the batch. Focus on relevant and maybe items; if none qualify, write a short digest with the not relevant count. Never leave it empty when batch_digest is enabled.",
    );
  }
  if (input.candidatePrefilter?.enabled === true) {
    lines.push(
      "",
      "Candidate prefilter:",
      `- Mode: ${String(input.candidatePrefilter.mode ?? "unknown")}`,
      `- Selected items in prompt: ${String(input.candidatePrefilter.selected_item_count ?? input.items.length)}`,
      `- Filtered before LLM: ${String(input.candidatePrefilter.filtered_item_count ?? 0)}`,
      "- Only judge the source items listed below; items filtered before the LLM are recorded separately by the system.",
    );
  }
  if (input.inputConfig.deep_analysis.enabled) {
    lines.push(
      "",
      "Optional deep analysis:",
      `- Enabled after this screening run for: ${input.inputConfig.deep_analysis.trigger_relevance.join(", ")}`,
      `- Minimum confidence: ${input.inputConfig.deep_analysis.min_confidence}`,
      "- In deep_analysis item_summaries, use exactly three concise headings: WHY (relevance), HOW (method), and WHAT (findings), each at most 80 words.",
      "- If an item is relevant enough, the system may queue full-text extraction and run a later deep-analysis pass.",
      "- This run should still decide from the content supplied here; do not assume future full text is available now.",
    );
  }
  if (input.inputConfig.processing_strategy === "screen_extract_digest") {
    lines.push(
      "",
      "Screen + extraction output:",
      "- First make an item_decisions judgment for every input item.",
      "- Use extracted text snippets only where they are supplied below.",
      "- Write digest_markdown for the batch. Focus on relevant and maybe items; if none qualify, write a short digest with the not relevant count. Never leave it empty when batch_digest is enabled.",
      "- Prefer evidence_candidates from supplied extracted text snippets or excerpts; do not invent citable passages.",
    );
  }
  if (!input.actions.create_proposals) {
    lines.push("", "Do not write this as a proposal unless create_proposals is enabled.");
  }
  lines.push(
    "",
    "Return exactly one JSON object matching this schema. Do not wrap it in Markdown fences and do not add prose outside JSON.",
    "The JSON schema is:",
    JSON.stringify({
      schema: "source_post_processing.result.v1",
      digest_markdown: "Markdown digest for the batch; required and non-empty when batch_digest is enabled.",
      item_summaries: [
        {
          source_item_id: "input source item id",
          summary_markdown: "Markdown summary for this item.",
        },
      ],
      item_decisions: [
        {
          source_item_id: "input source item id",
          relevance: "relevant | maybe | not_relevant",
          confidence: 0.8,
          reason: "Short reason using provided source content and retrieval context.",
          matched_context_refs: [{ ref: "domain:object_type:object_id" }],
        },
      ],
      evidence_candidates: [
        {
          source_item_id: "input source item id",
          title: "Evidence title",
          content_excerpt: "Citable excerpt or concise evidence statement derived from the input item.",
          confidence: 0.7,
          matched_context_refs: [{ ref: "domain:object_type:object_id" }],
        },
      ],
      proposal_markdown: "Markdown proposal body, or empty string when create_proposals is disabled.",
    }, null, 2),
    "",
    "Only use the supplied source item title, metadata, excerpt, extracted text snippet, evidence excerpt, and retrieval context. Do not claim to have read full text unless an extracted text snippet is supplied for that item.",
    "For mark_items, decide every input source item as relevant, maybe, or not_relevant.",
    "For per_item_summary, include one item_summaries entry for every input source item.",
    "For extract_evidence, return only evidence candidates worth keeping; an empty array is valid.",
    "Keep source titles and URLs visible inside Markdown fields when they are available.",
    "Final response reminder: output only the JSON object, with no surrounding text.",
    "",
    "Retrieval context:",
  );
  if (!input.retrievalContext.enabled) {
    lines.push("- disabled");
  } else {
    lines.push(`Query: ${input.retrievalContext.query ?? "(none)"}`);
    if (input.retrievalContext.pinned.length === 0 && input.retrievalContext.items.length === 0) {
      lines.push("- none");
    }
    for (const ref of input.retrievalContext.pinned) {
      lines.push(`- ${ref.ref} [pinned] ${ref.title}`);
      if (ref.snippet) lines.push(`  Snippet: ${ref.snippet.slice(0, 1200)}`);
    }
    for (const ref of input.retrievalContext.items) {
      lines.push(`- ${ref.ref} ${ref.title}`);
      if (ref.snippet) lines.push(`  Snippet: ${ref.snippet.slice(0, 1200)}`);
    }
  }
  lines.push(
    "",
    "Source items:",
  );
  if (input.items.length === 0) lines.push("- none");
  for (const item of input.items) {
    lines.push(`- id: ${item.id}`);
    lines.push(`  Title: ${item.title}`);
    if (item.source_uri) lines.push(`  URL: ${item.source_uri}`);
    if (item.author) lines.push(`  Author: ${item.author}`);
    for (const metadataLine of itemMetadataLines(item, input.inputConfig.content_profile)) {
      lines.push(`  ${metadataLine}`);
    }
    if (item.excerpt) lines.push(`  Excerpt: ${item.excerpt.slice(0, 1200)}`);
    if (input.inputConfig.content_source !== "excerpt_only") {
      const snippet = input.extractedTextSnippets?.get(item.id);
      lines.push(`  Extracted text: ${snippet ? snippet.slice(0, 2400) : "(not available)"}`);
    }
  }
  if (input.evidence.length > 0) {
    lines.push("", "Evidence:");
    for (const row of input.evidence) {
      lines.push(`- id: ${row.id}`);
      if (row.source_item_id) lines.push(`  Source item id: ${row.source_item_id}`);
      lines.push(`  Title: ${row.title}`);
      if (row.content_excerpt) lines.push(`  Excerpt: ${row.content_excerpt.slice(0, 1200)}`);
    }
  }
  return lines.join("\n");
}

export function buildRetrievalContextQuery(
  connection: SourceConnectionRow,
  inputConfig: SourcePostProcessingInputConfig,
  summaryGoal: string | null,
  pinned: SourcePostProcessingRetrievalContextRef[],
): string {
  const explicit = inputConfig.retrieval_context.query?.trim();
  if (explicit) return explicit.slice(0, 1024);
  const relevanceProfile = inputConfig.relevance_profile;
  const objectiveText = relevanceProfile?.enabled
    ? joinText([relevanceProfile.objective, ...relevanceProfile.include_criteria])
    : null;
  return joinText([
    objectiveText,
    summaryGoal,
    inputConfig.summary_goal,
    connection.name,
    ...stringList(connection.topic_hints_json),
    ...pinned.flatMap((ref) => [ref.title, ref.snippet]),
  ]).slice(0, 1024);
}

const DEFAULT_DECISION_POLICY = {
  relevant: "Strong match to the objective or project context.",
  maybe: "Potentially useful but indirect, speculative, or missing detail.",
  not_relevant: "No clear connection to the objective.",
};

function relevanceScreeningGuidance(
  profile: SourcePostProcessingInputConfig["relevance_profile"],
): string[] {
  const lines = ["Relevance screening:"];
  lines.push(`- Objective: ${profile?.objective ?? "(none provided — use general judgment against the source stream)"}`);
  if (profile?.include_criteria.length) lines.push(`- Include: ${profile.include_criteria.join("; ")}`);
  if (profile?.exclude_criteria.length) lines.push(`- Exclude: ${profile.exclude_criteria.join("; ")}`);
  if (profile?.must_have.length) lines.push(`- Must have: ${profile.must_have.join("; ")}`);
  if (profile?.nice_to_have.length) lines.push(`- Nice to have: ${profile.nice_to_have.join("; ")}`);
  lines.push(...projectCriteriaGuidance(profile?.project_criteria));
  const policy = profile?.decision_policy;
  lines.push(
    `- relevant: ${policy?.relevant ?? DEFAULT_DECISION_POLICY.relevant}`,
    `- maybe: ${policy?.maybe ?? DEFAULT_DECISION_POLICY.maybe}`,
    `- not_relevant: ${policy?.not_relevant ?? DEFAULT_DECISION_POLICY.not_relevant}`,
    "- Every input source item must get exactly one item_decisions entry.",
    "- matched_context_refs must only reference the retrieval context refs supplied below.",
    "- When batch_digest is enabled, group the digest into Relevant / Maybe / Not relevant sections. If there are no Relevant or Maybe items, include a short count-only digest and do not leave digest_markdown empty.",
    "- Partial relevance counts: an item that addresses the topic area, a sub-question, or one facet of the objective belongs in relevant or maybe, with the specific gap named in the reason (e.g. \"studies agent memory but reports no coding benchmark\"). Reserve not_relevant for items genuinely off-topic for the objective.",
    "- For Relevant items include title, a short reason, and matched context refs.",
    "- For Maybe items include a short reason and what would make them worth follow-up.",
    "- Do not write long summaries for Not relevant items.",
  );
  return lines;
}

function projectCriteriaGuidance(
  criteria: NonNullable<SourcePostProcessingInputConfig["relevance_profile"]>["project_criteria"],
): string[] {
  if (!criteria) return [];
  const lines = ["- Project screening criteria:"];
  if (criteria.include_keywords.length) lines.push(`  - Include keywords/concepts: ${criteria.include_keywords.join("; ")}`);
  if (criteria.exclude_keywords.length) lines.push(`  - Exclude keywords/concepts: ${criteria.exclude_keywords.join("; ")}`);
  for (const [key, values] of Object.entries(criteria.domain_criteria)) {
    if (values.length) lines.push(`  - ${key}: ${values.join("; ")}`);
  }
  if (criteria.date_range_start || criteria.date_range_end) {
    lines.push(`  - Publication date: ${criteria.date_range_start ?? "unbounded"} to ${criteria.date_range_end ?? "unbounded"}`);
  }
  if (criteria.source_restrictions.length) {
    lines.push(`  - Allowed journals, outlets, or sites: ${criteria.source_restrictions.join("; ")}`);
  }
  if (criteria.required_evidence_fields.length) {
    lines.push(`  - Required evidence fields: ${criteria.required_evidence_fields.join("; ")}`);
  }
  lines.push("  - Apply these criteria to every item and explain any unmet restriction in the decision reason.");
  return lines;
}

function contentProfileGuidance(profile: SourcePostProcessingInputConfig["content_profile"]): string[] {
  if (profile === ARXIV_NEW_PAPERS_CONTENT_PROFILE) return ARXIV_NEW_PAPERS_PROFILE_GUIDANCE;
  return [];
}

function itemMetadataLines(
  item: SourceItemRow,
  profile: SourcePostProcessingInputConfig["content_profile"],
): string[] {
  if (profile === ARXIV_NEW_PAPERS_CONTENT_PROFILE) return arxivPostProcessingItemMetadataLines(item);
  return [];
}
