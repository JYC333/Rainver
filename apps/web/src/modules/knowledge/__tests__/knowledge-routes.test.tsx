import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

// ── Mocks (hoisted by vitest above the imports below) ──────────────────────
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [{ id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' }],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'personal-1',
    activeSpaceName: 'My Personal',
    preferredSpaceId: 'personal-1',
  }),
}))

vi.mock('../../../api/client', () => {
  const emptyPage = { items: [], total: 0 }
  const collections = [
    {
      id: 'col-inbox',
      space_id: 'personal-1',
      parent_id: null,
      name: 'Inbox',
      system_role: 'inbox',
      sort_order: 0,
      is_system: true,
      is_hidden: false,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'col-custom',
      space_id: 'personal-1',
      parent_id: null,
      name: 'Client Research',
      system_role: 'normal',
      sort_order: 100,
      is_system: false,
      is_hidden: false,
      created_at: '',
      updated_at: '',
    },
    {
      id: 'col-archive',
      space_id: 'personal-1',
      parent_id: null,
      name: 'Archive',
      system_role: 'archive',
      sort_order: 200,
      is_system: true,
      is_hidden: false,
      created_at: '',
      updated_at: '',
    },
  ]
  return {
    focusAreasApi: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      contents: vi.fn(),
      setForObject: vi.fn(),
      setForProject: vi.fn(),
    },
    projectsApi: { list: vi.fn().mockResolvedValue(emptyPage) },
    notesCollectionsApi: {
      list: vi.fn().mockResolvedValue(collections),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    notesTreeApi: {
      reorder: vi.fn().mockResolvedValue({ kind: 'notes', updated: 0 }),
    },
    notesApi: {
      list: vi.fn().mockResolvedValue(emptyPage),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      purgeDeleted: vi.fn(),
      links: vi.fn().mockResolvedValue([]),
      backlinks: vi.fn().mockResolvedValue([]),
      shares: vi.fn().mockResolvedValue([]),
      revokeShare: vi.fn(),
      addPlacement: vi.fn(),
      removePlacement: vi.fn(),
    },
    knowledgeApi: {
      list: vi.fn().mockResolvedValue(emptyPage),
      summary: vi.fn().mockResolvedValue({
        notes: { active: 0, archived: 0, deleted: 0, total: 0 },
        wiki: { active: 0 },
        sources: { total: 0 },
      }),
    },
    knowledgeSourcesApi: { list: vi.fn().mockResolvedValue(emptyPage) },
    objectSchemaApi: {
      listKinds: vi.fn().mockResolvedValue(emptyPage),
    },
  }
})

vi.mock('../../../components/editor', async () => {
  const React = await import('react')
  const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] }
  const savedDoc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved rich text' }] }],
  }
  return {
    RichTextEditor: React.forwardRef(function MockRichTextEditor(
      props: { initialContent: Record<string, unknown> },
      ref: React.ForwardedRef<{ getSnapshot: () => Record<string, unknown>; focus: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({
        getSnapshot: () => ({
          content_json: savedDoc,
          content_format: 'prosemirror_json',
          content_schema_version: 1,
        }),
        focus: vi.fn(),
      }))
      return React.createElement('div', { 'data-testid': 'rich-text-editor' }, JSON.stringify(props.initialContent))
    }),
    emptyRichTextDocument: vi.fn(() => emptyDoc),
    normalizeNoteDocument: vi.fn((note: { content_json: Record<string, unknown> | null; plain_text: string | null }) => (
      note.content_json ?? {
        type: 'doc',
        content: note.plain_text
          ? [{ type: 'paragraph', content: [{ type: 'text', text: note.plain_text }] }]
          : [{ type: 'paragraph' }],
      }
    )),
    richTextSnapshotFromDocument: vi.fn((doc: Record<string, unknown>) => ({
      content_json: doc,
      content_format: 'prosemirror_json',
      content_schema_version: 1,
    })),
    HistoryChip: ({ onClick }: { active: boolean; onClick: () => void }) =>
      React.createElement('button', { type: 'button', onClick }, 'History'),
    AiEditBanner: ({ onUndo }: { runId: string; onUndo: () => void }) =>
      React.createElement('button', { type: 'button', onClick: onUndo }, 'Undo AI change'),
    NoteRevisionHistory: () => React.createElement('div', { 'data-testid': 'note-revision-history' }),
  }
})

