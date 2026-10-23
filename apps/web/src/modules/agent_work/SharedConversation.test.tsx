import { act, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentAttentionApi, roomsApi, runsApi } from '../../api/client'
import { AgentAttentionProvider } from './AgentAttentionProvider'
import type { RoomDetail, RoomMessage } from '../../types/api'
import { ConversationSurface } from '../conversation/ConversationSurface'
import { ConversationScope } from '../conversation/ConversationScope'
import { deferred, run, turn } from './fixtures.test-support'

vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user', activeSpaceId: 'space-a', preferredSpaceId: 'space-a' }) }))
vi.mock('../../api/client', async original => ({
  ...await original<typeof import('../../api/client')>(),
  roomsApi: { messages: vi.fn(), conversationQuota: vi.fn(async () => null), summary: vi.fn(async () => null) },
  runsApi: { get: vi.fn(), turn: vi.fn() },
  agentAttentionApi: { recordViews: vi.fn(async () => ({ read_count: 0, read_states: [] })), stream: vi.fn(async (_sink, options) => { await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true })) }) },
}))
const detail = { room: { id: 'room-b', project_id: 'project-b', project_folder_id: null }, viewer_can_write: false, agent_members: [] } as unknown as RoomDetail
const message: RoomMessage = { space_id: 'space-b', id: 'message-b', session_id: 'session-b', user_id: 'user', role: 'user', content: 'Visible source message', metadata_json: {}, created_at: '2026-10-21T00:00:00Z' }
function show(onMessagesDisplayed: (ids: string[]) => void, onReadError = vi.fn()) {
  return render(<MemoryRouter><ConversationScope spaceId="space-b" actionUserId="user" actionRole="member">
    <ConversationSurface roomId="room-b" conversationId="session-b" spaceId="space-b" variant="panel" detail={detail} readOnly
      onMessagesDisplayed={onMessagesDisplayed} onReadError={onReadError} />
  </ConversationScope></MemoryRouter>)
}
beforeEach(() => { vi.clearAllMocks() })
describe('workbench shared transcript boundary', () => {
  it('records the Project panel transcript as read through the shared provider', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({ items: [message], total: 1, limit: 50, offset: 0 } as never)
    render(<MemoryRouter><AgentAttentionProvider userId="user">
      <ConversationSurface roomId="room-b" conversationId="session-b" spaceId="space-b" variant="panel" detail={detail} readOnly />
    </AgentAttentionProvider></MemoryRouter>)
    expect(await screen.findByText('Visible source message')).toBeVisible()
    await waitFor(() => expect(agentAttentionApi.recordViews).toHaveBeenCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['message-b'] }, expect.objectContaining({ signal: expect.any(AbortSignal) })))
  })
  it('reports displayed messages after successful mount, while a read-only viewer has no composer', async () => {
    const pending = deferred<Awaited<ReturnType<typeof roomsApi.messages>>>()
    vi.mocked(roomsApi.messages).mockReturnValueOnce(pending.promise)
    const displayed = vi.fn()
    show(displayed)
    expect(displayed).not.toHaveBeenCalled()
    await act(async () => pending.resolve({ items: [message], total: 1, limit: 50, offset: 0 } as never))
    expect(await screen.findByText('Visible source message')).toBeVisible()
    await waitFor(() => expect(displayed).toHaveBeenCalledWith(['message-b']))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
    expect(roomsApi.messages).toHaveBeenCalledWith('room-b', 'session-b', { limit: 50, offset: 0 }, expect.objectContaining({ spaceId: 'space-b' }))
  })
  it('reports an initial transcript failure without reporting successful display', async () => {
    const error = new Error('read unavailable')
    vi.mocked(roomsApi.messages).mockRejectedValueOnce(error)
    const displayed = vi.fn(), failed = vi.fn()
    show(displayed, failed)
    await waitFor(() => expect(failed).toHaveBeenCalledWith(error))
    expect(displayed).not.toHaveBeenCalled()
  })
  it.each([
    { variant: 'full', writable: false, readOnly: false, retry: true },
    { variant: 'panel', writable: false, readOnly: false, retry: true },
    { variant: 'panel', writable: true, readOnly: false, retry: true },
    { variant: 'panel', writable: false, readOnly: true, retry: false },
  ] as const)('preserves retry defaults for $variant (writer=$writable, readOnly=$readOnly)', async ({ variant, writable, readOnly, retry }) => {
    vi.mocked(roomsApi.messages).mockResolvedValue({ items: [{ ...message, role: 'assistant', run_id: 'run-b' }], total: 1, limit: 50, offset: 0 } as never)
    vi.mocked(runsApi.get).mockResolvedValue(run({ status: 'failed', owner_user_id: 'other', instructed_by_user_id: 'other' }))
    vi.mocked(runsApi.turn).mockResolvedValue(turn({ state: 'failed' }))
    render(<MemoryRouter><ConversationScope spaceId="space-b" actionUserId="user" actionRole="member">
      <ConversationSurface roomId="room-b" conversationId="session-b" spaceId="space-b" variant={variant} detail={{ ...detail, viewer_can_write: writable }} readOnly={readOnly} />
    </ConversationScope></MemoryRouter>)
    await waitFor(() => expect(runsApi.turn).toHaveBeenCalledWith('run-b', expect.objectContaining({ spaceId: 'space-b' })))
    const controls = await screen.findByTestId('conversation-run-controls-run-b')
    if (retry) expect(within(controls).getByRole('button', { name: 'Retry turn' })).toBeVisible()
    else expect(within(controls).queryByRole('button', { name: 'Retry turn' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Only the Run owner/)).not.toBeInTheDocument()
  })
})
