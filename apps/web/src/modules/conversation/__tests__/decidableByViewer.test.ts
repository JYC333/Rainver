import { describe, expect, it } from 'vitest'
import { decidableByViewer, delegatedRunIds, mergeMessages, messageRunIds } from '../ConversationSurface'
import type { RoomMessage } from '../../../types/api'
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

  it('keeps original and retry Runs attached to one Room message', () => {
    expect(messageRunIds({
      run_id: 'run-original',
      metadata_json: { run_ids: ['run-original', 'run-recipient'], retry_run_ids: ['run-retry'] },
    })).toEqual(['run-original', 'run-recipient', 'run-retry'])
  })
})

describe('a polled page merged into the held transcript', () => {
  const message = (id: string, extra: Partial<RoomMessage> = {}): RoomMessage => ({
    id,
    space_id: 'space-1',
    session_id: 'session-1',
    user_id: 'user-1',
    role: 'user',
    content: id,
    created_at: '2026-09-24T00:00:00.000Z',
    ...extra,
  }) as RoomMessage

  it('takes the server\'s revision of a message it already holds, in place', () => {
    const merged = mergeMessages(
      [message('m-1'), message('m-2')],
      [message('m-1', { discussion_id: 'discussion-1' }), message('m-3')],
    )
    expect(merged.map(item => item.id)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(merged[0]!.discussion_id).toBe('discussion-1')
  })

  it('lists a delegated child Run as live but apart from the recipients', () => {
    const held = { run_id: null, metadata_json: { run_ids: ['run-recipient'], delegated_run_ids: ['run-child'] } }
    expect(messageRunIds(held)).toEqual(['run-recipient', 'run-child'])
    expect(delegatedRunIds(held)).toEqual(['run-child'])
  })
})
