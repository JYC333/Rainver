import { describe, expect, it } from "vitest";
import { structuredOutputFromText } from "../src/modules/providers/invocation/invocation";
import {
  RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT,
  RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT,
} from "../src/modules/projectResearch/outputSchemas";

describe("Project Research P0 structured contracts", () => {
  it("accepts the bounded FINER question refinement shape", () => {
    const output = {
      reply: "The current topic needs a bounded population and outcome.",
      recommended_question: "How does tool-use planning affect completion rate for coding agents?",
      assessment: {
        answerable: false,
        finer: { feasible: 1, interesting: 3, novel: 1, ethical: 3, relevant: 1 },
        issues: ["The topic has no researchable outcome."],
      },
      suggested_questions: ["How does tool-use planning affect completion rate for coding agents?"],
      sub_questions: ["Which benchmark defines completion rate?"],
      scope: { in: ["coding agents"], out: ["general intelligence"] },
      clarifying_questions: [{ question: "Which agent setting matters?", options: ["Coding agents", "Assistant agents"], allow_multiple: true }],
    };
    expect(structuredOutputFromText(JSON.stringify(output), RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT)).toEqual(output);
  });

  it("rejects clarifying questions without structured options metadata", () => {
    const output = {
      reply: "The question is answerable.",
      recommended_question: "How does tool-use planning affect completion rate for coding agents?",
      assessment: { answerable: true, finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 }, issues: [] },
      suggested_questions: ["How does tool-use planning affect completion rate for coding agents?"],
      sub_questions: [],
      scope: { in: [], out: [] },
      clarifying_questions: ["Which agent setting matters?"],
    };
    expect(() => structuredOutputFromText(JSON.stringify(output), RESEARCH_QUESTION_REFINEMENT_OUTPUT_CONTRACT)).toThrow(/structured output/i);
  });

  it("rejects critique references that are not report ref-N labels", () => {
    const output = {
      verdict: "revise",
      issues: [{ severity: "critical", kind: "unsupported_claim", detail: "The central claim is not supported.", affected_refs: ["paper-1"] }],
    };
    expect(() => structuredOutputFromText(JSON.stringify(output), RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT)).toThrow(/structured output/i);
  });

  it("accepts an empty issue list for a passing critique", () => {
    const output = { verdict: "pass", issues: [] };
    expect(structuredOutputFromText(JSON.stringify(output), RESEARCH_SYNTHESIS_CRITIQUE_OUTPUT_CONTRACT)).toEqual(output);
  });
});
