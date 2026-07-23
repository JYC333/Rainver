import { describe, expect, it } from "vitest";
import {
  ActivateResearchQueryStrategyRequestSchema,
  ResearchContextSchema,
  ResearchQueryAttemptSchema,
} from "../src/researchDiscovery.js";

describe("research discovery contracts", () => {
  it("accepts a complete bounded research context", () => {
    expect(ResearchContextSchema.parse({
      schema_version: "research_context.v1",
      objective: "How should long-lived agent memory be evaluated?",
      sub_questions: ["Which benchmarks measure cross-session recall?"],
      in_scope: ["LLM agent memory"],
      out_of_scope: ["Human autobiographical memory"],
      must_have: ["Reports an evaluation method"],
      nice_to_have: ["Includes a public benchmark"],
      time_window: { from: "2020-01-01", to: null },
      source_scope: { providers: ["arxiv", "openalex"], include_web: false },
    }).objective).toContain("agent memory");
  });

  it("rejects criteria longer than the shared 200 character boundary", () => {
    const result = ResearchContextSchema.safeParse({
      schema_version: "research_context.v1",
      objective: "A valid objective",
      sub_questions: ["x".repeat(201)],
      in_scope: [],
      out_of_scope: [],
      must_have: [],
      nice_to_have: [],
      time_window: null,
      source_scope: { providers: ["arxiv"], include_web: false },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a fourth adaptive attempt", () => {
    const result = ResearchQueryAttemptSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      provider_plan_id: "22222222-2222-4222-8222-222222222222",
      sequence: 4,
      direction: "broaden",
      semantic_query: {
        schema_version: "research_semantic_query.v1",
        core: [{ value: "agent memory", synonyms: [], weight: 1 }],
        expansions: [], qualifiers: [], exclusions: [], time_window: null,
      },
      compiled_query: {
        schema_version: "research_compiled_query.v1",
        provider_key: "arxiv",
        query: { search_query: "all:agent" },
        fingerprint: "0123456789abcdef",
      },
      observation: null,
      score: null,
      decision: null,
      decision_reason: null,
      error_class: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });
    expect(result.success).toBe(false);
  });

  it("limits explicit version activation to manual selection or rollback", () => {
    expect(ActivateResearchQueryStrategyRequestSchema.parse({ reason: "rollback" })).toEqual({ reason: "rollback" });
    expect(ActivateResearchQueryStrategyRequestSchema.safeParse({ reason: "monitoring_feedback" }).success).toBe(false);
  });
});
