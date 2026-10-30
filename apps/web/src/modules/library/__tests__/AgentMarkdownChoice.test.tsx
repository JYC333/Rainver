import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ showAgentTextAsMarkdown: vi.fn() }))
vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return { ApiRequestError: actual.ApiRequestError, sourcesApi: api }
})
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import { ApiRequestError } from '../../../api/client'
import { clearSessionResidue } from '../../../lib/sessionResidue'
import { AgentMarkdownChoice } from '../AgentMarkdownChoice'

const shownA = { artifact_id: 'art-a', source_snapshot_id: null }
const shownB = { artifact_id: 'art-b', source_snapshot_id: null }
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const view = (reload: () => Promise<'shown' | 'superseded' | 'denied'>, shown = shownA, itemId = 'item-1') =>
  <AgentMarkdownChoice itemId={itemId} spaceId="space-1" syntax="undeclared" shown={shown} reload={reload} />

async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Show as Markdown' }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Show as Markdown' }))
}

beforeEach(() => { api.showAgentTextAsMarkdown.mockReset(); toasts.success.mockReset(); toasts.error.mockReset() })

describe('a reply belongs to the Reader that asked', () => {
  it('after the Reader is gone: no reload, no message', async () => {
    const reply = deferred<unknown>()
    api.showAgentTextAsMarkdown.mockReturnValue(reply.promise)
    const reload = vi.fn(async () => 'shown' as const)
    const { unmount } = render(view(reload))
    await confirm()
    unmount()
    await act(async () => reply.resolve({ artifact_id: 'new' }))
    expect(reload).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('after moving to another version and back (A→B→A): the old reply changes nothing', async () => {
    const reply = deferred<unknown>()
    api.showAgentTextAsMarkdown.mockReturnValue(reply.promise)
    const reload = vi.fn(async () => 'shown' as const)
    const { rerender } = render(view(reload))
    await confirm()
    rerender(view(reload, shownB))
    rerender(view(reload, shownA))
    await act(async () => reply.resolve({ artifact_id: 'new' }))
    expect(reload).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    // The current run is not left busy.
    expect(screen.getByRole('button', { name: 'Show as Markdown' })).toBeEnabled()
  })

  it('after logout: no reload, no message, also for a failure', async () => {
    const ok = deferred<unknown>()
    api.showAgentTextAsMarkdown.mockReturnValueOnce(ok.promise)
    const reload = vi.fn(async () => 'shown' as const)
    render(view(reload))
    await confirm()
    act(() => clearSessionResidue())
    await act(async () => ok.resolve({ artifact_id: 'new' }))
    expect(reload).not.toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('says it was saved but could not be reloaded when the reload fails, not that it failed', async () => {
    api.showAgentTextAsMarkdown.mockResolvedValue({ artifact_id: 'new' })
    render(view(async () => { throw new Error('offline') }))
    await confirm()
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Saved as Markdown in a new version, but the text could not be reloaded; open it again.'))
    expect(toasts.success).not.toHaveBeenCalled()
  })

  it('shows the current text again when the version shown changed meanwhile, without converting anything', async () => {
    api.showAgentTextAsMarkdown.mockRejectedValue(new ApiRequestError('The text was updated', 409, 'reading_version_changed'))
    const reload = vi.fn(async () => 'shown' as const)
    render(view(reload))
    await confirm()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(toasts.error).toHaveBeenCalledWith('The text was updated; the current version is shown. Look at it before choosing again.')
    expect(api.showAgentTextAsMarkdown).toHaveBeenCalledWith('item-1', shownA, { spaceId: 'space-1' })
  })
})
