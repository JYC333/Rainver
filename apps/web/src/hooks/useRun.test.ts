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
    vi.mocked(runsApi.get)
      .mockResolvedValueOnce(running as never)
      .mockResolvedValue({ ...running, status: 'succeeded' } as never)
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

  it('follows dependency and review pauses through to the complete terminal detail', async () => {
    vi.useFakeTimers()
    const fail = { ...running, status: 'orphaned', error_json: { code: 'host_disconnected' } }
    vi.mocked(runsApi.get)
      .mockResolvedValueOnce({ ...running, status: 'waiting_for_dependency' } as never)
      .mockResolvedValueOnce({ ...running, status: 'waiting_for_review' } as never)
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue(fail as never)
    vi.mocked(runsApi.status)
      .mockResolvedValueOnce({ ...running, status: 'waiting_for_review' } as never)
      .mockResolvedValue(fail as never)
    const { result } = renderHook(() => useRun('run-1'))
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.run?.status).toBe('waiting_for_review')
    await act(() => vi.advanceTimersByTimeAsync(4000))
    expect(result.current.run).toEqual(fail)
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(runsApi.status).toHaveBeenCalledTimes(3)
  })

  it('stops and reports when the Run is no longer there', async () => {
    vi.useFakeTimers()
    vi.mocked(runsApi.get).mockResolvedValue(running as never)
    vi.mocked(runsApi.status).mockRejectedValue(new Error('404 Not Found'))
    const { result } = renderHook(() => useRun('run-1'))
    await act(() => vi.advanceTimersByTimeAsync(0))

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.error).toContain('404')
    expect(result.current.run).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(6000))
    expect(runsApi.status).toHaveBeenCalledTimes(1)
  })

  it('replaces full details with the server summary when access changes at the same status', async () => {
    vi.useFakeTimers()
    const full = { ...running, effective_access_level: 'full', error_message: 'Restricted failure' }
    const summary = { ...running, effective_access_level: 'summary' }
    vi.mocked(runsApi.get).mockResolvedValueOnce(full as never).mockResolvedValueOnce(summary as never)
    vi.mocked(runsApi.status).mockResolvedValue(summary as never)
    const { result } = renderHook(() => useRun('run-1'))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.run?.error_message).toBe('Restricted failure')
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(result.current.run).toEqual(summary)
  })
})
