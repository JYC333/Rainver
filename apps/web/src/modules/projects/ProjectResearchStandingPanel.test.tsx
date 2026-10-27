import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ResearchScanTimeline } from './ResearchScanTimeline'
import { ProjectResearchStandingPanel } from './ProjectResearchStandingPanel'
import { projectResearchApi } from '../../api/client'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('../../api/client', () => ({
  projectResearchApi: {
    standing: vi.fn(),
    initializeArea: vi.fn(),
    retryStandingBatch: vi.fn(),
    actionStandingAdvice: vi.fn(),
    dismissStandingAdvice: vi.fn(),
  },
}))

const batch = (id: string, status: 'blocked_baseline' | 'budget_exhausted' | 'failed') => ({
  id,
  status,
  source_item_ids: ['item-1'],
  ready_at: '2026-08-07T00:00:00.000Z',
  run_id: status === 'failed' ? 'run-1' : null,
  missing_baseline_role: status === 'blocked_baseline' ? 'understanding' : null,
  error: status === 'failed' ? 'Provider execution failed' : null,
  created_at: '2026-08-07T00:00:00.000Z',
  updated_at: '2026-08-07T00:00:00.000Z',
  completed_at: '2026-08-07T00:00:00.000Z',
})

describe('ProjectResearchStandingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectResearchApi.standing).mockResolvedValue({
      enabled: true,
      enabled_binding_count: 1,
      budget: { daily_limit: 20, daily_used: 20 },
      batches: [batch('blocked-1', 'blocked_baseline'), batch('budget-1', 'budget_exhausted'), batch('failed-1', 'failed')],
      advice: [],
      recent_inflow: [],
    })
    vi.mocked(projectResearchApi.initializeArea).mockResolvedValue({} as never)
    vi.mocked(projectResearchApi.retryStandingBatch).mockResolvedValue({} as never)
  })

  it('renders durable failure states and repairs the baseline before retrying', async () => {
    render(<ProjectResearchStandingPanel projectId="project-1" canAct />)

    expect(await screen.findByText('Project understanding is not ready')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Reading List' })).toHaveAttribute('href', '/projects/project-1/research?tab=reading')
    expect(screen.getByText('Daily comparison budget reached')).toBeInTheDocument()
    expect(screen.getByText('Provider execution failed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Project notes' })).toHaveAttribute('href', '/projects/project-1/notes')
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', '/runs/run-1')

    fireEvent.click(screen.getAllByRole('button', { name: 'Retry comparison' })[0]!)
    await waitFor(() => {
      expect(projectResearchApi.initializeArea).toHaveBeenCalledWith('project-1')
      expect(projectResearchApi.retryStandingBatch).toHaveBeenCalledWith('project-1', 'blocked-1')
    })
  })
})

it('links a completed scan update to the explicit standing tab', () => {
  render(<ResearchScanTimeline projectId="project-1" monitoringActive summaries={[{
    workflow_id: 'workflow-1', scan_date: '2026-10-24', new_item_count: 1,
    relevant_count: 1, maybe_count: 0, supports_count: 1, contradicts_count: 0,
    new_direction_count: 0, comparisons: [], integrity_alerts: [],
  } as never]} />)
  expect(screen.getByRole('link', { name: 'View update' })).toHaveAttribute('href', '/projects/project-1/research?tab=standing')
})
