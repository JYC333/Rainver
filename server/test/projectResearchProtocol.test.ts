import { describe, expect, it } from "vitest";
import { loadProtocol } from "../src/modules/providers/protocolRuntime";

const citation = { arxiv_id: "2601.12345" };

describe("Project Research output protocol", () => {
  it("exposes the baseline, historical backfill, incremental, and history mode vocabularies", async () => {
    const { ProjectResearchHistoryModeSchema, ProjectResearchRunKindSchema } = await loadProtocol();
    expect(ProjectResearchRunKindSchema.parse("baseline")).toBe("baseline");
    expect(ProjectResearchRunKindSchema.parse("historical_backfill")).toBe("historical_backfill");
    expect(ProjectResearchRunKindSchema.parse("incremental")).toBe("incremental");
    expect(ProjectResearchHistoryModeSchema.parse("all_available")).toBe("all_available");
    expect(() => ProjectResearchHistoryModeSchema.parse("implicit_default")).toThrow();
  });

  it("uses a project-owned materialized query strategy for initial intake", async () => {
    const { ProjectResearchInitialIntakeRequestSchema } = await loadProtocol();
    const parsed = ProjectResearchInitialIntakeRequestSchema.parse({
      query_strategy_id: "11111111-1111-4111-8111-111111111111",
      history_mode: "all_available",
      max_items: 10000,
      report_depth: "quick",
      question_refine_skipped: false,
      execution: { model_provider_id: "provider-1" },
    });
    expect(parsed.query_strategy_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.history_mode).toBe("all_available");
    expect(parsed.report_depth).toBe("quick");
    expect(ProjectResearchInitialIntakeRequestSchema.safeParse({
      source_channel_ids: ["monitor-1"],
      execution: { model_provider_id: "provider-1" },
    }).success).toBe(false);
  });

  it("does not expose CLI runtime configuration in the Research contract", async () => {
    const { ProjectResearchInitialIntakeRequestSchema } = await loadProtocol();
    const parsed = ProjectResearchInitialIntakeRequestSchema.parse({
      query_strategy_id: "11111111-1111-4111-8111-111111111111",
      report_depth: "full",
      question_refine_skipped: false,
      execution: { model_provider_id: "provider-1", model_name: "provider/path-to-model" },
    });
    expect(parsed.execution).toEqual({ model_provider_id: "provider-1", model_name: "provider/path-to-model" });
    expect(parsed.execution).not.toHaveProperty("adapter_type");
    expect(parsed.execution).not.toHaveProperty("credential_profile_id");
    expect(ProjectResearchInitialIntakeRequestSchema.safeParse({
      query_strategy_id: "11111111-1111-4111-8111-111111111111",
      execution: { adapter_type: "opencode" },
    }).success).toBe(false);
    expect(ProjectResearchInitialIntakeRequestSchema.safeParse({
      query_strategy_id: "11111111-1111-4111-8111-111111111111",
      model_provider_id: "provider-1",
    }).success).toBe(false);
  });

  it("requires a source or evidence reference on every structured output entry", async () => {
    const { ResearchReportV1Schema } = await loadProtocol();
    const base = {
      schema_version: "research_report.v1",
      research_question: "Does X improve Y?",
      summary: "A bounded summary.",
      findings: [{ claim: "X helps Y.", support: "Two included papers.", references: [citation] }],
      limitations: [],
      sources: [{ title: "Paper", authors: ["Author"], references: [citation], relevance: "relevant" }],
      ideas: [{ title: "Idea", problem: "A gap", novelty: "A new angle", testability: "A measurable test", references: [citation] }],
    };
    expect(ResearchReportV1Schema.safeParse(base).success).toBe(true);

    expect(ResearchReportV1Schema.safeParse({ ...base,
      findings: [{ claim: "Unsupported.", support: "No citation.", references: [] }],
    }).success).toBe(false);
  });

  it("requires the combined report sections", async () => {
    const { ResearchReportV1Schema } = await loadProtocol();
    expect(ResearchReportV1Schema.safeParse({ schema_version: "research_report.v1", research_question: "Q", summary: "S" }).success).toBe(false);
  });
});
