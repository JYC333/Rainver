import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectBoardPage from '../board/ProjectBoardPage'
import { ApiRequestError, projectsApi, tasksApi } from '../../../api/client'
import { blockedCompletion, completionReasonLabel, moveCardStatus } from '../board/completionOverride'
import type { ProjectBoard, ProjectBoardCard } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../api/client')>('../../../api/client')
  return {
    ApiRequestError: actual.ApiRequestError,
    projectsApi: { getBoard: vi.fn() },
    tasksApi: { update: vi.fn(), create: vi.fn() },
    agentsApi: { list: vi.fn().mockResolvedValue([]) },
  }
})

function card(overrides: Partial<ProjectBoardCard> & Pick<ProjectBoardCard, 'id' | 'title' | 'status'>): ProjectBoardCard {
  return {
    column_key: overrides.status,
    priority: 'normal',
    risk_level: 'low',
    due_at: null,
    updated_at: '2026-08-27T00:00:00.000Z',
    loop_stage: null,
    loop_stage_label: null,
    responsible: { kind: null, id: null, display_name: null },
    active_run_count: 0,
    latest_run_status: null,
    evaluation_recommendation: null,
    blocked_reason: null,
    completion: { ok: true, missing: [] },
    ...overrides,
  }
}

const board: ProjectBoard = {
  project: { id: 'project-1', name: 'Thin branch mapping', primary_mode: 'research' },
  columns: [
    { status_key: 'ready', label: 'Ready', wip_limit: null, count: 1 },
    { status_key: 'in_progress', label: 'In Progress', wip_limit: 2, count: 1 },
    { status_key: 'waiting_for_review', label: 'Waiting', wip_limit: null, count: 1 },
    { status_key: 'done', label: 'Done', wip_limit: null, count: 0 },
  ],
  cards: [
    card({ id: 'task-ready', title: 'Draft the protocol', status: 'ready' }),
    card({
      id: 'task-active',
      title: 'Run the depth repair',
      status: 'in_progress',
      loop_stage: 'act',
      loop_stage_label: 'Investigate',
      responsible: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
      active_run_count: 1,
      completion: { ok: false, missing: ['evaluation'] },
    }),
    // Held up by something else: no lane of its own, drawn where the work sits.
    card({
      id: 'task-blocked',
      title: 'Wait on the vendor',
      status: 'blocked',
      column_key: 'in_progress',
      blocked_reason: 'Waiting for the licence',
      responsible: { kind: 'user', id: 'user-2', display_name: 'Teammate' },
    }),
    card({
      id: 'task-waiting',
      title: 'Decide on the baseline',
      status: 'waiting_for_review',
      responsible: { kind: 'user', id: 'user-1', display_name: 'Owner' },
      completion: { ok: false, missing: ['evaluation', 'required_output:report'] },
    }),
  ],
  viewer_user_id: 'user-1',
  viewer_can_write: true,
  filters: { all: 4, mine: 1, agent_held: 1, needs_me: 1 },
}

function renderBoard() {
  return render(
    <MemoryRouter initialEntries={['/projects/project-1/board']}>
      <Routes>
        <Route path="/projects/:projectId/board" element={<ProjectBoardPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.getBoard).mockResolvedValue(board)
})

