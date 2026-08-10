import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Factory is hoisted — define the mocks inline, then import the (mocked) module for assertions.
vi.mock('../api/client', () => ({
  meApi: {
    summary: vi.fn().mockResolvedValue({
      pending_proposals_count: 1, assigned_tasks_count: 0, recent_runs: [], recent_participation: [], accessible_spaces_count: 2,
      spaces: [
        { space_id: 'team-1', name: 'Acme Team', type: 'team', pending_proposals_count: 1, assigned_tasks_count: 0, recent_failed_runs_count: 0 },
      ],
    }),
    timeline: vi.fn().mockResolvedValue([]),
    tasks: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
    pending: vi.fn().mockResolvedValue([
      { id: 'p1', space_id: 'team-1', proposal_type: 'memory_update', status: 'pending', urgency: 'normal', title: 'A team proposal', visibility: 'space_shared', created_by_user_id: null, created_at: '', updated_at: '' },
    ]),
  },
  homeApi: { summary: vi.fn() },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    spaces: [
      { id: 'personal-1', name: 'My Personal', type: 'personal', role: 'owner', created_at: '', updated_at: '' },
      { id: 'team-1', name: 'Acme Team', type: 'team', role: 'member', created_at: '', updated_at: '' },
    ],
    personalSpaceId: 'personal-1',
    activeSpaceId: 'personal-1',
    preferredSpaceId: 'personal-1',
  }),
}))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'u1', display_name: 'Ada', email: 'a@x', avatar_url: null, default_space_id: 'personal-1', created_at: '', last_login_at: null } }),
}))

import { meApi, homeApi } from '../api/client'
import HomePage from '../modules/home/HomePage'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function renderHome() {
  render(<MemoryRouter future={routerFuture}><HomePage /></MemoryRouter>)
}

async function waitForHomeData() {
  await screen.findAllByText('A team proposal')
}

describe('HomePage (user-scoped Today Command Center)', () => {
  it('reads the /me aggregate, never the space-scoped Space Today endpoint', async () => {
    renderHome()
    await waitForHomeData()

    expect(meApi.summary).toHaveBeenCalled()
    expect(homeApi.summary).not.toHaveBeenCalled()
  })

  it('does not retain the hardcoded Personal Assistant chat entry', async () => {
    renderHome()
    await waitForHomeData()

    expect(screen.queryByText('Personal Assistant')).toBeNull()
    expect(screen.queryByText(/DirectChat/i)).toBeNull()
  })

  it('labels cross-space aggregated items with a source Space badge', async () => {
    renderHome()

    expect((await screen.findAllByText('A team proposal')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText('Acme Team')).length).toBeGreaterThan(0)
  })
})
