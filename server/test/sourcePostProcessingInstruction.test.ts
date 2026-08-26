import { describe, expect, it } from "vitest";
import {
  buildRetrievalContextQuery,
  renderInstruction,
  type SourcePostProcessingRetrievalContextSnapshot,
} from "../src/modules/sources/postProcessing/instruction.js";
import { parsePostProcessingResult } from "../src/modules/sources/postProcessing/resultParser.js";
import {
  normalizeActions,
  normalizeInputConfig,
  normalizeTriggerConfig,
} from "../src/modules/sources/postProcessing/repository.js";
import type { EvidenceRow, SourceItemRow, SourceConnectionRow } from "../src/modules/sources/sourceRepositoryRows.js";

function makeConnection(overrides: Partial<SourceConnectionRow> = {}): SourceConnectionRow {
  return {
    id: "conn-1",
    space_id: "space-1",
    project_id: null,
    owner_user_id: "user-1",
    credential_id: null,
    visibility: "space_shared",
    access_level: "full",
    name: "arXiv: cs.AI",
    status: "active",
    capture_policy: "extract_text",
    trust_level: "trusted",
    topic_hints_json: [],
    consent_json: null,
    policy_json: null,
    config_json: null,
    handler_kind: "builtin",
    active_handler_version_id: null,
    active_recipe_version_id: null,
    repair_status: "ok",
    last_handler_run_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<SourceItemRow> = {}): SourceItemRow {
  return {
    id: "item-1",
    space_id: "space-1",
    project_id: null,
    owner_user_id: "user-1",
    visibility: "space_shared",
    access_level: "full",
    connection_id: "conn-1",
    item_type: "article",
    source_object_type: null,
    source_object_id: null,
    created_by_user_id: null,
    title: "A paper about agent memory",
    source_uri: "https://arxiv.org/abs/1234.5678",
    canonical_uri: null,
    source_domain: "arxiv.org",
    source_external_id: null,
    author: "Jane Doe",
    occurred_at: null,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    content_hash: null,
    excerpt: "This paper studies retrieval-augmented agent memory.",
    content_state: "excerpt_only",
    retention_policy: "default",
    relevance_score: null,
    novelty_score: null,
    raw_artifact_id: null,
    extracted_artifact_id: null,
    summary_artifact_id: null,
    search_index_ref: null,
    embedding_index_ref: null,
    metadata_json: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function disabledRetrievalContext(): SourcePostProcessingRetrievalContextSnapshot {
  return { enabled: false, query: null, domains: ["project"], pinned: [], items: [] };
}

describe("buildRetrievalContextQuery priority", () => {
  it("uses the explicit retrieval_context.query first", () => {
    const connection = makeConnection({ name: "Ignored connection name" });
    const inputConfig = normalizeInputConfig({
      retrieval_context: { query: "explicit query text" },
      relevance_profile: { enabled: true, objective: "ignored objective" },
    });
    const query = buildRetrievalContextQuery(connection, inputConfig, "ignored summary goal", []);
    expect(query).toBe("explicit query text");
  });

  it("falls back to relevance_profile objective and include_criteria when no explicit query", () => {
    const connection = makeConnection({ name: "Connection name" });
    const inputConfig = normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "Screen papers on agent memory",
        include_criteria: ["retrieval evaluation"],
      },
    });
    const query = buildRetrievalContextQuery(connection, inputConfig, null, []);
    expect(query).toContain("Screen papers on agent memory");
    expect(query).toContain("retrieval evaluation");
    expect(query.indexOf("Screen papers on agent memory")).toBeLessThan(query.indexOf("Connection name"));
  });

  it("ignores the relevance_profile when it is not enabled", () => {
    const connection = makeConnection({ name: "Connection name" });
    const inputConfig = normalizeInputConfig({
      relevance_profile: {
        enabled: false,
        objective: "Should not appear",
      },
    });
    const query = buildRetrievalContextQuery(connection, inputConfig, "summary goal text", []);
    expect(query).not.toContain("Should not appear");
    expect(query).toContain("summary goal text");
  });

  it("falls back to summary goal, then connection name, when no relevance profile is set", () => {
    const connection = makeConnection({ name: "Connection name" });
    const inputConfig = normalizeInputConfig({});
    const query = buildRetrievalContextQuery(connection, inputConfig, "run summary goal", []);
    expect(query.indexOf("run summary goal")).toBeLessThan(query.indexOf("Connection name"));
  });
});

