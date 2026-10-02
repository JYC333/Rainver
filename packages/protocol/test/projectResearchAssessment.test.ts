import { describe, expect, it } from "vitest";
import {
  ProjectResearchCheckpointTypeSchema,
  ProjectResearchInitialIntakeRequestSchema,
  ProjectResearchQuestionRefinementResponseSchema,
  ProjectResearchRunKindSchema,
} from "../src/projectResearch.js";

describe("project research intake and lifecycle contracts", () => {
  it("accepts the intake request the web sends and the server reads", () => {
    const parsed = ProjectResearchInitialIntakeRequestSchema.parse({
      workflow_id: "workflow-1",
      thread_id: "thread-1",
      research_context_version_id: "context-1",
      query_strategy_id: "6f1c1b7e-2c6a-4d8e-9f1a-0b2c3d4e5f60",
      research_question: "How do retry strategies affect completion rates?",
      history_mode: "bounded_range",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      max_items: 500,
      monitoring_field: "submittedDate",
      report_depth: "quick",
      question_refine_skipped: false,
      question_refinement: null,
      execution: { model_provider_id: "provider-1" },
    });
    expect(parsed.thread_id).toBe("thread-1");
  });

  it("names every stored run kind and checkpoint type", () => {
    for (const kind of ["question_rescreen", "synthesis_only"]) {
      expect(ProjectResearchRunKindSchema.safeParse(kind).success).toBe(true);
    }
    for (const type of ["integrity_gate", "manuscript_gate", "review_gate", "other"]) {
      expect(ProjectResearchCheckpointTypeSchema.safeParse(type).success).toBe(true);
    }
  });
});

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
