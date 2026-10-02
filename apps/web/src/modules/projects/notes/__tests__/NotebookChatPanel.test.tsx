import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { scopedUserStorageKey } from '../../../../lib/sessionResidue'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { id: 'user-1' } }) }))

const mocked = vi.hoisted(() => ({ messages: vi.fn(), rollback: vi.fn() }))
vi.mock('../../../../api/client', () => ({
  notesApi: { rollback: mocked.rollback },
  sessionsApi: { messages: mocked.messages },
  projectNotebookChatApi: { send: vi.fn() },
}))

import { NotebookChatPanel } from '../NotebookChatPanel'

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.setItem(scopedUserStorageKey('notebook-chat-session', 'user-1', 'project-1'), 'session-1')
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  mocked.messages.mockResolvedValue([{
    id: 'message-1', role: 'assistant', content: 'Updated the log.',
    metadata_json: { notebook_edit: { note_id: 'note-1', version: 5, conflict: false } },
  }])
  mocked.rollback.mockResolvedValue({})
})

describe('NotebookChatPanel', () => {
  it('undoes an edit only while the note is still at the version that edit wrote', async () => {
    render(
      <NotebookChatPanel
        projectId="project-1"
        providers={[]}
        noteTitleById={new Map([['note-1', 'Log']])}
        onNotebookChanged={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(mocked.rollback).toHaveBeenCalledWith('note-1', 4, 5))
  })
})
