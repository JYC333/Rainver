import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    scan: vi.fn().mockResolvedValue({ items: [] }),
    create: vi.fn(),
    unregister: vi.fn(),
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
    expect(projectFoldersApi.list).toHaveBeenCalledWith('project-1', { limit: '200' })
  })

  /** The empty state used to link back to the Project Overview, which owned
   *  Folder creation — the Area that uses Folders could not create one. */
  it('creates a Folder in place instead of sending the user back to the Overview', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [], total: 0, limit: 200, offset: 0,
    })

    renderPage()

    const create = await screen.findByRole('button', { name: 'Create or connect Folder' })
    expect(screen.queryByRole('link', { name: /create or connect folder/i })).toBeNull()
    fireEvent.click(create)

    expect(await screen.findByRole('heading', { name: 'New Project Folder' })).toBeInTheDocument()
  })

  it('declares the shared-workspace boundary before Folder registration', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [], total: 0, limit: 200, offset: 0,
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Create or connect Folder' }))

    expect(await screen.findByRole('heading', { name: 'New Project Folder' })).toBeInTheDocument()
    const boundaryNote = screen.getByRole('note')
    expect(boundaryNote).toHaveTextContent(/shared workspace with no personal area/i)
    expect(boundaryNote).toHaveTextContent(/whole registered Folder.*mounted read-only for CLI runs/i)
    expect(projectFoldersApi.create).not.toHaveBeenCalled()
  })

  /** Unregistering removes the registration row outright and the toolbar
   *  button acts on whatever is selected, not on a Folder named in a list. */
  it('names the Folder and spares the directory before unregistering', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1', project_id: 'project-1', space_id: 'space-1',
        name: 'Source', kind: 'code', status: 'active', root_path: '/managed/source',
      } as never],
      total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    fireEvent.click(await screen.findByTitle('Unregister Source'))
    expect(projectFoldersApi.unregister).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: /unregister “source”/i })).toBeInTheDocument()
    expect(screen.getByText(/never deleted, moved, or rewritten/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /unregister folder/i }))
    await waitFor(() => expect(projectFoldersApi.unregister).toHaveBeenCalledWith('project-1', 'folder-1'))
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
