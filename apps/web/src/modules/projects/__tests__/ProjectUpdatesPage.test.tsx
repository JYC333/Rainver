import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectUpdatesPage from '../ProjectUpdatesPage'
import { projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../../api/client', () => ({
  projectsApi: { updates: vi.fn(), postUpdate: vi.fn(), undoUpdate: vi.fn() },
}))

function page(overrides: Record<string, unknown> = {}) {
  return {
    items: [{
      id: 'event-1', event_kind: 'task.reported', occurred_at: '2026-08-27T09:00:00.000Z',
      actor: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
      summary: 'Repaired the depth estimate', outcome: 'progress',
      subject: { type: 'task', id: 'task-1', title: 'Run the depth repair' },
      undo: null,
      undone_by_event_id: null,
      members: null,
    }],
    next_cursor: null,
    viewer_can_write: true,
    ...overrides,
  }
}

function renderUpdates() {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1/updates']}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/updates" element={<ProjectUpdatesPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.updates).mockResolvedValue(page() as never)
})

describe('Project updates', () => {
  it('lists what has been reported and links the Task inside the Project', async () => {
    renderUpdates()
    expect(await screen.findByText('Repaired the depth estimate')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Run the depth repair' }))
      .toHaveAttribute('href', '/projects/project-1/tasks/task-1')
  })

  it('expands one turn\'s decomposition and undoes a single member of it', async () => {
    // ADR 0017 §4: the Agent created these without asking, so this is where a
    // person sees what it did and puts one back. The fold keeps it one thing
    // that happened while each member stays individually reversible.
    vi.mocked(projectsApi.updates).mockResolvedValue(page({
      items: [{
        id: 'fold-1', event_kind: 'thread.created', occurred_at: '2026-08-27T09:00:00.000Z',
        actor: { kind: 'agent', id: 'agent-1', display_name: 'Assistant' },
        summary: 'Opened 3 questions', outcome: null, subject: null,
        undo: null, undone_by_event_id: null,
        members: [1, 2, 3].map(n => ({
          id: `member-${n}`, event_kind: 'thread.created', occurred_at: '2026-08-27T09:00:00.000Z',
          actor: { kind: 'agent', id: 'agent-1', display_name: 'Assistant' },
          summary: `Question opened`, outcome: null,
          subject: { type: 'inquiry_thread', id: `thread-${n}`, title: `Axis ${n}` },
          undo: { action: 'archive_thread', target_id: `thread-${n}` },
          undone_by_event_id: null,
        })),
      }],
    }) as never)
    vi.mocked(projectsApi.undoUpdate).mockResolvedValue({ undone_event_id: 'member-2', action: 'archive_thread' } as never)
    renderUpdates()

    // The fold itself offers no undo: "undo all of it" is a different
    // decision from "that one was wrong".
    const fold = await screen.findByTestId('update-fold-1')
    expect(within(fold).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('update-member-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Opened 3 questions'))
    const member = await screen.findByTestId('update-member-2')
    fireEvent.click(within(member).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(projectsApi.undoUpdate).toHaveBeenCalledWith('project-1', 'member-2'))
    // Reloaded rather than patched: the reversal is its own update.
    await waitFor(() => expect(projectsApi.updates).toHaveBeenCalledTimes(2))
  })

  it('shows an already-undone update as undone and offers no second undo', async () => {
    vi.mocked(projectsApi.updates).mockResolvedValue(page({
      items: [{
        id: 'event-9', event_kind: 'thread.created', occurred_at: '2026-08-27T09:00:00.000Z',
        actor: { kind: 'agent', id: 'agent-1', display_name: 'Assistant' },
        summary: 'Question opened', outcome: null,
        subject: { type: 'inquiry_thread', id: 'thread-9', title: 'A question' },
        undo: null, undone_by_event_id: 'event-10', members: null,
      }],
    }) as never)
    renderUpdates()

    const row = await screen.findByTestId('update-event-9')
    expect(within(row).getByText(/undone/)).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('posts an update and reloads, so the list and the record cannot drift', async () => {
    vi.mocked(projectsApi.postUpdate).mockResolvedValue({ id: 'event-2' } as never)
    renderUpdates()
    await screen.findByText('Repaired the depth estimate')

    fireEvent.change(screen.getByPlaceholderText('Where does this Project stand?'), {
      target: { value: 'On track for the review' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Post update' }))

    await waitFor(() => expect(projectsApi.postUpdate)
      .toHaveBeenCalledWith('project-1', { summary: 'On track for the review' }))
    await waitFor(() => expect(projectsApi.updates).toHaveBeenCalledTimes(2))
  })

  it('carries the cursor forward and appends the next page', async () => {
    vi.mocked(projectsApi.updates)
      .mockResolvedValueOnce(page({ next_cursor: '2026-08-27T09:00:00.000Z|event-1' }) as never)
      .mockResolvedValueOnce(page({
        items: [{
          id: 'event-0', event_kind: 'project.reported', occurred_at: '2026-08-26T09:00:00.000Z',
          actor: { kind: 'user', id: 'user-1', display_name: 'Yuchuan' },
          summary: 'Kicked the Project off', outcome: null, task: null,
        }],
        next_cursor: null,
      }) as never)
    renderUpdates()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))

    await waitFor(() => expect(projectsApi.updates)
      .toHaveBeenLastCalledWith('project-1', { cursor: '2026-08-27T09:00:00.000Z|event-1' }))
    expect(await screen.findByText('Kicked the Project off')).toBeInTheDocument()
    // Appended, not replaced.
    expect(screen.getByText('Repaired the depth estimate')).toBeInTheDocument()
  })

  it('offers no composer to someone who may only read', async () => {
    // Reading the account and adding to it are different permissions; a box
    // that always 403s on submit is worse than no box.
    vi.mocked(projectsApi.updates).mockResolvedValue(page({ viewer_can_write: false }) as never)
    renderUpdates()
    await screen.findByText('Repaired the depth estimate')
    expect(screen.queryByPlaceholderText('Where does this Project stand?')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Post update' })).not.toBeInTheDocument()
  })

  it('offers a reader no Undo either, except on their own memory', async () => {
    vi.mocked(projectsApi.updates).mockResolvedValue(page({
      viewer_can_write: false,
      items: [
        {
          id: 'event-thread', event_kind: 'thread.created', occurred_at: '2026-08-27T09:00:00.000Z',
          actor: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
          summary: 'Question opened', outcome: null,
          subject: { type: 'inquiry_thread', id: 'thread-1', title: 'How deep is it?' },
          // Undoing this is a Project write, and a reader would only get a 403.
          undo: { action: 'archive_thread', target_id: 'thread-1' },
          undone_by_event_id: null, members: null,
        },
        {
          id: 'event-memory', event_kind: 'memory.remembered', occurred_at: '2026-08-27T09:01:00.000Z',
          actor: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
          summary: 'Remembered something', outcome: null,
          subject: { type: 'memory_entry', id: 'memory-1', title: 'Prefers mornings' },
          // Archiving your own memory is not a Project write, and the read
          // model shows a viewer only their own memory rows.
          undo: { action: 'archive_memory', target_id: 'memory-1' },
          undone_by_event_id: null, members: null,
        },
      ],
    }) as never)
    renderUpdates()

    await screen.findByText('Question opened')
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1)
    expect(screen.getByText('Remembered something')).toBeInTheDocument()
  })

  it('says it could not load rather than that nothing was reported', async () => {
    vi.mocked(projectsApi.updates).mockRejectedValue(new Error('boom'))
    renderUpdates()
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing reported yet')).not.toBeInTheDocument()
  })
})
