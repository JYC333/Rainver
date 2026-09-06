import { describe, expect, it } from 'vitest'
import { decidableByViewer } from '../ConversationSurface'
import type { ChatActionPreview } from '../../../types/api'

/**
 * Which of a turn's cards this person is shown.
 *
 * Almost every proposal is decided by whoever has the role for it, so almost
 * every card is shown to everyone in the Room. One is not: an Agent's persona
 * is its owner's alone, by identity rather than by role (ADR 0003 §5). The
 * member who asked for the change cannot accept it, so they get no card — a
 * card whose buttons refuse is worse than nothing.
 */

const OWNER = 'owner-1'
const MEMBER = 'member-1'

function preview(overrides: Partial<ChatActionPreview> = {}): ChatActionPreview {
  return {
    action_id: 'memory.remember',
    status: 'proposed',
    proposal_id: 'proposal-1',
    proposal_type: 'memory_create',
    title: 'Remember this',
    ...overrides,
  }
}

describe('which cards a person is shown', () => {
  it('shows an ordinary card to everyone', () => {
    const cards = [preview()]
    expect(decidableByViewer(cards, MEMBER)).toEqual(cards)
    expect(decidableByViewer(cards, null)).toEqual(cards)
  })

  it('shows a card that names one decider to that person and to nobody else', () => {
    const cards = [preview({ decidable_by_user_id: OWNER, title: 'Change what I have become' })]
    expect(decidableByViewer(cards, OWNER)).toEqual(cards)
    // The member who asked for it, who cannot accept it.
    expect(decidableByViewer(cards, MEMBER)).toEqual([])
    // And an unauthenticated render, which is nobody.
    expect(decidableByViewer(cards, null)).toEqual([])
  })

  it('leaves the rest of the turn cards alone', () => {
    const shared = preview({ proposal_id: 'proposal-2', title: 'Split this question' })
    const owned = preview({ proposal_id: 'proposal-3', decidable_by_user_id: OWNER })
    expect(decidableByViewer([shared, owned], MEMBER)).toEqual([shared])
    expect(decidableByViewer([shared, owned], OWNER)).toEqual([shared, owned])
  })
})
