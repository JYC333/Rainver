import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function treeSources(path: string): string {
  const absolute = join(repoRoot, path);
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap(entry => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return treeSources(child);
      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [source(child)] : [];
    })
    .join("\n");
}

describe("Project Research generalization boundaries", () => {
  it("does not restore label-only research workflow presets or academic execution ids", () => {
    const pack = source("server/src/modules/capabilities/researchPack.ts");
    const execution = [
      source("server/src/modules/projectResearch/researchPassExecution.ts"),
      source("server/src/modules/projectResearch/synthesisOnlyExecution.ts"),
    ].join("\n");

    // The pack used to carry an empty `workflow_template_ids: []` to prove no
    // label-only preset had crept back. The workflow template layer is gone
    // entirely, so the absence of the field is the stronger form of the same
    // guard: there is nothing left for a preset to be declared in.
    expect(pack).not.toContain("workflow_template_ids");
    for (const retired of [
      "research.academic_literature_review",
      "research.news_scan",
      "research.market_research",
      "research.technical_survey",
      "academic_literature_review",
      "academic_research_workflow_execution",
    ]) {
      expect(`${pack}\n${execution}`).not.toContain(retired);
    }
    expect(execution).toContain('"project_research.reconcile_pass"');
    expect(execution).toContain('"project_research.synthesis_only"');
  });

  it("keeps generic Research surfaces free of paper/literature-only wording", () => {
    const genericSurfaces = [
      "apps/web/src/modules/projects/FocusResearchWorkbench.tsx",
      "apps/web/src/modules/projects/ResearchCheckpointReview.tsx",
      "apps/web/src/modules/projects/ResearchScanTimeline.tsx",
      "apps/web/src/modules/projects/ResearchSetupSummary.tsx",
      "apps/web/src/modules/projects/ResearchTabsLegend.tsx",
      "apps/web/src/modules/projects/researchArea/ReadingListView.tsx",
      // The Research Area page replaced the ProjectResearchWorkbench wrapper
      // as the surface that composes standing and focus; useProjectResearch
      // holds the copy that used to sit in the Project Overview.
      "apps/web/src/modules/projects/ResearchAreaPage.tsx",
      "apps/web/src/modules/projects/ResearchSettingsCard.tsx",
      "apps/web/src/modules/projects/useProjectResearch.ts",
      "apps/web/src/modules/projects/ProjectResearchStandingPanel.tsx",
      "apps/web/src/modules/projects/ProjectDetailPage.tsx",
      "apps/web/src/modules/projects/ProjectSourcesPage.tsx",
    ].map(source).join("\n");

    expect(genericSurfaces).not.toMatch(/\b(?:paper|papers|literature)\b/i);
    expect(genericSurfaces).not.toContain("Academic research");
  });

  it("keeps Template provenance out of Project runtime capability decisions", () => {
    const projectBackend = treeSources("server/src/modules/projects");
    const genericFrontend = [
      "apps/web/src/modules/projects/ProjectDetailPage.tsx",
      "apps/web/src/modules/projects/ProjectSourcesPage.tsx",
      "apps/web/src/modules/projects/ResearchAreaPage.tsx",
      "apps/web/src/modules/projects/useProjectResearch.ts",
    ].map(source).join("\n");
    const genericExecution = [
      "server/src/modules/projectResearch/researchPassExecution.ts",
      "server/src/modules/projectResearch/synthesisOnlyExecution.ts",
      "server/src/modules/projectResearch/standingComparisonService.ts",
    ].map(source).join("\n");

    expect(projectBackend).not.toMatch(/from\s+["'][^"']*\/academic\//);
    expect(projectBackend).not.toContain("academic_paper_v1");
    expect(source("server/src/modules/projects/projectSourceProposalApplier.ts"))
      .not.toContain("ProjectSourceBindingRepository");
    expect(genericExecution).not.toContain("academic_paper_v1");
    expect(genericFrontend).not.toContain("ACADEMIC_TEMPLATE_KEY");
    expect(genericFrontend).not.toContain("templateKeyFromProject");
    expect(genericFrontend).not.toContain("academic_research");
  });

  it("keeps generic backend Research ownership and setup wording domain-neutral", () => {
    const backend = [
      "server/src/db/schema/projectResearch.ts",
      "server/src/modules/projectResearch/areaService.ts",
      "server/src/modules/projectResearch/standingComparisonService.ts",
      "server/src/modules/projectResearch/researchPassExecution.ts",
      "server/src/modules/projectResearch/synthesisOnlyExecution.ts",
    ].map(source).join("\n");
    expect(backend).not.toMatch(/Project-owned Academic Research|focus paper triage|academic sources only/i);
    expect(backend).not.toMatch(/\b(?:paper|papers|literature)\b/i);
    expect(source("apps/web/src/modules/projects/ResearchSetupDialog.tsx"))
      .not.toContain("Academic sources only");
  });

  it("keeps standing advice on the shared object-action inventory", async () => {
    const { systemActionsForObjectType } = await import("@agent-space/protocol");
    expect(systemActionsForObjectType("source").map((definition) => definition.id))
      .toEqual(["source.raise_as_question"]);
  });
});
