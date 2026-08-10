import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'personal-1',
    activeSpaceName: 'My Personal',
    preferredSpaceId: 'personal-1',
  }),
}))

vi.mock('../../../../api/client', () => {
  const emptyPage = { items: [], total: 0, limit: 200, offset: 0 }
  const collection = (over: Record<string, unknown>) => ({
    space_id: 'personal-1', parent_id: null, name: 'Folder', system_role: 'normal',
    sort_order: 0, is_system: false, is_hidden: false, created_at: '', updated_at: '', ...over,
  })
  const collections = [
    collection({ id: 'col-inbox', name: 'Inbox', system_role: 'inbox', is_system: true }),
    collection({ id: 'col-project', name: 'Study', system_role: 'project', is_system: true, project_id: 'project-1' }),
    collection({ id: 'col-project-sub', name: 'Experiments', parent_id: 'col-project' }),
    collection({ id: 'col-other', name: 'Other project', system_role: 'project', is_system: true, project_id: 'project-2' }),
  ]
  return {
    ApiRequestError: class ApiRequestError extends Error { status = 0 },
    notesCollectionsApi: {
      list: vi.fn().mockResolvedValue(collections),
      ensureForProject: vi.fn().mockResolvedValue(collections[1]),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    },
    notesTreeApi: { reorder: vi.fn() },
    notesApi: {
      list: vi.fn().mockResolvedValue(emptyPage),
      get: vi.fn().mockResolvedValue({
        id: 'note-7', space_id: 'personal-1', title: 'Experiment log', excerpt: null, status: 'active',
        content_format: 'prosemirror_json', content_json: {}, content_schema_version: 1, plain_text: null,
        primary_project_id: 'project-1', project_role: null, role_project_id: null, placements: [],
        version: 1, content_hash: null, updated_by_user_id: null, updated_by_run_id: null,
        created_from_activity_id: null, created_by_user_id: null, created_at: '', updated_at: '',
        archived_at: null, deleted_at: null,
      }),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
      revisions: vi.fn().mockResolvedValue([]), rollback: vi.fn(),
      createLink: vi.fn(), deleteLink: vi.fn(), promote: vi.fn(),
      links: vi.fn().mockResolvedValue([]), backlinks: vi.fn().mockResolvedValue([]),
      shares: vi.fn().mockResolvedValue([]), revokeShare: vi.fn(),
      addPlacement: vi.fn(), removePlacement: vi.fn(),
    },
    knowledgeApi: { list: vi.fn().mockResolvedValue(emptyPage), search: vi.fn().mockResolvedValue({ items: [] }) },
    inquiryApi: { raiseFromNote: vi.fn() },
    providersApi: { list: vi.fn().mockResolvedValue([]) },
    sessionsApi: { messages: vi.fn().mockResolvedValue([]) },
    projectNotebookChatApi: { send: vi.fn() },
  }
})

vi.mock('../../../../components/editor', async () => {
  const React = await import('react')
  return {
    RichTextEditor: React.forwardRef(function MockRichTextEditor(_props: unknown, ref: React.ForwardedRef<unknown>) {
      React.useImperativeHandle(ref, () => ({ getSnapshot: () => ({}), focus: vi.fn() }))
      return React.createElement('div', { 'data-testid': 'rich-text-editor' })
    }),
    emptyRichTextDocument: vi.fn(() => ({})),
    normalizeNoteDocument: vi.fn(() => ({})),
    richTextSnapshotFromDocument: vi.fn(() => ({})),
    HistoryChip: () => React.createElement('button', { type: 'button' }, 'History'),
    AiEditBanner: () => React.createElement('div'),
    NoteRevisionHistory: () => React.createElement('div'),
  }
})

import ProjectNotesPage from '../ProjectNotesPage'
import { notesApi, notesCollectionsApi } from '../../../../api/client'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{location.pathname}</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <LocationProbe />
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/notes/*" element={<ProjectNotesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  // jsdom does not implement Element.scrollTo, which the chat panel's thread
  // calls on mount.
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
})

/**
 * U1/U3: the Project's notes are the *same* page as `/knowledge/notes`, hoisted
 * to the Project's folder. The guardrail that matters is that there is one
 * implementation — the previous Project notebook was a weaker copy, and every
 * capability the shared editor grew stopped at its edge.
 */
describe('Project notes surface', () => {
  it('mounts the shared notes surface hoisted to the Project folder', async () => {
    renderAt('/spaces/personal-1/projects/project-1/notes')

    await waitFor(() => expect(notesCollectionsApi.ensureForProject).toHaveBeenCalledWith('project-1'))
    const tree = await screen.findByLabelText('Notes organization')

    // Only the Project's subtree — not the Space's Inbox, not another Project.
    expect(within(tree).getByRole('button', { name: 'Study' })).toBeInTheDocument()
    expect(within(tree).getByRole('button', { name: 'Experiments' })).toBeInTheDocument()
    expect(within(tree).queryByText('Inbox')).not.toBeInTheDocument()
    expect(within(tree).queryByText('Other project')).not.toBeInTheDocument()
  })

  it('narrows every note query to the Project subtree', async () => {
    renderAt('/spaces/personal-1/projects/project-1/notes')
    await screen.findByLabelText('Notes organization')

    await waitFor(() => expect(notesApi.list).toHaveBeenCalledWith(expect.objectContaining({
      collection_ids: expect.arrayContaining(['col-project', 'col-project-sub']),
    })))
    for (const [params] of vi.mocked(notesApi.list).mock.calls) {
      const scoped = params?.collection_ids ?? [params?.collection_id]
      expect(scoped).not.toContain('col-inbox')
      expect(scoped).not.toContain('col-other')
    }
  })

  it('offers no way out of the Project folder — the surface exists because of it', async () => {
    renderAt('/spaces/personal-1/projects/project-1/notes')
    const tree = await screen.findByLabelText('Notes organization')

    expect(within(tree).queryByRole('button', { name: /Exit focus/ })).not.toBeInTheDocument()
  })

  it('keeps the surface mounted when a note is opened', async () => {
    renderAt('/spaces/personal-1/projects/project-1/notes/note-7')

    expect(await screen.findByTestId('loc')).toHaveTextContent('/projects/project-1/notes/note-7')
    expect(await screen.findByLabelText('Notes organization')).toBeInTheDocument()
    await waitFor(() => expect(notesApi.get).toHaveBeenCalledWith('note-7'))
  })
})
