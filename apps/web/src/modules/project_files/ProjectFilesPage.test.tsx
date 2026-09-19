import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFoldersApi } from '../../api/client'
import ProjectFilesPage from './ProjectFilesPage'
import { ProjectFolderConversationProvider, useProjectFolderConversation, type CurrentFileAttachment } from '../projects/ProjectFolderConversationContext'
import { sha256Utf8 } from './draftController'
import type { FileContent } from '../../types/api'
import { notifyProjectFolderContentChanged } from '../../core/projectFolderEvents'
import { ProjectFileEditor } from './ProjectFileEditor'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../api/client', () => ({
  hostsApi: { executionTargets: vi.fn().mockResolvedValue({ targets: [] }), browseDirectories: vi.fn(), registerWorkspace: vi.fn() },
  projectFoldersApi: {
    list: vi.fn(),
    tree: vi.fn(),
    gitStatus: vi.fn(),
    locations: vi.fn().mockResolvedValue([]),
    file: vi.fn(),
    draft: vi.fn().mockResolvedValue(null),
    upsertDraft: vi.fn(),
    rebaseDraft: vi.fn(),
    discardDraft: vi.fn(),
    saveDraft: vi.fn(),
    previewRevision: vi.fn(),
    restoreRevisionAsDraft: vi.fn(),
    fileRevisions: vi.fn().mockResolvedValue([]),
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

function ConversationFolderSeed({ ids }: { ids: readonly string[] }) {
  const { setConversationFolderIds } = useProjectFolderConversation()
  useEffect(() => { setConversationFolderIds(ids) }, [ids, setConversationFolderIds])
  return null
}

function SelectedFolderProbe({ onChange }: { onChange: (id: string | null) => void }) {
  const { selectedFolderId } = useProjectFolderConversation()
  useEffect(() => { onChange(selectedFolderId) }, [onChange, selectedFolderId])
  return null
}

function CurrentFileProbe({ onChange }: { onChange: (attachment: CurrentFileAttachment | null) => void }) {
  const { currentFileAttachment } = useProjectFolderConversation()
  useEffect(() => { onChange(currentFileAttachment) }, [currentFileAttachment, onChange])
  return null
}

function renderPage(
  path = '/projects/project-1/files',
  conversationFolderIds?: readonly string[],
  onSelectedFolderChange?: (id: string | null) => void,
  onCurrentFileChange?: (attachment: CurrentFileAttachment | null) => void,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectFolderConversationProvider projectId="project-1">
        {conversationFolderIds && <ConversationFolderSeed ids={conversationFolderIds} />}
        {onSelectedFolderChange && <SelectedFolderProbe onChange={onSelectedFolderChange} />}
        {onCurrentFileChange && <CurrentFileProbe onChange={onCurrentFileChange} />}
        <Routes>
          <Route path="/projects/:projectId/files" element={<ProjectFilesPage />} />
        </Routes>
      </ProjectFolderConversationProvider>
    </MemoryRouter>,
  )
}

