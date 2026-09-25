import { describe, expect, it } from 'vitest'
import { readBackTurnState } from '../settledTurn'

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
