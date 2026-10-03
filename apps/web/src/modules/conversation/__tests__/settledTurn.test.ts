import { describe, expect, it } from 'vitest'
import { readBackTurnState, settledTurn } from '../settledTurn'
import type { RunTurn } from '../../../types/api'

describe('readBackTurnState', () => {
  it('settles a turn read back after its reply, including one still queued for its directory', () => {
    expect(readBackTurnState('working')).toBe('done')
    // Blocked on the workspace is a Run its host had not started: not a
    // person's decision to keep a link open for.
    expect(readBackTurnState('blocked', 'workspace')).toBe('done')
  })

  it('keeps a turn that is waiting on a person blocked', () => {
    expect(readBackTurnState('blocked', 'authorization')).toBe('blocked')
    expect(readBackTurnState('blocked', 'run_decision')).toBe('blocked')
    expect(readBackTurnState('failed')).toBe('failed')
  })
})

describe('settledTurn', () => {
  it('gives the saved reply an index no kept step already uses', () => {
    const streamed = {
      run_id: 'run-1', state: 'working', blocked_on: null,
      parts: [
        { type: 'tool_call', index: 0, status: 'failed', name: 'grep', title: 'grep', detail: null },
        { type: 'text', index: 1, text: 'Looking' },
        { type: 'diagnostic', index: 2, message: 'exit 2' },
        { type: 'text', index: 3, text: 'Hmm' },
      ],
    } as unknown as RunTurn
    const settled = settledTurn(streamed, 'failed', 'It failed.')!
    const indexes = settled.parts.map(part => part.index)
    expect(new Set(indexes).size).toBe(indexes.length)
    expect(settled.parts[settled.parts.length - 1]).toMatchObject({ type: 'text', text: 'It failed.' })
  })
})
