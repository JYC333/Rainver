import type { TurnPart } from '../../types/api'

/** Earlier prose followed by more work, never inferred from sentence content. */
export function progressTextIndexes(parts: readonly TurnPart[]): Set<number> {
  let lastText = -1
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) lastText = part.index
  }
  // Keep the last prose block even if the runtime ended without a closing reply.
  return new Set(parts.flatMap(part => part.type === 'text'
    && part.text.trim() && !part.streamed && part.index < lastText ? [part.index] : []))
}

/** Read both current command summaries and already stored provider summaries. */
export function presentToolOutput(output: string | null): { text: string | null; exitCode: number | null; truncated: boolean } {
  try {
    const value: unknown = JSON.parse(output ?? '')
    if (value && typeof value === 'object' && 'formatted_output' in value && typeof value.formatted_output === 'string') {
      const rawCode = 'exit_code' in value ? value.exit_code : null
      const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && /^-?\d+$/.test(rawCode) ? Number(rawCode) : null
      return { text: value.formatted_output, exitCode: code !== null && Number.isSafeInteger(code) ? code : null, truncated: 'truncated' in value && value.truncated === true }
    }
  } catch { /* Older summaries may contain only the beginning of JSON. */ }
  return { text: output, exitCode: null, truncated: output?.endsWith('…') === true || output?.includes('[output truncated; middle omitted]') === true }
}

export function isDebugDiagnostic(part: TurnPart): boolean {
  return part.type === 'diagnostic' && (part.visibility === 'debug'
    || part.error_code === 'runtime_auth_available' || part.error_code === 'runtime_auth_none'
    || (part.level === 'info' && !part.error_code))
}

/** Execution history stays intact; technical logs have their own disclosure. */
export function presentConversationParts(parts: readonly TurnPart[]): TurnPart[] {
  return parts.filter(part => part.type !== 'reasoning'
    && !isDebugDiagnostic(part))
}

type ToolPart = Extract<TurnPart, { type: 'tool_call' }>
export type ConversationWorkItem = { type: 'part'; part: TurnPart } | { type: 'tools'; id: string; parts: ToolPart[] }

/** Consecutive tool calls share a disclosure without crossing visible message boundaries. */
export function conversationWorkItems(parts: readonly TurnPart[]): ConversationWorkItem[] {
  const items: ConversationWorkItem[] = []
  let group: ToolPart[] = []
  const flush = () => {
    if (group.length > 1) items.push({ type: 'tools', id: `tools:${group[0].call_id ?? group[0].index}`, parts: group })
    else if (group[0]) items.push({ type: 'part', part: group[0] })
    group = []
  }
  for (const part of parts) {
    if (part.type === 'tool_call') group.push(part)
    else { flush(); items.push({ type: 'part', part }) }
  }
  flush()
  return items
}
