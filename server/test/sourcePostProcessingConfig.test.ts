import { describe, expect, it } from "vitest";
import { normalizeActions, normalizeInputConfig } from "../src/modules/sources/postProcessing/repository.js";

describe("source post-processing config", () => {
  it("defaults retrieval context to disabled project context", () => {
    const config = normalizeInputConfig({});

    expect(config.processing_strategy).toBe("batch_digest");
    expect(config.content_source).toBe("excerpt_only");
    expect(config.item_limit).toBe(10);
    expect(config.max_batches_per_event).toBe(10);
    expect(config.retrieval_context).toEqual({
      enabled: false,
      domains: ["project"],
      max_results_per_domain: 6,
      mode: "hybrid",
    });
    expect(config.candidate_prefilter).toEqual({
      enabled: false,
      mode: "hybrid",
      max_candidates: 20,
    });
    expect(config.deep_analysis).toEqual({
      enabled: false,
      trigger_relevance: ["relevant"],
      min_confidence: 0.7,
      max_candidates_per_run: 5,
      content_source: "prefer_extracted_text",
      output: "deep_report",
    });
  });

  it("normalizes explicit retrieval context domains and query", () => {
    const config = normalizeInputConfig({
      retrieval_context: {
        enabled: true,
        domains: ["knowledge", "source", "memory", "source"],
        query: "graph neural networks for molecular property prediction",
        max_results_per_domain: 8,
        mode: "hybrid_rerank",
      },
    });

    expect(config.retrieval_context).toEqual({
      enabled: true,
      domains: ["knowledge", "source", "memory"],
      query: "graph neural networks for molecular property prediction",
      max_results_per_domain: 8,
      mode: "hybrid_rerank",
    });
  });

  it("rejects invalid retrieval context mode", () => {
    expect(() => normalizeInputConfig({
      retrieval_context: {
        mode: "semantic_magic",
      },
    })).toThrow(/retrieval_context\.mode/);
  });

  it("normalizes screening strategy and candidate full-text preference", () => {
    const config = normalizeInputConfig({
      processing_strategy: "screen_then_digest",
      content_source: "prefer_extracted_text_for_candidates",
      item_limit: 7,
      max_batches_per_event: 4,
    });

    expect(config.processing_strategy).toBe("screen_then_digest");
    expect(config.content_source).toBe("prefer_extracted_text_for_candidates");
    expect(config.item_limit).toBe(7);
    expect(config.max_batches_per_event).toBe(4);
  });

  it("normalizes candidate prefilter and optional deep analysis config", () => {
    const config = normalizeInputConfig({
      candidate_prefilter: {
        enabled: true,
        mode: "hybrid_rerank",
        max_candidates: 12,
        min_score: 0.42,
      },
      deep_analysis: {
        enabled: true,
        trigger_relevance: ["relevant", "maybe", "not_relevant", "relevant"],
        min_confidence: 0.6,
        max_candidates_per_run: 3,
        content_source: "require_extracted_text",
        output: "per_item_deep_summary",
      },
    });

    expect(config.candidate_prefilter).toEqual({
      enabled: true,
      mode: "hybrid_rerank",
      max_candidates: 12,
      min_score: 0.42,
    });
    expect(config.deep_analysis).toEqual({
      enabled: true,
      trigger_relevance: ["relevant", "maybe"],
      min_confidence: 0.6,
      max_candidates_per_run: 3,
      content_source: "require_extracted_text",
      output: "per_item_deep_summary",
    });
  });

  it("rejects invalid candidate prefilter and deep analysis values", () => {
    expect(() => normalizeInputConfig({
      candidate_prefilter: { max_candidates: 0 },
    })).toThrow(/candidate_prefilter\.max_candidates/);
    expect(() => normalizeInputConfig({
      candidate_prefilter: { min_score: -1 },
    })).toThrow(/candidate_prefilter\.min_score/);
    expect(() => normalizeInputConfig({
      deep_analysis: { min_confidence: 1.2 },
    })).toThrow(/deep_analysis\.min_confidence/);
    expect(() => normalizeInputConfig({
      deep_analysis: { content_source: "raw_pdf" },
    })).toThrow(/deep_analysis\.content_source/);
  });

  it("enforces the deep-analysis candidate cap", () => {
    expect(normalizeInputConfig({
      deep_analysis: { max_candidates_per_run: 25 },
    }).deep_analysis.max_candidates_per_run).toBe(25);
    expect(() => normalizeInputConfig({
      deep_analysis: { max_candidates_per_run: 26 },
    })).toThrow(/deep_analysis\.max_candidates_per_run/);
  });

  it("rejects invalid processing strategy and auto batch cap", () => {
    expect(() => normalizeInputConfig({ processing_strategy: "magic" })).toThrow(/processing_strategy/);
    expect(() => normalizeInputConfig({ max_batches_per_event: 0 })).toThrow(/max_batches_per_event/);
  });

  it("omits relevance_profile when absent", () => {
    const config = normalizeInputConfig({});
    expect(config.relevance_profile).toBeUndefined();
  });

  it("normalizes a valid relevance profile, deduplicating and trimming criteria", () => {
    const config = normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "  Find papers on retrieval-augmented agent memory.  ",
        include_criteria: [" agent memory ", "retrieval evaluation", "agent memory"],
        exclude_criteria: ["pure hardware optimization"],
        must_have: [],
        nice_to_have: ["novel benchmark"],
        decision_policy: {
          relevant: "Strong match to the objective.",
          maybe: "Indirect or speculative.",
          not_relevant: "No clear connection.",
        },
      },
    });

    expect(config.relevance_profile).toEqual({
      enabled: true,
      objective: "Find papers on retrieval-augmented agent memory.",
      include_criteria: ["agent memory", "retrieval evaluation"],
      exclude_criteria: ["pure hardware optimization"],
      must_have: [],
      nice_to_have: ["novel benchmark"],
      decision_policy: {
        relevant: "Strong match to the objective.",
        maybe: "Indirect or speculative.",
        not_relevant: "No clear connection.",
      },
    });
  });

  it("rejects an enabled relevance profile with no objective or include_criteria", () => {
    expect(() => normalizeInputConfig({
      relevance_profile: {
        enabled: true,
      },
    })).toThrow(/relevance_profile requires an objective or include_criteria/);
  });

  it("rejects oversize relevance profile objective", () => {
    expect(() => normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "x".repeat(2001),
      },
    })).toThrow(/relevance_profile\.objective/);
  });

  it("rejects oversize relevance profile criteria arrays", () => {
    expect(() => normalizeInputConfig({
      relevance_profile: {
        enabled: true,
        objective: "Screen papers",
        include_criteria: Array.from({ length: 21 }, (_, index) => `criterion ${index}`),
      },
    })).toThrow(/include_criteria must contain at most 20 entries/);
  });
});

describe("source post-processing actions", () => {
  it("normalizes actions from an object, defaulting unset keys", () => {
    const actions = normalizeActions({ mark_items: true });
    expect(actions).toEqual({
      batch_digest: true,
      per_item_summary: false,
      extract_evidence: false,
      create_proposals: false,
      mark_items: true,
    });
  });

  it("no longer accepts the legacy array form of actions, falling back to defaults", () => {
    const actions = normalizeActions(["batch_digest", "mark_items"]);
    expect(actions).toEqual({
      batch_digest: true,
      per_item_summary: false,
      extract_evidence: false,
      create_proposals: false,
      mark_items: false,
    });
  });

  it("preserves preset content profile hints", () => {
    expect(normalizeInputConfig({
      content_profile: "arxiv_new_papers",
      summary_goal: "Summarize newly captured arXiv papers for categories: cs.AI.",
      output_instructions: "Include arXiv ids and categories.",
    })).toMatchObject({
      content_profile: "arxiv_new_papers",
      summary_goal: "Summarize newly captured arXiv papers for categories: cs.AI.",
      output_instructions: "Include arXiv ids and categories.",
    });
  });
});
