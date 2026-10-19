import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CommandCenterModule from '../CommandCenterModule'
import { hostsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// `HostsPanel` is the page, so its auth dependency has to be satisfied here too.
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: null }) }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space', preferredSpaceId: 'space-1', spaces: [] }),
}))
vi.mock('../../../api/client', () => ({
  hostsApi: {
    list: vi.fn(),
    listRuntimeDefinitions: vi.fn(),
  },
  providersApi: { list: vi.fn().mockResolvedValue([]) },
}))

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listRuntimeDefinitions).mockResolvedValue({ items: [] })
})

describe('CommandCenterModule', () => {
  it('is the host page — no dispatch composer, no work stream, no thread', async () => {
    render(<MemoryRouter initialEntries={['/']}><CommandCenterModule /></MemoryRouter>)
    expect(await screen.findByText('Command Center')).toBeInTheDocument()
    expect(screen.getByText(/Pair machines/i)).toBeInTheDocument()
    // The page is host management. Work starts from a Task or a Room, and a
    // turn is read where the conversation is. Do not put a dispatch composer
    // or a work stream here.
    expect(screen.queryByRole('tab', { name: 'Work Stream' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Hosts' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Dispatch a task/i)).not.toBeInTheDocument()
  })
})
