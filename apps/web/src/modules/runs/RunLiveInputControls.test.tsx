import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runsApi } from '../../api/client'
import { run, deferred } from '../agent_work/fixtures.test-support'
import { RunLiveInputControls } from './RunLiveInputControls'

vi.mock('../../api/client', () => ({ runsApi: { liveInput: vi.fn(), sendLiveInput: vi.fn() } }))
const binding = '30000000-0000-4000-8000-000000000099'
const active = run({ status: 'running', session_id: 'conversation-a' })
const scope = { spaceId: 'space-a' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runsApi.liveInput).mockResolvedValue({ available: true, binding_id: binding })
})
async function compose() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add instruction' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Add instruction' }), { target: { value: 'Keep the cancellation behavior.' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send to running turn' })) })
}
describe('governed live input controls', () => {
  it('sends only on explicit submission, carrying the current physical binding and Space', async () => {
    vi.mocked(runsApi.sendLiveInput).mockResolvedValue({ state: 'injected', message_id: binding, delivery_id: binding })
    const changed = vi.fn()
    render(<RunLiveInputControls run={active} scope={scope} onChanged={changed} />)
    await screen.findByRole('button', { name: 'Add instruction' })
    expect(runsApi.sendLiveInput).not.toHaveBeenCalled()
    await compose()
    expect(await screen.findByRole('status')).toHaveTextContent('Delivered to the running turn.')
    expect(runsApi.sendLiveInput).toHaveBeenCalledExactlyOnceWith(active.id, { binding_id: binding, content: 'Keep the cancellation behavior.' }, scope)
    expect(changed).toHaveBeenCalledWith(active)
  })
  it.each(['not_injected', 'unconfirmed'] as const)('keeps a saved instruction visible without resending after %s', async state => {
    vi.mocked(runsApi.sendLiveInput).mockResolvedValue({ state, message_id: binding, delivery_id: binding })
    render(<RunLiveInputControls run={active} scope={scope} />)
    await compose()
    expect(await screen.findByRole('status')).toHaveTextContent(state === 'unconfirmed' ? 'delivery was not acknowledged' : 'was not delivered')
    expect(screen.getByRole('textbox')).toHaveValue('Keep the cancellation behavior.')
    expect(screen.getByRole('button', { name: 'Send to running turn' })).toBeDisabled()
    expect(runsApi.sendLiveInput).toHaveBeenCalledOnce()
  })
  it('retains the draft and the eventual receipt when the running turn ends during delivery', async () => {
    const pending = deferred<Awaited<ReturnType<typeof runsApi.sendLiveInput>>>()
    vi.mocked(runsApi.sendLiveInput).mockReturnValueOnce(pending.promise)
    const view = render(<RunLiveInputControls run={active} scope={scope} />)
    await compose()
    view.rerender(<RunLiveInputControls run={{ ...active, status: 'succeeded' }} scope={scope} />)
    expect(screen.getByRole('textbox')).toHaveValue('Keep the cancellation behavior.')
    await act(async () => pending.resolve({ state: 'not_injected', message_id: binding, delivery_id: binding }))
    expect(await screen.findByRole('status')).toHaveTextContent('was not delivered')
    expect(screen.getByRole('textbox')).toHaveValue('Keep the cancellation behavior.')
    expect(screen.getByRole('button', { name: 'Send to running turn' })).toBeDisabled()
    expect(runsApi.sendLiveInput).toHaveBeenCalledOnce()
  })
  it('aborts the old capability read and discards a late response after changing Space', async () => {
    const pending = deferred<Awaited<ReturnType<typeof runsApi.liveInput>>>()
    vi.mocked(runsApi.liveInput).mockReturnValueOnce(pending.promise).mockResolvedValue({ available: false, binding_id: null })
    const view = render(<RunLiveInputControls run={active} scope={scope} />)
    const signal = vi.mocked(runsApi.liveInput).mock.calls[0]![1]!.signal!
    view.rerender(<RunLiveInputControls run={{ ...active, space_id: 'space-b' }} scope={{ spaceId: 'space-b' }} />)
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve({ available: true, binding_id: binding }))
    await waitFor(() => expect(runsApi.liveInput).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('does not query an ended Run or display an unsupported capability', async () => {
    const view = render(<RunLiveInputControls run={{ ...active, status: 'succeeded' }} scope={scope} />)
    expect(runsApi.liveInput).not.toHaveBeenCalled()
    vi.mocked(runsApi.liveInput).mockResolvedValue({ available: false, binding_id: null })
    view.rerender(<RunLiveInputControls run={active} scope={scope} />)
    await waitFor(() => expect(runsApi.liveInput).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button')).toBeNull()
  })
})
