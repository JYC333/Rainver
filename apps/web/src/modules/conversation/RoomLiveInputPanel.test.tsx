import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runsApi } from '../../api/client'
import { RoomLiveInputChoice, RoomLiveInputStatus, type RoomLiveDelivery } from './RoomLiveInputPanel'

vi.mock('../../api/client', () => ({ runsApi: { liveInputOutcome: vi.fn() } }))
const scope = { spaceId: 'space-a' }

function Deliveries({ initial, onResend }: { initial: RoomLiveDelivery[]; onResend: (messageId: string) => Promise<void> }) {
  const [items, setItems] = useState(initial)
  return <RoomLiveInputStatus deliveries={items} scope={scope} onResend={onResend}
    onState={(messageId, state) => setItems(current => current.map(item => item.message_id === messageId ? { ...item, state } : item))}
    onDismiss={messageId => setItems(current => current.filter(item => item.message_id !== messageId))} />
}

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ordinary send into an active Run', () => {
  it('names each candidate Run and never picks one for the person', () => {
    const choose = vi.fn(), ordinary = vi.fn()
    render(<RoomLiveInputChoice disabled={false} onChoose={choose} onOrdinary={ordinary} onDismiss={vi.fn()} candidates={[
      { run_id: 'run-a', agent_id: 'agent', agent_name: 'Codex', status: 'running', delivery: 'live', delegated: true, started_at: null },
      { run_id: 'run-b', agent_id: 'agent', agent_name: 'Codex', status: 'waiting_for_dependency', delivery: 'with_results', delegated: false, started_at: null },
    ]} />)
    expect(choose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Codex · waiting for results' }))
    expect(choose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ run_id: 'run-b' }))
    expect(screen.getByRole('button', { name: 'Codex · running now · delegated' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send as a new message' }))
    expect(ordinary).toHaveBeenCalledOnce()
  })

  it('tells apart Runs that would read alike, by start time and then by place when even that repeats', () => {
    const run = (run_id: string, started_at: string | null) => ({ run_id, agent_id: 'agent', agent_name: 'Codex', status: 'running' as const, delivery: 'live' as const, delegated: true, started_at })
    const at = '2026-11-23T10:00:00.000Z', later = '2026-11-23T10:05:00.000Z'
    render(<RoomLiveInputChoice disabled={false} onChoose={vi.fn()} onOrdinary={vi.fn()} onDismiss={vi.fn()}
      candidates={[run('run-a', at), run('run-b', at), run('run-c', later), run('run-d', null)]} />)
    const names = screen.getAllByRole('button').map(button => button.textContent ?? '').filter(name => name.startsWith('Codex'))
    expect(new Set(names).size).toBe(4)
    expect(names[0]).toContain(new Date(at).toLocaleString('en'))
    expect(names[0]).toMatch(/#1$/)
    expect(names[1]).toMatch(/#2$/)
    expect(names[2]).toContain(new Date(later).toLocaleString('en'))
    expect(names[2]).not.toMatch(/#\d$/)
    expect(names[3]).toBe('Codex · running now · delegated')
  })

  it('says a chosen Run can no longer take the message and offers what still can', () => {
    render(<RoomLiveInputChoice unavailable disabled={false} onChoose={vi.fn()} onOrdinary={vi.fn()} onDismiss={vi.fn()} candidates={[
      { run_id: 'run-b', agent_id: 'agent', agent_name: 'Codex', status: 'waiting_for_dependency', delivery: 'with_results', delegated: false, started_at: null },
    ]} />)
    expect(screen.getByRole('group')).toHaveTextContent('The run you chose can no longer take this message. Nothing was sent. Choose again, or send it as a new message.')
    expect(screen.getByRole('button', { name: 'Codex · waiting for results' })).toBeEnabled()
  })

  it('stops reading a status it repeatedly cannot read, and lets the person dismiss it', async () => {
    vi.mocked(runsApi.liveInputOutcome).mockRejectedValue(new Error('offline'))
    render(<Deliveries onResend={vi.fn()} initial={[{ message_id: 'm', run_id: 'run', agent_name: 'Manager', state: 'pending', excerpt: 'Also check it' }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('Also check it')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(runsApi.liveInputOutcome).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(screen.getByRole('status')).toHaveTextContent('The delivery status for Manager cannot be read right now.')
    const calls = vi.mocked(runsApi.liveInputOutcome).mock.calls.length
    expect(calls).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(runsApi.liveInputOutcome).toHaveBeenCalledTimes(calls)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reads an owed delivery until the Run records its outcome, and stops reading then', async () => {
    vi.mocked(runsApi.liveInputOutcome).mockResolvedValueOnce('deferred').mockResolvedValue('delivered_with_results')
    render(<Deliveries onResend={vi.fn()} initial={[{ message_id: 'm', run_id: 'run', agent_name: 'Manager', state: 'deferred' }]} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved for Manager. It is delivered with the results it is waiting for.')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByRole('status')).toHaveTextContent('Delivered to Manager with the results it was waiting for.')
    expect(runsApi.liveInputOutcome).toHaveBeenCalledWith('run', 'm', expect.objectContaining({ spaceId: 'space-a' }))
    const calls = vi.mocked(runsApi.liveInputOutcome).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(9000) })
    expect(runsApi.liveInputOutcome).toHaveBeenCalledTimes(calls)
  })

  it('offers a new message only when the addition was definitely not delivered', async () => {
    const resend = vi.fn(async () => undefined)
    render(<Deliveries onResend={resend} initial={[
      { message_id: 'lost', run_id: 'run', agent_name: 'Codex', state: 'not_injected' },
      { message_id: 'maybe', run_id: 'run', agent_name: 'Codex', state: 'unconfirmed' },
    ]} />)
    expect(screen.getByTestId('live-input-maybe')).toHaveTextContent('It is not sent again; check the reply first.')
    expect(screen.getByTestId('live-input-maybe').querySelector('button[aria-label="Dismiss"]')).not.toBeNull()
    const offers = screen.getAllByRole('button', { name: 'Send as a new message' })
    expect(offers).toHaveLength(1)
    await act(async () => { fireEvent.click(offers[0]!) })
    expect(resend).toHaveBeenCalledExactlyOnceWith('lost')
    expect(runsApi.liveInputOutcome).not.toHaveBeenCalled()
  })
})
