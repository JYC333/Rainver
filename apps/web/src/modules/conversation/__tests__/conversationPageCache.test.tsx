import { toast } from 'sonner'
import { act, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError, roomsApi } from '../../../api/client'
import type { RoomDetail, RoomMessage } from '../../../types/api'
import { ConversationSurface } from '../ConversationSurface'
import { conversationPageCacheStats } from '../../../lib/conversationPageCache'
import { clearSessionResidue } from '../../../lib/sessionResidue'
import { deferred } from '../../agent_work/fixtures.test-support'

vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user', activeSpaceId: 'space-a', spaces: [{ id: 'space-a', name: 'A', role: 'member' }] }) }))
vi.mock('../../../api/client', async original => ({
  ...await original<typeof import('../../../api/client')>(),
  roomsApi: { messages: vi.fn(), conversationQuota: vi.fn(async () => null), summary: vi.fn(async () => null), discussions: vi.fn(async () => ({ items: [] })) },
  runsApi: { get: vi.fn(), turn: vi.fn() },
}))

type Page = Awaited<ReturnType<typeof roomsApi.messages>>
const detail = { room: { id: 'room-a', project_id: 'project-a', project_folder_id: null }, viewer_can_write: false, agent_members: [] } as unknown as RoomDetail
const msg = (sessionId: string, id: string, content: string): RoomMessage => ({
  space_id: 'space-a', id, session_id: sessionId, user_id: 'user', role: 'user', content, metadata_json: {}, created_at: '2026-11-25T00:00:00Z',
})
const page = (sessionId: string, items: RoomMessage[]): Page => ({
  items, conversation: { id: sessionId } as Page['conversation'], task_group_ids: [], limit: 50, offset: 0,
})

/** Each conversation answers its full-page reads and its one-message probe from queues the test controls. */
function serve() {
  const full = new Map<string, Array<Promise<Page>>>()
  const probe = new Map<string, Array<Promise<Page>>>()
  vi.mocked(roomsApi.messages).mockImplementation(((_room: string, sessionId: string, params: { limit?: number } = {}) => {
    const queue = (params.limit === 1 ? probe : full).get(sessionId) ?? []
    return queue.shift() ?? new Promise<Page>(() => {})
  }) as typeof roomsApi.messages)
  const push = (target: Map<string, Array<Promise<Page>>>) => (sessionId: string, value: Promise<Page>) => {
    target.set(sessionId, [...(target.get(sessionId) ?? []), value])
  }
  return { full: push(full), probe: push(probe) }
}

function Surface({ conversationId }: { conversationId: string }) {
  return <MemoryRouter><ConversationSurface roomId="room-a" conversationId={conversationId} spaceId="space-a" variant="panel" detail={detail} readOnly /></MemoryRouter>
}

async function visitOnce(api: ReturnType<typeof serve>, sessionId: string, items: RoomMessage[]) {
  api.full(sessionId, Promise.resolve(page(sessionId, items)))
  const view = render(<Surface conversationId={sessionId} />)
  expect(await screen.findByText(items[items.length - 1]!.content)).toBeVisible()
  view.unmount()
}

const probeCalls = () => vi.mocked(roomsApi.messages).mock.calls.filter(call => call[2]?.limit === 1)

beforeEach(() => { vi.clearAllMocks() })

