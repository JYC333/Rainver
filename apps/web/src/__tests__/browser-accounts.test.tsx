import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { __resetAccountChangeForTests, AuthProvider, useAuth } from '../contexts/AuthContext'
import { ApiRequestError, authApi } from '../api/client'
import { authApi as realAuthApi } from '../api/identity'
import { artifactsApi } from '../api/artifacts'
import { conversationInputApi } from '../api/conversation'
import { ordinaryToolsApi } from '../api/hosts'
import { __resetAccountStreamsForTests, ACCOUNT_SWITCHED_EVENT, accountFetch, accountHeaders, request, setAccountHandle } from '../api/transport'
import { failureKind } from '../modules/agent_work/attentionStore'
import { __resetLogoutChannelForTests, registerInMemoryResidue, rememberAccountAddOrigin, rememberSignInPending } from '../lib/sessionResidue'

vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  authApi: {
    me: vi.fn(),
    logout: vi.fn().mockResolvedValue(null),
    switchAccount: vi.fn().mockResolvedValue({ ok: true, account_handle: 'session-b' }),
    addPasswordAccount: vi.fn().mockResolvedValue({ user: {} }),
  },
}))

const ada = { id: 'u1', display_name: 'Ada', email: 'ada@example.test', avatar_url: null, default_space_id: 'personal-1', created_at: '', last_login_at: null, account_handle: 'session-a' }
let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  vi.mocked(authApi.me).mockResolvedValue(ada)
})
afterEach(() => {
  setAccountHandle(null)
  __resetAccountChangeForTests()
  __resetAccountStreamsForTests()
  __resetLogoutChannelForTests()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

function Probe() {
  const { currentUser, switchAccount, addPasswordAccount } = useAuth()
  return (
    <div>
      <span>{currentUser ? currentUser.display_name : 'nobody'}</span>
      <button type="button" onClick={() => { void switchAccount('u2') }}>switch</button>
      <button type="button" onClick={() => { void addPasswordAccount({ email: 'b@example.test', password: 'p', rememberMe: false }).catch(() => {}) }}>add</button>
    </div>
  )
}

describe('a tab names the browser account it was loaded for', () => {
  it('sends the handle with every request and reports a refusal as an account switch', async () => {
    setAccountHandle('session-a')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'account_switched', message: 'switched' }), {
      status: 409, headers: { 'Content-Type': 'application/json', 'x-rainver-account-switched': '1' },
    }))
    vi.stubGlobal('fetch', fetch)
    const heard = vi.fn()
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, heard)
    await expect(request('POST', '/notes', { title: 'x' })).rejects.toMatchObject({ status: 409, code: 'account_switched' })
    window.removeEventListener(ACCOUNT_SWITCHED_EVENT, heard)
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Rainver-Account': 'session-a' })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('reloads instead of acting as the new account when its request is refused as stale', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    act(() => { window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT)) })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads when another tab switches the browser to another account', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    const other = new BroadcastChannel('rainver:auth')
    other.postMessage('account-changed')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    other.close()
  })

  it('switches, tells the other tabs and reloads; a refused addition changes nothing', async () => {
    const heard = vi.fn()
    const other = new BroadcastChannel('rainver:auth')
    // What a tab reloading on the message would read: the previous person's storage is already gone.
    other.addEventListener('message', event => heard(event.data, localStorage.getItem('rainver:notes-last')))
    localStorage.setItem('rainver:notes-last', 'note-of-ada')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')

    vi.mocked(authApi.addPasswordAccount).mockRejectedValueOnce(new Error('invalid'))
    await act(async () => screen.getByRole('button', { name: 'add' }).click())
    expect(reload).not.toHaveBeenCalled()
    expect(screen.getByText('Ada')).toBeVisible()

    await act(async () => screen.getByRole('button', { name: 'switch' }).click())
    expect(authApi.switchAccount).toHaveBeenCalledWith('u2')
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('account-changed', null))
    expect(reload).toHaveBeenCalledTimes(1)
    other.close()
  })

  it('announces an account added through Google once it returns as someone else', async () => {
    rememberAccountAddOrigin('session-a')
    vi.mocked(authApi.me).mockResolvedValueOnce({ ...ada, id: 'u2', display_name: 'Ben', account_handle: 'session-b' })
    render(<AuthProvider><Probe /></AuthProvider>)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('keeps the original account when adding through Google was cancelled', async () => {
    rememberAccountAddOrigin('session-a')
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps the old handle while it leaves, and drops only this tab\'s storage, memory and streams', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    sessionStorage.setItem('rainver:conversation-draft:v1:room-1', 'an unsent draft of Ada')
    localStorage.setItem('rainver:theme', 'dark')
    localStorage.setItem('rainver:next-person-state', 'written by the tab that switched')
    const dropped = vi.fn()
    const stop = registerInMemoryResidue(dropped)
    let streamSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      streamSignal = init?.signal ?? undefined
      return new Response(null, { status: 204 })
    }))
    await accountFetch('/api/v1/me/agent-attention/stream')

    const other = new BroadcastChannel('rainver:auth')
    other.postMessage('account-changed')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    other.close()
    stop()

    expect(sessionStorage.getItem('rainver:conversation-draft:v1:room-1')).toBeNull()
    expect(dropped).toHaveBeenCalledTimes(1)
    expect(streamSignal?.aborted).toBe(true)
    await expect(accountFetch('/api/v1/projects/p/updates/stream')).rejects.toMatchObject({ status: 409, code: 'account_switched' })
    // Shared storage is the switching tab's to clear; clearing it here could erase the next person's.
    expect(localStorage.getItem('rainver:next-person-state')).toBe('written by the tab that switched')
    // A keepalive write sent while unloading still names Ada, so the server refuses it rather than writing as the new account.
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-a' })
    const write = vi.fn(async () => new Response('{}', { status: 409, headers: { 'Content-Type': 'application/json', 'x-rainver-account-switched': '1' } }))
    vi.stubGlobal('fetch', write)
    await expect(request('PUT', '/reader/documents/d/position', { offset: 1 }, { keepalive: true })).rejects.toMatchObject({ status: 409 })
    expect((write.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Rainver-Account': 'session-a' })
    // After a cancelled unload the page stays refused; it does not ask to leave on every request.
    act(() => { window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT)) })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reports a refusal as an account switch on an upload, a download and a tool account stream', async () => {
    setAccountHandle('session-a')
    const heard = vi.fn()
    window.addEventListener(ACCOUNT_SWITCHED_EVENT, heard)
    const refused = () => new Response('{"code":"account_switched"}', { status: 409, headers: { 'Content-Type': 'application/json', 'x-rainver-account-switched': '1' } })
    vi.stubGlobal('fetch', vi.fn(async () => refused()))
    await expect(artifactsApi.export('artifact-1')).rejects.toMatchObject({ status: 409 })
    await expect(ordinaryToolsApi.sessionStream('host-1', 'tool-1', 'login').next()).rejects.toMatchObject({ status: 409 })

    const sentHeaders: Record<string, string> = {}
    class RefusingXhr {
      status = 0; statusText = ''; responseText = ''; withCredentials = false
      upload = { onprogress: null }
      onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null
      open() {}
      setRequestHeader(name: string, value: string) { sentHeaders[name] = value }
      getResponseHeader(name: string) { return name.toLowerCase() === 'x-rainver-account-switched' ? '1' : null }
      addEventListener() {}
      send() { this.status = 409; this.responseText = '{"code":"account_switched"}'; this.onload?.() }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', RefusingXhr)
    await expect(conversationInputApi.uploadImage(new File(['x'], 'x.png', { type: 'image/png' }))).rejects.toMatchObject({ status: 409 })
    window.removeEventListener(ACCOUNT_SWITCHED_EVENT, heard)
    expect(sentHeaders['X-Rainver-Account']).toBe('session-a')
    expect(heard).toHaveBeenCalledTimes(3)
    // An attention stream refused this way stops instead of reading a snapshot as anyone.
    expect(failureKind(new ApiRequestError('switched', 409, 'account_switched'))).toBe('denied')
  })

  it('adopts the rotated handle from its own password change', async () => {
    setAccountHandle('session-a')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, account_handle: 'session-a2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await realAuthApi.changePassword({ current_password: 'old', new_password: 'new' })
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-a2' })
  })

  it('stays signed out when its password change answers after a sign-out, without signing the browser out again', async () => {
    // The server's side: cookies a late response writes back, and the stale-tab check against them.
    let selected = 'session-a'
    let answerChange: (() => void) | null = null
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const named = (init.headers as Record<string, string>)['X-Rainver-Account']
      if (!url.endsWith('/auth/logout') && named !== undefined && named !== selected) {
        return new Response(JSON.stringify({ code: 'account_switched', message: 'switched' }), { status: 409, headers: { 'Content-Type': 'application/json', 'x-rainver-account-switched': '1' } })
      }
      if (url.endsWith('/auth/password/change')) {
        await new Promise<void>(resolve => { answerChange = resolve })
        selected = 'session-a2'
        return new Response(JSON.stringify({ ok: true, account_handle: 'session-a2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/auth/logout')) { selected = '-'; return new Response(null, { status: 204 }) }
      if (url.endsWith('/auth/sign-in/email')) { selected = 'session-b'; return new Response(JSON.stringify({ user: {}, account_handle: 'session-b' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const logouts = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/auth/logout')).length
    setAccountHandle('session-a')
    const changing = realAuthApi.changePassword({ current_password: 'old', new_password: 'new' })
    await vi.waitFor(() => expect(answerChange).not.toBeNull())
    await realAuthApi.logout()
    expect(logouts()).toBe(1)
    answerChange!()
    await expect(changing).rejects.toMatchObject({ code: 'signed_out' })
    // Not adopted: the tab still names no account. The server undoes the written-back selection on the next request.
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': '-' })
    selected = '-'
    await realAuthApi.passwordLogin({ email: 'b@example.test', password: 'p', rememberMe: true })
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-b' })
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/auth/sign-in/email'))).toBe(true)
    // Never a second sign-out: it would sign out any account signed in since.
    expect(logouts()).toBe(1)
  })

  it('clears the shared storage, then tells the other tabs, when a public page signs in, also on the return from Google', async () => {
    const heard = vi.fn()
    const other = new BroadcastChannel('rainver:auth')
    // What a tab reloading on the message would read: the previous person's storage is already gone.
    other.addEventListener('message', event => heard(event.data, localStorage.getItem('rainver:notes-last')))
    const cleared = vi.fn(async () => true)
    vi.stubGlobal('caches', { delete: cleared })
    localStorage.setItem('rainver:notes-last', 'note-of-ada')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: {}, account_handle: 'session-b' }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await realAuthApi.passwordLogin({ email: 'b@example.test', password: 'p', rememberMe: true })
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('account-changed', null))
    expect(cleared).toHaveBeenCalled()
    // The tab that signed in acts as the new session from its next request.
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-b' })
    heard.mockClear()
    cleared.mockClear()

    localStorage.setItem('rainver:notes-last', 'note-of-ada')
    rememberSignInPending()
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith('account-changed', null))
    expect(cleared).toHaveBeenCalled()
    other.close()
  })

  it('signs in again from the page it signed out on, and is still refused once another tab signs in first', async () => {
    // The server's side of the stale-tab check: a request naming an account other than the browser's is refused.
    let selected = 'session-a'
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const named = (init.headers as Record<string, string>)['X-Rainver-Account']
      if (!url.endsWith('/auth/logout') && named !== undefined && named !== selected) {
        return new Response(JSON.stringify({ code: 'account_switched', message: 'switched' }), { status: 409, headers: { 'Content-Type': 'application/json', 'x-rainver-account-switched': '1' } })
      }
      if (url.endsWith('/auth/logout')) { selected = '-'; return new Response(null, { status: 204 }) }
      if (url.endsWith('/auth/sign-in/email')) { selected = 'session-b'; return new Response(JSON.stringify({ user: {}, account_handle: 'session-b' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    setAccountHandle('session-a')
    await realAuthApi.logout()
    await expect(realAuthApi.configuration()).resolves.toBeTruthy()
    await realAuthApi.passwordLogin({ email: 'b@example.test', password: 'p', rememberMe: true })
    await expect(request('GET', '/me')).resolves.toBeTruthy()
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-b' })

    // Signed out again, then another tab signs in before this one: this tab still names no account and is refused.
    await realAuthApi.logout()
    selected = 'session-c'
    await expect(request('POST', '/notes', { title: 'x' })).rejects.toMatchObject({ status: 409, code: 'account_switched' })
    expect((fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Rainver-Account': '-' })
  })

  it('names no account once another tab\'s sign-out reaches the server, but keeps its account when a session only ended', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-a' })
    // A 401: the browser's account stays selected on the server, so the tab keeps naming it.
    act(() => { window.dispatchEvent(new CustomEvent('auth:required')) })
    await screen.findByText('nobody')
    expect(accountHeaders()).toEqual({ 'X-Rainver-Account': 'session-a' })
    const other = new BroadcastChannel('rainver:auth')
    other.postMessage('logged-out')
    other.postMessage('signed-out')
    await vi.waitFor(() => expect(accountHeaders()).toEqual({ 'X-Rainver-Account': '-' }))
    expect(reload).not.toHaveBeenCalled()
    other.close()
  })

  it('reloads, reporting nothing, when its own switch or addition is refused because another tab switched first', async () => {
    const refusedAsStale = async () => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT))
      throw new ApiRequestError('This browser switched to another account; reload the page', 409, 'account_switched')
    }
    vi.mocked(authApi.switchAccount).mockImplementationOnce(refusedAsStale)
    const failed = vi.fn()
    window.addEventListener('unhandledrejection', failed)
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    await act(async () => screen.getByRole('button', { name: 'switch' }).click())
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(failed).not.toHaveBeenCalled()
    window.removeEventListener('unhandledrejection', failed)
  })

  it('reloads when its own addition is refused because another tab switched first', async () => {
    vi.mocked(authApi.addPasswordAccount).mockImplementationOnce(async () => {
      window.dispatchEvent(new CustomEvent(ACCOUNT_SWITCHED_EVENT))
      throw new ApiRequestError('This browser switched to another account; reload the page', 409, 'account_switched')
    })
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    await act(async () => screen.getByRole('button', { name: 'add' }).click())
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })
})
