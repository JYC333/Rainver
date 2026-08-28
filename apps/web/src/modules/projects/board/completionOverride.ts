import { ApiRequestError, tasksApi } from '../../../api/client'

/**
 * Move a card, and turn the server's refusal into something a person can act
 * on.
 *
 * The refusal is a decision point, not an error: the server names exactly which
 * declared requirements are unmet, and acknowledging them is what lets the
 * close through while recording that it was early. Surfacing it as a toast
 * would drop the reasons and leave no way forward.
 */
export async function moveCardStatus(
  taskId: string,
  toStatus: string,
  acknowledged?: readonly string[],
): Promise<void> {
  // An empty acknowledgement is not an override — the server reads it as none
  // at all and refuses again, which would make "Close anyway" a loop.
  await tasksApi.update(taskId, acknowledged && acknowledged.length > 0
    ? { status: toStatus, override_completion: { acknowledged: [...acknowledged] } }
    : { status: toStatus })
}

/** The reasons a close was refused, or null when the failure was something else. */
export function blockedCompletion(error: unknown): string[] | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'completion_requirements_unmet') return null
  const missing = error.payload?.missing
  const reasons = Array.isArray(missing)
    ? missing.filter((value): value is string => typeof value === 'string')
    : []
  // A refusal that names nothing cannot be acknowledged, so it is surfaced as
  // an ordinary error rather than an empty dialog with a button that re-fails.
  return reasons.length > 0 ? reasons : null
}

export function completionReasonLabel(reason: string): string {
  if (reason === 'evaluation') return 'No evaluation has accepted the result'
  if (reason.startsWith('required_output:')) {
    return `Missing a declared output: ${reason.slice('required_output:'.length)}`
  }
  return reason
}
