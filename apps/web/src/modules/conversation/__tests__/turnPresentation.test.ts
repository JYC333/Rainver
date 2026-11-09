import { describe, expect, it } from 'vitest'
import type { TurnPart } from '../../../types/api'
import { presentConversationParts, progressTextIndexes } from '../turnPresentation'

describe('permission audit presentation', () => {
  it('keeps technical logs separate from actionable errors without changing the recorded parts', () => {
    const parts: TurnPart[] = [
      { type: 'diagnostic', index: 0, level: 'info', text: 'Permission pre-authorized (execute): allowed', error_code: null },
      { type: 'diagnostic', index: 1, level: 'info', text: 'Permission pre-authorized (search): cancelled', error_code: null },
      { type: 'diagnostic', index: 2, level: 'error', text: 'Permission pre-authorized (execute): allowed', error_code: 'permission_failed' },
      { type: 'diagnostic', index: 3, level: 'info', text: 'Waiting for runtime.', error_code: null },
    ]
    expect(presentConversationParts(parts)).toEqual([parts[2]])
    expect(parts).toHaveLength(4)
  })
})

it('folds every earlier message, including buffered prose after the last tool',()=>{
 const parts:TurnPart[]=[{type:'text',index:0,text:'First progress.'},{type:'text',index:1,text:'Second progress.'},{type:'text',index:2,text:'Final answer.'}];
 expect([...progressTextIndexes(parts)]).toEqual([0,1]);
});
