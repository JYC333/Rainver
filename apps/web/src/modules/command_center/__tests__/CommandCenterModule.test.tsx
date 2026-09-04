import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CommandCenterModule from '../CommandCenterModule'
import { hostsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// `HostsPanel` renders unconditionally now that it is the page rather than
// one tab of it, so its auth dependency has to be satisfied here too.
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: null }) }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space', preferredSpaceId: 'space-1', spaces: [] }),
}))
vi.mock('../../../api/client', () => ({
  hostsApi: {
    list: vi.fn(),
    listRuntimeAdapters: vi.fn(),
    listProviderBindings: vi.fn().mockResolvedValue({ items: [] }),
  },
  providersApi: { list: vi.fn().mockResolvedValue([]) },
}))

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [] })
})

describe('CommandCenterModule', () => {
  it('is the host page — no dispatch composer, no work stream, no thread', async () => {
    render(<MemoryRouter initialEntries={['/']}><CommandCenterModule /></MemoryRouter>)
    expect(await screen.findByText('Command Center')).toBeInTheDocument()
    // What the page is now.
    expect(screen.getByText(/Pair machines/i)).toBeInTheDocument()

    // What it no longer is. The dispatch composer and the work stream were
    // this product's third conversation surface, with their own message
    // queue; work starts from a Task or a Room, and a turn is read where the
    // conversation is.
    expect(screen.queryByRole('tab', { name: 'Work Stream' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Hosts' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Dispatch a task/i)).not.toBeInTheDocument()
  })
})
