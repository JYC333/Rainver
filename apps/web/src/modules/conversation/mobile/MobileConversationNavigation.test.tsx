import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { MobileConversationNavigation } from './MobileConversationNavigation'

describe('MobileConversationNavigation', () => {
  it('names the open conversation’s own audience in the header and the Room’s in the drawer', async () => {
    // jsdom has no matchMedia; the drawer asks whether it is on a wide screen.
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia
    render(
      <MemoryRouter>
        <MobileConversationNavigation
          title="Before Carol joined" room="Tax season"
          audience="With Bob and Carol" conversationAudience="With Bob · earlier members only"
          conversations={[]} selected={null} unread={new Set()}
          onSelect={() => {}} onNew={() => {}} back={null}
        />
      </MemoryRouter>,
    )
    // A frozen conversation is read by fewer people than its Room: the
    // header a phone reader sees before writing says so.
    expect(screen.getByTestId('mobile-conversation-audience')).toHaveTextContent('Tax season · With Bob · earlier members only')
    fireEvent.click(screen.getByRole('button', { name: 'Conversations and Room details' }))
    expect(await screen.findByRole('dialog')).toHaveAccessibleDescription('With Bob and Carol')
  })
})
