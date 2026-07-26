import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { plansApiMock } = vi.hoisted(() => ({ plansApiMock: { list: vi.fn() } }))

vi.mock('../../../api/client', () => ({ plansApi: plansApiMock }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Test Space' }) }))
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }))

import PlansPage from '../PlansPage'

describe('PlansPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    plansApiMock.list.mockResolvedValue([{
      id: 'plan-1', space_id: 'space-1', project_folder_id: null, project_id: null, source_task_id: 'task-1', root_run_id: null,
      name: 'Plan Alpha', description: 'Agent generated', status: 'active', created_by_user_id: 'user-1', created_by_agent_id: 'agent-1',
      created_at: '2026-07-12T00:00:00Z', updated_at: '2026-07-12T00:00:00Z',
      current_version: { id: 'version-1', version: 1, status: 'approved', node_count: 2, depth: 2, pending_node_count: 1 },
    }])
  })

  it('shows Agent plans and links each plan to its source Task', async () => {
    render(<MemoryRouter><PlansPage /></MemoryRouter>)
    expect(await screen.findByText('Plan Alpha')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Source task/ })).toHaveAttribute('href', '/tasks/task-1')
    expect(plansApiMock.list).toHaveBeenCalledWith({ limit: 100 })
    expect(screen.queryByRole('button', { name: /New plan/i })).not.toBeInTheDocument()
  })
})
