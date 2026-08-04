import type { ProjectResearchCheckpoint } from '../../types/api'

const HUMAN_REVIEW_CHECKPOINT_TYPES = new Set(['screening_gate', 'idea_review'])

export function isResearchHumanReviewCheckpoint(
  checkpoint: Pick<ProjectResearchCheckpoint, 'checkpoint_type'>,
): boolean {
  return HUMAN_REVIEW_CHECKPOINT_TYPES.has(checkpoint.checkpoint_type)
}

export function researchCheckpointLabel(checkpoint: Pick<ProjectResearchCheckpoint, 'checkpoint_type'>): string {
  return checkpoint.checkpoint_type === 'idea_review' ? 'Idea candidates' : 'Screening results'
}

export function researchReviewToastId(projectId: string, checkpointId: string): string {
  return `research-review:${projectId}:${checkpointId}`
}

export function researchCheckpointOperationId(
  checkpoint: Pick<ProjectResearchCheckpoint, 'machine_result_json'>,
): string | null {
  const value = checkpoint.machine_result_json?.operation_id
  return typeof value === 'string' && value.trim() ? value : null
}
