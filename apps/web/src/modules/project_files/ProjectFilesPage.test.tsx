import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    locations: vi.fn().mockResolvedValue([]),
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function folder(id: string, name: string) {
  return {
    id, project_id: 'project-1', space_id: 'space-1', name, kind: 'code',
    status: 'active', root_path: '/managed/source',
  } as never
}

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

  it('tints changed files and their folders in the tree by Git status', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [
        { name: 'src', path: 'src', type: 'dir', children: [
          { name: 'app.ts', path: 'src/app.ts', type: 'file', size: 10 },
          { name: 'clean.ts', path: 'src/clean.ts', type: 'file', size: 10 },
        ] },
        { name: 'backups', path: 'backups', type: 'dir', children: [
          { name: 'dump.sql', path: 'backups/dump.sql', type: 'file', size: 10 },
        ] },
      ],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({
      is_repo: true, branch: 'main', files: [
        { path: 'src/app.ts', status: 'modified' },
        { path: 'backups/', status: 'untracked' },
      ],
    })

    renderPage()

    const modified = await screen.findByTitle('app.ts · modified')
    expect(modified.className).toContain('text-amber-600')
    expect(within(modified).getByLabelText('modified')).toHaveTextContent('M')
    // An untracked directory covers the files beneath it, the way git reports it.
    const untracked = await screen.findByTitle('dump.sql · untracked')
    expect(untracked.className).toContain('text-emerald-600')
    expect(screen.getByRole('button', { name: 'clean.ts 10B' }).className).not.toContain('text-amber-600')
    expect(screen.getByRole('button', { name: /^src$/ }).className).toContain('text-amber-600')
    // A folder whose only changes are new files is green, matching the files inside it.
    expect(screen.getByRole('button', { name: /^backups$/ }).className).toContain('text-emerald-600')
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

  it('shows an offline remote host error with last-seen context and retry', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1', project_id: 'project-1', space_id: 'space-1',
        name: 'Source', kind: 'code', status: 'active', root_path: null,
      } as never], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockRejectedValue(Object.assign(new Error('host offline'), {
      code: 'host_offline',
      payload: { code: 'host_offline', detail: 'The host Laptop is offline.', host_name: 'Laptop', last_heartbeat_at: '2026-08-30T02:00:00.000Z' },
    }))
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/This Folder is on Laptop, which is offline \(last seen /i)
    expect(screen.getAllByText('Retry').length).toBeGreaterThan(0)
    expect(screen.queryByText('No files found')).not.toBeInTheDocument()
  })

  it('shows the owner-only remote host error without presenting an empty tree', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1', project_id: 'project-1', space_id: 'space-1',
        name: 'Source', kind: 'code', status: 'active', root_path: null,
      } as never], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockRejectedValue(Object.assign(new Error('not owner'), {
      code: 'host_not_owned',
      payload: { code: 'host_not_owned', detail: "This Folder is on Alice's machine; only its owner can browse it here.", host_name: 'Alice' },
    }))
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/This Folder is on Alice's machine\. Only its owner can browse it here\./i)
    expect(screen.queryByText('No files found')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry Folder reads' })).not.toBeInTheDocument()
  })

  it('explains when a host daemon lost the registered location', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1', project_id: 'project-1', space_id: 'space-1',
        name: 'Source', kind: 'code', status: 'active', root_path: null,
      } as never], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockRejectedValue(Object.assign(new Error('location unknown'), {
      code: 'location_unknown_on_host',
      payload: { code: 'location_unknown_on_host', detail: 'The daemon no longer knows this directory.', host_name: 'Laptop' },
    }))
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent(/The daemon on Laptop no longer knows this directory\. Run rainver-host workspace add there\./i)
    expect(screen.queryByText('No files found')).not.toBeInTheDocument()
  })

  it('labels a successful remote Folder with its owning host', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [{
        id: 'folder-1', project_id: 'project-1', space_id: 'space-1',
        name: 'Source', kind: 'code', status: 'active', root_path: null,
      } as never], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([{
      id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1',
      execution_host_kind: 'remote', display_path: '/Users/alice/source', root_path: null,
      branch: null, git_head: null, dirty: false, status: 'active', preferred: true,
      execution_ready: false, last_seen_at: null, created_at: '', updated_at: '',
      host_name: 'Alice laptop', host_online: true, host_owner_is_me: true,
    }])
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 5 }] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    expect(await screen.findByText('on Alice laptop')).toBeInTheDocument()
    expect(await screen.findByText('README.md')).toBeInTheDocument()
  })

  it('ignores a late tree response from a Folder that is no longer selected', async () => {
    const oldTree = deferred<{ name: string; path: string; type: 'dir'; children: never[] }>()
    const nextTree = deferred<{ name: string; path: string; type: 'dir'; children: { name: string; path: string; type: 'file'; size: number }[] }>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source'), folder('folder-2', 'Other')], total: 2, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree)
      .mockImplementationOnce(() => oldTree.promise as never)
      .mockImplementationOnce(() => nextTree.promise as never)
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    const selector = await screen.findByRole('button', { name: 'Source' })
    fireEvent.click(selector)
    fireEvent.click(await screen.findByRole('option', { name: 'Other' }))
    nextTree.resolve({ name: 'other', path: '.', type: 'dir', children: [{ name: 'new.txt', path: 'new.txt', type: 'file', size: 3 }] })
    oldTree.resolve({ name: 'source', path: '.', type: 'dir', children: [] })

    expect(await screen.findByText('new.txt')).toBeInTheDocument()
    expect(screen.queryByText('source')).not.toBeInTheDocument()
  })

  it('ignores a late file response after switching Folders', async () => {
    const fileResponse = deferred<{ path: string; content: string; size: number; line_count: number }>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source'), folder('folder-2', 'Other')], total: 2, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 5 }],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file).mockImplementationOnce(() => fileResponse.promise as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /README\.md/ }))
    await waitFor(() => expect(projectFoldersApi.file).toHaveBeenCalledWith('project-1', 'folder-1', 'README.md'))
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Other' }))
    fileResponse.resolve({ path: 'README.md', content: 'stale source content', size: 19, line_count: 1 })

    await waitFor(() => expect(screen.queryByText('stale source content')).not.toBeInTheDocument())
  })

  it('shows a read error in the center even when a file was already open', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 5 }],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file).mockResolvedValue({ path: 'README.md', content: 'existing file', size: 13, line_count: 1 })

    renderPage()

    await waitFor(() => expect(projectFoldersApi.tree).toHaveBeenCalled())
    fireEvent.click(await screen.findByRole('button', { name: /README\.md/ }))
    expect(await screen.findByText('existing file')).toBeInTheDocument()
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockRejectedValue(Object.assign(new Error('host offline'), {
      code: 'host_offline', payload: { code: 'host_offline', detail: 'The host Laptop is offline.', host_name: 'Laptop', last_heartbeat_at: null },
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry Folder reads' }))

    expect((await screen.findAllByText(/This Folder is on Laptop, which is offline/i)).length).toBeGreaterThan(0)
    expect(screen.queryByText('existing file')).not.toBeInTheDocument()
  })

  it('uses No files found only for a successful empty tree', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage()

    expect(await screen.findByText('No files found')).toBeInTheDocument()
  })

  it('ignores every loader response from a superseded Retry generation', async () => {
    const firstTree = deferred<unknown>()
    const secondTree = deferred<unknown>()
    const firstStatus = deferred<unknown>()
    const secondStatus = deferred<unknown>()
    const firstLocations = deferred<unknown>()
    const secondLocations = deferred<unknown>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree)
      .mockImplementationOnce(() => firstTree.promise as never)
      .mockImplementationOnce(() => secondTree.promise as never)
    vi.mocked(projectFoldersApi.gitStatus)
      .mockImplementationOnce(() => firstStatus.promise as never)
      .mockImplementationOnce(() => secondStatus.promise as never)
    vi.mocked(projectFoldersApi.locations)
      .mockImplementationOnce(() => firstLocations.promise as never)
      .mockImplementationOnce(() => secondLocations.promise as never)

    renderPage()
    await waitFor(() => expect(projectFoldersApi.tree).toHaveBeenCalledTimes(1))

    firstTree.resolve({ name: 'source', path: '.', type: 'dir', children: [{ name: 'old.txt', path: 'old.txt', type: 'file', size: 3 }] })
    firstStatus.resolve({ is_repo: true, branch: 'old-branch', files: [] })
    firstLocations.resolve([{
      id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1',
      execution_host_kind: 'remote', display_path: '/Users/alice/old', root_path: null,
      branch: null, git_head: null, dirty: false, status: 'active', preferred: true,
      execution_ready: false, last_seen_at: null, created_at: '', updated_at: '',
      host_name: 'Old laptop', host_online: true, host_owner_is_me: true,
    }])
    expect(await screen.findByText('old.txt')).toBeInTheDocument()
    expect(await screen.findByText('old-branch')).toBeInTheDocument()
    expect(await screen.findByText('on Old laptop')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry Folder reads' }))
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('old-branch')).not.toBeInTheDocument()
    expect(screen.queryByText('on Old laptop')).not.toBeInTheDocument()

    secondTree.resolve({ name: 'source', path: '.', type: 'dir', children: [{ name: 'new.txt', path: 'new.txt', type: 'file', size: 3 }] })
    secondStatus.resolve({ is_repo: true, branch: 'new-branch', files: [] })
    secondLocations.resolve([{
      id: 'location-2', project_folder_id: 'folder-1', execution_host_id: 'host-2',
      execution_host_kind: 'remote', display_path: '/Users/alice/new', root_path: null,
      branch: null, git_head: null, dirty: false, status: 'active', preferred: true,
      execution_ready: false, last_seen_at: null, created_at: '', updated_at: '',
      host_name: 'New laptop', host_online: true, host_owner_is_me: true,
    }])
    expect(await screen.findByText('new.txt')).toBeInTheDocument()
    expect(await screen.findByText('new-branch')).toBeInTheDocument()
    expect(await screen.findByText('on New laptop')).toBeInTheDocument()
    expect(screen.queryByText('old.txt')).not.toBeInTheDocument()
    expect(screen.queryByText('old-branch')).not.toBeInTheDocument()
    expect(screen.queryByText('on Old laptop')).not.toBeInTheDocument()
  })
})
