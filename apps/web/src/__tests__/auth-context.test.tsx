import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { __resetLogoutChannelForTests, API_CACHE_NAME, API_KEY_STORAGE } from '../lib/sessionResidue'

vi.mock('../api/client', () => ({
  setAuth: vi.fn(),
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
  const { currentUser, isLoading, logout } = useAuth()
  if (isLoading) return <div>loading</div>
  return (
    <div>
      <span>{currentUser ? currentUser.display_name : 'signed out'}</span>
      <button type="button" onClick={() => { void logout() }}>sign out</button>
    </div>
  )
}

describe('AuthProvider', () => {
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
   * Both halves of that are silent when broken, which is why they are pinned
   * here. Attaching the handler to the event directly would pass the `Event`
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
