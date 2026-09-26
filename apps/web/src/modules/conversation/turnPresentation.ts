import type { TurnPart } from '../../types/api'

/**
 * Builds the conversation's display model without changing the durable turn.
 *
 * Reasoning and successful calls remain available in the Run audit trail, but
 * they are not conversation content. Active/failed calls and diagnostics stay
 * visible because they explain what is happening or what went wrong.
 */
export function presentConversationParts(parts: readonly TurnPart[]): TurnPart[] {
  return parts.filter(part => part.type !== 'reasoning'
    && !(part.type === 'tool_call' && part.status === 'succeeded'))
}
