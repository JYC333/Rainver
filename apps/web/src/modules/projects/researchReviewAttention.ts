import type { ProjectResearchCheckpoint } from '../../types/api'

// Mirrors the server's checkpoint policy (researchCheckpointPolicy.ts):
// `idea_review` is auto-waived and never asks a human; `screening_gate` asks
// only when it pauses over the corpus budget (the row is then pending, which
// is what this set is filtered against); `manuscript_gate` always asks.
const HUMAN_REVIEW_CHECKPOINT_TYPES = new Set(['screening_gate', 'manuscript_gate'])

export function isResearchHumanReviewCheckpoint(
  checkpoint: Pick<ProjectResearchCheckpoint, 'checkpoint_type'>,
): boolean {
  return HUMAN_REVIEW_CHECKPOINT_TYPES.has(checkpoint.checkpoint_type)
}

export function researchCheckpointLabel(checkpoint: Pick<ProjectResearchCheckpoint, 'checkpoint_type'>): string {
  return checkpoint.checkpoint_type === 'manuscript_gate' ? 'Manuscript review' : 'Screening results'
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
