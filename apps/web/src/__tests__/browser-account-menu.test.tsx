import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

const auth = vi.hoisted(() => ({ accountAddReturned: false, acknowledgeAccountAdd: vi.fn() }))
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { id: 'u1', display_name: 'Ada', email: 'ada@example.test', avatar_url: null, default_space_id: 'personal-1', created_at: '', last_login_at: null, account_handle: 'session-a' },
    logout: vi.fn(), switchAccount: vi.fn(), addPasswordAccount: vi.fn(), addGoogleAccount: vi.fn(),
    accountAddReturned: auth.accountAddReturned, acknowledgeAccountAdd: auth.acknowledgeAccountAdd,
  }),
}))
vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [{ id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' }],
    personalSpaceId: 'personal-1', activeSpaceId: 'personal-1', activeSpaceName: 'My Personal', preferredSpaceId: 'personal-1',
  }),
}))
vi.mock('../api/client', async original => {
  const actual = await original<typeof import('../api/client')>()
  return {
    ...actual,
    agentAttentionApi: { stream: vi.fn(() => new Promise(() => {})), snapshot: vi.fn(), list: vi.fn() },
    authApi: { ...actual.authApi, browserAccounts: vi.fn(), configuration: vi.fn() },
  }
})
import { authApi } from '../api/client'
import Shell from '../core/Shell'

const ada = { user_id: 'u1', email: 'ada@example.test', display_name: 'Ada', avatar_url: null, active: true, remembered: true }
const ben = { user_id: 'u2', email: 'ben@example.test', display_name: 'Ben', avatar_url: null, active: false, remembered: false }

function Address() {
  const location = useLocation()
  return <output aria-label="address">{location.pathname}{location.search}</output>
}
function renderShell(path = '/home') {
  return render(<MemoryRouter initialEntries={[path]} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}><Shell /><Address /></MemoryRouter>)
}
const trigger = () => screen.getByRole('button', { name: 'Account menu for Ada' })
async function openMenu() {
  fireEvent.keyDown(trigger(), { key: 'Enter' })
  return screen.findByRole('menu')
}

beforeEach(() => {
  auth.accountAddReturned = false
  auth.acknowledgeAccountAdd.mockClear()
  vi.mocked(authApi.browserAccounts).mockReset().mockResolvedValue({ accounts: [ada, ben], limit: 5 })
  vi.mocked(authApi.configuration).mockReset().mockResolvedValue({ google_auth_available: false, bootstrap_registration_available: false, password_min_length: 15, password_max_length: 128 })
})

describe('the avatar account menu', () => {
  it('is a named menu button that opens and closes from the keyboard', async () => {
    renderShell()
    const button = trigger()
    expect(button).toHaveAttribute('aria-haspopup', 'menu')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    const menu = await openMenu()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('menuitem', { name: /Ben/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Sign out of all accounts' })).toBeInTheDocument()
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await vi.waitFor(() => expect(button).toHaveFocus())
  })

  it('reads the sign-in configuration only once adding an account is chosen', async () => {
    renderShell()
    await act(async () => {})
    expect(authApi.configuration).not.toHaveBeenCalled()
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add another account' }))
    expect(await screen.findByRole('dialog', { name: 'Add another account' })).toBeInTheDocument()
    expect(authApi.configuration).toHaveBeenCalledTimes(1)
  })

  it('shows loading and a failed list instead of an empty menu, and says sign-out ends every account unless there is one', async () => {
    let fail: (error: Error) => void = () => {}
    vi.mocked(authApi.browserAccounts).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    renderShell()
    await openMenu()
    expect(screen.getByRole('status')).toHaveTextContent('Loading accounts…')
    await act(async () => fail(new Error('offline')))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the other accounts on this browser.')
    expect(screen.getByRole('menuitem', { name: 'Sign out of all accounts' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    vi.mocked(authApi.browserAccounts).mockResolvedValueOnce({ accounts: [ada], limit: 5 })
    await openMenu()
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('says why a Google addition came back without an account and drops the reason from the address', async () => {
    auth.accountAddReturned = true
    renderShell('/projects?tab=active&error=account_limit')
    expect(await screen.findByText('This browser holds as many accounts as it can. Sign out to add another.')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'address' })).toHaveTextContent('/projects?tab=active')
    expect(screen.getByRole('status', { name: 'address' }).textContent).not.toContain('error')
    expect(auth.acknowledgeAccountAdd).toHaveBeenCalled()
  })
})
