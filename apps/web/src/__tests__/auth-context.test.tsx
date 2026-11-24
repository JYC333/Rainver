import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { authApi } from '../api/client'
import { __resetLogoutChannelForTests, API_CACHE_NAME, API_KEY_STORAGE } from '../lib/sessionResidue'

vi.mock('../api/client', () => ({
  authApi: {
    me: vi.fn().mockResolvedValue({
      id: 'u1',
      display_name: 'Ada',
      email: 'ada@example.test',
      avatar_url: null,
      default_space_id: 'personal-1',
      created_at: '',
      last_login_at: null,
    }),
    logout: vi.fn().mockResolvedValue(null),
  },
}))

function Probe() {
  const { currentUser, isLoading, logout, reloadUser } = useAuth()
  if (isLoading) return <div>loading</div>
  return (
    <div>
      <span>{currentUser ? currentUser.display_name : 'signed out'}</span>
      <button type="button" onClick={() => { void logout() }}>sign out</button>
      <button type="button" onClick={() => { void reloadUser() }}>check session</button>
    </div>
  )
}

describe('AuthProvider', () => {
  it('ignores a late identity read after signing out', async () => {
    let finish!: (value: Awaited<ReturnType<typeof authApi.me>>) => void
    const stale = new Promise<Awaited<ReturnType<typeof authApi.me>>>(resolve => { finish = resolve })
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    vi.mocked(authApi.me).mockReturnValueOnce(stale)
    act(() => screen.getByRole('button', { name: 'check session' }).click())
    act(() => screen.getByRole('button', { name: 'sign out' }).click())
    await screen.findByText('signed out')
    const oldUser = await authApi.me()
    await act(async () => finish(oldUser))
    expect(screen.getByText('signed out')).toBeVisible()
  })

  it('keeps the current identity after a temporary failure and retries on reconnect', async () => {
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    const previousReads = vi.mocked(authApi.me).mock.calls.length
    vi.mocked(authApi.me).mockRejectedValueOnce(new TypeError('offline'))
    await act(async () => screen.getByRole('button', { name: 'check session' }).click())
    expect(screen.getByText('Ada')).toBeVisible()
    act(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(previousReads + 2))
    expect(screen.getByText('Ada')).toBeVisible()
  })

  it('keeps a failed sign-out across a reload and retries without reading the old session', async () => {
    const first = render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('Ada')
    const reads = vi.mocked(authApi.me).mock.calls.length
    const logouts = vi.mocked(authApi.logout).mock.calls.length
    vi.mocked(authApi.logout)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('still offline'))

    await act(async () => screen.getByRole('button', { name: 'sign out' }).click())
    expect(screen.getByText('signed out')).toBeVisible()
    first.unmount()
    render(<AuthProvider><Probe /></AuthProvider>)
    await screen.findByText('signed out')
    expect(authApi.me).toHaveBeenCalledTimes(reads)

    await act(async () => window.dispatchEvent(new Event('online')))
    expect(authApi.logout).toHaveBeenCalledTimes(logouts + 3)
    expect(authApi.me).toHaveBeenCalledTimes(reads)
    expect(screen.getByText('signed out')).toBeVisible()
  })

  it('clears the current user when the API reports authentication is required', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    expect(await screen.findByText('Ada')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new CustomEvent('auth:required'))
    })

    expect(screen.getByText('signed out')).toBeInTheDocument()
  })

  it('clears the API cache and leftover key on logout', async () => {
    localStorage.setItem(API_KEY_STORAGE, 'rvk_old')
    localStorage.setItem('project:p1:research-workflow', 'wf-1')
    const deleted: string[] = []
    vi.stubGlobal('caches', {
      delete: vi.fn(async (name: string) => {
        deleted.push(name)
        return true
      }),
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    expect(await screen.findByText('Ada')).toBeInTheDocument()
    await act(async () => {
      screen.getByRole('button', { name: 'sign out' }).click()
    })

    await waitFor(() => {
      expect(screen.getByText('signed out')).toBeInTheDocument()
      expect(localStorage.getItem(API_KEY_STORAGE)).toBeNull()
      expect(localStorage.getItem('project:p1:research-workflow')).toBeNull()
      expect(deleted).toEqual([API_CACHE_NAME])
    })
  })

  /**
   * A session revoked server-side reaches only whichever tab happens to make
   * the next API call, so a 401 tells the others too.
   *
   * Both halves of that are silent when broken. They are pinned here.
   * Attaching the handler to the event directly would pass the `Event`
   * object as `fromAnotherTab` — truthy — and a 401 would then never announce.
   * And announcing for an announcement we just *received* makes two tabs tell
   * each other forever.
   */
  it('tells the other tabs about a 401, and does not answer one it was told', async () => {
    const heard: unknown[] = []
    const listener = new BroadcastChannel('rainver:auth')
    listener.addEventListener('message', event => { heard.push(event.data) })
    try {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      )
      expect(await screen.findByText('Ada')).toBeInTheDocument()

      await act(async () => {
        window.dispatchEvent(new Event('auth:required'))
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(screen.getByText('signed out')).toBeInTheDocument()
      expect(heard).toEqual(['logged-out'])

      // What another tab's announcement sounds like. This one must clear and
      // stay quiet.
      await act(async () => {
        listener.postMessage('logged-out')
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(heard).toEqual(['logged-out'])
    } finally {
      listener.close()
      __resetLogoutChannelForTests()
    }
  })
})
