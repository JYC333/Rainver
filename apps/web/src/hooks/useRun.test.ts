import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runsApi } from '../api/client'
import { useRun } from './useRun'

vi.mock('../api/client', () => ({ runsApi: { get: vi.fn(), status: vi.fn() } }))

const running = { id: 'run-1', status: 'running', mode: 'managed', run_type: 'agent', trigger_origin: 'manual', started_at: null, ended_at: null, error_message: null }

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useRun', () => {
  it('keeps the Run and keeps polling through a status read that fails once', async () => {
    vi.useFakeTimers()
    vi.mocked(runsApi.get).mockResolvedValue(running as never)
    vi.mocked(runsApi.status)
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue({ ...running, status: 'succeeded' } as never)
    const { result } = renderHook(() => useRun('run-1'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.run?.status).toBe('running')

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.error).toBeNull()
    expect(result.current.run?.status).toBe('running')

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.run?.status).toBe('succeeded')
  })

  it('stops and reports when the Run is no longer there', async () => {
    vi.useFakeTimers()
    vi.mocked(runsApi.get).mockResolvedValue(running as never)
    vi.mocked(runsApi.status).mockRejectedValue(new Error('404 Not Found'))
    const { result } = renderHook(() => useRun('run-1'))
    await act(() => vi.advanceTimersByTimeAsync(0))

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.error).toContain('404')
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(runsApi.status).toHaveBeenCalledTimes(1)
  })
})