describe('Project Board', () => {
  it('renders one lane per column with its cards and Loop labels', async () => {
    renderBoard()

    expect(await screen.findByText('Draft the protocol')).toBeInTheDocument()
    for (const label of ['Ready', 'In Progress', 'Waiting', 'Done']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // The stage label comes from the server in the Project's own Mode; the
    // Board never maps stage keys to words itself.
    expect(screen.getByText('Investigate')).toBeInTheDocument()
    expect(screen.getByText('Research specialist')).toBeInTheDocument()
    expect(screen.getByTestId('board-column-waiting_for_review')).toContainElement(
      screen.getByTestId('board-card-task-waiting'),
    )
  })

  it('shows the WIP limit without preventing anything', async () => {
    renderBoard()
    // The limit is information. Refusing a move because of it would override a
    // person's judgement about their own work.
    // Two cards sit in In Progress against a limit of 2 — one of them the
    // blocked card, drawn there rather than nowhere.
    expect(await screen.findByText('2 / 2')).toBeInTheDocument()
  })

  it('narrows to the cards a filter names, with the server counts', async () => {
    renderBoard()
    fireEvent.click(await screen.findByRole('button', { name: /Agent working/ }))

    expect(screen.getByText('Run the depth repair')).toBeInTheDocument()
    expect(screen.queryByText('Draft the protocol')).not.toBeInTheDocument()
  })

  it('scopes Mine to the viewer the server named, not to anyone with a name', async () => {
    renderBoard()
    fireEvent.click(await screen.findByRole('button', { name: /Mine/ }))

    // Two cards are held by a person; only one is held by this person, and the
    // badge already said so.
    expect(screen.getByText('Decide on the baseline')).toBeInTheDocument()
    expect(screen.queryByText('Wait on the vendor')).not.toBeInTheDocument()
  })

  it('draws a blocked card in the lane its work sits in, wearing the overlay', async () => {
    renderBoard()
    // `blocked` is not a column, so without a lane assignment the card would be
    // fetched, counted, and drawn nowhere — invisible and undraggable.
    const blocked = await screen.findByTestId('board-card-task-blocked')
    expect(screen.getByTestId('board-column-in_progress')).toContainElement(blocked)
    expect(screen.getByText('Waiting for the licence')).toBeInTheDocument()
  })

  it('treats a refusal that names nothing as an ordinary error', () => {
    // An empty dialog whose only button re-fails is worse than a message.
    expect(blockedCompletion(new ApiRequestError('x', 422, 'completion_requirements_unmet', {}))).toBeNull()
  })

  it('does not send an empty acknowledgement as an override', async () => {
    vi.mocked(tasksApi.update).mockResolvedValue({} as never)
    await moveCardStatus('task-waiting', 'done', [])
    expect(tasksApi.update).toHaveBeenCalledWith('task-waiting', { status: 'done' })
  })

  it('reads a refused close as the requirements it is missing', () => {
    // The dialog is driven by this mapping, and drag-and-drop is a pointer
    // gesture jsdom cannot produce — so the refusal path is exercised where it
    // actually lives rather than through a simulated drop that proves nothing.
    const refusal = new ApiRequestError(
      'Task completion requirements are not met',
      422,
      'completion_requirements_unmet',
      { code: 'completion_requirements_unmet', missing: ['evaluation', 'required_output:report'] },
    )
    expect(blockedCompletion(refusal)).toEqual(['evaluation', 'required_output:report'])
    expect(blockedCompletion(new ApiRequestError('Task not found', 404))).toBeNull()
    expect(blockedCompletion(new Error('network'))).toBeNull()
  })

  it('acknowledges exactly the reasons it was refused for', async () => {
    vi.mocked(tasksApi.update).mockResolvedValue({} as never)
    await moveCardStatus('task-waiting', 'done', ['evaluation', 'required_output:report'])
    // A bare force flag would record that it closed and lose what was skipped.
    expect(tasksApi.update).toHaveBeenCalledWith('task-waiting', {
      status: 'done',
      override_completion: { acknowledged: ['evaluation', 'required_output:report'] },
    })
  })

  it('words each refusal reason for a person', () => {
    expect(completionReasonLabel('evaluation')).toMatch(/evaluation/i)
    expect(completionReasonLabel('required_output:report')).toContain('report')
  })

  it('creates a Task here, in the Project', async () => {
    // Putting work on the Board is the daily action; before this it meant
    // leaving the Project for the cross-Project Tasks list.
    vi.mocked(tasksApi.create).mockResolvedValue({ id: 'task-new' } as never)
    renderBoard()
    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }))
    fireEvent.change(await screen.findByLabelText('What needs to be done?'), { target: { value: 'Write the summary' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Task' }))
    await waitFor(() => expect(tasksApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Write the summary', project_id: 'project-1', status: 'ready' }),
    ))
    await waitFor(() => expect(projectsApi.getBoard).toHaveBeenCalledTimes(2))
  })

  it('offers a viewer no New Task', async () => {
    vi.mocked(projectsApi.getBoard).mockResolvedValue({ ...board, viewer_can_write: false })
    renderBoard()
    expect(await screen.findByText('Draft the protocol')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New Task' })).not.toBeInTheDocument()
  })

  it('gives a writer a keyboard-reachable handle and a viewer none', async () => {
    renderBoard()
    // The handle is a real button, so a keyboard has something to focus: Space
    // picks the card up, arrows change lane, Space drops it. It is separate
    // from the title link, so the card is not a "button" with a link inside.
    const handle = await screen.findByRole('button', { name: 'Move Draft the protocol' })
    expect(handle).toHaveAttribute('aria-roledescription', 'draggable')
    expect(screen.getByRole('link', { name: 'Draft the protocol' })).toBeInTheDocument()
  })

  it('shows a viewer the Board without any way to move a card', async () => {
    vi.mocked(projectsApi.getBoard).mockResolvedValue({ ...board, viewer_can_write: false })
    renderBoard()
    expect(await screen.findByText('Draft the protocol')).toBeInTheDocument()
    // Before this a viewer could drag any card to Done and get a 403 after
    // the drop; the honest surface is one that offers no drag at all.
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument()
  })

  it('opens a card inside the Project, so the Board and the chat panel survive the click', async () => {
    // A Task reached from the Board is Project work. Sending it to the
    // top-level /tasks route unmounted the Project shell — and with it the
    // chat panel whose focus hint is derived from being on a Task page.
    vi.mocked(projectsApi.getBoard).mockResolvedValue(board)
    renderBoard()
    expect(await screen.findByText('Draft the protocol')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Draft the protocol' }))
      .toHaveAttribute('href', '/projects/project-1/tasks/task-ready')
  })
})
