import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectPulse from '../ProjectPulse'
import { inquiryApi, projectsApi } from '../../../api/client'
import type { ProjectBoard, ProjectOverview } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../../api/client', () => ({
  projectsApi: { getBoard: vi.fn(), updates: vi.fn() },
  inquiryApi: { adoptAdvice: vi.fn() },
}))

const board = {
  project: { id: 'project-1', name: 'Thin branch mapping' },
  columns: [],
  cards: [
    {
      id: 'task-active', title: 'Run the depth repair', status: 'in_progress',
      column_key: 'in_progress', priority: 'normal', risk_level: 'low', due_at: null,
      updated_at: '2026-08-27T00:00:00.000Z', loop_stage: 'act', loop_stage_label: 'Investigate',
      responsible: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
      active_run_count: 1, latest_run_status: 'running', evaluation_recommendation: null,
      blocked_reason: null, completion: { ok: true, missing: [] },
    },
    {
      id: 'task-finished', title: 'Old agent work', status: 'done',
      column_key: 'done', priority: 'normal', risk_level: 'low', due_at: null,
      updated_at: '2026-08-26T00:00:00.000Z', loop_stage: null, loop_stage_label: null,
      // Still carries the Agent that did it — but it is finished, not moving.
      responsible: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
      active_run_count: 0, latest_run_status: 'succeeded', evaluation_recommendation: null,
      blocked_reason: null, completion: { ok: true, missing: [] },
    },
  ],
  filters: { mine: 0, needs_me: 0, blocked: 0 },
  viewer_user_id: 'user-1',
  viewer_can_write: true,
} as unknown as ProjectBoard

const overview = {
  definition_status: { status: 'initialized', basis: 'published_brief_goal', goal_or_problem: 'Map the branches' },
  attention: [
    { id: 'alert-1', title: 'Health check failed', summary: null, href: '/projects/project-1/operations?alert=alert-1', attention_class: 'gate', severity: 'high', reason: 'operational alert' },
    { id: 'task:task-1', title: 'Ship release', summary: null, href: '/tasks/task-1', attention_class: 'gate', severity: 'normal', reason: 'waiting_for_review' },
  ],
} as unknown as ProjectOverview

const overviewChanged = vi.fn()
const defineGoal = vi.fn()

function renderPulse(over: ProjectOverview | null = overview) {
  return render(
    <MemoryRouter initialEntries={['/spaces/space-1/projects/project-1']}>
      <Routes>
        <Route
          path="/spaces/:spaceId/projects/:projectId"
          element={<ProjectPulse projectId="project-1" overview={over} onOverviewChanged={overviewChanged} onDefineGoal={defineGoal} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.getBoard).mockResolvedValue(board)
  vi.mocked(projectsApi.updates).mockResolvedValue({
    items: [{
      id: 'event-1', event_kind: 'task.reported', occurred_at: '2026-08-27T09:00:00.000Z',
      actor: { kind: 'agent', id: 'agent-1', display_name: 'Research specialist' },
      summary: 'Repaired the depth estimate', outcome: 'progress',
      task: { id: 'task-active', title: 'Run the depth repair' },
    }],
    next_cursor: null,
    viewer_can_write: true,
  } as never)
})

