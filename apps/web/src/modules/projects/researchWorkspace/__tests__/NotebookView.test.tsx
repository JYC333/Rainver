import { act, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ProjectNoteCard } from '../NotebookView'
import type { Note } from '../../../../types/api'

const { setContentSpy, capturedOnUpdate, typedDoc, editorStub } = vi.hoisted(() => {
  const setContentSpy = vi.fn()
  const capturedOnUpdate: { current: (() => void) | null } = { current: null }
  const typedDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'typed content' }] }] }
  // A real Tiptap `useEditor` returns a stable instance across re-renders —
  // this stub must too, or TiptapEditorAdapter's `[editor, initialContentKey]`
  // effect would spuriously refire on every render regardless of this fix.
  const editorStub = {
    commands: { setContent: setContentSpy, focus: vi.fn() },
    chain: () => ({
      focus: () => ({
        toggleBold: () => ({ run: vi.fn() }), toggleItalic: () => ({ run: vi.fn() }), toggleStrike: () => ({ run: vi.fn() }),
        setParagraph: () => ({ run: vi.fn() }), toggleHeading: () => ({ run: vi.fn() }), toggleBulletList: () => ({ run: vi.fn() }),
        toggleOrderedList: () => ({ run: vi.fn() }), toggleBlockquote: () => ({ run: vi.fn() }), toggleCode: () => ({ run: vi.fn() }),
        undo: () => ({ run: vi.fn() }), redo: () => ({ run: vi.fn() }),
      }),
    }),
    can: () => ({ undo: () => false, redo: () => false }),
    isActive: () => false,
    getJSON: () => typedDoc,
  }
  return { setContentSpy, capturedOnUpdate, typedDoc, editorStub }
})

vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>()
  return {
    ...actual,
    useEditor: (config: { onUpdate?: () => void }) => {
      capturedOnUpdate.current = config.onUpdate ?? null
      return editorStub
    },
    EditorContent: () => <div>editor surface</div>,
  }
})

const { update, ApiRequestError } = vi.hoisted(() => ({
  update: vi.fn(),
  ApiRequestError: class ApiRequestError extends Error {
    status: number
    constructor(message: string, status: number) { super(message); this.status = status }
  },
}))
vi.mock('../../../../api/client', () => ({
  notesApi: {
    update,
    revisions: vi.fn().mockResolvedValue([]),
    rollback: vi.fn(),
    delete: vi.fn(),
  },
  ApiRequestError,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: Link }
})

const note: Note = {
  id: 'note-1', space_id: 'space-1', title: 'Current understanding', excerpt: null,
  status: 'active', content_format: 'prosemirror_json', primary_project_id: 'project-1', collection_id: 'col-1',
  content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original claim' }] }] },
  content_schema_version: 1, plain_text: 'Original claim',
  version: 2, content_hash: 'hash', updated_by_user_id: null, updated_by_run_id: null,
  created_from_activity_id: null, created_by_user_id: null,
  created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z', archived_at: null, deleted_at: null,
}

describe('ProjectNoteCard autosave', () => {
  it('does not reset the live document (cursor jump) when the server echoes back re-serialized but equal content', async () => {
    // Simulates Postgres JSONB round-tripping: a different object, keys in a
    // different order, but the same document — must not be mistaken for an
    // external change.
    update.mockResolvedValue({
      ...note,
      version: 3,
      content_json: { content: typedDoc.content, type: 'doc' },
    })

    render(
      <MemoryRouter>
        <ProjectNoteCard note={note} onSaved={() => {}} onDeleted={() => {}} />
      </MemoryRouter>,
    )
    expect(setContentSpy).toHaveBeenCalledTimes(1)

    act(() => { capturedOnUpdate.current?.() })
    await waitFor(() => expect(update).toHaveBeenCalledWith(
      'note-1', expect.objectContaining({ expect_version: 2 }),
    ), { timeout: 2000 })

    // Give the post-save re-render a tick to settle, then confirm no reset fired.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(setContentSpy).toHaveBeenCalledTimes(1)
  })
})