describe("renderInstruction relevance screening section", () => {
  const actions = normalizeActions({ batch_digest: true, mark_items: true });
  const triggerConfig = normalizeTriggerConfig({}, "manual");

  it("renders objective, criteria, and decision policy when relevance_profile is enabled", () => {
    const inputConfig = normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "Find papers on retrieval-augmented agent memory.",
        include_criteria: ["agent memory"],
        exclude_criteria: ["pure hardware optimization"],
        decision_policy: { relevant: "Custom relevant wording" },
      },
    });
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [],
      actions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
    });
    expect(instruction).toContain("Relevance screening:");
    expect(instruction).toContain("Find papers on retrieval-augmented agent memory.");
    expect(instruction).toContain("Include: agent memory");
    expect(instruction).toContain("Exclude: pure hardware optimization");
    expect(instruction).toContain("Custom relevant wording");
    expect(instruction).toContain("Every input source item must get exactly one item_decisions entry.");
  });

  it("renders Project criteria that automated screening must apply", () => {
    const inputConfig = normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "Find useful studies.",
        project_criteria: {
          include_keywords: ["agent memory"],
          exclude_keywords: ["survey"],
          domain_criteria: { methods: ["randomized"] },
          date_range_start: "2024-01-01",
          date_range_end: "2026-12-31",
          source_restrictions: ["arxiv.org"],
          required_evidence_fields: ["sample size"],
        },
      },
    });
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [],
      actions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
    });

    expect(instruction).toContain("Project screening criteria:");
    expect(instruction).toContain("Include keywords/concepts: agent memory");
    expect(instruction).toContain("Exclude keywords/concepts: survey");
    expect(instruction).toContain("methods: randomized");
    expect(instruction).toContain("2024-01-01 to 2026-12-31");
    expect(instruction).toContain("Allowed journals, outlets, or sites: arxiv.org");
    expect(instruction).toContain("Required evidence fields: sample size");
  });

  it("rejects a reversed Project screening date range", () => {
    expect(() => normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "Find useful studies.",
        project_criteria: {
          date_range_start: "2026-12-31",
          date_range_end: "2024-01-01",
        },
      },
    })).toThrow(/date_range_start must be before date_range_end/);
  });

  it("still renders the screening section with default wording when mark_items is on but no profile is set", () => {
    const inputConfig = normalizeInputConfig({});
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [],
      actions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
    });
    expect(instruction).toContain("Relevance screening:");
    expect(instruction).toContain("Strong match to the objective or project context.");
  });

  it("renders staged screening and extracted text snippets when configured", () => {
    const inputConfig = normalizeInputConfig({
      processing_strategy: "screen_extract_digest",
      content_source: "prefer_extracted_text_for_candidates",
      relevance_profile: { enabled: true, objective: "Find relevant papers" },
    });
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [],
      actions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
      extractedTextSnippets: new Map([["item-1", "Full paper section about retrieval memory."]]),
    });
    expect(instruction).toContain("Processing strategy: screen_extract_digest");
    expect(instruction).toContain("Content source: prefer_extracted_text_for_candidates");
    expect(instruction).toContain("Screen + extraction output:");
    expect(instruction).toContain("Extracted text: Full paper section about retrieval memory.");
    expect(instruction).toContain("Do not claim to have read full text unless an extracted text snippet is supplied");
  });

  it("renders candidate prefilter metadata and optional deep analysis guidance", () => {
    const inputConfig = normalizeInputConfig({
      relevance_profile: { enabled: true, objective: "Find relevant papers" },
      candidate_prefilter: {
        enabled: true,
        mode: "hybrid",
        max_candidates: 20,
      },
      deep_analysis: {
        enabled: true,
        trigger_relevance: ["relevant", "maybe"],
        min_confidence: 0.65,
      },
    });
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [],
      actions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
      candidatePrefilter: {
        enabled: true,
        mode: "hybrid",
        selected_item_count: 1,
        filtered_item_count: 9,
      },
    });
    expect(instruction).toContain("Candidate prefilter:");
    expect(instruction).toContain("Selected items in prompt: 1");
    expect(instruction).toContain("Filtered before LLM: 9");
    expect(instruction).toContain("Only judge the source items listed below");
    expect(instruction).toContain("Optional deep analysis:");
    expect(instruction).toContain("Enabled after this screening run for: relevant, maybe");
    expect(instruction).toContain("Minimum confidence: 0.65");
    expect(instruction).toContain("do not assume future full text is available now");
  });

  it("omits the screening section when neither mark_items nor relevance_profile is enabled", () => {
    const noScreeningActions = normalizeActions({ batch_digest: true });
    const inputConfig = normalizeInputConfig({});
    const instruction = renderInstruction({
      connection: makeConnection(),
      items: [makeItem()],
      evidence: [] as EvidenceRow[],
      actions: noScreeningActions,
      inputConfig,
      triggerConfig,
      retrievalContext: disabledRetrievalContext(),
    });
    expect(instruction).not.toContain("Relevance screening:");
  });
});

