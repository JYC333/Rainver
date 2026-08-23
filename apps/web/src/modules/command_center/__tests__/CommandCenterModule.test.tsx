import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import CommandCenterModule from '../CommandCenterModule'
import { hostsApi, projectFoldersApi, projectsApi, runsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Research Space', preferredSpaceId: 'space-1', spaces: [] }),
}))
vi.mock('../../../api/client', () => ({
  hostsApi: { list: vi.fn(), listThreads: vi.fn(), listRecentThreads: vi.fn(), listRuntimeAdapters: vi.fn(), dispatch: vi.fn() },
  projectFoldersApi: { list: vi.fn() },
  projectsApi: { list: vi.fn() },
  runsApi: { list: vi.fn() },
}))

beforeEach(() => {
  vi.mocked(hostsApi.list).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listThreads).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listRecentThreads).mockResolvedValue({ items: [] })
  vi.mocked(hostsApi.listRuntimeAdapters).mockResolvedValue({ items: [] })
  vi.mocked(projectFoldersApi.list).mockResolvedValue({ items: [], total: 0 } as never)
  vi.mocked(projectsApi.list).mockResolvedValue({ items: [], total: 0 } as never)
  vi.mocked(runsApi.list).mockResolvedValue([] as never)
})

describe('CommandCenterModule', () => {
  it('renders the index route (composer + work stream/hosts tabs) without crashing', async () => {
    render(<MemoryRouter initialEntries={['/']}><CommandCenterModule /></MemoryRouter>)
    expect(await screen.findByText('Command Center')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Work Stream' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Hosts' })).toBeInTheDocument()
  })
})
