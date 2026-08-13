import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import ProjectRawMaterialPage from '../ProjectRawMaterialPage'
import { activityApi, projectsApi } from '../../../api/client'
import type { ActivityInboxRecord } from '../../../types/api'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <Link to={to} {...props}>{children}</Link>
  ),
}))

vi.mock('../../../api/client', () => ({
  activityApi: { list: vi.fn(), review: vi.fn(), archive: vi.fn() },
  projectsApi: { list: vi.fn() },
}))

function activityRecord(overrides: Partial<ActivityInboxRecord> = {}): ActivityInboxRecord {
  return {
    id: 'activity-1',
    space_id: 'space-1',
    user_id: 'user-1',
    project_folder_id: null,
    agent_id: null,
    source_type: 'user_capture',
    title: 'Captured in the project',
    content: 'Remember this.',
    source_run_id: null,
    source_task_id: null,
    source_session_id: null,
    source_url: null,
    status: 'raw',
    metadata_json: {},
    visibility: 'space_shared',
    project_id: 'project-1',
    created_at: '2026-08-12T10:00:00.000Z',
    updated_at: '2026-08-12T10:00:00.000Z',
    ...overrides,
  }
}

function renderPage(entry = '/projects/project-1/raw') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:projectId/raw" element={<ProjectRawMaterialPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(activityApi.list).mockResolvedValue([activityRecord()])
})

/**
 * The Project's own view of the Space's one review queue. What matters is that
 * it is that queue — same records, same actions — scoped, and that the scope
 * is not something the address bar can widen.
 */
describe('ProjectRawMaterialPage', () => {
  it('asks only for this project\'s records', async () => {
    renderPage()

    await waitFor(() => expect(activityApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-1', status: 'raw' }),
    ))
    expect(await screen.findByText('Captured in the project')).toBeInTheDocument()
  })

  it('ignores a project_id in the URL rather than letting it retarget the page', async () => {
    renderPage('/projects/project-1/raw?project_id=project-2')

    await waitFor(() => expect(activityApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-1' }),
    ))
  })

  it('drops the per-row Project tag, which every row here would repeat', async () => {
    renderPage()

    await screen.findByText('Captured in the project')
    expect(screen.queryByLabelText(/^Filter by project/)).toBeNull()
    // And it does not pay for the names it would need to render them.
    expect(projectsApi.list).not.toHaveBeenCalled()
  })

  it('offers the same review actions as the Space Inbox', async () => {
    renderPage()

    expect(await screen.findByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
  })
})
