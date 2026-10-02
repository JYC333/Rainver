import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocked = vi.hoisted(() => ({
  listAgents: vi.fn(async () => [{ id: 'agent-1', name: 'Planner' }]),
  listRuntimeProfiles: vi.fn(async () => []),
  execute: vi.fn(async () => ({})),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../api/client', () => ({
  agentsApi: { list: mocked.listAgents, listRuntimeProfiles: mocked.listRuntimeProfiles },
  plansApi: { execute: mocked.execute },
}))

import PlanExecuteDialog from '../PlanExecuteDialog'

describe('PlanExecuteDialog', () => {
  it('offers the Space Agents when its owner opens it, and executes with the chosen one', async () => {
    const onExecuted = vi.fn(async () => {})
    render(<PlanExecuteDialog open planId="plan-1" onOpenChange={vi.fn()} onExecuted={onExecuted} />)

    await waitFor(() => expect(mocked.listAgents).toHaveBeenCalledWith({ limit: '100' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select agent…' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Planner' }))
    fireEvent.click(screen.getByRole('button', { name: 'Execute' }))

    await waitFor(() => expect(mocked.execute).toHaveBeenCalledWith('plan-1', expect.objectContaining({ agent_id: 'agent-1' })))
    expect(onExecuted).toHaveBeenCalled()
  })
})
