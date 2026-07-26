import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom'
import ActivityInboxPage from '../ActivityInboxPage'
import { activityApi } from '../../../api/client'
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
  activityApi: {
    list: vi.fn(),
    review: vi.fn(),
    archive: vi.fn(),
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
