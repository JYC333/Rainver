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
  tasksApi: { work: vi.fn() },
}))

function view(overrides: Partial<TaskWorkView> = {}): TaskWorkView {
  return {
    task: {
      id: 'task-1', project_id: 'project-1', title: 'Draft the protocol',
      status: 'waiting_for_review', definition_of_done: null, required_outputs: [],
      completed_at: null,
    },
    responsible: { kind: 'user', id: 'user-1', display_name: 'Test User' },
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
  it('shows who is responsible', async () => {
    renderTab()
    expect(await screen.findByText('Responsible')).toBeInTheDocument()
    expect(screen.getByText('Test User')).toBeInTheDocument()
  })

  it('names what is missing before the Task can close', async () => {
    renderTab()
    expect(await screen.findByText(/No evaluation has accepted the result/)).toBeInTheDocument()
  })

  it('reloads the Work view when the page asks it to', async () => {
    const view = render(<MemoryRouter><TaskWorkTab taskId="task-1" refreshToken={0} /></MemoryRouter>)
    await waitFor(() => expect(tasksApi.work).toHaveBeenCalledTimes(1))

    view.rerender(<MemoryRouter><TaskWorkTab taskId="task-1" refreshToken={1} /></MemoryRouter>)
    await waitFor(() => expect(tasksApi.work).toHaveBeenCalledTimes(2))
  })
})

it('opens the associated question from the Task parent surface',async()=>{
 vi.mocked(tasksApi.work).mockResolvedValue(view({links:[{entity_type:'inquiry_thread',entity_id:'thread-1',role:'investigates'}]}) as never);
 renderTab();expect(await screen.findByRole('link',{name:'Open question'})).toHaveAttribute('href','/projects/project-1/inquiry?thread=thread-1');
});
