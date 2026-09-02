import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import CommandCenterPage from '../CommandCenterPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space', preferredSpaceId: 'space-1', spaces: [] }),
}))
vi.mock('../DispatchComposer', () => ({ default: () => <div>Dispatch composer</div> }))
vi.mock('../WorkStreamList', () => ({ default: () => <div>Work stream contents</div> }))
vi.mock('../HostsPanel', () => ({ default: () => <div>Host setup contents</div> }))

describe('CommandCenterPage', () => {
  it('opens the Hosts setup tab from a backend-setup deep link', () => {
    render(
      <MemoryRouter initialEntries={['/spaces/space-1/command-center?tab=hosts']}>
        <Routes>
          <Route path="/spaces/:spaceId/command-center" element={<CommandCenterPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(screen.getByText('Host setup contents')).toBeInTheDocument()
    expect(screen.queryByText('Work stream contents')).not.toBeInTheDocument()
  })
})
