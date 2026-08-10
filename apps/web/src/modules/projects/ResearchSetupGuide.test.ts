import { describe, expect, it } from 'vitest'
import { pendingResearchSetupStepIds } from './ResearchSetupGuide'

describe('research setup guide', () => {
  it('shows the two choices needed before initial material intake', () => {
    expect(pendingResearchSetupStepIds([
      { id: 'research-question', complete: false },
      { id: 'initial-intake', complete: false },
    ])).toEqual(['research-question', 'initial-intake'])
  })

  it('removes completed choices while setup is still in progress', () => {
    expect(pendingResearchSetupStepIds([
      { id: 'research-question', complete: true },
      { id: 'initial-intake', complete: false },
    ])).toEqual(['initial-intake'])
  })
})