describe('Project Pulse', () => {
  it('re-reads the situation on an interval and asks the parent to refresh the overview', async () => {
    // A definition accepted or a question opened from the Room shows here
    // without leaving the page; the overview is the parent's read.
    const intervals: Array<() => void> = []
    const spy = vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void) => {
      intervals.push(fn)
      return 42 as unknown as ReturnType<typeof window.setInterval>
    }) as typeof window.setInterval)
    try {
      renderPulse()
      await waitFor(() => expect(projectsApi.getBoard).toHaveBeenCalledTimes(1))
      expect(overviewChanged).not.toHaveBeenCalled()
      intervals.forEach(fn => fn())
      await waitFor(() => expect(projectsApi.getBoard).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(overviewChanged).toHaveBeenCalledTimes(1))
    } finally {
      spy.mockRestore()
    }
  })

  it('asks for a goal until the Project has one, and then stops', async () => {
    // Creation no longer asks for a goal and the shell no longer carries a
    // readiness checklist; this is the one place the question is put.
    renderPulse({ ...overview, definition_status: { status: 'needs_definition', basis: 'missing_published_brief_goal', goal_or_problem: null } } as unknown as ProjectOverview)
    expect(await screen.findByTestId('pulse-needs-goal')).toBeInTheDocument()
    // The goal is edited on this page; the prompt opens that dialog rather
    // than sending the person to the Inquiry Area to do the same thing.
    fireEvent.click(screen.getByRole('button', { name: 'Define the goal' }))
    expect(defineGoal).toHaveBeenCalledTimes(1)
  })

  it('points at Files & Code while no Folder is connected, and stops once one is', async () => {
    // The only place a Folder is connected is Files & Code, two clicks away;
    // without this an Agent quietly works in a managed workspace instead of
    // the Project's code. A Folder is optional, so it is a quiet line.
    renderPulse({ ...overview, has_project_folder: false } as unknown as ProjectOverview)
    expect(await screen.findByTestId('pulse-needs-folder')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect a Folder' }))
      .toHaveAttribute('href', '/projects/project-1/files?setup=folder')
    cleanup()
    renderPulse({ ...overview, has_project_folder: true } as unknown as ProjectOverview)
    await screen.findByText('Health check failed')
    expect(screen.queryByTestId('pulse-needs-folder')).not.toBeInTheDocument()
  })

  it('says nothing about a goal once one is defined', async () => {
    renderPulse()
    await screen.findByText('Health check failed')
    expect(screen.queryByTestId('pulse-needs-goal')).not.toBeInTheDocument()
  })

  it('shows every attention item, not just the Task-shaped ones', async () => {
    // The shell renders the same list unfiltered a few pixels away. Two
    // surfaces on one screen disagreeing about whether anything is pending is
    // worse than either alone — and only the Task adapter emits the token
    // reasons an earlier filter matched on.
    renderPulse()
    expect(await screen.findByText('Health check failed')).toBeInTheDocument()
    expect(screen.getByText('Ship release')).toBeInTheDocument()
    expect(screen.queryByText('Nothing is waiting on you.')).not.toBeInTheDocument()
  })

  it('keeps a Task reached from here inside the Project', async () => {
    renderPulse()
    expect(await screen.findByRole('link', { name: 'Ship release' }))
      .toHaveAttribute('href', '/projects/project-1/tasks/task-1')
    expect(screen.getByRole('link', { name: 'Run the depth repair' }))
      .toHaveAttribute('href', '/projects/project-1/tasks/task-active')
  })

  it('groups what needs a person by why it needs them', async () => {
    // ADR 0017 §4: a decision, a spend and a suggestion read differently and
    // are acted on differently. One undifferentiated list is what made six
    // identical cards feel like a pile nobody could resolve.
    renderPulse({
      ...overview,
      attention: [
        { id: 'a1', attention_class: 'gate', title: 'Decide the proposal', summary: null, href: '/proposals', severity: 'high' },
        { id: 'a2', attention_class: 'remainder', title: 'Read the earlier 673', summary: null, href: '/projects/project-1/research', severity: 'normal' },
        { id: 'a3', attention_class: 'next_step', source_type: 'inquiry_advice', source_id: 'thread-7', title: 'Split this question', summary: null, href: '/projects/project-1/inquiry', severity: 'normal' },
      ],
    } as ProjectOverview)

    expect(await screen.findByTestId('attention-gate')).toHaveTextContent('Decide the proposal')
    expect(screen.getByTestId('attention-remainder')).toHaveTextContent('Read the earlier 673')
    expect(screen.getByTestId('attention-next_step')).toHaveTextContent('Split this question')
    expect(screen.getByText('Waiting on your decision')).toBeInTheDocument()
    // The system worked the step out; taking it must not mean navigating to
    // an Area to press the same button.
    fireEvent.click(within(screen.getByTestId('attention-next_step')).getByRole('button', { name: 'Adopt' }))
    await waitFor(() => expect(inquiryApi.adoptAdvice).toHaveBeenCalledWith('project-1', 'thread-7'))
    // The attention list lives on the overview this surface receives as a
    // prop: without telling its owner, the adopted suggestion stays on screen
    // and a second click 404s against its own "already taken" guard.
    await waitFor(() => expect(overviewChanged).toHaveBeenCalled())
    // A gate is not adoptable.
    expect(within(screen.getByTestId('attention-gate')).queryByRole('button', { name: 'Adopt' })).not.toBeInTheDocument()
    expect(screen.getByText('Suggested next step')).toBeInTheDocument()
    // A class with nothing in it is not a heading.
    expect(screen.queryByTestId('attention-uncertain')).not.toBeInTheDocument()
  })

  it('shows a running Operation, what it is doing, and how far in', async () => {
    // The failure this fixes: a research acquisition screened 873 documents
    // for four hours while this panel said "nothing is being worked on",
    // because its only source was the Task board and an Operation is not a
    // Task. The progress was in the Operation the whole time.
    renderPulse({
      ...overview,
      in_progress: [{
        id: 'op-1', project_id: 'project-1', kind: 'research', title: 'Start initial material intake',
        status: 'active', created_at: '2026-08-27T16:00:00.000Z', updated_at: '2026-08-27T20:00:00.000Z',
        progress_json: {
          current_stage: 'screening',
          screening_progress: {
            phase: 'screening_batches', total_items: 873, classified_items: 848,
            total_batches: 88, completed_batches: 85, running_batches: 2, queued_batches: 1,
          },
        },
      }],
    } as ProjectOverview)

    const row = await screen.findByTestId('in-progress-op-1')
    expect(within(row).getByText(/848\/873 materials classified/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Start initial material intake' }))
      .toHaveAttribute('href', '/projects/project-1/research?tab=runs&open=op-1')
    // A bar and a spinner say "something is happening" and nothing else; a
    // stage with no item counts of its own must still say where it is.
    expect(within(row).getByText(/% · step 3\/5/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing is being worked on right now.')).not.toBeInTheDocument()
  })

  it('shows how far along a stage that counts nothing is', async () => {
    // Synthesis has no item counts of its own, so the row used to be a
    // sentence, a spinner and a bar — no number anywhere. Where it is in the
    // pipeline, and how far, is available at every stage.
    renderPulse({
      ...overview,
      in_progress: [{
        id: 'op-2', project_id: 'project-1', kind: 'research', title: 'Start initial material intake',
        status: 'active', created_at: '2026-08-27T16:00:00.000Z', updated_at: '2026-08-27T22:20:00.000Z',
        progress_json: {
          current_stage: 'synthesis',
          synthesis_progress: { run_status: 'queued', queued_at: '2026-08-27T22:19:40.000Z' },
        },
      }],
    } as ProjectOverview)

    const row = await screen.findByTestId('in-progress-op-2')
    expect(within(row).getByText(/Synthesis run queued/)).toBeInTheDocument()
    expect(within(row).getByText(/% · step 4\/5/)).toBeInTheDocument()
  })

  it('does not call finished work "in progress"', async () => {
    renderPulse()
    expect(await screen.findByText('Run the depth repair')).toBeInTheDocument()
    expect(screen.queryByText('Old agent work')).not.toBeInTheDocument()
  })

  it('says it could not load rather than that nothing is happening', async () => {
    // The one surface whose whole job is situational awareness must never
    // report a failed read as an all-clear.
    vi.mocked(projectsApi.getBoard).mockRejectedValue(new Error('boom'))
    renderPulse()
    expect(await screen.findByText(/Could not load/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing is being worked on right now.')).not.toBeInTheDocument()
    expect(screen.queryByText('Nobody has reported on this Project yet.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })

  it('asks for only the updates it shows', async () => {
    renderPulse()
    await waitFor(() => expect(projectsApi.updates).toHaveBeenCalledWith('project-1', { limit: 3 }))
  })
})
