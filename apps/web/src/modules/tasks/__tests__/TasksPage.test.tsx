import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'team-1', activeSpaceName: 'Team', personalSpaceId: 'personal-1' }),
}))

const mocked = vi.hoisted(() => ({
  listTasks: vi.fn(),
  createTask: vi.fn(),
  listBoards: vi.fn(),
  listAgents: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  tasksApi: { list: mocked.listTasks, create: mocked.createTask, update: vi.fn() },
  boardsApi: { list: mocked.listBoards },
  agentsApi: { list: mocked.listAgents },
}))

import TasksPage from '../TasksPage'

const TASK = {
  id: 'task-1', space_id: 'team-1', board_id: null, title: 'Ship it', description: null,
  task_type: 'build', status: 'open', priority: 'normal', risk_level: 'low', visibility: 'space',
  assigned_user_id: null, assigned_agent_id: null, acceptance_criteria_json: null,
} as unknown as Task

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/spaces/team-1/tasks']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <Routes>
        <Route path="/spaces/:spaceId/tasks" element={<TasksPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.listTasks.mockResolvedValue({ items: [TASK] })
  mocked.listBoards.mockImplementation(async (_params: unknown, options?: { spaceId?: string }) => ({
    items: options?.spaceId === 'personal-1'
      ? [{ id: 'board-personal', name: 'Personal board' }]
      : [{ id: 'board-team', name: 'Team board' }],
  }))
  mocked.listAgents.mockImplementation(async (_params: unknown, options?: { spaceId?: string }) => (
    options?.spaceId === 'personal-1'
      ? [{ id: 'agent-personal', name: 'Personal agent' }]
      : [{ id: 'agent-team', name: 'Team agent' }]
  ))
})

describe('TasksPage', () => {
  it('opens a Task in the Space that holds it', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Ship it'))
    expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/team-1/tasks/task-1')
  })

  it('offers only Boards and Agents from the Personal Space a new Task is written to', async () => {
    mocked.createTask.mockResolvedValue({ ...TASK, id: 'task-2', space_id: 'personal-1' })
    renderPage()
    await screen.findByText('Ship it')
    fireEvent.click(screen.getByRole('button', { name: /New task/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('What needs to be done?'), { target: { value: 'Plan launch' } })

    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'No board' })).toBeInTheDocument())
    fireEvent.click(within(dialog).getByRole('button', { name: 'No board' }))
    expect(within(dialog).queryByRole('option', { name: 'Team board' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('option', { name: 'Personal board' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose later' }))
    expect(within(dialog).queryByRole('option', { name: 'Team agent' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('option', { name: 'Personal agent' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }))

    await waitFor(() => expect(mocked.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Plan launch', board_id: 'board-personal', assigned_agent_id: 'agent-personal' }),
      { spaceId: 'personal-1' },
    ))
    expect(await screen.findByTestId('where')).toHaveTextContent('/spaces/personal-1/tasks/task-2')
  })
})
