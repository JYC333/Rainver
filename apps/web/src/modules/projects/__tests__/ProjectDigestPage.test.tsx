import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { informationDigestsApi } from '../../../api/client'
import ProjectDigestPage from '../ProjectDigestPage'
import type { InformationDigest } from '../../../types/api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-1' }) }))
vi.mock('../../../core/spaceNav', () => ({ SpaceLink: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }))
vi.mock('../../../api/client', () => ({
  informationDigestsApi: { project: vi.fn(), backfillProject: vi.fn() },
  informationBriefingsApi: { project: async () => ({ can_generate: false, daily_enabled: false, latest: null, history: [] }) },
}))

/** A history read that found the day's scheduled snapshot. */
function available(digest: Omit<InformationDigest, 'timezone' | 'period_start_utc' | 'period_end_utc' | 'generation_kind' | 'generated_at'>) {
  return {
    status: 'available' as const,
    digest: {
      ...digest,
      timezone: 'UTC', period_start_utc: `${digest.digest_date}T00:00:00.000Z`, period_end_utc: `${digest.digest_date}T23:59:59.999Z`,
      generation_kind: 'scheduled' as const, generated_at: digest.created_at,
    },
  }
}

describe('ProjectDigestPage', () => {
  beforeEach(() => {
    vi.mocked(informationDigestsApi.project).mockResolvedValue(available({
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
    }))
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

  it('offers a Project backfill for a missing day and shows the refusal when the reader cannot write', async () => {
    vi.mocked(informationDigestsApi.project).mockResolvedValue({
      status: 'missing', digest_date: '2026-08-06', timezone: 'UTC',
      period_start_utc: '2026-08-06T00:00:00.000Z', period_end_utc: '2026-08-07T00:00:00.000Z',
      reason: 'not_generated', backfill_available: true,
    })
    vi.mocked(informationDigestsApi.backfillProject).mockRejectedValue(new Error('Project write access is required'))
    render(
      <MemoryRouter initialEntries={['/projects/project-1/digest']}>
        <Routes><Route path="/projects/:projectId/digest" element={<ProjectDigestPage />} /></Routes>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Backfill this day' }))
    await waitFor(() => expect(informationDigestsApi.backfillProject).toHaveBeenCalledWith('space-1', 'project-1', '2026-08-06'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Project write access is required'))
    expect(screen.getByText('No digest for Aug 6, 2026')).toBeInTheDocument()
  })

  it('tells a reader who cannot write that the day is missing, without offering a backfill', async () => {
    vi.mocked(informationDigestsApi.project).mockResolvedValue({
      status: 'missing', digest_date: '2026-08-06', timezone: 'UTC',
      period_start_utc: '2026-08-06T00:00:00.000Z', period_end_utc: '2026-08-07T00:00:00.000Z',
      reason: 'not_generated', backfill_available: false,
    })
    render(
      <MemoryRouter initialEntries={['/projects/project-1/digest']}>
        <Routes><Route path="/projects/:projectId/digest" element={<ProjectDigestPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('No digest for Aug 6, 2026')).toBeInTheDocument()
    expect(screen.getByText(/No digest was generated for this day/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Backfill this day' })).not.toBeInTheDocument()
  })

  it('opens another Project at its own latest day, not the day picked in this one', async () => {
    vi.mocked(informationDigestsApi.project).mockClear()
    function SwitchProject() {
      const navigate = useNavigate()
      return <button type="button" onClick={() => navigate('/projects/project-2/digest')}>Go to project 2</button>
    }
    render(
      <MemoryRouter initialEntries={['/projects/project-1/digest']}>
        <SwitchProject />
        <Routes><Route path="/projects/:projectId/digest" element={<ProjectDigestPage />} /></Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('biology')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(informationDigestsApi.project).toHaveBeenLastCalledWith('space-1', 'project-1', '2026-08-05'))

    fireEvent.click(screen.getByRole('button', { name: 'Go to project 2' }))
    await waitFor(() => expect(informationDigestsApi.project).toHaveBeenLastCalledWith('space-1', 'project-2', undefined))
  })

  it('never lets a slow answer for the previous Project replace the open one', async () => {
    const latest = await informationDigestsApi.project('space-1', 'project-1') as ReturnType<typeof available>
    const forProject = (projectId: string, marker: string) => ({
      ...latest,
      digest: { ...latest.digest, project_id: projectId, team_blind_spot_domains: [marker] },
    })
    let answerProjectOne: (value: unknown) => void = () => undefined
    vi.mocked(informationDigestsApi.project).mockReset()
    vi.mocked(informationDigestsApi.project).mockImplementation((_space, projectId) => (
      projectId === 'project-1'
        ? new Promise(resolve => { answerProjectOne = resolve })
        : Promise.resolve(forProject('project-2', 'project two domain'))
    ) as never)
    function SwitchProject() {
      const navigate = useNavigate()
      return <button type="button" onClick={() => navigate('/projects/project-2/digest')}>Go to project 2</button>
    }
    render(
      <MemoryRouter initialEntries={['/projects/project-1/digest']}>
        <SwitchProject />
        <Routes><Route path="/projects/:projectId/digest" element={<ProjectDigestPage />} /></Routes>
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go to project 2' }))
    expect(await screen.findByText('project two domain')).toBeInTheDocument()
    answerProjectOne(forProject('project-1', 'project one domain'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getByText('project two domain')).toBeInTheDocument()
    expect(screen.queryByText('project one domain')).not.toBeInTheDocument()
  })
})
