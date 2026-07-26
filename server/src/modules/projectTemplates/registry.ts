import type { ProjectTemplateDescriptor } from "./types";

export const DEFAULT_PROJECT_TEMPLATE_KEY = "blank";

// Built-in Project Templates. Static/code-owned, matching the capabilities
// module's packRegistry.ts pattern: Templates are not DB-seeded. A Template
// is a creation-time defaults bundle, not a permanent Project type — see
// project-model-clean-cutover-plan.md.
const BLANK_TEMPLATE: ProjectTemplateDescriptor = {
  key: "blank",
  name: "Blank",
  description: "General-purpose Project with no starter setup beyond Inquiry.",
  sections: [],
  extraction_profile_key: null,
  graph_lens_id: null,
  initial_primary_mode: "inquiry",
  starter_workflow_template_keys: [],
};

const ACADEMIC_RESEARCH_TEMPLATE: ProjectTemplateDescriptor = {
  key: "academic_research",
  name: "Academic Research",
  description: "Literature monitoring workflow over normal Project Sources with academic paper extraction defaults.",
  // Corpus and project graph are backed by the core Project Sources + Project
  // Corpus foundation. Paper/citation data uses the academic object extension
  // but remains reachable through the normal Project surface.
  sections: ["source_monitoring", "corpus", "project_graph"],
  extraction_profile_key: "academic_paper_v1",
  graph_lens_id: "academic_citation_v1",
  initial_primary_mode: "inquiry",
  starter_workflow_template_keys: ["academic_literature_review"],
};

const BUILT_IN_PROJECT_TEMPLATES: ProjectTemplateDescriptor[] = [BLANK_TEMPLATE, ACADEMIC_RESEARCH_TEMPLATE];

let registryOverrideForTests: ProjectTemplateDescriptor[] | null = null;

export function __setProjectTemplateRegistryForTests(templates: ProjectTemplateDescriptor[] | null): void {
  registryOverrideForTests = templates;
}

export function listBuiltInProjectTemplates(): ProjectTemplateDescriptor[] {
  return [...(registryOverrideForTests ?? BUILT_IN_PROJECT_TEMPLATES)].sort((a, b) => a.key.localeCompare(b.key));
}

export function getBuiltInProjectTemplate(key: string): ProjectTemplateDescriptor | null {
  return listBuiltInProjectTemplates().find((template) => template.key === key) ?? null;
}
