import type { Project } from '../../types/api'

// Project Template is a first-class kernel field (`project.template_key`).
// Template origin is provenance only — it must never gate which Areas or
// capabilities a Project shows (see the Project Model Clean-Cutover plan).
// Academic Research *presentation* is decided elsewhere, from configured
// Research Workflows and domain state — see `hasResearchWorkflow` in
// ProjectDetailPage.tsx / ProjectSourcesPage.tsx, not from this key.
export const ACADEMIC_TEMPLATE_KEY = 'academic_research'

export function templateKeyFromProject(project: Project): string | null {
  return project.template_key ?? null
}
