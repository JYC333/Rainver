import { describe, expect, it } from "vitest";
import { validateResearchArtifacts, type ResearchArtifactRecord } from "../src/modules/projectResearch/artifactValidation";

const citation = { arxiv_id: "2601.12345" };
const report = {
  schema_version: "research_report.v1", research_question: "Does X improve Y?", summary: "A bounded summary.",
  findings: [{ claim: "X helps Y.", support: "Two included papers.", references: [citation] }],
  sources: [{ title: "Paper", authors: ["Author"], references: [citation], relevance: "relevant" }],
  limitations: [], ideas: [{ title: "Idea", problem: "Gap", novelty: "Angle", testability: "Test", references: [citation] }],
};
const artifacts = (content: string): ResearchArtifactRecord[] => [{ id: "archive-1", artifact_type: "research_report.archive.v1", content }];

describe("Project Research report validation", () => {
  it("accepts a complete combined report", async () => {
    const result = await validateResearchArtifacts(artifacts(JSON.stringify(report)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report).toMatchObject({ schema_version: "research_report.v1" });
  });
  it("rejects a standalone JSON code fence", async () => {
    const result = await validateResearchArtifacts(artifacts(`\`\`\`json\n${JSON.stringify(report)}\n\`\`\``));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("research_artifact_invalid_json");
  });
  it("reports invalid JSON without exposing full content", async () => {
    const result = await validateResearchArtifacts(artifacts('{"schema_version":}'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ code: "research_artifact_invalid_json", diagnostics: { artifact_id: "archive-1" } });
  });
  it("rejects an incomplete report", async () => {
    const result = await validateResearchArtifacts(artifacts(JSON.stringify({ schema_version: "research_report.v1" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("research_artifact_schema_invalid");
  });
});
