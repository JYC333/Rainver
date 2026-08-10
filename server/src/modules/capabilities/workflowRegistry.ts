import type { WorkflowTemplate } from "./types";

let registryOverrideForTests: WorkflowTemplate[] | null = null;

export function __setWorkflowTemplateRegistryForTests(templates: WorkflowTemplate[] | null): void {
  registryOverrideForTests = templates;
}

export function listBuiltInWorkflowTemplates(): WorkflowTemplate[] {
  return [...(registryOverrideForTests ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

export function getBuiltInWorkflowTemplate(id: string): WorkflowTemplate | null {
  return listBuiltInWorkflowTemplates().find((template) => template.id === id) ?? null;
}

export function assertUniqueWorkflowTemplateIds(templates: readonly WorkflowTemplate[]): void {
  const seen = new Set<string>();
  for (const template of templates) {
    if (seen.has(template.id)) throw new Error(`duplicate workflow template id ${template.id}`);
    seen.add(template.id);
  }
}

