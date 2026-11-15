import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ConversationStatusIndicator } from './ConversationUnreadDot'

it('keeps an unread conversation spinning until all work ends, then clears once read', () => {
  const { rerender } = render(<ConversationStatusIndicator running unread />)
  expect(screen.getByRole('status', { name: 'Conversation running' })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: 'Unread conversation' })).not.toBeInTheDocument()
  rerender(<ConversationStatusIndicator running={false} unread />)
  expect(screen.getByRole('status', { name: 'Unread conversation' })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: 'Conversation running' })).not.toBeInTheDocument()
  rerender(<ConversationStatusIndicator running={false} unread={false} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
