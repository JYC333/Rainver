import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Task } from '../../types/api'
import TaskCreateForm from './TaskCreateForm'
import TaskContractEditor from './TaskContractEditor'

describe('TaskContractEditor', () => {
  it('creates a source Task from natural language without exposing generated JSON or parent ids', async () => {
    const user = userEvent.setup({ delay: null })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<TaskCreateForm boards={[]} agents={[]} submitLabel="Create task" onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('What needs to be done?'), 'Ship contract')
    await user.click(screen.getByRole('button', { name: 'Create task' }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Ship contract',
      max_runs: 3,
      max_cost: 10,
      max_duration_seconds: 3600,
    }))
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('parent_task_id')
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('acceptance_criteria_json')
    expect(screen.queryByText('Acceptance criteria JSON')).not.toBeInTheDocument()
    expect(screen.queryByText('Parent task ID')).not.toBeInTheDocument()
  })

  it('keeps generated contract fields out of manual editing and collapses execution limits', () => {
    const task = {
      title: 'Existing task',
      description: 'Context',
      task_type: 'general',
      priority: 'normal',
      risk_level: 'low',
      board_id: null,
      assigned_agent_id: null,
      definition_of_done: null,
      max_runs: 3,
      max_cost: 10,
      max_duration_seconds: 3600,
      tags: [],
    } as unknown as Task
    render(<TaskContractEditor task={task} boards={[]} agents={[]} submitLabel="Save contract" onSubmit={vi.fn().mockResolvedValue(undefined)} />)

    expect(screen.queryByText('Acceptance criteria JSON')).not.toBeInTheDocument()
    expect(screen.queryByText('Parent task ID')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Max runs')).not.toBeInTheDocument()
  })
})
