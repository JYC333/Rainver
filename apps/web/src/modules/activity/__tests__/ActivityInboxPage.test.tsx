import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import ActivityInboxPage from '../ActivityInboxPage'
import { activityApi, projectsApi } from '../../../api/client'
import type { ActivityInboxRecord, Project } from '../../../types/api'

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
  activityApi: {
    list: vi.fn(),
    review: vi.fn(),
    archive: vi.fn(),
  },
  projectsApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 }),
  },
}))

function activityRecord(overrides: Partial<ActivityInboxRecord> = {}): ActivityInboxRecord {
  return {
    id: 'activity-1',
    space_id: 'space-1',
    user_id: 'user-1',
    project_folder_id: null,
    agent_id: null,
    source_type: 'user_capture',
    title: 'Captured note',
    content: 'Remember this.',
    source_run_id: null,
    source_task_id: null,
    source_session_id: null,
    source_url: null,
    status: 'raw',
    metadata_json: {},
    visibility: 'space_shared',
    created_at: '2026-07-08T10:00:00.000Z',
    updated_at: '2026-07-08T10:00:00.000Z',
    ...overrides,
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Marginalia',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: null,
    active_brief_version_id: null,
    created_at: '2026-07-08T10:00:00.000Z',
    updated_at: '2026-07-08T10:00:00.000Z',
    archived_at: null,
    ...overrides,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/activity']}>
      <Routes>
        <Route path="/activity" element={<ActivityInboxPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ActivityInboxPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders briefing pointer rows as links to the Library digest view', async () => {
    vi.mocked(activityApi.list).mockResolvedValue([
      activityRecord({
        id: 'briefing-1',
        source_type: 'source',
        title: 'arXiv - 2026-07-08 briefing',
        content: '2 items screened: 1 relevant, 1 maybe, 0 not relevant.',
        metadata_json: {
          briefing_date: '2026-07-08',
          source_connection_id: 'conn-1',
          post_processing_run_ids: ['run-1'],
          artifact_ids: ['artifact-1'],
          decision_counts: { relevant: 1, maybe: 1, not_relevant: 0 },
          run_count: 1,
        },
        aggregate_key: 'source:briefing:conn-1:2026-07-08',
      }),
    ])

    renderPage()

    expect(await screen.findByRole('link', { name: 'arXiv - 2026-07-08 briefing' }))
      .toHaveAttribute('href', '/library/digests/conn-1/2026-07-08')
    expect(screen.getByRole('link', { name: 'Open Digest' })).toHaveAttribute('href', '/library/digests/conn-1/2026-07-08')
    expect(screen.getByText('1 relevant')).toBeInTheDocument()
    expect(screen.getByText('1 maybe')).toBeInTheDocument()
    expect(screen.getByText('0 not relevant')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Generate proposals' })).not.toBeInTheDocument()
  })

  it('keeps ordinary activity rows on the Activity detail flow', async () => {
    vi.mocked(activityApi.list).mockResolvedValue([
      activityRecord(),
    ])

    renderPage()

    expect(await screen.findByRole('link', { name: 'Captured note' }))
      .toHaveAttribute('href', '/activity/activity-1')
    expect(screen.getByRole('link', { name: 'Generate proposals' }))
      .toHaveAttribute('href', '/activity/activity-1')
  })
})

/**
 * Capture inside a Project writes raw material to the Space's one review queue
 * — there is no second queue in the Project. That is only legible if the row
 * says which Project it belongs to; without it, the capture reads as having
 * gone somewhere the user did not choose.
 */
describe('ActivityInboxPage project ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(projectsApi.list).mockResolvedValue({
      items: [project()], total: 1, limit: 200, offset: 0,
    })
  })

  it('names the owning Project on a record captured inside one', async () => {
    vi.mocked(activityApi.list).mockResolvedValue([
      activityRecord({ id: 'raw-1', project_id: 'project-1' }),
    ])

    renderPage()

    expect(await screen.findByText('Marginalia')).toBeInTheDocument()
  })

  it('narrows the queue to that Project when the tag is clicked', async () => {
    vi.mocked(activityApi.list).mockResolvedValue([
      activityRecord({ id: 'raw-1', project_id: 'project-1' }),
    ])

    renderPage()
    fireEvent.click(await screen.findByLabelText('Filter by project Marginalia'))

    await waitFor(() => expect(activityApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ project_id: 'project-1' }),
    ))
  })

  it('leaves a record with no Project untagged', async () => {
    vi.mocked(activityApi.list).mockResolvedValue([activityRecord({ id: 'raw-2' })])

    renderPage()

    expect(await screen.findByText('Captured note')).toBeInTheDocument()
    expect(screen.queryByText('Marginalia')).toBeNull()
  })
})
