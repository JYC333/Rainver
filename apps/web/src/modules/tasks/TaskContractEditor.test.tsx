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
    }))
    // No default time limit: a long-running Task is not stopped unless someone sets one.
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('max_duration_seconds')
    expect(screen.getByText(/no time limit/)).toBeInTheDocument()
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
  it('clears a stored time limit with an explicit null and leaves an unset one untouched', async () => {
    const user = userEvent.setup({ delay: null })
    const base = {
      title: 'Existing task',
      description: null,
      task_type: 'general',
      priority: 'normal',
      risk_level: 'low',
      board_id: null,
      assigned_agent_id: null,
      definition_of_done: null,
      max_runs: 3,
      max_cost: 10,
      tags: [],
    }
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { unmount } = render(<TaskContractEditor task={{ ...base, max_duration_seconds: 3600 } as unknown as Task} boards={[]} agents={[]} submitLabel="Save contract" onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: /Advanced execution limits/ }))
    await user.clear(screen.getByLabelText('Max duration (seconds)'))
    await user.clear(screen.getByLabelText('Max runs'))
    await user.clear(screen.getByLabelText('Max cost'))
    await user.click(screen.getByRole('button', { name: 'Save contract' }))
    // The update API keeps an omitted field, so clearing a stored limit must send null.
    expect(JSON.parse(JSON.stringify(onSubmit.mock.calls[0]?.[0]))).toMatchObject({ max_duration_seconds: null, max_runs: null, max_cost: null })
    unmount()

    const untouched = vi.fn().mockResolvedValue(undefined)
    render(<TaskContractEditor task={{ ...base, max_duration_seconds: null } as unknown as Task} boards={[]} agents={[]} submitLabel="Save contract" onSubmit={untouched} />)
    await user.click(screen.getByRole('button', { name: 'Save contract' }))
    expect(JSON.parse(JSON.stringify(untouched.mock.calls[0]?.[0]))).not.toHaveProperty('max_duration_seconds')
    expect(untouched.mock.calls[0]?.[0]).toMatchObject({ max_runs: 3, max_cost: 10 })
  })
})
