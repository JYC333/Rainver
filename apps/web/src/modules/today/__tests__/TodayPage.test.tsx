import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TodayPage from '../TodayPage'
import { homeApi, projectsApi, sessionsApi } from '../../../api/client'
import type { HomeSummaryOut, Project } from '../../../types/api'

const { spaceState } = vi.hoisted(() => ({
  spaceState: { activeSpaceId: 'space-a', activeSpaceName: 'Alpha' },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ ...spaceState, preferredSpaceId: spaceState.activeSpaceId }),
}))

vi.mock('../../../api/client', () => ({
  homeApi: { summary: vi.fn() },
  sessionsApi: { list: vi.fn() },
  projectsApi: { list: vi.fn() },
  proposalsApi: { get: vi.fn(), accept: vi.fn(), reject: vi.fn() },
}))

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function summaryWithSourceItems(openItems: number): HomeSummaryOut {
  return {
    recent_runs: [], active_runs: [], pending_proposals: { count: 0, items: [] }, recent_artifacts: [],
    task_summary: { by_status: {}, total_open: 0, needs_review_count: 0, blocked_count: 0, done_count: 0 },
    active_tasks: [], activity_summary: { recent_count: 0, raw_count: 0, today_count: 0 },
    run_stats_today: { created: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, dry_run_count: 0 },
    job_queue_status: { queued: 0, running: 0, failed: 0, retryable: 0, recent_error_preview: null },
    runtime_status: { real_adapters_configured_count: 0, configured_runtime_keys: [], message: '' },
    model_provider_status: { model_providers_count: 0, enabled_model_providers_count: 0, missing_model_provider_config: true, message: '' },
    suggested_actions: [],
    operations_in_progress: [],
    source_summary: { open_items: openItems, new_items_today: 0, pending_extraction_jobs: 0, failed_extraction_jobs: 0, candidate_evidence: 0, active_evidence: 0, due_connections: 0 },
  } as HomeSummaryOut
}

function projects(name: string) {
  return { items: [{ id: `project-${name}`, name, current_focus: null } as Project] }
}

function page() {
  return <MemoryRouter future={routerFuture}><TodayPage /></MemoryRouter>
}

function switchToBeta(view: ReturnType<typeof render>) {
  spaceState.activeSpaceId = 'space-b'
  spaceState.activeSpaceName = 'Beta'
  view.rerender(page())
}

describe('TodayPage Space switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    spaceState.activeSpaceId = 'space-a'
    spaceState.activeSpaceName = 'Alpha'
    vi.mocked(homeApi.summary).mockResolvedValue(summaryWithSourceItems(0))
    vi.mocked(sessionsApi.list).mockResolvedValue({ items: [] } as never)
  })

  it('keeps the new Space\'s summary and projects when the previous Space answers later', async () => {
    let answerAlphaSummary: (value: HomeSummaryOut) => void = () => {}
    let answerAlphaProjects: (value: ReturnType<typeof projects>) => void = () => {}
    vi.mocked(homeApi.summary)
      .mockImplementationOnce(() => new Promise(resolve => { answerAlphaSummary = resolve }))
      .mockResolvedValueOnce(summaryWithSourceItems(222))
    vi.mocked(projectsApi.list)
      .mockImplementationOnce(() => new Promise(resolve => { answerAlphaProjects = resolve }) as never)
      .mockResolvedValueOnce(projects('Beta project') as never)
    const view = render(page())

    switchToBeta(view)
    expect(await screen.findByText('Beta project')).toBeInTheDocument()
    expect(await screen.findByText('222')).toBeInTheDocument()

    await act(async () => {
      answerAlphaSummary(summaryWithSourceItems(111))
      answerAlphaProjects(projects('Alpha project'))
    })
    expect(screen.queryByText('Alpha project')).not.toBeInTheDocument()
    expect(screen.queryByText('111')).not.toBeInTheDocument()
    expect(screen.getByText('Beta project')).toBeInTheDocument()
  })

  it('drops the previous Space\'s projects when the new Space\'s list fails', async () => {
    vi.mocked(projectsApi.list)
      .mockResolvedValueOnce(projects('Alpha project') as never)
      .mockRejectedValueOnce(new Error('projects unavailable'))
    const view = render(page())
    expect(await screen.findByText('Alpha project')).toBeInTheDocument()

    switchToBeta(view)
    expect(await screen.findByRole('heading', { name: 'Beta' })).toBeInTheDocument()
    await vi.waitFor(() => expect(projectsApi.list).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.queryByText('Alpha project')).not.toBeInTheDocument()
  })
})
