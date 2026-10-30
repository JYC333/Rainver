import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Briefing, BriefingOverviewResponse } from '@rainver/protocol'
import { PersonalBriefingPanel } from '../briefing/PersonalBriefingPanel'
import { personalBriefingsApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({
  personalBriefingsApi: { overview: vi.fn(), get: vi.fn(), generate: vi.fn(), cancel: vi.fn(), setDaily: vi.fn() },
}))
const api = vi.mocked(personalBriefingsApi)
const ITEM = '11111111-1111-4111-8111-111111111111'

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    id: 'p1', version: 1, kind: 'manual', status: 'ready', outcome: 'briefing', comparison: 'baseline', period_date: null,
    cutoff_at: '2026-10-30T08:00:00.000Z', created_at: '2026-10-30T08:00:00.000Z', completed_at: '2026-10-30T08:02:00.000Z', checked_at: null, error_code: null,
    scope_type: 'personal', previous_briefing_id: null, run_status: null,
    coverage: { since: null, cutoff: '2026-10-30T08:00:00.000Z', candidates: 2, included: 2, merged_duplicates: 0, not_ready: 0, truncated: 0, egress_refused: 0, not_shared_with_audience: 0, carried_from_previous: 0, unchanged_since_previous: 0, background: 0, context_changed: false, complete: true },
    visibility: 'visible', hidden_units: 0,
    overview: { text: 'Your topics and one Project point the same way.', refs: ['S1'] },
    highlights: [{
      title: 'Gripper launch', what_changed: 'Two outlets report one launch.', novelty: 'baseline', importance: 'high', why_it_matters: 'It is your topic.',
      impact: { assessment: 'affects', text: 'Bears on your focus.', context_refs: ['C1'] }, suggested_action: 'watch',
      statements: [{ kind: 'fact', text: 'Launched.', refs: ['S1'] }], contradictions: null, refs: ['S1'], source_domains: 1, rests_on_unverified: false,
    }],
    open_questions: [],
    evidence: [{ key: 'S1', source_item_id: ITEM, title: 'Launch report', source_domain: 'news.test', occurred_at: null, delta_class: 'baseline', unverified: false, lenses: [{ kind: 'following', label: 'Soft grippers' }, { kind: 'corpus', label: 'Project "Robotics": Corpus' }] }],
    context: [{ key: 'C1', kind: 'personal_focus', label: 'Following: Soft grippers' }],
    context_outdated: false,
    ...overrides,
  }
}
const summary = (b: Briefing) => ({ id: b.id, version: b.version, kind: b.kind, status: b.status, outcome: b.outcome, comparison: b.comparison, period_date: b.period_date, cutoff_at: b.cutoff_at, created_at: b.created_at, completed_at: b.completed_at, checked_at: b.checked_at, error_code: b.error_code })
const overview = (latest: Briefing | null, history: Briefing[] = latest ? [latest] : []): BriefingOverviewResponse => ({
  can_generate: true, daily_enabled: false, latest, latest_briefing: history.find(b => b.outcome === 'briefing') ?? null, history: history.map(summary),
})
const panel = (spaceId = 's') => <MemoryRouter><PersonalBriefingPanel key={spaceId} spaceId={spaceId} /></MemoryRouter>

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.useRealTimers() })

it('shows only the status and overview above Reading until opened, then the cited briefing with Reader links back to Reading', async () => {
  api.overview.mockResolvedValue(overview(briefing()))
  render(panel())
  expect(await screen.findByText('Your topics and one Project point the same way.')).toBeInTheDocument()
  expect(screen.getByText('My briefing')).toBeInTheDocument()
  expect(screen.queryByText('Gripper launch')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show full briefing' }))
  expect(screen.getByText('Gripper launch')).toBeInTheDocument()
  expect(screen.getByText(/Project "Robotics": Corpus/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Launch report' }).getAttribute('href')).toBe(`/library/items/${ITEM}?from=library&returnTo=%2Flibrary%2Freading`)
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.queryByText('Gripper launch')).not.toBeInTheDocument()
  expect(api.overview).toHaveBeenCalledWith('s')
})

it('lets its owner generate, then follows the new version to its briefing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const queued = briefing({ id: 'p2', version: 2, status: 'queued', outcome: null, overview: null, highlights: [], evidence: [], run_status: 'running' })
  api.overview.mockResolvedValueOnce(overview(null)).mockResolvedValueOnce(overview(queued)).mockResolvedValue(overview(briefing({ id: 'p2', version: 2 })))
  api.generate.mockResolvedValue({ created: true, briefing: queued })
  render(panel())
  fireEvent.click(await screen.findByRole('button', { name: /Generate briefing/ }))
  expect(await screen.findByText('Synthesizing… (Run running)')).toBeInTheDocument()
  expect(api.generate).toHaveBeenCalledWith('s')
  await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
  expect(await screen.findByText('Your topics and one Project point the same way.')).toBeInTheDocument()
  expect(api.generate).toHaveBeenCalledTimes(1)
})

it('follows a held personal day by reads alone', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const held = briefing({ id: 'day', version: 3, kind: 'daily', period_date: '2026-10-29', status: 'blocked', outcome: null, error_code: 'briefing_scope_busy', overview: null, highlights: [], evidence: [] })
  const running = briefing({ id: 'm', version: 2, status: 'queued', outcome: null, overview: null, highlights: [], evidence: [] })
  api.overview.mockResolvedValueOnce(overview(held, [held, running, briefing()])).mockResolvedValue(overview(briefing({ id: 'day', version: 3, kind: 'daily', period_date: '2026-10-29' })))
  render(panel())
  expect(await screen.findByText('The briefing for 2026-10-29 is held and will start in its turn.')).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
  expect(await screen.findByText('Your topics and one Project point the same way.')).toBeInTheDocument()
  expect(api.generate).not.toHaveBeenCalled()
  expect(api.setDaily).not.toHaveBeenCalled()
})

it('drops a late reply from the previous Space', async () => {
  let finish: ((value: BriefingOverviewResponse) => void) | undefined
  api.overview.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue(overview(null))
  const rendered = render(panel('a'))
  rendered.rerender(panel('b'))
  await act(async () => { finish?.(overview(briefing())) })
  expect(await screen.findByText('No briefing yet.')).toBeInTheDocument()
  expect(screen.queryByText('Your topics and one Project point the same way.')).not.toBeInTheDocument()
  expect(api.overview).toHaveBeenLastCalledWith('b')
})
