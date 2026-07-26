import type { ProjectResearchWorkflow } from '../../types/api'

export function researchWorkflowForDisplayFrom(
  workflows: ProjectResearchWorkflow[],
  selectedWorkflowId?: string | null,
): ProjectResearchWorkflow | null {
  if (selectedWorkflowId) {
    const selected = workflows.find(workflow => workflow.id === selectedWorkflowId)
    if (selected) return selected
  }
  return workflows.find(workflow => workflow.status === 'active')
    ?? workflows
      .filter(workflow => workflow.status !== 'archived')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
    ?? null
}
