import { describe, expect, it } from "vitest";
import { ProjectResearchQuestionRefinementResponseSchema } from "../src/projectResearch.js";

describe("project research question assessment contracts", () => {
  it("accepts a durable Thread-scoped conversation with its latest framework", () => {
    const subQuestion = "How do long-horizon memory mechanisms affect recovery?";
    const refinement = {
      research_context_version_id: "context-1",
      reply: "The scope is now bounded.",
      recommended_question: "How do retry strategies affect coding-agent completion rates?",
      assessment: {
        answerable: true,
        finer: { feasible: 4, interesting: 4, novel: 3, ethical: 5, relevant: 4 },
        issues: [],
      },
      suggested_questions: ["How do retry strategies affect coding-agent completion rates?"],
      sub_questions: [subQuestion],
      scope: { in: ["Coding agents"], out: ["Human-only workflows"] },
      clarifying_questions: [],
    };
    const parsed = ProjectResearchQuestionRefinementResponseSchema.parse({
      ...refinement,
      assessment_session: {
        id: "session-1",
        thread_id: "thread-1",
        recommended_question: refinement.recommended_question,
        latest_refinement: refinement,
        assessment_baseline: refinement,
        research_context_version_id: "context-1",
        messages: [
          {
            id: "message-1",
            turn_index: 1,
            role: "user",
            content: "Focus on coding agents.",
            status: "complete",
            created_by_user_id: "user-1",
            created_at: "2026-07-30T10:00:00.000Z",
          },
          {
            id: "message-2",
            turn_index: 1,
            role: "assistant",
            content: refinement.reply,
            status: "complete",
            created_by_user_id: null,
            created_at: "2026-07-30T10:00:01.000Z",
          },
        ],
        created_at: "2026-07-30T10:00:00.000Z",
        updated_at: "2026-07-30T10:00:01.000Z",
      },
    });

    expect(parsed.assessment_session.messages).toHaveLength(2);
    expect(parsed.sub_questions).toEqual([subQuestion]);
    expect(parsed.assessment_session.latest_refinement?.recommended_question).toContain("retry strategies");
  });
});