describe('conversation latest-page cache on the surface', () => {
  it('spaces out foreground retries and warns once until a read succeeds', async () => {
    const api = serve()
    const error = vi.spyOn(toast, 'error').mockImplementation(() => 'test-toast')
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const disconnect = () => new TypeError('FetchEvent.respondWith received an error: Load failed')
    const refresh = async () => {
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    }
    try {
      api.full('c1', Promise.reject(disconnect()))
      render(<Surface conversationId="c1" />)
      await act(async () => {})
      expect(error).not.toHaveBeenCalled()
      for (let attempt = 0; attempt < 4; attempt++) {
        clock.mockReturnValue(attempt * 5000)
        api.full('c1', Promise.reject(disconnect()))
        await refresh()
        const calls = vi.mocked(roomsApi.messages).mock.calls.length
        clock.mockReturnValue(attempt * 5000 + 4999)
        await refresh()
        expect(roomsApi.messages).toHaveBeenCalledTimes(calls)
        expect(error).toHaveBeenCalledTimes(attempt < 2 ? 0 : 1)
      }
      expect(error).toHaveBeenCalledWith('Could not refresh this conversation. Retrying…')
      clock.mockReturnValue(20000)
      api.full('c1', Promise.resolve(page('c1', [msg('c1', 'm1', 'Recovered message')])))
      await refresh()
      expect(screen.getByText('Recovered message')).toBeVisible()
      clock.mockReturnValue(25000)
      api.full('c1', Promise.reject(disconnect()))
      await refresh()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
      error.mockRestore()
    }
  })

  it('shows a revisited conversation once a fresh scoped read confirms it, then replaces it with the full page', async () => {
    const api = serve()
    const held = msg('c1', 'm1', 'Held latest message')
    await visitOnce(api, 'c1', [held])
    const full = deferred<Page>()
    api.full('c1', full.promise)
    api.probe('c1', Promise.resolve(page('c1', [held])))
    render(<Surface conversationId="c1" />)
    expect(await screen.findByText('Held latest message')).toBeVisible()
    expect(probeCalls()).toEqual([['room-a', 'c1', { limit: 1, offset: 0 }, expect.objectContaining({ spaceId: 'space-a' })]])
    await act(async () => full.resolve(page('c1', [held, msg('c1', 'm2', 'Newer reply')])))
    expect(await screen.findByText('Newer reply')).toBeVisible()
  })

  it('never shows the cached copy before the probe answers, or when the newest message changed', async () => {
    const api = serve()
    await visitOnce(api, 'c1', [msg('c1', 'm1', 'Original text')])
    const probe = deferred<Page>()
    const full = deferred<Page>()
    api.probe('c1', probe.promise)
    api.full('c1', full.promise)
    render(<Surface conversationId="c1" />)
    await waitFor(() => expect(probeCalls()).toHaveLength(1))
    expect(screen.queryByText('Original text')).not.toBeInTheDocument()
    await act(async () => probe.resolve(page('c1', [msg('c1', 'm1', 'Edited text')])))
    expect(screen.queryByText('Original text')).not.toBeInTheDocument()
    expect(conversationPageCacheStats().entries).toBe(0)
    await act(async () => full.resolve(page('c1', [msg('c1', 'm1', 'Edited text')])))
    expect(await screen.findByText('Edited text')).toBeVisible()
  })

  it('drops the cache and shows nothing cached when the scoped read is refused', async () => {
    const api = serve()
    await visitOnce(api, 'c1', [msg('c1', 'm1', 'Revoked content')])
    api.probe('c1', Promise.reject(new ApiRequestError('Room conversation not found', 404)))
    api.full('c1', Promise.reject(new ApiRequestError('Room conversation not found', 404)))
    render(<Surface conversationId="c1" />)
    await waitFor(() => expect(conversationPageCacheStats().entries).toBe(0))
    expect(screen.queryByText('Revoked content')).not.toBeInTheDocument()
  })

  it('withdraws a cached page when the full read is refused after the probe passed', async () => {
    const api = serve()
    const held = msg('c1', 'm1', 'Briefly authorized')
    await visitOnce(api, 'c1', [held])
    const full = deferred<Page>()
    api.probe('c1', Promise.resolve(page('c1', [held])))
    api.full('c1', full.promise)
    render(<Surface conversationId="c1" />)
    expect(await screen.findByText('Briefly authorized')).toBeVisible()
    await act(async () => full.reject(new ApiRequestError('Room conversation not found', 404)))
    await waitFor(() => expect(screen.queryByText('Briefly authorized')).not.toBeInTheDocument())
    expect(conversationPageCacheStats().entries).toBe(0)
  })

  it('keeps conversations apart while switching A → B → A', async () => {
    const api = serve()
    const a = msg('c1', 'a1', 'Thread A message')
    const b = msg('c2', 'b1', 'Thread B message')
    await visitOnce(api, 'c1', [a])
    await visitOnce(api, 'c2', [b])
    api.probe('c1', Promise.resolve(page('c1', [a])))
    const view = render(<Surface conversationId="c1" />)
    expect(await screen.findByText('Thread A message')).toBeVisible()
    api.probe('c2', Promise.resolve(page('c2', [b])))
    view.rerender(<Surface conversationId="c2" />)
    expect(await screen.findByText('Thread B message')).toBeVisible()
    expect(screen.queryByText('Thread A message')).not.toBeInTheDocument()
    api.probe('c1', Promise.resolve(page('c1', [a])))
    view.rerender(<Surface conversationId="c1" />)
    expect(await screen.findByText('Thread A message')).toBeVisible()
    expect(screen.queryByText('Thread B message')).not.toBeInTheDocument()
  })

  it('stores and shows nothing from a read that was in flight across logout', async () => {
    const api = serve()
    const held = msg('c1', 'm1', 'Before logout')
    await visitOnce(api, 'c1', [held])
    const probe = deferred<Page>()
    const full = deferred<Page>()
    api.probe('c1', probe.promise)
    api.full('c1', full.promise)
    render(<Surface conversationId="c1" />)
    await waitFor(() => expect(probeCalls()).toHaveLength(1))
    act(() => clearSessionResidue())
    await act(async () => probe.resolve(page('c1', [held])))
    expect(screen.queryByText('Before logout')).not.toBeInTheDocument()
    await act(async () => full.resolve(page('c1', [held])))
    expect(screen.queryByText('Before logout')).not.toBeInTheDocument()
    expect(conversationPageCacheStats().entries).toBe(0)
  })
})
