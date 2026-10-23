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
  const hostTurn: RunTurn = {
    schema_version: 'run_turn.v1', run_id: 'run-host', state: 'working',
    source: 'host_thread_events', blocked_on: null, cursor: 3, updated_at: null,
    parts: [
      { type: 'text', index: 0, text: 'Checking.' },
      { type: 'tool_call', index: 1, call_id: 'read', name: 'read', kind: null, status: 'succeeded', input: null, output: null },
      { type: 'text', index: 2, text: 'Done.' },
    ],
  }

  it('retains recorded message boundaries when the complete trace matches the saved reply', () => {
    const settled = settledTurn(hostTurn, 'done', 'Checking.Done.')!
    expect(settled.parts).toEqual(hostTurn.parts)
    expect(settled.state).toBe('done')
    expect(hostTurn.state).toBe('working')
    expect(settledTurn(settled, 'done', 'Checking.Done.')!.parts).toEqual(settled.parts)
  })

  it('uses the canonical message when the trace is incomplete or the finalizer adds a question', () => {
    for (const text of ['Checking.Done. Answer this question?', 'Only the saved reply.']) {
      const settled = settledTurn(hostTurn, 'done', text)!
      expect(settled.parts.filter(part => part.type === 'text')).toEqual([{ type: 'text', index: 2, text }])
    }
  })

  it('drops a transient duplicate without discarding the complete Host segments', () => {
    const streamed: RunTurn = { ...hostTurn, parts: [...hostTurn.parts,
      { type: 'text', index: Number.MAX_SAFE_INTEGER, text: 'Checking.Done.', streamed: true },
    ] }
    expect(settledTurn(streamed, 'done', 'Checking.Done.')!.parts).toEqual(hostTurn.parts)
  })

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
