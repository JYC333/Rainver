import { describe, expect, it } from "vitest";
import {
  RESEARCH_CRITERION_MAX_LENGTH,
  normalizeResearchScope,
  relevanceCriteriaFromScope,
  relevanceProfileFromResearchContext,
  researchScopeFromRefinement,
} from "../src/modules/projectResearch/researchContext";

describe("Project Research shared refinement context", () => {
  it("maps refinement scope and sub-questions into bounded screening criteria", () => {
    const context = researchScopeFromRefinement({
      sub_questions: ["Which benchmarks measure recovery?", "Which benchmarks measure recovery?"],
      scope: {
        in: ["Tool-using coding agents", `Long criterion ${"x".repeat(250)}`],
        out: ["Human-only studies"],
      },
    });

    expect(context.sub_questions).toEqual(["Which benchmarks measure recovery?"]);
    expect(context.in[1]).toHaveLength(RESEARCH_CRITERION_MAX_LENGTH);
    expect(relevanceCriteriaFromScope(context)).toEqual({
      include: ["Tool-using coding agents", context.in[1], "Which benchmarks measure recovery?"],
      exclude: ["Human-only studies"],
    });
  });

  it("keeps a long sub-question intact, unlike short scope criteria", () => {
    const longQuestion = `Does ${"long-horizon tool use ".repeat(15)}affect recovery?`;
    const context = researchScopeFromRefinement({ sub_questions: [longQuestion], scope: { in: [], out: [] } });

    expect(longQuestion.length).toBeGreaterThan(RESEARCH_CRITERION_MAX_LENGTH);
    expect(context.sub_questions).toEqual([longQuestion]);
  });

  it("normalizes missing scope fields without copying the full question", () => {
    expect(normalizeResearchScope({ in: ["  Included   systems  "] })).toEqual({
      sub_questions: [],
      in: ["Included systems"],
      out: [],
      must_have: [],
      nice_to_have: [],
    });
    expect(relevanceCriteriaFromScope(normalizeResearchScope(null))).toEqual({ include: [], exclude: [] });
  });

  it("keeps a long research question only in the objective", () => {
    const question = `How should ${"long-horizon agents ".repeat(20)}be evaluated?`;
    const profile = relevanceProfileFromResearchContext(question, normalizeResearchScope(null));

    expect(question.length).toBeGreaterThan(RESEARCH_CRITERION_MAX_LENGTH);
    expect(profile.objective).toBe(question);
    expect(profile.include_criteria).toEqual([]);
    expect(profile.exclude_criteria).toEqual([]);
  });

  it("keeps canonical must-have and nice-to-have criteria across screening", () => {
    const scope = normalizeResearchScope({
      must_have: ["Reports an empirical evaluation"],
      nice_to_have: ["Uses a public benchmark"],
    });

    expect(relevanceProfileFromResearchContext("How should agent memory be evaluated?", scope)).toMatchObject({
      must_have: ["Reports an empirical evaluation"],
      nice_to_have: ["Uses a public benchmark"],
    });
  });
});
