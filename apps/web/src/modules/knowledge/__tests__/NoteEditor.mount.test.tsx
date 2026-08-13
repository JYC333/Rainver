import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'personal-1',
    activeSpaceName: 'My Personal',
    preferredSpaceId: 'personal-1',
  }),
}))

vi.mock('../../../api/client', () => {
  const emptyPage = { items: [], total: 0, limit: 100, offset: 0 }
  return {
    ApiRequestError: class ApiRequestError extends Error { status = 0 },
    notesApi: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue(emptyPage),
      update: vi.fn(),
      links: vi.fn().mockResolvedValue([]),
      backlinks: vi.fn().mockResolvedValue([]),
      shares: vi.fn().mockResolvedValue([]),
      revokeShare: vi.fn(),
      revisions: vi.fn().mockResolvedValue([]),
      rollback: vi.fn(),
      createLink: vi.fn(),
      deleteLink: vi.fn(),
      promote: vi.fn(),
    },
    knowledgeApi: {
      list: vi.fn().mockResolvedValue(emptyPage),
      search: vi.fn().mockResolvedValue({ items: [] }),
    },
    inquiryApi: { raiseFromNote: vi.fn() },
  }
})

vi.mock('../../../components/editor', async () => {
  const React = await import('react')
  return {
    RichTextEditor: React.forwardRef(function MockRichTextEditor(
      _props: { initialContent: Record<string, unknown> },
      ref: React.ForwardedRef<{ getSnapshot: () => Record<string, unknown>; focus: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({ getSnapshot: () => ({}), focus: vi.fn() }))
      return React.createElement('div', { 'data-testid': 'rich-text-editor' })
    }),
    emptyRichTextDocument: vi.fn(() => ({ type: 'doc', content: [] })),
    normalizeNoteDocument: vi.fn(() => ({ type: 'doc', content: [] })),
    richTextSnapshotFromDocument: vi.fn(() => ({})),
    HistoryChip: () => React.createElement('button', { type: 'button' }, 'History'),
    AiEditBanner: () => React.createElement('div'),
    NoteRevisionHistory: () => React.createElement('div'),
  }
})

import NoteEditor from '../NoteEditor'
import { notesApi } from '../../../api/client'
import { publishNoteChanged } from '../../../core/noteEvents'
import type { Note } from '../../../types/api'

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    space_id: 'personal-1',
    title: 'Portable note',
    excerpt: null,
    status: 'active',
    content_format: 'prosemirror_json',
    content_json: { type: 'doc', content: [] },
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

beforeEach(() => {
  vi.clearAllMocks()
})

/**
 * S1's structural guarantee. The editor used to read its note from
 * `useParams()` and its callback from `useOutletContext()`, which pinned it to
 * one route and is why the Project notebook grew a second, weaker editor
 * instead of reusing this one. Mounting it here with neither a matched route
 * nor an Outlet is the test that the coupling is gone.
 */
describe('NoteEditor is route-agnostic', () => {
  it('renders from props with no route params and no Outlet context', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(makeNote())
    const onNoteResolved = vi.fn()

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NoteEditor noteId="note-1" onNoteResolved={onNoteResolved} />
      </MemoryRouter>,
    )

    expect(await screen.findByDisplayValue('Portable note')).toBeInTheDocument()
    expect(notesApi.get).toHaveBeenCalledWith('note-1')
    await waitFor(() => expect(onNoteResolved).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-1' })))
  })

  it('follows the noteId prop when the surface switches notes', async () => {
    vi.mocked(notesApi.get).mockImplementation(async id => makeNote({ id, title: `Note ${id}` }))

    const { rerender } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NoteEditor noteId="note-a" onNoteResolved={vi.fn()} />
      </MemoryRouter>,
    )
    expect(await screen.findByDisplayValue('Note note-a')).toBeInTheDocument()

    rerender(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NoteEditor noteId="note-b" onNoteResolved={vi.fn()} />
      </MemoryRouter>,
    )
    expect(await screen.findByDisplayValue('Note note-b')).toBeInTheDocument()
  })
})

/**
 * The open note has to show a capture that was written into it from the
 * composer, without the user reloading and without the editor polling for it.
 */
describe('NoteEditor picks up an external write', () => {
  it('re-reads the note it is showing when that note is announced as changed', async () => {
    vi.mocked(notesApi.get)
      .mockResolvedValueOnce(makeNote())
      .mockResolvedValueOnce(makeNote({ title: 'Portable note (+ capture)', version: 2 }))

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NoteEditor noteId="note-1" onNoteResolved={vi.fn()} />
      </MemoryRouter>,
    )
    expect(await screen.findByDisplayValue('Portable note')).toBeInTheDocument()

    publishNoteChanged({ noteId: 'note-1', projectId: null, reason: 'capture' })

    expect(await screen.findByDisplayValue('Portable note (+ capture)')).toBeInTheDocument()
  })

  it('ignores a write to some other note, so one capture refetches one editor', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(makeNote())

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <NoteEditor noteId="note-1" onNoteResolved={vi.fn()} />
      </MemoryRouter>,
    )
    await screen.findByDisplayValue('Portable note')
    expect(notesApi.get).toHaveBeenCalledTimes(1)

    publishNoteChanged({ noteId: 'note-2', projectId: null, reason: 'capture' })

    await waitFor(() => expect(notesApi.get).toHaveBeenCalledTimes(1))
  })
})