import KnowledgeModule from '../KnowledgeModule'
import { KNOWLEDGE_SECTIONS } from '../KnowledgeSectionHeader'
import { readLastKnowledgeSection, rememberKnowledgeSection } from '../utils'
import { MODULE_REGISTRY } from '../../registry'
import { RAIL_ITEMS } from '../../../core/navigation'
import { notesApi, notesCollectionsApi } from '../../../api/client'
import type { EntityLink, Note } from '../../../types/api'

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

function renderAt(path: string) {
  return render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <LocationProbe />
      <Routes>
        <Route path="/spaces/:spaceId/knowledge/*" element={<KnowledgeModule />} />
      </Routes>
    </MemoryRouter>,
  )
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    space_id: 'personal-1',
    title: 'Untitled note',
    excerpt: null,
    status: 'active',
    content_format: 'prosemirror_json',
    content_json: { type: 'doc', content: [{ type: 'paragraph' }] },
    content_schema_version: 1,
    plain_text: null,
    primary_project_id: null,
    project_role: null,
    role_project_id: null,
    placements: [],
    version: 1,
    content_hash: null,
    updated_by_user_id: null,
    updated_by_run_id: null,
    created_from_activity_id: null,
    created_by_user_id: null,
    created_at: '',
    updated_at: '',
    archived_at: null,
    deleted_at: null,
    ...overrides,
  }
}

function makeLink(overrides: Partial<EntityLink> = {}): EntityLink {
  return {
    id: 'link-1',
    space_id: 'personal-1',
    source_type: 'note',
    source_id: 'note-alpha',
    target_type: 'note',
    target_id: 'note-beta',
    link_type: 'related_to',
    confidence: null,
    status: 'accepted',
    created_by_user_id: null,
    created_at: '',
    ...overrides,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
})

describe('Knowledge section switcher catalog', () => {
  it('lists exactly Knowledge Home, Notes, Wiki, Sources, Cards, Domains', () => {
    expect(KNOWLEDGE_SECTIONS.map(s => s.id)).toEqual(['home', 'notes', 'wiki', 'sources', 'cards', 'domains'])
    expect(KNOWLEDGE_SECTIONS.map(s => s.label)).toEqual(['Knowledge Home', 'Notes', 'Wiki', 'Sources', 'Cards', 'Domains'])
  })

  // Domains is a focus-area surface parked under Knowledge because the section
  // taxonomy is functional and has no home for a life-area grouping yet. Its
  // placement is a stopgap; that it is *reachable* is not — this renders the
  // route because the defect it guards against (a splat mount with no nested
  // Routes) is invisible to an assertion on the catalog constant.
  it('renders Domains at its own route', async () => {
    expect(KNOWLEDGE_SECTIONS.find(s => s.id === 'domains')?.to).toBe('/knowledge/domains')
    renderAt('/spaces/personal-1/knowledge/domains')
    expect(await screen.findByText('No domains yet')).toBeInTheDocument()
  })

  it('keeps Wiki backed by the KnowledgeItem route', () => {
    expect(KNOWLEDGE_SECTIONS.find(s => s.id === 'wiki')?.to).toBe('/knowledge/wiki')
  })
})

describe('last-used Knowledge section', () => {
  it('defaults to notes on a fresh client', () => {
    expect(readLastKnowledgeSection()).toBe('notes')
  })

  it('remembers the last section', () => {
    rememberKnowledgeSection('wiki')
    expect(readLastKnowledgeSection()).toBe('wiki')
  })

  it('never persists the overview (home) as the redirect target', () => {
    rememberKnowledgeSection('sources')
    rememberKnowledgeSection('home')
    expect(readLastKnowledgeSection()).toBe('sources')
  })
})