describe("parsePostProcessingResult screening requirement", () => {
  const itemIds = ["item-1", "item-2"];

  function resultJson(decisions: Array<Record<string, unknown>>): string {
    return JSON.stringify({
      schema: "source_post_processing.result.v1",
      digest_markdown: "digest",
      item_summaries: [],
      item_decisions: decisions,
      evidence_candidates: [],
      proposal_markdown: "",
    });
  }

  it("requires a decision for every item when relevance_profile is enabled, even if mark_items is off", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: false });
    const inputConfig = normalizeInputConfig({
      relevance_profile: { enabled: true, objective: "Screen papers" },
    });
    const incompleteOutput = resultJson([
      { source_item_id: "item-1", relevance: "relevant" },
    ]);
    expect(() => parsePostProcessingResult(incompleteOutput, actions, inputConfig, itemIds)).toThrow(
      /item_decisions must include every input item/,
    );

    const completeOutput = resultJson([
      { source_item_id: "item-1", relevance: "relevant" },
      { source_item_id: "item-2", relevance: "not_relevant" },
    ]);
    expect(() => parsePostProcessingResult(completeOutput, actions, inputConfig, itemIds)).not.toThrow();
  });

  it("does not require item_decisions when neither mark_items nor relevance_profile screening is enabled", () => {
    const actions = normalizeActions({ batch_digest: true });
    const inputConfig = normalizeInputConfig({});
    const output = resultJson([]);
    expect(() => parsePostProcessingResult(output, actions, inputConfig, itemIds)).not.toThrow();
  });

  it("accepts JSON wrapped in a markdown code fence", () => {
    const actions = normalizeActions({ batch_digest: true });
    const inputConfig = normalizeInputConfig({});
    const output = `\`\`\`json\n${resultJson([])}\n\`\`\``;
    expect(parsePostProcessingResult(output, actions, inputConfig, itemIds).digest_markdown).toBe("digest");
  });

  it("generates a count-only digest when every screened item is not relevant", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: true });
    const inputConfig = normalizeInputConfig({});
    const output = JSON.stringify({
      schema: "source_post_processing.result.v1",
      digest_markdown: "",
      item_summaries: [],
      item_decisions: [
        { source_item_id: "item-1", relevance: "not_relevant" },
        { source_item_id: "item-2", relevance: "not_relevant" },
      ],
      evidence_candidates: [],
      proposal_markdown: "",
    });

    const parsed = parsePostProcessingResult(output, actions, inputConfig, itemIds);
    expect(parsed.digest_markdown).toContain("Relevant: 0");
    expect(parsed.digest_markdown).toContain("Not relevant: 2");
  });

  it("extracts the first complete JSON object from prose-wrapped model output", () => {
    const actions = normalizeActions({ batch_digest: true });
    const inputConfig = normalizeInputConfig({});
    const output = `Here is the result:\n${resultJson([])}\nDone.`;
    expect(parsePostProcessingResult(output, actions, inputConfig, itemIds).digest_markdown).toBe("digest");
  });

  it("rejects hallucinated matched_context_refs when retrieval refs are supplied", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: true });
    const inputConfig = normalizeInputConfig({});
    const output = resultJson([
      { source_item_id: "item-1", relevance: "relevant", matched_context_refs: ["knowledge:claim:known"] },
      { source_item_id: "item-2", relevance: "maybe", matched_context_refs: ["knowledge:claim:hallucinated"] },
    ]);
    expect(() =>
      parsePostProcessingResult(output, actions, inputConfig, itemIds, ["knowledge:claim:known"]),
    ).toThrow(/must reference a supplied retrieval context ref/);
  });

  it("accepts object matched_context_refs when they point at supplied retrieval refs", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: true });
    const inputConfig = normalizeInputConfig({});
    const output = resultJson([
      { source_item_id: "item-1", relevance: "relevant", matched_context_refs: [{ ref: "knowledge:claim:known" }] },
      { source_item_id: "item-2", relevance: "not_relevant", matched_context_refs: [] },
    ]);
    const parsed = parsePostProcessingResult(output, actions, inputConfig, itemIds, ["knowledge:claim:known"]);
    expect(parsed.item_decisions[0]?.matched_context_refs).toEqual([{ ref: "knowledge:claim:known" }]);
  });

  it("normalizes a structurally valid result when a runtime omits the schema discriminator", () => {
    const actions = normalizeActions({ batch_digest: true, mark_items: true });
    const inputConfig = normalizeInputConfig({});
    const output = JSON.stringify({
      digest_markdown: "digest",
      item_summaries: [],
      item_decisions: [
        { source_item_id: "item-1", relevance: "relevant" },
        { source_item_id: "item-2", relevance: "not_relevant" },
      ],
      evidence_candidates: [],
      proposal_markdown: "",
    });
    expect(parsePostProcessingResult(output, actions, inputConfig, itemIds).digest_markdown).toBe("digest");
  });

  it("unwraps a runtime result envelope before validating its fields", () => {
    const actions = normalizeActions({ batch_digest: true });
    const inputConfig = normalizeInputConfig({});
    const output = JSON.stringify({
      result: {
        schema: "source_post_processing.result.v1",
        digest_markdown: "digest",
        item_summaries: [],
        item_decisions: [],
        evidence_candidates: [],
        proposal_markdown: "",
      },
    });
    expect(parsePostProcessingResult(output, actions, inputConfig, itemIds).digest_markdown).toBe("digest");
  });
});
