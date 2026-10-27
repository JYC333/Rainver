import { describe, expect, it } from 'vitest'
import type { TurnPart } from '../../../types/api'
import { presentConversationParts } from '../turnPresentation'

describe('permission audit presentation', () => {
  it('hides only successful preauthorization notices without changing the audit parts', () => {
    const parts: TurnPart[] = [
      { type: 'diagnostic', index: 0, level: 'info', text: 'Permission pre-authorized (execute): allowed', error_code: null },
      { type: 'diagnostic', index: 1, level: 'info', text: 'Permission pre-authorized (search): cancelled', error_code: null },
      { type: 'diagnostic', index: 2, level: 'error', text: 'Permission pre-authorized (execute): allowed', error_code: 'permission_failed' },
      { type: 'diagnostic', index: 3, level: 'info', text: 'Waiting for runtime.', error_code: null },
    ]
    expect(presentConversationParts(parts)).toEqual(parts.slice(1))
    expect(parts).toHaveLength(4)
  })
})
