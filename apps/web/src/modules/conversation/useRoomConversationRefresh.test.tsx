import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { roomsApi } from '../../api/client'
import { useRoomConversationRefresh } from './useRoomConversationRefresh'

vi.mock('../../api/client', () => ({ roomsApi: { conversations: vi.fn() } }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('refreshes non-selected threads and discards an old Room response after switching', async () => {
  vi.useFakeTimers()
  let finish!: (value: never) => void
  vi.mocked(roomsApi.conversations).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const refreshed = vi.fn()
  const { rerender, unmount } = renderHook(({ id }) => useRoomConversationRefresh(id, refreshed), { initialProps: { id: 'old' } })
  await act(async () => { vi.advanceTimersByTime(5000) })
  rerender({ id: 'new' })
  await act(async () => { finish({ items: [{ id: 'old-thread' }], total: 1 } as never) })
  expect(refreshed).not.toHaveBeenCalled()
  vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [
    { id: 'empty', created_at: '2026-01-02T00:00:00Z' },
    { id: 'active', created_at: '2026-01-01T00:00:00Z', last_message_at: '2026-01-03T00:00:00Z', is_running: true },
  ], total: 2 } as never)
  await act(async () => { vi.advanceTimersByTime(5000) })
  expect(refreshed.mock.calls[0][0].map((item: { id: string }) => item.id)).toEqual(['active', 'empty'])
  unmount()
})
