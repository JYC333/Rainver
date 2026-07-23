import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResearchWorkspacePage from '../ResearchWorkspacePage'
import { projectResearchApi, notesApi, sessionsApi } from '../../../api/client'
import type { Note, NoteRevision, Project, ResearchReadingList, ResearchWorkspace } from '../../../types/api'

const { editorMountCount } = vi.hoisted(() => ({ editorMountCount: { current: 0 } }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return { SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link> }
})
vi.mock('../../../components/editor/RichTextEditor', () => ({
  RichTextEditor: forwardRef(function FakeEditor({ onChange }: { onChange?: () => void }, ref) {
    useImperativeHandle(ref, () => ({ getSnapshot: () => ({ content_json: { type: 'doc', content: [] } }) }))
    useEffect(() => { editorMountCount.current += 1 }, [])
    return <button onClick={onChange}>Edit document</button>
  }),
}))
vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  },
  projectResearchApi: {
    initializeWorkspace: vi.fn(), workspace: vi.fn(), readingList: vi.fn(),
    updatePaperCard: vi.fn(), createChecklistItem: vi.fn(), updateChecklistItem: vi.fn(), deleteChecklistItem: vi.fn(),
    askAi: vi.fn(), notebookChat: vi.fn(), generateReportSnapshot: vi.fn(),
  },
  notesApi: {
    list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), revisions: vi.fn(), rollback: vi.fn(),
  },
  projectsApi: { get: vi.fn(), updateCorpusItem: vi.fn() },
  providersApi: { list: vi.fn() },
  sessionsApi: { messages: vi.fn() },
}))

