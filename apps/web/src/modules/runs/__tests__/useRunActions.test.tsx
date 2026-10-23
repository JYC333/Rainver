import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runsApi } from '../../../api/client'
import type { Run } from '../../../types/api'
import { useRunActions } from '../useRunActions'

vi.mock('../../../api/client', () => ({
  runsApi: { stop: vi.fn(), resume: vi.fn(), abandon: vi.fn(), get: vi.fn() },
  authorizationRequestsApi: { approve: vi.fn(), reject: vi.fn() },
}))
const canonical = { id: 'run-b', space_id: 'space-b', status: 'cancelled' } as Run
const scope = { spaceId: 'space-b' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runsApi.get).mockResolvedValue(canonical)
})
describe('shared Run actions', () => {
  it('removes panel listeners after a command completes normally', async () => {
    const panel = new AbortController()
    const remove = vi.spyOn(panel.signal, 'removeEventListener')
    const { result } = renderHook(() => useRunActions('run-b', { ...scope, signal: panel.signal }, vi.fn()))
    await act(async () => { expect(await result.current.perform({ kind: 'resume' })).toBe(true) })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(panel.signal.aborted).toBe(false)
    expect(result.current.busy).toBeNull()
  })
  it('stops only the named Run in the source Space and rereads before notifying its consumer', async () => {
    const changed = vi.fn()
    const { result } = renderHook(() => useRunActions('run-b', scope, changed))
    await act(async () => { expect(await result.current.perform({ kind: 'stop' })).toBe(true) })
    expect(runsApi.stop).toHaveBeenCalledExactlyOnceWith('run-b', expect.objectContaining({ spaceId: 'space-b', signal: expect.any(AbortSignal) }))
    expect(changed).toHaveBeenCalledExactlyOnceWith(canonical)
    expect(runsApi.get).toHaveBeenCalledWith('run-b', expect.objectContaining({ spaceId: 'space-b' }))
  })
  it('keeps supervisor resume and abandon on their owning Run endpoints', async () => {
    const { result } = renderHook(() => useRunActions('run-b', scope, vi.fn()))
    await act(async () => { await result.current.perform({ kind: 'resume' }) })
    await act(async () => { await result.current.perform({ kind: 'abandon', reason: 'No longer needed' }) })
    expect(runsApi.resume).toHaveBeenCalledWith('run-b', expect.objectContaining(scope))
    expect(runsApi.abandon).toHaveBeenCalledWith('run-b', { reason: 'No longer needed' }, expect.objectContaining(scope))
  })
  it('aborts an old command when changing Run/Space and ignores its late result', async () => {
    let finish!: () => void
    vi.mocked(runsApi.stop).mockReturnValue(new Promise(resolve => { finish = () => resolve({}) }))
    const changed = vi.fn()
    const { result, rerender } = renderHook(({ id, spaceId }) => useRunActions(id, { spaceId }, changed), { initialProps: { id: 'run-a', spaceId: 'space-a' } })
    let old!: Promise<boolean>
    act(() => { old = result.current.perform({ kind: 'stop' }) })
    const options = vi.mocked(runsApi.stop).mock.calls[0]![1]!
    rerender({ id: 'run-b', spaceId: 'space-b' })
    expect(options.signal!.aborted).toBe(true)
    await act(async () => { finish(); expect(await old).toBe(false) })
    expect(changed).not.toHaveBeenCalled()
    expect(runsApi.get).not.toHaveBeenCalled()
    expect(result.current.busy).toBeNull()
  })
  it('suppresses concurrent clicks and reports a failed command without marking work complete', async () => {
    let fail!: (error: Error) => void
    vi.mocked(runsApi.resume).mockReturnValue(new Promise((_resolve, reject) => { fail = reject }))
    const changed = vi.fn()
    const { result } = renderHook(() => useRunActions('run-b', scope, changed))
    let pending!: Promise<boolean>
    act(() => { pending = result.current.perform({ kind: 'resume' }) })
    await act(async () => { expect(await result.current.perform({ kind: 'stop' })).toBe(false); fail(new Error('Denied')); await pending })
    await waitFor(() => expect(result.current.error).toBe('Denied'))
    expect(runsApi.stop).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })
  it('treats an applied command as done when only the Run reread fails', async () => {
    vi.mocked(runsApi.get).mockRejectedValueOnce(new Error('Reread unavailable'))
    const changed = vi.fn()
    const { result } = renderHook(() => useRunActions('run-b', scope, changed))
    await act(async () => { expect(await result.current.perform({ kind: 'stop' })).toBe(true) })
    expect(result.current.error).toBeNull()
    expect(result.current.refreshError).toBe('Reread unavailable')
    expect(changed).not.toHaveBeenCalled()
    expect(result.current.busy).toBeNull()
    vi.mocked(runsApi.resume).mockResolvedValueOnce(undefined as never)
    await act(async () => { expect(await result.current.perform({ kind: 'resume' })).toBe(true) })
    expect(result.current.refreshError).toBeNull()
  })
})
