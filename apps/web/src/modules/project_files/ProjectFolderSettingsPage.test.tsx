import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFoldersApi, projectsApi } from '../../api/client'
import ProjectFolderSettingsPage from './ProjectFolderSettingsPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  projectFoldersApi: {
    get: vi.fn(),
    locations: vi.fn(),
    activateLocation: vi.fn(),
    update: vi.fn(),
  },
  projectsApi: { get: vi.fn() },
}))

vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    spaces: [{ id: 'space-1', role: 'member' }],
  }),
}))

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: React.ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectFoldersApi.get).mockResolvedValue({
    id: 'folder-1',
    project_id: 'project-1',
    space_id: 'space-1',
    name: 'Source',
    kind: 'code',
    status: 'active',
    is_primary: true,
    root_path: '/managed/source',
    snapshot_retention_days: null,
    snapshot_max_count: null,
    created_at: '2026-07-25T00:00:00.000Z',
  } as never)
  vi.mocked(projectsApi.get).mockResolvedValue({ current_user_can_write: true } as never)
  vi.mocked(projectFoldersApi.locations).mockResolvedValue([{
    id: 'location-1',
    project_folder_id: 'folder-1',
    execution_host_id: 'host-1',
    execution_host_kind: 'server',
    display_path: '/managed/source',
    root_path: '/managed/source',
    branch: 'main',
    git_head: 'abc123',
    dirty: false,
    status: 'active',
    execution_ready: true,
    last_seen_at: null,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  } as never])
})

describe('Project Folder settings route', () => {
  it('loads settings within the owning Project route', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/folders/folder-1']}>
        <Routes>
          <Route
            path="/projects/:projectId/folders/:folderId"
            element={<ProjectFolderSettingsPage />}
          />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('heading', { name: 'Source' })).toBeInTheDocument()
    expect(projectFoldersApi.get).toHaveBeenCalledWith('project-1', 'folder-1')
    expect(screen.getByText('Project Folder settings')).toBeInTheDocument()
    expect(screen.getByText('/managed/source')).toBeInTheDocument()
  })

  it('lets a Project writer confirm a stale Location for new conversations', async () => {
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([
      {
        id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1',
        execution_host_kind: 'server', display_path: '/managed/source', root_path: '/managed/source',
        branch: 'main', git_head: 'abc123', dirty: false, status: 'active', execution_ready: true,
        last_seen_at: null, created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z',
      },
      {
        id: 'location-2', project_folder_id: 'folder-1', execution_host_id: 'host-2',
        execution_host_kind: 'remote', display_path: '/work/source', root_path: null,
        branch: 'main', git_head: 'def456', dirty: false, status: 'stale', execution_ready: true,
        last_seen_at: null, created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z',
        host_name: 'Laptop', host_online: true, host_owner_is_me: true,
      },
    ] as never)
    vi.mocked(projectFoldersApi.activateLocation).mockResolvedValue({ id: 'location-2', status: 'active' } as never)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(
      <MemoryRouter initialEntries={['/projects/project-1/folders/folder-1']}>
        <Routes>
          <Route path="/projects/:projectId/folders/:folderId" element={<ProjectFolderSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Use for new conversations' }))
    await waitFor(() => expect(projectFoldersApi.activateLocation).toHaveBeenCalledWith('project-1', 'folder-1', 'location-2'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Existing conversations will stay'))
    confirm.mockRestore()
  })
})
