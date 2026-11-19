import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ get: vi.fn(), accept: vi.fn(), reject: vi.fn() }))
vi.mock('../../../api/client', () => ({ proposalsApi: api }))
vi.mock('../../../core/spaceNav', async () => ({ SpaceLink: (await import('react-router-dom')).Link }))
import { ActionPreviewCards } from '../ActionPreviewCard'
import { ConversationScope } from '../ConversationScope'
import type { ChatActionPreview } from '../../../types/api'

// ADR 0033 §6: a card the withdrawn Gmail hand-off left in a Room, the mainline or a chat is owner-only history.
const preview = (extra: Partial<ChatActionPreview> = {}): ChatActionPreview => ({
  action_id: 'source.gmail.private_read.request', proposal_id: 'card-1', proposal_type: 'gmail_private_read', status: 'failed',
  title: 'Private Gmail check · owner@gmail.example · Kitchen', summary: 'Earlier private Gmail check of “Did the quote arrive?”.',
  decidable_by_user_id: 'owner', scope: { project_id: 'project-1' }, ...extra,
})
const show = (previews: ChatActionPreview[], viewer: string, onDecision = vi.fn(async () => {})) => {
  render(<MemoryRouter><ConversationScope spaceId="space-1"><ActionPreviewCards previews={previews} viewerUserId={viewer} onDecision={onDecision} /></ConversationScope></MemoryRouter>)
  return onDecision
}
beforeEach(() => { vi.resetAllMocks() })

it('is shown to its owner alone', () => {
  api.get.mockResolvedValue({ id: 'card-1', status: 'pending', expired: false })
  show([preview()], 'member')
  expect(screen.queryByText(/Private Gmail check/)).toBeNull()
})

it('a still-pending card offers no decision, no link and no continuation', async () => {
  api.get.mockResolvedValue({ id: 'card-1', status: 'pending', expired: false })
  const next = show([preview({ status: 'proposed' })], 'owner')
  expect(await screen.findByText('Expired · not applied')).toBeInTheDocument()
  expect(screen.getByText(/no longer in use and cannot start anything/)).toBeInTheDocument()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  expect(api.accept).not.toHaveBeenCalled()
  expect(next).not.toHaveBeenCalled()
})

it('an accepted card stays history without a link to the conversation it started', async () => {
  api.get.mockResolvedValue({ id: 'card-1', status: 'accepted', expired: false })
  show([preview({ status: 'auto_applied', scope: { project_id: 'project-1', agent_id: 'agent-1', session_id: 'session-9' } })], 'owner')
  expect(await screen.findByText(/no longer in use/)).toBeInTheDocument()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

// ADR 0033 §6: the in-place private check card is withdrawn too; Gmail is read in the conversation.
it('a withdrawn private check card, even one accepted earlier, is history: no answer, decision, continuation or link', async () => {
  api.get.mockResolvedValue({ id: 'card-2', status: 'accepted', expired: false })
  const next = show([preview({ action_id: 'source.gmail.private_check.request', proposal_id: 'card-2', proposal_type: 'gmail_private_check', status: 'auto_applied',
    summary: 'Earlier private Gmail check against owner@gmail.example in Kitchen.' })], 'owner')
  expect(await screen.findByText(/Gmail is now read in the conversation itself/)).toBeInTheDocument()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  expect(next).not.toHaveBeenCalled()
})

// The generic "continue to next step" starts an Agent follow-up; an owner-only Gmail card's decision is complete on its own.
it('never offers the generic continuation on an owner Gmail card once decided', async () => {
  api.get.mockResolvedValue({ id: 'card-3', status: 'accepted', expired: false })
  const next = show([preview({ action_id: 'source.gmail.monitor.propose', proposal_id: 'card-3', proposal_type: 'gmail_monitor_create', status: 'auto_applied',
    title: 'Gmail monitor', summary: 'Remind me about new mail from the builder.' })], 'owner')
  expect(await screen.findByText('Gmail monitor')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  expect(next).not.toHaveBeenCalled()
})