describe('Project Files & Code Area', () => {
  it('requires confirmation before saving a draft that normalizes mixed line endings', async () => {
    const draft = {
      id: 'draft-mixed', space_id: 'space-1', project_id: 'project-1', project_folder_id: 'folder-1',
      workspace_location_id: 'location-1', owner_user_id: 'user-1', target_kind: 'existing' as const,
      relative_path: 'mixed.txt', base_exists: true, base_sha256: 'a'.repeat(64),
      content: 'one\ntwo\n', content_sha256: 'b'.repeat(64), byte_size: 8, version: 1,
      source_encoding: 'utf8' as const, preserve_bom: false, line_ending_mode: 'mixed' as const,
      created_at: '2026-09-18T12:00:00.000Z', updated_at: '2026-09-18T12:00:00.000Z', expires_at: '2026-09-19T12:00:00.000Z',
    }
    const saved = {
      file: { path: 'mixed.txt', content: draft.content, size: 8, line_count: 3, sha256: 'c'.repeat(64), encoding: 'utf8' as const, writable: true },
      revision: { id: 'revision-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1', path: 'mixed.txt', before_exists: true, after_exists: true, after_sha256: 'c'.repeat(64), created_at: '', expires_at: '', status: 'available' as const },
      draft_deleted: true,
      newer_draft_retained: false,
    }
    const onDraftSave = vi.fn().mockResolvedValue(saved)
    render(<ProjectFileEditor
      file={{ path: 'mixed.txt', content: 'one\r\ntwo\n', size: 10, line_count: 3, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true, line_ending_mode: 'mixed' }}
      draft={draft}
      onDraftUpsert={vi.fn()}
      onDraftDiscard={vi.fn()}
      onDraftSave={onDraftSave}
      onDraftRebase={vi.fn()}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Save to Folder' }))
    expect(await screen.findByText('Normalize mixed line endings?')).toBeInTheDocument()
    expect(onDraftSave).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Normalize and save' }))
    await waitFor(() => expect(onDraftSave).toHaveBeenCalledWith(draft, {
      confirmMixedLineEndingNormalization: true,
    }))
  })

  it('does not flash a Host conflict while a successful save adopts the new file', async () => {
    const draft = {
      id: 'draft-save', space_id: 'space-1', project_id: 'project-1', project_folder_id: 'folder-1',
      workspace_location_id: 'location-1', owner_user_id: 'user-1', target_kind: 'existing' as const,
      relative_path: 'notes.md', base_exists: true, base_sha256: 'a'.repeat(64),
      content: 'updated\n', content_sha256: 'b'.repeat(64), byte_size: 8, version: 1,
      source_encoding: 'utf8' as const, preserve_bom: false, line_ending_mode: 'lf' as const,
      created_at: '', updated_at: '', expires_at: '',
    }
    const saved = {
      file: { path: 'notes.md', content: draft.content, size: 8, line_count: 2, sha256: 'c'.repeat(64), encoding: 'utf8' as const, writable: true },
      revision: { id: 'revision-save', project_folder_id: 'folder-1', workspace_location_id: 'location-1', path: 'notes.md', before_exists: true, after_exists: true, after_sha256: 'c'.repeat(64), created_at: '', expires_at: '', status: 'available' as const },
      draft_deleted: true,
      newer_draft_retained: false,
    }
    const pendingSave = deferred<typeof saved>()
    const onDraftSave = vi.fn(() => pendingSave.promise)
    const onDraftUpsert = vi.fn()
    const onDraftDiscard = vi.fn()
    const onDraftRebase = vi.fn()
    const originalFile = { path: 'notes.md', content: 'original\n', size: 9, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8' as const, writable: true }
    const { rerender } = render(<ProjectFileEditor
      file={originalFile}
      draft={draft}
      onDraftUpsert={onDraftUpsert}
      onDraftDiscard={onDraftDiscard}
      onDraftSave={onDraftSave}
      onDraftRebase={onDraftRebase}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Save to Folder' }))
    await waitFor(() => expect(onDraftSave).toHaveBeenCalledTimes(1))

    rerender(<ProjectFileEditor
      file={saved.file}
      draft={draft}
      saving={false}
      onDraftUpsert={onDraftUpsert}
      onDraftDiscard={onDraftDiscard}
      onDraftSave={onDraftSave}
      onDraftRebase={onDraftRebase}
    />)
    expect(screen.queryByText('The Folder file changed after this draft was saved.')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saving to Folder…')

    await act(async () => { pendingSave.resolve(saved); await pendingSave.promise })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Clean'))
    expect(screen.queryByText('The Folder file changed after this draft was saved.')).not.toBeInTheDocument()
  })

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

  it('opens the connect dialog on arrival from a ?setup=folder link, once', async () => {
    // Pulse and the conversation preflight send someone here to connect a
    // Folder; landing on the page and then hunting for the button is the
    // extra click the link exists to remove. The parameter is consumed so a
    // reload does not reopen the dialog.
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [], total: 0, limit: 200, offset: 0,
    })
    renderPage('/projects/project-1/files?setup=folder')
    // Queried afresh: consuming the parameter re-renders the route, and an
    // element found before that is detached by the time it is asserted on.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New Project Folder' })).toBeInTheDocument())
  })

  it('keeps the one dialog it opened on arrival while the Folders load', async () => {
    // The dialog is showing before the Folder list answers; the switch to the
    // empty state must keep that instance rather than mount a second one,
    // which played the open animation twice.
    const list = deferred<{ items: never[]; total: number; limit: number; offset: number }>()
    vi.mocked(projectFoldersApi.list).mockReturnValue(list.promise as never)
    renderPage('/projects/project-1/files?setup=folder')
    const heading = await screen.findByRole('heading', { name: 'New Project Folder' })
    list.resolve({ items: [], total: 0, limit: 200, offset: 0 })
    await screen.findByText('No Project Folders yet')
    expect(screen.getAllByRole('heading', { name: 'New Project Folder' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'New Project Folder' })).toBe(heading)
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
    expect(boundaryNote).toHaveTextContent(/Conversation can bind its Primary or attached Location with read or write access/i)
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
    await waitFor(() => expect(projectFoldersApi.unregister).toHaveBeenCalledWith('project-1', 'folder-1', false))
  })

  /** The server refuses while recovery drafts are live and reports how many it
   *  would discard; without the second step the Folder could not be
   *  unregistered from this page at all. */
  it('confirms the active recovery drafts the server refuses to discard silently', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.unregister).mockImplementation(async (_projectId, _folderId, confirm) => {
      if (confirm) return null as never
      throw Object.assign(new Error('Active File drafts must be explicitly confirmed before unregistering this Folder'), {
        payload: { code: 'active_drafts_require_confirmation', active_draft_count: 2, affected_user_count: 1 },
      })
    })

    renderPage()

    fireEvent.click(await screen.findByTitle('Unregister Source'))
    fireEvent.click(screen.getByRole('button', { name: /unregister folder/i }))

    expect(await screen.findByRole('heading', { name: /discard unsaved recovery drafts/i })).toBeInTheDocument()
    expect(screen.getByText(/2 unsaved recovery drafts from 1 person/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /unregister and discard drafts/i }))
    await waitFor(() => expect(projectFoldersApi.unregister).toHaveBeenCalledWith('project-1', 'folder-1', true))
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

  it('refreshes the selected Folder when a conversation changes its workspace', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree)
      .mockResolvedValueOnce({ name: 'source', path: '.', type: 'dir', children: [] })
      .mockResolvedValueOnce({ name: 'source', path: '.', type: 'dir', children: [{ name: 'created.txt', path: 'created.txt', type: 'file', size: 11 }] })
    vi.mocked(projectFoldersApi.gitStatus)
      .mockResolvedValueOnce({ is_repo: true, branch: 'main', files: [] })
      .mockResolvedValueOnce({ is_repo: true, branch: 'main', files: [{ path: 'created.txt', status: 'untracked' }] })

    renderPage()

    await waitFor(() => {
      expect(projectFoldersApi.tree).toHaveBeenCalledTimes(1)
      expect(projectFoldersApi.gitStatus).toHaveBeenCalledTimes(1)
    })
    act(() => notifyProjectFolderContentChanged(['folder-1']))

    expect(await screen.findByText('created.txt')).toBeInTheDocument()
    await waitFor(() => {
      expect(projectFoldersApi.tree).toHaveBeenCalledTimes(2)
      expect(projectFoldersApi.gitStatus).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByTitle('created.txt · untracked')).toBeInTheDocument()
  })

  it('publishes the selected Folder for a new Sidecar conversation', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source'), folder('folder-2', 'Docs')], total: 2, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    const selected: Array<string | null> = []

    renderPage('/projects/project-1/files', undefined, id => { selected.push(id) })

    await waitFor(() => expect(selected).toContain('folder-1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Docs' }))
    await waitFor(() => expect(selected).toContain('folder-2'))
  })

  it('explains that switching Folder does not retarget an existing conversation', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source'), folder('folder-2', 'Docs')], total: 2, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })

    renderPage('/projects/project-1/files', ['folder-1'])

    fireEvent.click(await screen.findByRole('button', { name: 'Source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Docs' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'This conversation remains pinned to its original execution context and will not switch automatically',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Source' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Docs' }))
    expect(await screen.findByRole('status')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Folder context notice' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
      branch: null, git_head: null, dirty: false, status: 'active',
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

  it('shows file content without waiting for revision history', async () => {
    const revisions = deferred<never[]>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 7 }],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file).mockResolvedValue({ path: 'README.md', content: 'loaded\n', size: 7, line_count: 2 })
    vi.mocked(projectFoldersApi.fileRevisions).mockReturnValue(revisions.promise as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /README\.md/ }))
    expect(await screen.findByText('loaded')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading file' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()

    revisions.resolve([])
    await waitFor(() => expect(projectFoldersApi.fileRevisions).toHaveBeenCalledWith('project-1', 'folder-1', 'README.md'))
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

  it('keeps the current file visible while the next file is loading', async () => {
    const nextFile = deferred<{ path: string; content: string; size: number; line_count: number }>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [
        { name: 'first.txt', path: 'first.txt', type: 'file', size: 6 },
        { name: 'second.txt', path: 'second.txt', type: 'file', size: 7 },
      ],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file)
      .mockResolvedValueOnce({ path: 'first.txt', content: 'first\n', size: 6, line_count: 2 })
      .mockImplementationOnce(() => nextFile.promise as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /first\.txt/ }))
    expect(await screen.findByText('first')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /second\.txt/ }))

    expect(screen.getByText('first')).toBeInTheDocument()
    expect(screen.getByRole('status', { name: 'Loading file' })).toBeInTheDocument()

    nextFile.resolve({ path: 'second.txt', content: 'second\n', size: 7, line_count: 2 })
    expect(await screen.findByText('second')).toBeInTheDocument()
    expect(screen.queryByText('first')).not.toBeInTheDocument()
  })

  it('reuses cached content when returning to an already opened file', async () => {
    const revalidation = deferred<{ path: string; content: string; size: number; line_count: number }>()
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [
        { name: 'first.txt', path: 'first.txt', type: 'file', size: 6 },
        { name: 'second.txt', path: 'second.txt', type: 'file', size: 7 },
      ],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file)
      .mockResolvedValueOnce({ path: 'first.txt', content: 'first\n', size: 6, line_count: 2 })
      .mockResolvedValueOnce({ path: 'second.txt', content: 'second\n', size: 7, line_count: 2 })
      .mockReturnValueOnce(revalidation.promise as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /first\.txt/ }))
    expect(await screen.findByText('first')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /second\.txt/ }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /first\.txt/ }))

    expect(screen.getByText('first')).toBeInTheDocument()
    expect(projectFoldersApi.file).toHaveBeenCalledTimes(3)

    revalidation.resolve({ path: 'first.txt', content: 'first refreshed\n', size: 16, line_count: 2 })
    expect(await screen.findByText('first refreshed')).toBeInTheDocument()
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
      branch: null, git_head: null, dirty: false, status: 'active',
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
      branch: null, git_head: null, dirty: false, status: 'active',
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

  it('opens a new file in the always-editable CodeMirror surface', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    const savedDraft = {
      id: 'draft-1', space_id: 'space-1', project_id: 'project-1', project_folder_id: 'folder-1',
      workspace_location_id: 'location-1', owner_user_id: 'user-1', target_kind: 'new' as const,
      relative_path: 'notes/today.md', base_exists: false, base_sha256: null,
      content: '# Today\n', content_sha256: 'b'.repeat(64), byte_size: 8, version: 1,
      source_encoding: 'utf8' as const, preserve_bom: false, line_ending_mode: 'lf' as const,
      created_at: '', updated_at: '', expires_at: '',
    }
    vi.mocked(projectFoldersApi.upsertDraft).mockResolvedValue(savedDraft)
    vi.mocked(projectFoldersApi.saveDraft).mockResolvedValue({
      file: { path: 'notes/today.md', content: '# Today\n', size: 8, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true },
      revision: { id: 'revision-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1', path: 'notes/today.md', before_exists: false, after_exists: true, after_sha256: 'a'.repeat(64), created_at: '', expires_at: '', status: 'available' },
      draft_deleted: true, newer_draft_retained: false,
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'New File' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'File path' }), { target: { value: 'notes/today.md' } })
    expect(screen.getByRole('textbox', { name: 'File content' })).toHaveAttribute('contenteditable', 'true')
    expect(screen.queryByRole('button', { name: 'Save directly' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save to Folder' })).toBeDisabled()
  })

  /** The editor is keyed on the file it renders. Keyed on the pending
   *  selection, it remounted against the file still on screen and pinned its
   *  path state to it — every later draft and attachment then named the wrong
   *  file. */
  it('binds the editor to the file it shows, not to the one still loading', async () => {
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [
        { name: 'a.txt', path: 'a.txt', type: 'file', size: 3 },
        { name: 'b.txt', path: 'b.txt', type: 'file', size: 3 },
      ],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    const second = deferred<FileContent>()
    vi.mocked(projectFoldersApi.file)
      .mockResolvedValueOnce({ path: 'a.txt', content: 'aa\n', size: 3, line_count: 2, sha256: 'a'.repeat(64), encoding: 'utf8', writable: true })
      .mockReturnValueOnce(second.promise as never)

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /a\.txt/ }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'File path' })).toHaveValue('a.txt'))

    fireEvent.click(screen.getByRole('button', { name: /b\.txt/ }))
    expect(screen.getByRole('textbox', { name: 'File path' })).toHaveValue('a.txt')

    second.resolve({ path: 'b.txt', content: 'bb\n', size: 3, line_count: 2, sha256: 'b'.repeat(64), encoding: 'utf8', writable: true })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'File path' })).toHaveValue('b.txt'))
  })

  /** The message freezes the decoded body, so the attachment must describe
   *  that body. A BOM-marked file's bytes on disk are three longer and hash
   *  differently, and admission rejected every one of them. */
  it('attaches a BOM-marked file by its decoded body, not by its bytes on disk', async () => {
    const body = 'hello\n'
    const diskSha = 'd'.repeat(64)
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [{ name: 'notes.md', path: 'notes.md', type: 'file', size: 9 }],
    })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file).mockResolvedValue({
      path: 'notes.md', content: body, size: 9, line_count: 2, sha256: diskSha,
      encoding: 'utf8', has_bom: true, writable: true, line_ending_mode: 'lf',
    })
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([{
      id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1',
      execution_host_kind: 'server', display_path: '/managed/source', root_path: '/managed/source',
      branch: null, git_head: null, dirty: false, status: 'active',
      execution_ready: true, last_seen_at: null, created_at: '', updated_at: '',
      host_name: 'Server', host_online: true, host_owner_is_me: true,
    }] as never)

    let attachment: CurrentFileAttachment | null = null
    renderPage('/projects/project-1/files', undefined, undefined, next => { attachment = next })

    fireEvent.click(await screen.findByRole('button', { name: /notes\.md/ }))
    await waitFor(() => expect(attachment?.relativePath).toBe('notes.md'))

    let part: Awaited<ReturnType<CurrentFileAttachment['flushForSend']>> = null
    await act(async () => { part = await attachment!.flushForSend() })

    expect(part).toMatchObject({
      kind: 'input_resource', source_state: 'saved', relative_path: 'notes.md',
      byte_size: new TextEncoder().encode(body).byteLength,
      sha256: await sha256Utf8(body),
    })
    expect((part as { sha256?: string } | null)?.sha256).not.toBe(diskSha)
  })

  it('keeps editing active and offers History with Restore as draft instead of rollback', async () => {
    const originalHash = 'a'.repeat(64)
    const revision = { id: 'revision-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1', path: 'README.md', before_exists: true, after_exists: true, after_sha256: 'b'.repeat(64), created_at: '', expires_at: '', status: 'available' as const }
    vi.mocked(projectFoldersApi.list).mockResolvedValue({
      items: [folder('folder-1', 'Source')], total: 1, limit: 200, offset: 0,
    })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({ name: 'source', path: '.', type: 'dir', children: [{ name: 'README.md', path: 'README.md', type: 'file', size: 8 }] })
    vi.mocked(projectFoldersApi.gitStatus).mockResolvedValue({ is_repo: false, branch: null, files: [] })
    vi.mocked(projectFoldersApi.file).mockResolvedValue({ path: 'README.md', content: 'before\n', size: 7, line_count: 2, sha256: originalHash, encoding: 'utf8', writable: true, line_ending_mode: 'lf' })
    vi.mocked(projectFoldersApi.fileRevisions).mockResolvedValue([revision])
    vi.mocked(projectFoldersApi.previewRevision).mockResolvedValue({ revision, content: 'before\n' })
    vi.mocked(projectFoldersApi.restoreRevisionAsDraft).mockResolvedValue({
      id: 'draft-1', space_id: 'space-1', project_id: 'project-1', project_folder_id: 'folder-1', workspace_location_id: 'location-1', owner_user_id: 'user-1',
      target_kind: 'existing', relative_path: 'README.md', base_exists: true, base_sha256: originalHash, content: 'before\n', content_sha256: 'c'.repeat(64), byte_size: 7, version: 1,
      source_encoding: 'utf8', preserve_bom: false, line_ending_mode: 'lf', created_at: '', updated_at: '', expires_at: '',
    })

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /README\.md/ }))
    expect(await screen.findByText('before')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'File content' })).toHaveAttribute('contenteditable', 'true')
    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('button', { name: /previous content/ }))
    expect(await screen.findByText('Restore as draft')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore as draft' }))
    await waitFor(() => expect(projectFoldersApi.restoreRevisionAsDraft).toHaveBeenCalledWith('project-1', 'folder-1', 'revision-1'))
  })
})
