import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { informationDigestsApi } from '../../../api/client'
import ProjectDigestPage from '../ProjectDigestPage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }))
vi.mock('../../../api/client', () => ({ informationDigestsApi: { project: vi.fn() } }))

describe('ProjectDigestPage', () => {
  beforeEach(() => {
    vi.mocked(informationDigestsApi.project).mockResolvedValue({
      id: 'digest-1', digest_type: 'project', owner_user_id: null, project_id: 'project-1',
      digest_date: '2026-08-06', profile_maturity: null, status: 'ready', settings: {},
      created_at: '2026-08-06T07:00:00Z', updated_at: '2026-08-06T07:00:00Z',
      team_aggregates_available: true, team_blind_spot_domains: ['biology'],
      items: [{
        id: 'digest-item-1', source_item_id: 'source-item-1', section: 'interest', position: 0,
        quota_slot: 'project:1', matched_topic_id: null, serendipity_pool_item_id: null,
        target_domain_key: null, discovery_origin: null, score: 0.9, component_scores: {},
        rationale: 'Project relevance.', title: 'Collectively reviewed paper', source_uri: null,
        source_domain: null, author: null, excerpt: null, occurred_at: '2026-08-06T01:00:00Z',
        domain_key: 'artificial_intelligence', depth: 'analysis', genre: 'paper', summary: null,
        stance_target: null, stance_target_key: null, stance_polarity: 'neutral', stance_confidence: 0,
        read_status: 'unread', serendipity_feedback: null, anonymous_read_count: 3,
      }],
    })
  })

  it('renders only server-thresholded anonymous team signals', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/project-1/digest']}>
        <Routes><Route path="/projects/:projectId/digest" element={<ProjectDigestPage />} /></Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('Team blind spots')).toBeInTheDocument()
    expect(screen.getByText('biology')).toBeInTheDocument()
    expect(screen.getByText('3 people read this')).toBeInTheDocument()
    expect(screen.queryByText(/user-1|user-2/i)).not.toBeInTheDocument()
  })
})
