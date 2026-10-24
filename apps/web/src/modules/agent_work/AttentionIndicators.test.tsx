import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AttentionBadge } from './AttentionIndicators'
const state = vi.hoisted(() => ({ unread: 0, needsYou: 0, freshness: 'live' }))
vi.mock('./AgentAttentionProvider', () => ({ useOptionalAttention: () => ({}), useAttentionState: () => state, useAttention: () => ({}) }))
describe('mobile attention dot', () => {
  it('shows no indicator when nothing needs attention', () => {
    state.unread = 0; state.needsYou = 0
    render(<AttentionBadge dot />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  it.each([[2, 0], [0, 1]])('shows an accessible dot without visible numbers for %s unread and %s needs-you', (unread, needsYou) => {
    Object.assign(state, { unread, needsYou })
    render(<AttentionBadge dot />)
    expect(screen.getByRole('status')).toHaveAccessibleName()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})
