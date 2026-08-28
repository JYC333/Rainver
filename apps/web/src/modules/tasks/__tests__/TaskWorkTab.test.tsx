import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskWorkTab from '../TaskWorkTab'
import { tasksApi } from '../../../api/client'
import type { TaskWorkView } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../../../api/client', () => ({
  tasksApi: { work: vi.fn(), setStage: vi.fn() },
}))

function view(overrides: Partial<TaskWorkView> = {}): TaskWorkView {
  return {
    task: {
      id: 'task-1', project_id: 'project-1', title: 'Draft the protocol',
      status: 'waiting_for_review', definition_of_done: null, required_outputs: [],
      completed_at: null,
    },
    loop: { current_stage_key: 'verify', stage_entered_at: '2026-08-27T00:00:00.000Z', revision: 1 },
    visited_stage_keys: ['verify'],
    stages: [
      { key: 'frame', label: 'Question' },
      { key: 'plan', label: 'Method' },
      { key: 'act', label: 'Investigate' },
      { key: 'verify', label: 'Evaluate' },
      { key: 'conclude', label: 'Conclude' },
    ],
    responsible: { kind: 'user', id: 'user-1', display_name: 'Yuchuan' },
    completion: { ok: false, missing: ['evaluation'] },
    evaluation: null,
    present_outputs: [],
    links: [],
    events: [],
    runs: [],
    ...overrides,
  } as TaskWorkView
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tasksApi.work).mockResolvedValue(view() as never)
})

function renderTab() {
  return render(<MemoryRouter><TaskWorkTab taskId="task-1" /></MemoryRouter>)
}

describe('Task work tab', () => {
  it('ticks only the stages the Task has actually been in', async () => {
    // A Task that settled straight to Evaluate never framed, planned or acted.
    // Marking earlier stages done by position claims work nobody did.
    renderTab()
    await waitFor(() => expect(screen.getByTestId('loop-stage-verify')).toBeInTheDocument())
    expect(screen.getByTestId('loop-stage-verify')).toHaveAttribute('data-current', 'true')
    for (const key of ['frame', 'plan', 'act', 'conclude']) {
      expect(screen.getByTestId(`loop-stage-${key}`)).toHaveAttribute('data-visited', 'false')
    }
  })

  it('ticks a stage once it has been visited, even after moving back', async () => {
    vi.mocked(tasksApi.work).mockResolvedValue(view({
      loop: { current_stage_key: 'plan', stage_entered_at: '2026-08-27T01:00:00.000Z', revision: 2 },
      visited_stage_keys: ['plan', 'verify'],
    }) as never)
    renderTab()
    await waitFor(() => expect(screen.getByTestId('loop-stage-plan')).toBeInTheDocument())
    expect(screen.getByTestId('loop-stage-plan')).toHaveAttribute('data-current', 'true')
    // Verify was reached and then sent back — it stays ticked, because it
    // happened, and the rail is a record rather than a progress bar. Asserting
    // the tick positively matters: without it, hardcoding "nothing is done"
    // would pass every case here.
    expect(screen.getByTestId('loop-stage-verify')).toHaveAttribute('data-visited', 'true')
    expect(screen.getByTestId('loop-stage-act')).toHaveAttribute('data-current', 'false')
    expect(screen.getByTestId('loop-stage-act')).toHaveAttribute('data-visited', 'false')
  })

  it('names what is missing before the Task can close', async () => {
    renderTab()
    expect(await screen.findByText(/No evaluation has accepted the result/)).toBeInTheDocument()
  })
})