describe('Knowledge replaces the first-level Wiki', () => {
  it('registers a first-level Knowledge module and no first-level /wiki route', () => {
    const paths = MODULE_REGISTRY.map(m => m.path)
    expect(paths).toContain('/knowledge')
    expect(paths).not.toContain('/wiki')
    const knowledge = MODULE_REGISTRY.find(m => m.path === '/knowledge')
    expect(knowledge?.label).toBe('Knowledge')
    expect(knowledge?.hasSubRoutes).toBe(true)
  })

  it('shows Knowledge — not Wiki — in the global rail', () => {
    const wikiRail = RAIL_ITEMS.filter(i => i.label.toLowerCase() === 'wiki' || i.to === '/wiki')
    expect(wikiRail).toHaveLength(0)
    const knowledge = RAIL_ITEMS.find(i => i.id === 'knowledge')
    expect(knowledge?.label).toBe('Knowledge')
    expect(knowledge?.to).toBe('/knowledge')
  })
})

describe('Knowledge routing', () => {
  it('redirects /knowledge to the default section (notes)', async () => {
    renderAt('/spaces/personal-1/knowledge')
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes'))
  })

  it('redirects /knowledge to the last-used workspace', async () => {
    rememberKnowledgeSection('sources')
    renderAt('/spaces/personal-1/knowledge')
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/sources'))
  })

  it('renders Knowledge Home at /knowledge/home', async () => {
    renderAt('/spaces/personal-1/knowledge/home')
    expect(await screen.findByText('Continue working')).toBeInTheDocument()
  })

  it('renders the Notes section shell at /knowledge/notes', async () => {
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    expect(within(tree).getByText('Inbox')).toBeInTheDocument()
    expect(within(tree).getByText('Client Research')).toBeInTheDocument()
    expect(within(tree).getByText('Archive')).toBeInTheDocument()
    expect(tree).not.toHaveTextContent('system_role')
    expect(screen.getByLabelText('Switch Knowledge section')).toBeInTheDocument()
  })

  it('creates a normal folder without exposing system metadata in the request', async () => {
    vi.mocked(notesCollectionsApi.create).mockImplementationOnce(async body => ({
      id: body.id!,
      space_id: 'personal-1',
      parent_id: body.parent_id ?? null,
      name: body.name,
      system_role: 'normal',
      sort_order: body.sort_order!,
      is_system: false,
      is_hidden: false,
      created_at: '',
      updated_at: '',
    }))
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    expect(within(tree).getByText('Client Research')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /new folder/i })[0])
    fireEvent.change(screen.getByPlaceholderText('Folder name'), { target: { value: 'Ideas' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(within(tree).getByText('Ideas')).toBeInTheDocument()
    await waitFor(() => expect(notesCollectionsApi.create).toHaveBeenCalledWith({
      id: expect.any(String),
      name: 'Ideas',
      parent_id: null,
      sort_order: 201,
    }))
    expect(notesCollectionsApi.list).toHaveBeenCalledTimes(1)
  })

  it('removes a folder optimistically without reloading the tree', async () => {
    const user = userEvent.setup()
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    expect(within(tree).getByText('Client Research')).toBeInTheDocument()

    await user.click(within(tree).getByRole('button', { name: 'Folder actions for Client Research' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))

    expect(within(tree).queryByText('Client Research')).not.toBeInTheDocument()
    await waitFor(() => expect(notesCollectionsApi.delete).toHaveBeenCalledWith('col-custom'))
    expect(notesCollectionsApi.list).toHaveBeenCalledTimes(1)
  })

  it('reloads notes for the selected backend collection', async () => {
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    fireEvent.click(within(tree).getByText('Client Research'))

    await waitFor(() =>
      expect(notesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ collection_id: 'col-custom' })))
  })

  it('creates an active note in Inbox and opens it immediately', async () => {
    vi.mocked(notesApi.create).mockResolvedValueOnce(makeNote({ id: 'note-inbox', status: 'active' }))
    renderAt('/spaces/personal-1/knowledge/notes')
    await screen.findByLabelText('Notes organization')

    fireEvent.click(screen.getAllByRole('button', { name: /new note/i })[0])

    await waitFor(() =>
      expect(notesApi.create).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Untitled note',
        status: 'active',
        collection_id: 'col-inbox',
        content_format: 'prosemirror_json',
        content_schema_version: 1,
      })))
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes/note-inbox'))
  })

  it('creates active notes in normal collections', async () => {
    vi.mocked(notesApi.create).mockResolvedValueOnce(makeNote({ id: 'note-custom', status: 'active' }))
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    fireEvent.click(within(tree).getByText('Client Research'))

    fireEvent.click(screen.getAllByRole('button', { name: /new note/i })[0])

    await waitFor(() =>
      expect(notesApi.create).toHaveBeenCalledWith(expect.objectContaining({
        status: 'active',
        collection_id: 'col-custom',
      })))
  })

  it('creates new notes in the active note collection after route sync', async () => {
    const beta = makeNote({ id: 'note-beta', title: 'Beta note', status: 'active', placements: [{ collection_id: 'col-custom', sort_order: 0 }] })
    vi.mocked(notesApi.get).mockResolvedValue(beta)
    vi.mocked(notesApi.list).mockResolvedValue({ items: [beta], total: 1, limit: 200, offset: 0 })
    vi.mocked(notesApi.create).mockResolvedValueOnce(makeNote({
      id: 'note-new',
      status: 'active',
      placements: [{ collection_id: 'col-custom', sort_order: 0 }],
    }))

    try {
      renderAt('/spaces/personal-1/knowledge/notes/note-beta')

      expect(await screen.findByDisplayValue('Beta note')).toBeInTheDocument()
      await waitFor(() =>
        expect(notesApi.list).toHaveBeenCalledWith(expect.objectContaining({ collection_id: 'col-custom' })))

      fireEvent.click(screen.getAllByRole('button', { name: /new note/i })[0])

      await waitFor(() =>
        expect(notesApi.create).toHaveBeenCalledWith(expect.objectContaining({
          status: 'active',
          collection_id: 'col-custom',
        })))
    } finally {
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
    }
  })

  it('leaves the active note route when selecting a folder from the tree', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    vi.mocked(notesApi.get).mockResolvedValue(alpha)
    vi.mocked(notesApi.list).mockResolvedValue({ items: [alpha], total: 1, limit: 200, offset: 0 })

    try {
      renderAt('/spaces/personal-1/knowledge/notes/note-alpha')

      expect(await screen.findByDisplayValue('Alpha note')).toBeInTheDocument()
      const tree = await screen.findByLabelText('Notes organization')
      fireEvent.click(within(tree).getByRole('button', { name: 'Client Research' }))

      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes'))
      expect(screen.queryByDisplayValue('Alpha note')).not.toBeInTheDocument()
    } finally {
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
    }
  })

  it('does not create new notes in Archive', async () => {
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')
    fireEvent.click(within(tree).getByText('Archive'))
    await waitFor(() =>
      expect(notesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
        collection_id: 'col-archive',
        status: 'archived',
      })))

    const newNoteButton = screen.getAllByRole('button', { name: /new note/i })[0]
    expect(newNoteButton).toBeDisabled()
    fireEvent.click(newNoteButton)

    expect(notesApi.create).not.toHaveBeenCalled()
  })

  it('creates an active note without collection_id when no collection is selected', async () => {
    vi.mocked(notesCollectionsApi.list).mockResolvedValueOnce([])
    vi.mocked(notesApi.create).mockResolvedValueOnce(makeNote({ id: 'note-default', status: 'active' }))
    renderAt('/spaces/personal-1/knowledge/notes')
    await screen.findByText('No note folders')

    fireEvent.click(screen.getAllByRole('button', { name: /new note/i })[0])

    await waitFor(() => expect(notesApi.create).toHaveBeenCalled())
    const body = vi.mocked(notesApi.create).mock.calls[0][0]
    expect(body).toEqual(expect.objectContaining({ title: 'Untitled note', status: 'active' }))
    expect(body).not.toHaveProperty('collection_id')
  })

  it('keeps open note tabs in the Chrome-style equal-width tab contract', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note' })
    const beta = makeNote({ id: 'note-beta', title: 'Beta note' })
    vi.mocked(notesApi.get)
      .mockImplementation(async id => (id === 'note-alpha' ? alpha : beta))
    sessionStorage.setItem('agent-space:notes-tabs:personal-1:all', JSON.stringify(['note-alpha', 'note-beta']))

    try {
      renderAt('/spaces/personal-1/knowledge/notes/note-beta')

      const tablist = await screen.findByRole('tablist', { name: 'Open notes' })
      expect(tablist).toHaveClass('note-tabs-strip')
      const alphaTab = within(tablist).getByRole('tab', { name: 'Untitled note' })
      const betaTab = await within(tablist).findByRole('tab', { name: 'Beta note' })
      const alphaShell = alphaTab.closest('.note-tab')
      const betaShell = betaTab.closest('.note-tab')

      expect(alphaShell).toHaveClass('basis-44', 'shrink', 'grow-0')
      expect(alphaShell).not.toHaveClass('note-tab--active')
      expect(betaShell).toHaveClass('note-tab--active')
      expect(betaShell?.querySelector('.note-tab__bg')).toBeInTheDocument()
      expect(alphaShell?.querySelector('.note-tab__hover')).toBeInTheDocument()
      expect(alphaTab).toHaveClass('absolute', 'inset-0')

      fireEvent.click(alphaTab)
      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes/note-alpha'))
      expect(alphaShell).toHaveClass('note-tab--active')

      fireEvent.click(within(betaShell as HTMLElement).getByRole('button', { name: 'Close Beta note' }))
      await waitFor(() =>
        expect(within(tablist).queryByRole('tab', { name: 'Beta note' })).not.toBeInTheDocument())
      expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes/note-alpha')
    } finally {
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
    }
  })

  it('deletes notes from the tree with Delete or the right-click menu', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    const beta = makeNote({ id: 'note-beta', title: 'Beta note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    const notesPage = { items: [alpha, beta], total: 2, limit: 200, offset: 0 }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    vi.mocked(notesApi.get)
      .mockImplementation(async id => (id === 'note-alpha' ? alpha : beta))
    vi.mocked(notesApi.list).mockResolvedValue(notesPage)
    vi.mocked(notesApi.delete)
      .mockResolvedValueOnce({ ...alpha, status: 'deleted', deleted_at: '2026-06-09T00:00:00Z' })
      .mockResolvedValueOnce({ ...beta, status: 'deleted', deleted_at: '2026-06-09T00:00:00Z' })
    sessionStorage.setItem('agent-space:notes-tabs:personal-1:all', JSON.stringify(['note-alpha', 'note-beta']))

    try {
      renderAt('/spaces/personal-1/knowledge/notes/note-beta')

      expect(await screen.findByDisplayValue('Beta note')).toBeInTheDocument()
      const tree = await screen.findByLabelText('Notes organization')
      const alphaTreeItem = await within(tree).findByRole('button', { name: 'Alpha note' })
      const betaTreeItem = await within(tree).findByRole('button', { name: 'Beta note' })
      const tablist = await screen.findByRole('tablist', { name: 'Open notes' })

      fireEvent.keyDown(alphaTreeItem, { key: 'Delete' })
      await waitFor(() => expect(notesApi.delete).toHaveBeenCalledWith('note-alpha'))
      await waitFor(() => expect(within(tablist).getAllByRole('tab')).toHaveLength(1))
      expect(within(tree).queryByRole('button', { name: 'Alpha note' })).not.toBeInTheDocument()
      expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes/note-beta')
      expect(confirmSpy).not.toHaveBeenCalled()

      fireEvent.contextMenu(betaTreeItem, { clientX: 12, clientY: 24 })
      const menu = await screen.findByRole('menu', { name: 'Beta note actions' })
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))

      await waitFor(() => expect(notesApi.delete).toHaveBeenCalledWith('note-beta'))
      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes'))
      expect(screen.queryByRole('tablist', { name: 'Open notes' })).not.toBeInTheDocument()
    } finally {
      confirmSpy.mockRestore()
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
      vi.mocked(notesApi.delete).mockReset()
    }
  })

  it('does not show archived notes in the note tree by default', async () => {
    const active = makeNote({ id: 'note-active', title: 'Active note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }], status: 'active' })
    const archived = makeNote({ id: 'note-archived', title: 'Archived note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }], status: 'archived' })
    vi.mocked(notesApi.list).mockResolvedValue({ items: [active, archived], total: 2, limit: 200, offset: 0 })

    try {
      renderAt('/spaces/personal-1/knowledge/notes')

      const tree = await screen.findByLabelText('Notes organization')
      expect(await within(tree).findByRole('button', { name: 'Active note' })).toBeInTheDocument()
      expect(within(tree).queryByRole('button', { name: 'Archived note' })).not.toBeInTheDocument()
    } finally {
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
    }
  })

  it('archives notes from the tree context menu and closes open tabs', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    let archived = false
    vi.mocked(notesApi.get).mockResolvedValue(alpha)
    vi.mocked(notesApi.list).mockImplementation(async () => ({
      items: [archived ? { ...alpha, status: 'archived' as const } : alpha],
      total: 1,
      limit: 200,
      offset: 0,
    }))
    vi.mocked(notesApi.update).mockImplementationOnce(async () => {
      archived = true
      return { ...alpha, status: 'archived', archived_at: '2026-06-09T00:00:00Z' }
    })
    sessionStorage.setItem('agent-space:notes-tabs:personal-1:all', JSON.stringify(['note-alpha']))

    try {
      renderAt('/spaces/personal-1/knowledge/notes/note-alpha')

      expect(await screen.findByDisplayValue('Alpha note')).toBeInTheDocument()
      const tree = await screen.findByLabelText('Notes organization')
      const alphaTreeItem = await within(tree).findByRole('button', { name: 'Alpha note' })
      fireEvent.contextMenu(alphaTreeItem, { clientX: 12, clientY: 24 })
      const menu = await screen.findByRole('menu', { name: 'Alpha note actions' })
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }))

      await waitFor(() =>
        expect(notesApi.update).toHaveBeenCalledWith('note-alpha', { status: 'archived' }))
      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes'))
      expect(within(tree).queryByRole('button', { name: 'Alpha note' })).not.toBeInTheDocument()
      expect(screen.queryByRole('tablist', { name: 'Open notes' })).not.toBeInTheDocument()
    } finally {
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
      vi.mocked(notesApi.update).mockReset()
    }
  })

  it('bulk deletes a Shift-selected note range from the tree', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }], updated_at: '2025-04-01T00:00:00Z' })
    const beta = makeNote({ id: 'note-beta', title: 'Beta note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }], updated_at: '2025-03-01T00:00:00Z' })
    const gamma = makeNote({ id: 'note-gamma', title: 'Gamma note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }], updated_at: '2025-02-01T00:00:00Z' })
    const notesPage = { items: [alpha, beta, gamma], total: 3, limit: 200, offset: 0 }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    vi.mocked(notesApi.get).mockImplementation(async id => (
      id === 'note-alpha' ? alpha : id === 'note-beta' ? beta : gamma
    ))
    vi.mocked(notesApi.list).mockResolvedValue(notesPage)
    vi.mocked(notesApi.delete)
      .mockResolvedValueOnce({ ...alpha, status: 'deleted', deleted_at: '2026-06-09T00:00:00Z' })
      .mockResolvedValueOnce({ ...beta, status: 'deleted', deleted_at: '2026-06-09T00:00:00Z' })
      .mockResolvedValueOnce({ ...gamma, status: 'deleted', deleted_at: '2026-06-09T00:00:00Z' })

    try {
      renderAt('/spaces/personal-1/knowledge/notes')

      const tree = await screen.findByLabelText('Notes organization')
      fireEvent.click(await within(tree).findByRole('button', { name: 'Alpha note' }))
      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes/note-alpha'))

      const gammaTreeItem = within(tree).getByRole('button', { name: 'Gamma note' })
      fireEvent.click(gammaTreeItem, { shiftKey: true })
      fireEvent.keyDown(gammaTreeItem, { key: 'Delete' })

      await waitFor(() => expect(notesApi.delete).toHaveBeenCalledTimes(3))
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(notesApi.delete).toHaveBeenCalledWith('note-alpha')
      expect(notesApi.delete).toHaveBeenCalledWith('note-beta')
      expect(notesApi.delete).toHaveBeenCalledWith('note-gamma')
      await waitFor(() =>
        expect(screen.getByTestId('loc')).toHaveTextContent('/spaces/personal-1/knowledge/notes'))
      expect(within(tree).queryByRole('button', { name: 'Alpha note' })).not.toBeInTheDocument()
      expect(screen.queryByRole('tablist', { name: 'Open notes' })).not.toBeInTheDocument()
    } finally {
      confirmSpy.mockRestore()
      vi.mocked(notesApi.get).mockResolvedValue(null as unknown as Note)
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
      vi.mocked(notesApi.delete).mockReset()
    }
  })

  it('uses a custom dialog before deleting notes with note-to-note links', async () => {
    const alpha = makeNote({ id: 'note-alpha', title: 'Alpha note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    const beta = makeNote({ id: 'note-beta', title: 'Beta note', placements: [{ collection_id: 'col-inbox', sort_order: 0 }] })
    const notesPage = { items: [alpha, beta], total: 2, limit: 200, offset: 0 }
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    vi.mocked(notesApi.list).mockResolvedValue(notesPage)
    vi.mocked(notesApi.links).mockImplementation(async id => (
      id === 'note-alpha' ? [makeLink({ id: 'link-alpha-beta' })] : []
    ))
    vi.mocked(notesApi.backlinks).mockResolvedValue([])
    vi.mocked(notesApi.delete).mockResolvedValueOnce({
      ...alpha,
      status: 'deleted',
      deleted_at: '2026-06-09T00:00:00Z',
    })

    try {
      renderAt('/spaces/personal-1/knowledge/notes')

      const tree = await screen.findByLabelText('Notes organization')
      const alphaTreeItem = await within(tree).findByRole('button', { name: 'Alpha note' })
      fireEvent.keyDown(alphaTreeItem, { key: 'Delete' })

      expect(await screen.findByText('Delete linked note?')).toBeInTheDocument()
      expect(notesApi.delete).not.toHaveBeenCalled()
      expect(confirmSpy).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))

      await waitFor(() => expect(notesApi.delete).toHaveBeenCalledWith('note-alpha'))
      expect(within(tree).queryByRole('button', { name: 'Alpha note' })).not.toBeInTheDocument()
    } finally {
      confirmSpy.mockRestore()
      vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
      vi.mocked(notesApi.links).mockResolvedValue([])
      vi.mocked(notesApi.backlinks).mockResolvedValue([])
      vi.mocked(notesApi.delete).mockReset()
    }
  })

  it('auto-saves edits through the rich text wrapper snapshot', async () => {
    vi.mocked(notesApi.get).mockResolvedValueOnce(makeNote({
      id: 'note-markdown',
      title: 'Markdown note',
      content_format: 'markdown',
      content_json: null,
      plain_text: 'Markdown body',
      status: 'active',
    }))
    vi.mocked(notesApi.update).mockResolvedValueOnce(makeNote({
      id: 'note-markdown',
      title: 'Markdown note edited',
      status: 'active',
    }))

    renderAt('/spaces/personal-1/knowledge/notes/note-markdown')

    expect(await screen.findByDisplayValue('Markdown note')).toBeInTheDocument()
    expect(screen.getByTestId('rich-text-editor')).toHaveTextContent('Markdown body')

    // Editing the title triggers a debounced auto-save — no Save button.
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Markdown note edited' } })

    await waitFor(
      () =>
        expect(notesApi.update).toHaveBeenCalledWith('note-markdown', expect.objectContaining({
          title: 'Markdown note edited',
          content_format: 'prosemirror_json',
          content_schema_version: 1,
        })),
      { timeout: 2000 },
    )
    const payload = vi.mocked(notesApi.update).mock.calls[0][1]
    expect(payload).toHaveProperty('content_json')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('plain_text')
  })

  /**
   * S2's substance (U4). Hoisting that filtered only what is drawn, while a
   * search still spanned every Project, would be the wrong half of the feature.
   */
  it('narrows the tree and the note search to the hoisted subtree', async () => {
    const user = userEvent.setup()
    const nested = {
      id: 'col-nested',
      space_id: 'personal-1',
      parent_id: 'col-custom',
      name: 'Interviews',
      system_role: 'normal' as const,
      sort_order: 0,
      is_system: false,
      is_hidden: false,
      created_at: '',
      updated_at: '',
    }
    const listed = await vi.mocked(notesCollectionsApi.list)()
    vi.mocked(notesCollectionsApi.list).mockResolvedValue([...listed, nested])

    try {
      renderAt('/spaces/personal-1/knowledge/notes')
      const tree = await screen.findByLabelText('Notes organization')
      await within(tree).findByText('Interviews')

      await user.click(within(tree).getByRole('button', { name: 'Folder actions for Client Research' }))
      const menu = await screen.findByRole('menu')
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Focus on this folder' }))

      // The tree is the hoisted subtree and nothing else.
      await waitFor(() => expect(within(tree).queryByText('Inbox')).not.toBeInTheDocument())
      expect(within(tree).queryByText('Archive')).not.toBeInTheDocument()
      expect(within(tree).getByRole('button', { name: 'Client Research' })).toBeInTheDocument()
      expect(within(tree).getByRole('button', { name: 'Interviews' })).toBeInTheDocument()

      fireEvent.change(screen.getByPlaceholderText('Search notes'), { target: { value: 'protocol' } })

      await waitFor(() => expect(notesApi.list).toHaveBeenLastCalledWith(expect.objectContaining({
        q: 'protocol',
        collection_ids: expect.arrayContaining(['col-custom', 'col-nested']),
      })))
      const searchCall = vi.mocked(notesApi.list).mock.lastCall![0]!
      expect(searchCall.collection_ids).toHaveLength(2)
      expect(searchCall.collection_ids).not.toContain('col-inbox')
      expect(searchCall.collection_ids).not.toContain('col-archive')
    } finally {
      vi.mocked(notesCollectionsApi.list).mockResolvedValue(listed)
    }
  })

  it('leaves the hoisted subtree when focus is exited', async () => {
    const user = userEvent.setup()
    renderAt('/spaces/personal-1/knowledge/notes')
    const tree = await screen.findByLabelText('Notes organization')

    await user.click(within(tree).getByRole('button', { name: 'Folder actions for Client Research' }))
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Focus on this folder' }))
    await waitFor(() => expect(within(tree).queryByText('Inbox')).not.toBeInTheDocument())

    fireEvent.click(within(tree).getByRole('button', { name: 'Exit focus on Client Research' }))

    await waitFor(() => expect(within(tree).getByText('Inbox')).toBeInTheDocument())
    expect(within(tree).getByText('Archive')).toBeInTheDocument()
  })

  it('renders the Wiki section (KnowledgeItem-backed) at /knowledge/wiki', async () => {
    renderAt('/spaces/personal-1/knowledge/wiki')
    expect(await screen.findByText(/powered by KnowledgeItems/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Switch Knowledge section')).toBeInTheDocument()
  })
})
