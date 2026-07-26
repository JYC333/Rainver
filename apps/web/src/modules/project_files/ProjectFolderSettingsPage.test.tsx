import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFoldersApi } from '../../api/client'
import ProjectFolderSettingsPage from './ProjectFolderSettingsPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  projectFoldersApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    spaces: [{ id: 'space-1', role: 'owner' }],
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
})
