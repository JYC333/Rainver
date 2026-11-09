import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostsApi } from '../../api/client'
import { ConversationScope } from '../conversation/ConversationScope'
import { run, deferred } from '../agent_work/fixtures.test-support'
import { RuntimeFailureNotice } from './RuntimeFailureNotice'
import { runtimeFailure } from './runtimeFailure'

vi.mock('../../api/client', () => ({ hostsApi: { list: vi.fn() } }))
vi.mock('../../core/spaceNav', () => ({ SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }))
const target = { host_id: 'host-a', runtime_key: 'claude_code', installation: 'managed:0.101.0', backend_mode: 'runtime_native' }
const failure = () => run({ id: 'failed-run', space_id: 'source-space', status: 'failed', error_message: 'Internal error: failed to authenticate',
  error_json: { error_code: 'runtime_auth_required', runtime_target: target, runtime_failure: {
    category: 'auth', message: 'failed to authenticate', rpc_code: -32603, vendor_code: 'authentication_failed',
    occurred_at: '2026-11-05T21:00:00Z', resets_at: null, phase: 'prompt', phase_elapsed_ms: 1400,
  } } })
const host = (logged_in: boolean | null, status = 'online') => ({ id: target.host_id, name: 'Desk', status,
  last_heartbeat_at: '2026-11-05T21:05:00Z', capabilities_json: { installations: { claude_code: [{ id: target.installation, logged_in }] } } })
function show(value = failure()) {
  return render(<MemoryRouter><ConversationScope spaceId="source-space"><RuntimeFailureNotice run={value} /></ConversationScope></MemoryRouter>)
}
beforeEach(() => vi.mocked(hostsApi.list).mockReset())

describe('runtime recovery guidance', () => {
  it('links the exact Host and installation from the source Space without starting login or a probe', () => {
    show()
    const href = screen.getByRole('link', { name: 'Go to login' }).getAttribute('href')!
    const url = new URL(href, 'https://example.test')
    expect(url.pathname).toBe('/spaces/source-space/command-center')
    expect(Object.fromEntries(url.searchParams)).toEqual({ host: 'host-a', section: 'runtime', runtime: 'claude_code', installation: 'managed:0.101.0' })
    expect(screen.getByText('Failed during request execution.')).toBeInTheDocument()
    expect(hostsApi.list).not.toHaveBeenCalled()
  })

  it.each([true, false, null])('reads the Host report explicitly for login state %s and never retries the request', async loggedIn => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [host(loggedIn)] } as never)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    await waitFor(() => expect(hostsApi.list).toHaveBeenCalledOnce())
    expect(vi.mocked(hostsApi.list).mock.calls[0][0]).toMatchObject({ spaceId: 'source-space', signal: expect.any(AbortSignal) })
    expect(await screen.findByRole('status')).toHaveTextContent(loggedIn === true ? 'reports this copy as signed in' : loggedIn === false ? 'reports this copy as signed out' : 'has not confirmed')
    expect(screen.getByRole('status')).toHaveTextContent('Host report:')
  })

  it('shows missing access and missing copies without substituting another Host or version', async () => {
    vi.mocked(hostsApi.list).mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ ...host(true), capabilities_json: { installations: { claude_code: [{ id: 'own', logged_in: true }] } } }] } as never)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    expect(await screen.findByRole('status')).toHaveTextContent('not available to your account')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('exact runtime installation is no longer reported'))
  })

  it('keeps refresh failures visible and reports an offline Host after a later successful read', async () => {
    vi.mocked(hostsApi.list).mockRejectedValueOnce(new Error('Connection unavailable'))
      .mockResolvedValueOnce({ items: [host(true, 'offline')] } as never)
    show()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Desk is not online')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('aborts a report read when the Run changes and ignores its late result', async () => {
    const pending = deferred<Awaited<ReturnType<typeof hostsApi.list>>>()
    vi.mocked(hostsApi.list).mockReturnValueOnce(pending.promise)
    const view = show()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    const signal = vi.mocked(hostsApi.list).mock.calls[0][0]!.signal!
    view.rerender(<MemoryRouter><ConversationScope spaceId="source-space"><RuntimeFailureNotice run={run({ id: 'other-run' })} /></ConversationScope></MemoryRouter>)
    expect(signal.aborted).toBe(true)
    await act(async () => { pending.resolve({ items: [host(true)] } as never); await pending.promise })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps provider authentication separate from the Host native login lane and its report', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [host(false)] } as never)
    const value = failure()
    value.error_json!.runtime_target = { ...target, backend_mode: 'model_provider' }
    show(value)
    expect(screen.queryByRole('link', { name: 'Go to login' })).toBeNull()
    expect(screen.getByText('The model provider rejected authentication')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    expect(await screen.findByRole('status')).toHaveTextContent('does not verify its credentials')
    expect(screen.getByRole('status')).not.toHaveTextContent('Open its login controls')
  })

  it.each(['runtime_nonzero_exit', 'runtime_timeout', 'runtime_session_invalid'])(
    'uses typed configuration evidence under a generic exit but preserves the specific %s outcome', code => {
      const value = failure()
      value.error_json!.error_code = code
      value.error_json!.runtime_failure = { ...(value.error_json!.runtime_failure as object), category: 'configuration', vendor_code: 'model_not_found' }
      expect(runtimeFailure(value)?.cause).toBe(code === 'runtime_nonzero_exit' ? 'configuration' : code === 'runtime_timeout' ? 'timeout' : 'session_invalid')
    },
  )

  it('does not turn a signed-out CLI report into login advice for a timeout', async () => {
    vi.mocked(hostsApi.list).mockResolvedValue({ items: [host(false)] } as never)
    const value = failure()
    value.error_json!.error_code = 'runtime_timeout'
    show(value)
    expect(screen.queryByRole('link', { name: 'Go to login' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Host status' }))
    expect(await screen.findByRole('status')).toHaveTextContent('reports this copy as signed out')
    expect(screen.getByRole('status')).not.toHaveTextContent('Open its login controls')
  })

  it('keeps unknown failures unknown and withholds guidance for summary-only or non-runtime outcomes', () => {
    expect(runtimeFailure(run({ status: 'failed', error_json: null }))).toBeNull()
    expect(runtimeFailure(run({ status: 'failed', execution_kind: 'provider_task', error_json: failure().error_json }))).toBeNull()
    expect(runtimeFailure(run({ status: 'failed', error_json: { error_code: 'verification_failed' } }))).toBeNull()
    expect(runtimeFailure(run({ status: 'failed', error_json: { error_code: 'runtime_nonzero_exit' }, error_message: 'usage limit or auth?' }))?.cause).toBe('unknown')
  })
});
