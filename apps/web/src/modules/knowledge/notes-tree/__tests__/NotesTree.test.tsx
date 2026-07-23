import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { NoteCollection, NoteSummary } from '../../../../types/api'
import NotesTree from '../NotesTree'

function makeCollection(overrides: Partial<NoteCollection> = {}): NoteCollection {
  return {
    id: 'col-1',
    space_id: 'personal-1',
    parent_id: null,
    name: 'Inbox',
    system_role: 'normal',
    sort_order: 0,
    is_system: false,
    is_hidden: false,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function makeNote(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: 'note-1',
    space_id: 'personal-1',
    title: 'Untitled note',
    excerpt: null,
    status: 'active',
    content_format: 'prosemirror_json',
    primary_project_id: null,
    collection_id: 'col-1',
    version: 1,
    content_hash: null,
    updated_by_user_id: null,
    updated_by_run_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
}

function appearsBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

function renderTree({
  collections = [makeCollection()],
  notes = [],
  selectedCollectionId = null,
  activeNoteId,
  collapsedCollectionIds = new Set<string>(),
  resolveNoteTitle = (id: string) => notes.find(note => note.id === id)?.title ?? id,
  onToggleCollection = vi.fn(),
  onSelectCollection = vi.fn(),
  onSelectNoteCollection = vi.fn(),
  onOpenNote = vi.fn(),
  onArchiveNote = vi.fn(),
  onArchiveNotes = vi.fn(),
  onDeleteNote = vi.fn(),
  onDeleteNotes = vi.fn(),
  onCreateChild = vi.fn(),
  onRename = vi.fn(),
  onMove = vi.fn(),
  onHide = vi.fn(),
  onDeleteCollection = vi.fn(),
  onDropCollections = vi.fn(),
  onDropNotes = vi.fn(),
}: Partial<ComponentProps<typeof NotesTree>> = {}) {
  const tree = (nextActiveNoteId = activeNoteId) => (
    <NotesTree
      collections={collections}
      notes={notes}
      selectedCollectionId={selectedCollectionId}
      activeNoteId={nextActiveNoteId}
      collapsedCollectionIds={collapsedCollectionIds}
      resolveNoteTitle={resolveNoteTitle}
      onToggleCollection={onToggleCollection}
      onSelectCollection={onSelectCollection}
      onSelectNoteCollection={onSelectNoteCollection}
      onOpenNote={onOpenNote}
      onArchiveNote={onArchiveNote}
      onArchiveNotes={onArchiveNotes}
      onDeleteNote={onDeleteNote}
      onDeleteNotes={onDeleteNotes}
      onCreateChild={onCreateChild}
      onRename={onRename}
      onMove={onMove}
      onHide={onHide}
      onDeleteCollection={onDeleteCollection}
      onDropCollections={onDropCollections}
      onDropNotes={onDropNotes}
    />
  )
  const rendered = render(tree())

  return {
    onToggleCollection,
    onSelectCollection,
    onSelectNoteCollection,
    onOpenNote,
    onArchiveNote,
    onArchiveNotes,
    onDeleteNote,
    onDeleteNotes,
    onCreateChild,
    onRename,
    onMove,
    onHide,
    onDeleteCollection,
    onDropCollections,
    onDropNotes,
    rerenderWithActiveNote: (nextActiveNoteId?: string) => rendered.rerender(tree(nextActiveNoteId)),
  }
}

describe('NotesTree', () => {
  it('sorts folders by sort order/name and notes by newest update', () => {
    renderTree({
      collections: [
        makeCollection({ id: 'col-beta', name: 'Beta', sort_order: 20 }),
        makeCollection({ id: 'col-zulu', name: 'Zulu', sort_order: 10 }),
        makeCollection({ id: 'col-alpha', name: 'Alpha', sort_order: 10 }),
      ],
      notes: [
        makeNote({ id: 'note-old', title: 'Older note', collection_id: 'col-alpha', updated_at: '2025-01-01T00:00:00Z' }),
        makeNote({ id: 'note-new', title: 'Newer note', collection_id: 'col-alpha', updated_at: '2025-02-01T00:00:00Z' }),
      ],
    })

    appearsBefore(screen.getByText('Alpha'), screen.getByText('Zulu'))
    appearsBefore(screen.getByText('Zulu'), screen.getByText('Beta'))
    appearsBefore(screen.getByText('Newer note'), screen.getByText('Older note'))
  })

  it('does not render archived notes in the tree', () => {
    renderTree({
      notes: [
        makeNote({ id: 'note-active', title: 'Active note', status: 'active' }),
        makeNote({ id: 'note-archived', title: 'Archived note', status: 'archived' }),
        makeNote({ id: 'note-deleted', title: 'Deleted note', status: 'deleted' }),
      ],
    })

    expect(screen.getByRole('button', { name: 'Active note' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archived note' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deleted note' })).not.toBeInTheDocument()
  })

  it('hides destructive folder actions for protected system collections', async () => {
    const user = userEvent.setup()
    renderTree({
      collections: [
        makeCollection({
          id: 'col-inbox',
          name: 'Inbox',
          system_role: 'inbox',
          is_system: true,
        }),
      ],
    })

    await user.click(screen.getByLabelText('Folder actions for Inbox'))
    const menu = await screen.findByRole('menu')

    expect(within(menu).getByRole('menuitem', { name: 'New child folder' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Move' })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Hide' })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('only triggers note deletion from note keyboard and context menu actions', async () => {
    const note = makeNote({ id: 'note-alpha', title: 'Alpha note', collection_id: 'col-1' })
    const { onDeleteNote } = renderTree({ notes: [note] })

    fireEvent.keyDown(screen.getByRole('button', { name: 'Inbox' }), { key: 'Delete' })
    expect(onDeleteNote).not.toHaveBeenCalled()

    const noteItem = screen.getByRole('button', { name: 'Alpha note' })
    fireEvent.keyDown(noteItem, { key: 'Delete' })
    expect(onDeleteNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-alpha', title: 'Alpha note' }))

    vi.mocked(onDeleteNote).mockClear()
    fireEvent.contextMenu(noteItem, { clientX: 20, clientY: 30 })
    const menu = await screen.findByRole('menu', { name: 'Alpha note actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))

    expect(onDeleteNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-alpha', title: 'Alpha note' }))
  })

  it('archives notes from the note context menu', async () => {
    const note = makeNote({ id: 'note-alpha', title: 'Alpha note', collection_id: 'col-1' })
    const { onArchiveNote, onDeleteNote } = renderTree({ notes: [note] })

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Alpha note' }), { clientX: 20, clientY: 30 })
    const menu = await screen.findByRole('menu', { name: 'Alpha note actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive' }))

    expect(onArchiveNote).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-alpha', title: 'Alpha note' }))
    expect(onDeleteNote).not.toHaveBeenCalled()
  })

  it('syncs note collection selection and clears note selection when a folder is selected', () => {
    const collections = [
      makeCollection({ id: 'col-inbox', name: 'Inbox', sort_order: 0 }),
      makeCollection({ id: 'col-client', name: 'Client Research', sort_order: 1 }),
    ]
    const note = makeNote({ id: 'note-client', title: 'Client note', collection_id: 'col-client' })
    const { onSelectCollection, onSelectNoteCollection } = renderTree({ collections, notes: [note] })

    const noteItem = screen.getByRole('button', { name: 'Client note' })
    fireEvent.click(noteItem)

    expect(onSelectNoteCollection).toHaveBeenCalledWith('col-client')
    expect(noteItem).toHaveClass('bg-accent')

    fireEvent.click(screen.getByRole('button', { name: 'Inbox' }))

    expect(onSelectCollection).toHaveBeenCalledWith('col-inbox')
    expect(noteItem).not.toHaveClass('bg-accent')
  })

  it('clears the previous tree selection when the active note changes outside the tree', () => {
    const notes = [
      makeNote({ id: 'note-alpha', title: 'Alpha note', updated_at: '2025-02-01T00:00:00Z' }),
      makeNote({ id: 'note-beta', title: 'Beta note', updated_at: '2025-01-01T00:00:00Z' }),
    ]
    const { rerenderWithActiveNote } = renderTree({ notes, activeNoteId: 'note-alpha' })
    const alpha = screen.getByRole('button', { name: 'Alpha note' })
    const beta = screen.getByRole('button', { name: 'Beta note' })

    fireEvent.click(alpha)
    expect(alpha).toHaveAttribute('aria-pressed', 'true')

    rerenderWithActiveNote('note-beta')

    expect(alpha).not.toHaveClass('bg-accent')
    expect(beta).toHaveClass('bg-primary/10')
  })

  it('selects a visible note range with Shift and deletes the selected notes as a batch', async () => {
    const notes = [
      makeNote({ id: 'note-alpha', title: 'Alpha note', collection_id: 'col-1', updated_at: '2025-04-01T00:00:00Z' }),
      makeNote({ id: 'note-beta', title: 'Beta note', collection_id: 'col-1', updated_at: '2025-03-01T00:00:00Z' }),
      makeNote({ id: 'note-gamma', title: 'Gamma note', collection_id: 'col-1', updated_at: '2025-02-01T00:00:00Z' }),
      makeNote({ id: 'note-delta', title: 'Delta note', collection_id: 'col-1', updated_at: '2025-01-01T00:00:00Z' }),
    ]
    const { onDeleteNotes, onOpenNote } = renderTree({ notes })

    fireEvent.click(screen.getByRole('button', { name: 'Alpha note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Gamma note' }), { shiftKey: true })

    expect(onOpenNote).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Alpha note' })).toHaveClass('bg-accent')
    expect(screen.getByRole('button', { name: 'Beta note' })).toHaveClass('bg-accent')
    expect(screen.getByRole('button', { name: 'Gamma note' })).toHaveClass('bg-accent')
    expect(screen.getByRole('button', { name: 'Delta note' })).not.toHaveClass('bg-accent')

    fireEvent.keyDown(screen.getByRole('button', { name: 'Gamma note' }), { key: 'Delete' })

    expect(onDeleteNotes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'note-alpha', title: 'Alpha note' }),
      expect.objectContaining({ id: 'note-beta', title: 'Beta note' }),
      expect.objectContaining({ id: 'note-gamma', title: 'Gamma note' }),
    ])
  })

  it('uses the selected note range for the context menu delete action', async () => {
    const notes = [
      makeNote({ id: 'note-alpha', title: 'Alpha note', collection_id: 'col-1', updated_at: '2025-03-01T00:00:00Z' }),
      makeNote({ id: 'note-beta', title: 'Beta note', collection_id: 'col-1', updated_at: '2025-02-01T00:00:00Z' }),
      makeNote({ id: 'note-gamma', title: 'Gamma note', collection_id: 'col-1', updated_at: '2025-01-01T00:00:00Z' }),
    ]
    const { onDeleteNotes } = renderTree({ notes })

    fireEvent.click(screen.getByRole('button', { name: 'Alpha note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Gamma note' }), { shiftKey: true })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Beta note' }), { clientX: 20, clientY: 30 })

    const menu = await screen.findByRole('menu', { name: 'Selected notes actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete 3 notes' }))

    expect(onDeleteNotes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'note-alpha' }),
      expect.objectContaining({ id: 'note-beta' }),
      expect.objectContaining({ id: 'note-gamma' }),
    ])
  })

  it('uses the selected note range for the context menu archive action', async () => {
    const notes = [
      makeNote({ id: 'note-alpha', title: 'Alpha note', collection_id: 'col-1', updated_at: '2025-03-01T00:00:00Z' }),
      makeNote({ id: 'note-beta', title: 'Beta note', collection_id: 'col-1', updated_at: '2025-02-01T00:00:00Z' }),
      makeNote({ id: 'note-gamma', title: 'Gamma note', collection_id: 'col-1', updated_at: '2025-01-01T00:00:00Z' }),
    ]
    const { onArchiveNotes } = renderTree({ notes })

    fireEvent.click(screen.getByRole('button', { name: 'Alpha note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Gamma note' }), { shiftKey: true })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Beta note' }), { clientX: 20, clientY: 30 })

    const menu = await screen.findByRole('menu', { name: 'Selected notes actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Archive 3 notes' }))

    expect(onArchiveNotes).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'note-alpha' }),
      expect.objectContaining({ id: 'note-beta' }),
      expect.objectContaining({ id: 'note-gamma' }),
    ])
  })

  it('keeps fixed roots immovable while allowing ordinary and project folders to drag', () => {
    renderTree({
      collections: [
        makeCollection({ id: 'col-inbox', name: 'Inbox', system_role: 'inbox', is_system: true }),
        makeCollection({ id: 'col-projects', name: 'Projects', system_role: 'projects_root', is_system: true }),
        makeCollection({ id: 'col-project', name: 'Project Alpha', system_role: 'project', is_system: true }),
        makeCollection({ id: 'col-normal', name: 'Research', system_role: 'normal', is_system: false }),
      ],
    })

    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Project Alpha' })).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByRole('button', { name: 'Research' })).toHaveAttribute('aria-disabled', 'false')
  })
})
