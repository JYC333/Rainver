import type { RunTurn } from '../../types/api'

export function queuedRunLabel(turn?: RunTurn) {
  if (turn?.queue_wait_reason === 'waiting_for_parent') return 'conversation_ui.surface.waiting_parent'
  if (turn?.queue_wait_reason === 'waiting_for_delegation_admission') return 'conversation_ui.surface.waiting_admission'
  return 'conversation_ui.surface.queued'
}
