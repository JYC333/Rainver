import { render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ProjectsModule from '../ProjectsModule'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../ProjectAreaLayout', () => ({
  default: () => <div>project shell<Outlet /></div>,
}))
vi.mock('../../tasks/TaskDetailPage', () => ({
  default: () => <div>task detail</div>,
}))

/**
 * The route table itself, because href assertions cannot see it.
 *
 * Render the module. Do not check a Task link against a string, and do not
 * declare the route again in the sidecar test. Deleting the real route
 * would leave those tests green while the links render nothing.
 */
describe('Projects module routes', () => {
  it('mounts a Task inside the Project shell', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/tasks/task-1']}>
        <Routes>
          <Route path="/projects/*" element={<ProjectsModule />} />
        </Routes>
      </MemoryRouter>,
    )
    // Both halves: the shell survived the click, and the Task page is what
    // rendered inside it. That is what the Board card, Pulse, Updates and the
    // sidebar attention list all depend on.
    expect(await screen.findByText('project shell')).toBeInTheDocument()
    expect(await screen.findByText('task detail')).toBeInTheDocument()
  })
})
