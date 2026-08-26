import { describe, expect, it } from "vitest";
import type { ResearchContext, ResearchSemanticQuery } from "@agent-space/protocol";
import { PreviewRelevanceAssessor } from "../src/modules/research/discovery/previewRelevanceAssessor.js";

describe("PreviewRelevanceAssessor", () => {
  it("labels bounded metadata samples and computes conservative relevance/diversity metrics", () => {
    const result = new PreviewRelevanceAssessor().assess(context(), semanticQuery(), {
      providerHitCount: 100,
      accessibleHitCount: 100,
      candidates: [
        { sampleId: "1", title: "Evaluation benchmark for memory-augmented agents", sourceUri: null, occurredAt: null, excerpt: "Cross-session recall for agent memory." },
        { sampleId: "2", title: "Persistent retrieval in long-lived agent memory", sourceUri: null, occurredAt: null, excerpt: "An empirical evaluation benchmark." },
        { sampleId: "3", title: "Human autobiographical memory", sourceUri: null, occurredAt: null, excerpt: "A psychology survey." },
        { sampleId: "4", title: "Unrelated database indexing", sourceUri: null, occurredAt: null, excerpt: null },
      ],
    });

    expect(result.samples.map((sample) => sample.relevance)).toEqual(["relevant", "relevant", "not_relevant", "not_relevant"]);
    expect(result.relevance_rate).toBe(0.5);
    expect(result.relevance_lower_bound).toBeLessThan(result.relevance_rate);
    expect(result.diversity_score).toBe(1);
  });

  it("counts duplicate titles without retaining provider payloads", () => {
    const result = new PreviewRelevanceAssessor().assess(context(), semanticQuery(), {
      providerHitCount: 2,
      accessibleHitCount: 2,
      candidates: [
        { sampleId: "1", title: "Agent Memory Evaluation", sourceUri: null, occurredAt: null, excerpt: "retrieval benchmark" },
        { sampleId: "2", title: "Agent memory evaluation", sourceUri: null, occurredAt: null, excerpt: "retrieval benchmark" },
      ],
    });
    expect(result.duplicate_rate).toBe(0.5);
  });
});

function context(): ResearchContext {
  return {
    schema_version: "research_context.v1",
    objective: "How should long-lived agent memory be evaluated?",
    sub_questions: [],
    in_scope: ["agent memory"],
    out_of_scope: ["human autobiographical memory"],
    must_have: ["evaluation benchmark"],
    nice_to_have: [],
    time_window: null,
    source_scope: { providers: ["arxiv"], include_web: false },
  };
}

function semanticQuery(): ResearchSemanticQuery {
  return {
    schema_version: "research_semantic_query.v1",
    core: [
      { value: "agent memory", synonyms: ["memory-augmented agents"], weight: 1 },
      { value: "retrieval", synonyms: ["recall"], weight: 0.9 },
    ],
    expansions: [],
    qualifiers: [{ value: "evaluation benchmark", synonyms: ["empirical evaluation"], weight: 0.8 }],
    exclusions: [{ value: "human autobiographical memory", synonyms: [], weight: 0.8 }],
    time_window: null,
  };
}
