import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFoldersApi } from '../../api/client'
import ProjectFilesPage from './ProjectFilesPage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  projectFoldersApi: {
    list: vi.fn(),
    tree: vi.fn(),
    gitStatus: vi.fn(),
    file: vi.fn(),
    gitDiff: vi.fn(),
  },
}))

vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: React.ComponentProps<'a'> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function renderPage(path = '/projects/project-1/files') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/files" element={<ProjectFilesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Project Files & Code Area', () => {
  it('keeps the Area reachable for a Project with zero Folders', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [], total: 0, limit: 200, offset: 0,
    })

    renderPage()

    expect(await screen.findByText('No Project Folders yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create or connect Folder' })).toHaveAttribute('href', '/projects/project-1?create_folder=1')
    expect(projectFoldersApi.list).toHaveBeenCalledWith('project-1', { limit: '200' })
  })

  it('loads the selected Project Folder tree and Git status', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1',
        project_id: 'project-1',
        space_id: 'space-1',
        name: 'Source',
        kind: 'code',
        status: 'active',
        root_path: '/managed/source',
      } as never],
      total: 1,
      limit: 200,
      offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({
      is_repo: true, branch: 'main', files: [],
    })

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Files & Code' })).toBeInTheDocument()
    await waitFor(() => {
      expect(projectFoldersApi.tree).toHaveBeenCalledWith('project-1', 'folder-1')
      expect(projectFoldersApi.gitStatus).toHaveBeenCalledWith('project-1', 'folder-1')
    })
    expect(await screen.findByText('main')).toBeInTheDocument()
  })
})
