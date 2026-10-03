import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ambientSessionsApi, projectFoldersApi, projectsApi } from '../../api/client'
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
  ambientSessionsApi: { offer: vi.fn(), list: vi.fn(), setPolicy: vi.fn() },
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

  it('does not ask a server-host Location for ambient CLI history', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/folders/folder-1']}>
        <Routes>
          <Route path="/projects/:projectId/folders/:folderId" element={<ProjectFolderSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText('/managed/source')
    expect(screen.queryByTestId('ambient-import-panel')).not.toBeInTheDocument()
    expect(ambientSessionsApi.offer).not.toHaveBeenCalled()
    expect(ambientSessionsApi.list).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('puts the visibility choice back when recording it fails', async () => {
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([{
      id: 'location-2', project_folder_id: 'folder-1', execution_host_id: 'host-2', execution_host_kind: 'remote',
      display_path: '/home/me/source', branch: 'main', git_head: 'abc123', dirty: false, status: 'active',
      execution_ready: true, last_seen_at: null, created_at: '2026-07-25T00:00:00.000Z', updated_at: '2026-07-25T00:00:00.000Z',
    } as never])
    vi.mocked(ambientSessionsApi.offer).mockResolvedValue({
      policy: { entries: [{ runtime_key: 'claude', installation: 'own', sync: true, default_visibility: 'space_shared', auto_extract: false }] },
      counts: [{ location_id: 'location-2', runtime_key: 'claude', installation: 'own', session_count: 3, oldest_updated_at: null, newest_updated_at: null, error: null }],
    } as never)
    vi.mocked(ambientSessionsApi.list).mockResolvedValue({ sessions: [] })
    vi.mocked(ambientSessionsApi.setPolicy).mockRejectedValue(new Error('host offline'))
    render(
      <MemoryRouter initialEntries={['/projects/project-1/folders/folder-1']}>
        <Routes>
          <Route path="/projects/:projectId/folders/:folderId" element={<ProjectFolderSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    )
    const picker = await screen.findByRole('button', { name: 'Who can read it \u2014 claude own' })
    expect(picker).toHaveTextContent('Project shared')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByRole('option', { name: /Only me/ }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('host offline'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Who can read it \u2014 claude own' })).toHaveTextContent('Project shared'))
  })
})
