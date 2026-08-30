// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { audienceLabel, personLabel } from '../audience'

describe('audienceLabel', () => {
  // The one way a Room is named from its audience, on the conversation list,
  // the Room page and the empty-Room row alike.
  it('names the people, and the Agents only when there are any', () => {
    expect(audienceLabel({ otherMemberNames: [], agentCount: 0 })).toBe('Just you')
    expect(audienceLabel({ otherMemberNames: ['Alice'], agentCount: 0 })).toBe('With Alice')
    expect(audienceLabel({ otherMemberNames: ['Alice', 'Bob'], agentCount: 1 })).toBe('With Alice and Bob · 1 agent')
    expect(audienceLabel({ otherMemberNames: ['Alice', 'Bob', 'Cy'], agentCount: 2 })).toBe('With Alice, Bob and Cy · 2 agents')
  })
})

describe('personLabel', () => {
  it('falls back from display name to email to id, in that order', () => {
    expect(personLabel({ display_name: 'Dana', email: 'd@x', user_id: 'u1' })).toBe('Dana')
    expect(personLabel({ display_name: '', email: 'd@x', user_id: 'u1' })).toBe('d@x')
    expect(personLabel({ display_name: null, email: null, user_id: 'u1' })).toBe('u1')
  })
})
