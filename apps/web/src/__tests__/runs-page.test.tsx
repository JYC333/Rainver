import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
  projectsApi: {
    list: vi.fn().mockResolvedValue({ items: [] }),
  },
  projectFoldersApi: {
    list: vi.fn().mockResolvedValue({ items: [] }),
  },
  runsApi: {
    list: vi.fn().mockResolvedValue([]),
    stop: vi.fn(),
  },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: null,
    activeSpaceName: null,
    preferredSpaceId: 'personal-1',
    spaces: [
      { id: 'personal-1', name: 'Personal Space', type: 'personal' },
    ],
  }),
}))

import { runsApi } from '../api/client'
import RunsPage from '../modules/runs/RunsPage'
import type { Run } from '../types/api'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function run(overrides: Partial<Run>): Run {
  return {
    id: 'run-1', space_id: 'personal-1', agent_id: null, agent_version_id: null,
    run_role: 'execution', project_folder_id: null, session_id: null, parent_run_id: null,
    run_type: 'agent', trigger_origin: 'user', status: 'succeeded', mode: 'live',
    prompt: null, instruction: null, scheduled_at: null, started_at: null, ended_at: null,
    created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
    error_message: null, error_json: null, output_json: null, usage: null,
    ...overrides,
  } as Run
}

describe('RunsPage', () => {
  it('loads runs from the preferred space when opened from a user-scoped route', async () => {
    vi.mocked(runsApi.list).mockResolvedValue([])
    render(
      <MemoryRouter future={routerFuture}>
        <RunsPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(runsApi.list).toHaveBeenCalled())
    expect(await screen.findByText('Viewing: Personal Space')).toBeInTheDocument()
  })

  it('names a bounded provider task instead of reporting a missing Agent', async () => {
    // A `provider_task` Run has no Agent by construction (research ad-hoc
    // analysis, notebook chat, daily reports); "Agent unavailable" read as a
    // fault for what is the normal shape of that Run.
    vi.mocked(runsApi.list).mockResolvedValue([
      // `run_type` is the durable Run classification `ck_runs_run_type`
      // constrains; `provider_task` is not one of its values. A real bounded
      // provider task carries the run_type its writer uses — `agent` for
      // research ad-hoc analysis — and is marked by `execution_kind`.
      run({ id: 'run-pt', execution_kind: 'provider_task', capability_id: 'research.adhoc_analyze', run_type: 'agent' }),
      run({ id: 'run-agent', execution_kind: 'agent', agent_id: 'agent-gone' }),
    ])
    render(
      <MemoryRouter future={routerFuture}>
        <RunsPage />
      </MemoryRouter>,
    )

    expect(await screen.findByText(/Bounded provider task · research\.adhoc_analyze/)).toBeInTheDocument()
    expect(screen.getByText('provider task')).toBeInTheDocument()
    // An `agent` Run whose Agent really is missing still says so.
    expect(screen.getByText(/Agent unavailable/)).toBeInTheDocument()
  })
})
