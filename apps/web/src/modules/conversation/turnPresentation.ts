import type { TurnPart } from '../../types/api'

/** Earlier prose followed by more work, never inferred from sentence content. */
export function progressTextIndexes(parts: readonly TurnPart[]): Set<number> {
  let lastText = -1
  let lastWork = -1
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) lastText = part.index
    if (part.type === 'tool_call' || part.type === 'plan') lastWork = part.index
  }
  // Keep the last prose block even if the runtime ended without a closing reply.
  return new Set(parts.flatMap(part => part.type === 'text'
    && part.text.trim() && !part.streamed && part.index < lastText && part.index < lastWork ? [part.index] : []))
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
