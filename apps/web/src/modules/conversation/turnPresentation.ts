import type { TurnPart } from '../../types/api'

type ToolPart = Extract<TurnPart, { type: 'tool_call' }>

export type PresentedTurnPart =
  | { type: 'part'; key: string; part: TurnPart }
  | { type: 'completed_tool_group'; key: string; tools: ToolPart[] }

/**
 * Builds the conversation's display model without changing the durable turn.
 *
 * Only consecutive successful calls are grouped. Text, reasoning, plans,
 * failures and active calls remain at their protocol position, so reducing
 * visual noise never rewrites the chronology the user can expand back into.
 */
export function presentTurnParts(
  parts: readonly TurnPart[],
  options: { groupCompletedTools: boolean },
): PresentedTurnPart[] {
  const presented: PresentedTurnPart[] = []
  let completedTools: ToolPart[] = []

  const flushCompletedTools = () => {
    if (completedTools.length === 0) return
    presented.push({
      type: 'completed_tool_group',
      key: `completed-tools-${completedTools[0]!.index}`,
      tools: completedTools,
    })
    completedTools = []
  }

  for (const part of parts) {
    if (options.groupCompletedTools && part.type === 'tool_call' && part.status === 'succeeded') {
      completedTools.push(part)
      continue
    }
    flushCompletedTools()
    presented.push({ type: 'part', key: `part-${part.index}`, part })
  }
  flushCompletedTools()
  return presented
}
