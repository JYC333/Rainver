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

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

describe('RunsPage', () => {
  it('loads runs from the preferred space when opened from a user-scoped route', async () => {
    render(
      <MemoryRouter future={routerFuture}>
        <RunsPage />
      </MemoryRouter>,
    )

    await waitFor(() => expect(runsApi.list).toHaveBeenCalled())
    expect(await screen.findByText('Viewing: Personal Space')).toBeInTheDocument()
  })
})
