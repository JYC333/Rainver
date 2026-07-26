import { describe, expect, it } from "vitest";
import { getBuiltInProjectTemplate } from "../src/modules/projectTemplates/registry";

describe("project template registry", () => {
  it("ships Academic Research as a Project Sources, Corpus, and Graph backed Template", () => {
    const template = getBuiltInProjectTemplate("academic_research");
    expect(template).toMatchObject({
      key: "academic_research",
      extraction_profile_key: "academic_paper_v1",
      graph_lens_id: "academic_citation_v1",
    });
    expect(template?.sections).toEqual(["source_monitoring", "corpus", "project_graph"]);
  });
});