const note = {
  id: 'note-1', space_id: 'space-1', title: 'Current understanding', excerpt: null,
  status: 'active', content_format: 'prosemirror_json', primary_project_id: 'project-1', collection_id: 'col-1',
  content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original claim' }] }] },
  content_schema_version: 1, plain_text: 'Original claim',
  version: 2, content_hash: 'hash', updated_by_user_id: null, updated_by_run_id: 'run-9',
  created_from_activity_id: null, created_by_user_id: null,
  created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z', archived_at: null, deleted_at: null,
} satisfies Note
const revisions: NoteRevision[] = [
  {
    id: 'revision-2', version: 2, content_json: note.content_json, normalized_text: note.plain_text ?? '', refs_json: [],
    source: 'ai_monitoring', diff_json: { ops: [{ op: 'append', markdown: '## Monitoring update\n\n- Contradiction' }] },
    created_by_user_id: null, created_by_run_id: 'run-9', created_at: '2026-07-19T00:00:00.000Z',
  },
  {
    id: 'revision-1', version: 1, content_json: { type: 'doc', content: [] }, normalized_text: '', refs_json: [],
    source: 'seed', diff_json: null, created_by_user_id: null, created_by_run_id: null, created_at: '2026-07-18T00:00:00.000Z',
  },
]
const workspace = {
  notes_collection_id: 'col-1',
  notes: [{ id: note.id, title: note.title, version: note.version, content_json: note.content_json }],
  checklist: [{ id: 'task-1', text: 'Check evidence', status: 'open', sort_order: 0, origin: 'agent', origin_run_id: 'run-1', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z' }],
  reports: [{ id: 'report-1', research_question: 'How?', research_question_version: 1, status: 'awaiting_review', run_kind: 'baseline', created_at: '2026-07-19T00:00:00.000Z' }],
} as ResearchWorkspace
const reading = {
  items: [{ id: 'corpus-1', source_item_id: 'source-1', triage_status: 'relevant', read_status: 'unread', source_item: { title: 'Paper one', excerpt: 'Evidence excerpt' }, paper_card: { why_md: 'Relevant', how_md: 'Trial', what_md: 'Result', stance: null } }],
  total: 1, limit: 50, offset: 0,
} as unknown as ResearchReadingList

describe('ResearchWorkspacePage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    window.localStorage.clear()
    editorMountCount.current = 0
    // jsdom doesn't implement Element.scrollTo, which ChatThread calls on mount.
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
    const api = await import('../../../api/client')
    vi.mocked(api.projectsApi.get).mockResolvedValue({ id: 'project-1', name: 'Study', current_focus: 'How?' } as Project)
    vi.mocked(projectResearchApi.initializeWorkspace).mockResolvedValue(workspace)
    vi.mocked(projectResearchApi.workspace).mockResolvedValue(workspace)
    vi.mocked(projectResearchApi.readingList).mockResolvedValue(reading)
    vi.mocked(notesApi.list).mockResolvedValue({ items: [note], total: 1, limit: 200, offset: 0 })
    vi.mocked(notesApi.get).mockResolvedValue(note)
    vi.mocked(notesApi.update).mockResolvedValue({ ...note, version: 3 })
    vi.mocked(notesApi.revisions).mockResolvedValue(revisions)
    vi.mocked(notesApi.rollback).mockResolvedValue({ ...note, version: 3, updated_by_run_id: null })
    vi.mocked(projectResearchApi.updateChecklistItem).mockImplementation(async (_projectId, _itemId, body) => ({ ...workspace.checklist[0], ...body }))
    vi.mocked(projectResearchApi.askAi).mockResolvedValue({ run_id: 'run-12345678', job_id: 'job-1', status: 'queued', daily_limit: 20, daily_used: 1 })
    vi.mocked(projectResearchApi.generateReportSnapshot).mockResolvedValue({ id: 'operation-1' } as never)
    vi.mocked(api.providersApi.list).mockResolvedValue([{ id: 'provider-1', name: 'Provider', enabled: true }] as never)
    vi.mocked(sessionsApi.messages).mockResolvedValue([])
  })

  async function renderPage() {
    render(<MemoryRouter initialEntries={['/projects/project-1/research']}><Routes><Route path="/projects/:projectId/research" element={<ResearchWorkspacePage />} /></Routes></MemoryRouter>)
    await screen.findByDisplayValue('Current understanding')
  }

  it('auto-saves note edits with optimistic versions — no manual Save button', async () => {
    await renderPage()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    await waitFor(
      () => expect(notesApi.update).toHaveBeenCalledWith('note-1', expect.objectContaining({ expect_version: 2 })),
      { timeout: 2000 },
    )
  })

  it('never remounts the editor after a successful autosave (that used to cancel focus)', async () => {
    await renderPage()
    const mountsBeforeEdit = editorMountCount.current
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    await waitFor(
      () => expect(notesApi.update).toHaveBeenCalled(),
      { timeout: 2000 },
    )
    await screen.findByText('Saved')
    expect(editorMountCount.current).toBe(mountsBeforeEdit)
  })

  it('highlights the latest AI edit with its diff and one-click rollback', async () => {
    await renderPage()
    expect(screen.getByText(/AI edited this note/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Undo AI change' }))
    await waitFor(() => expect(notesApi.rollback).toHaveBeenCalledWith('note-1', 1))
  })

  it('confirms before a rollback discards an unsaved edit, and skips the rollback if the user cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderPage()
    // "Edit document" fires the fake editor's onChange, marking the note dirty.
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    await userEvent.click(screen.getByRole('button', { name: 'Undo AI change' }))
    expect(confirmSpy).toHaveBeenCalled()
    expect(notesApi.rollback).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Undo AI change' }))
    await waitFor(() => expect(notesApi.rollback).toHaveBeenCalledWith('note-1', 1))
    confirmSpy.mockRestore()
  })

  it('never discards an unsaved edit when the note refreshes in the background (e.g. a chat edit landing)', async () => {
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Edit document' }))
    const mountsBeforeRefresh = editorMountCount.current

    // Simulate an unrelated background refresh (e.g. NotebookChatPanel's
    // onNotebookChanged) observing a newer server version of this note while
    // the user still has an unsaved local edit.
    vi.mocked(notesApi.get).mockResolvedValue({ ...note, version: note.version + 1 })
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(projectResearchApi.workspace).toHaveBeenCalled())

    // The editor must not remount — that would silently wipe the unsaved edit.
    expect(editorMountCount.current).toBe(mountsBeforeRefresh)
    expect(screen.getByRole('button', { name: 'Edit document' })).toBeInTheDocument()
  })

  it('restores an old version from the history panel', async () => {
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'History' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(notesApi.rollback).toHaveBeenCalledWith('note-1', 1))
  })

  it('moves corpus review, checklist, and report snapshot actions into workspace tabs', async () => {
    await renderPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Reading List' }))
    expect(await screen.findByText('Paper one')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Checklist' }))
    expect(await screen.findByText('Check evidence')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    await userEvent.click(screen.getByRole('button', { name: /Generate new snapshot/ }))
    await waitFor(() => expect(projectResearchApi.generateReportSnapshot).toHaveBeenCalledWith('project-1'))
  })

  it('sends a notebook-chat turn and renders the reply', async () => {
    vi.mocked(projectResearchApi.notebookChat).mockResolvedValue({
      session_id: 'session-1', run_id: 'run-1', ok: true, reply: 'The current understanding covers X.',
      notebook_edit: null, daily_limit: 20, daily_used: 1,
    })
    await renderPage()
    const input = screen.getByPlaceholderText("Ask about or update the project's notes…")
    fireEvent.change(input, { target: { value: 'What is the current understanding?' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    await waitFor(() => expect(projectResearchApi.notebookChat).toHaveBeenCalledWith('project-1', expect.objectContaining({
      message: 'What is the current understanding?', session_id: undefined,
    })))
    expect(await screen.findByText('The current understanding covers X.')).toBeInTheDocument()
  })

  it('shows an inline undo for a chat turn that edited a note, and reloads the notes on undo', async () => {
    vi.mocked(projectResearchApi.notebookChat).mockResolvedValue({
      session_id: 'session-1', run_id: 'run-1', ok: true, reply: 'Updated the current understanding.',
      notebook_edit: { note_id: 'note-1', version: 3, conflict: false }, daily_limit: 20, daily_used: 1,
    })
    await renderPage()
    const input = screen.getByPlaceholderText("Ask about or update the project's notes…")
    fireEvent.change(input, { target: { value: 'Rewrite the current understanding' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(await screen.findByText('Updated "Current understanding"')).toBeInTheDocument()
    vi.mocked(notesApi.list).mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(notesApi.rollback).toHaveBeenCalledWith('note-1', 2))
    await waitFor(() => expect(notesApi.list).toHaveBeenCalled())
  })

  it('shows the uninitialized empty state instead of loading forever for readers', async () => {
    const { ApiRequestError } = await import('../../../api/client')
    vi.mocked(projectResearchApi.initializeWorkspace).mockRejectedValue(new ApiRequestError('not initialized', 404))
    render(<MemoryRouter initialEntries={['/projects/project-1/research']}><Routes><Route path="/projects/:projectId/research" element={<ResearchWorkspacePage />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('Research workspace not initialized')).toBeInTheDocument()
  })

  it('does not disguise server failures as an uninitialized workspace', async () => {
    const { ApiRequestError } = await import('../../../api/client')
    vi.mocked(projectResearchApi.initializeWorkspace).mockRejectedValue(new ApiRequestError('service unavailable', 503))
    render(<MemoryRouter initialEntries={['/projects/project-1/research']}><Routes><Route path="/projects/:projectId/research" element={<ResearchWorkspacePage />} /></Routes></MemoryRouter>)
    expect(await screen.findByText('Research workspace unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Research workspace not initialized')).not.toBeInTheDocument()
  })

})
