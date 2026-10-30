import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Briefing, BriefingOverviewResponse } from '@rainver/protocol'
import { ProjectBriefingPanel } from '../ProjectBriefingPanel'
import { informationBriefingsApi } from '../../../api/client'
import { clearSessionResidue } from '../../../lib/sessionResidue'

vi.mock('../../../core/spaceNav', () => ({ useSpaceNavigate: () => vi.fn() }))
vi.mock('../../../api/client', () => ({
  informationBriefingsApi: { project: vi.fn(), get: vi.fn(), generate: vi.fn(), cancel: vi.fn(), setDaily: vi.fn() },
}))
const api = vi.mocked(informationBriefingsApi)
const ITEM = '11111111-1111-4111-8111-111111111111'

function briefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    id: 'b1', version: 1, kind: 'manual', status: 'ready', outcome: 'briefing', comparison: 'baseline', period_date: null,
    cutoff_at: '2026-10-30T08:00:00.000Z', created_at: '2026-10-30T08:00:00.000Z', completed_at: '2026-10-30T08:02:00.000Z', checked_at: null, error_code: null,
    scope_type: 'project', previous_briefing_id: null, run_status: null,
    coverage: { since: null, cutoff: '2026-10-30T08:00:00.000Z', candidates: 3, included: 1, merged_duplicates: 1, not_ready: 1, truncated: 0, egress_refused: 0, not_shared_with_audience: 0, carried_from_previous: 0, unchanged_since_previous: 0, background: 0, context_changed: false, complete: false },
    visibility: 'visible', hidden_units: 0,
    overview: { text: 'One launch dominates.', refs: ['S1'] },
    highlights: [{
      title: 'Gripper launch', what_changed: 'A soft gripper shipped.', novelty: 'baseline', importance: 'high', why_it_matters: 'Fragile items.',
      impact: { assessment: 'insufficient_context', text: 'No Task covers grippers.', context_refs: [] }, suggested_action: 'watch',
      statements: [{ kind: 'fact', text: 'It shipped.', refs: ['S1'] }, { kind: 'inference', text: 'It may replace ours.', refs: ['S1', 'C1'] }],
      contradictions: null, refs: ['S1'], source_domains: 1, rests_on_unverified: true, index: 0,
    }],
    open_questions: [],
    evidence: [{ key: 'S1', source_item_id: ITEM, title: 'Gripper report', source_domain: 'news.test', occurred_at: null, delta_class: 'baseline', unverified: true, lenses: [{ kind: 'corpus', label: 'Project Corpus' }] }],
    context: [{ key: 'C1', kind: 'project_goal', label: 'Project goal' }],
    context_outdated: false,
    ...overrides,
  }
}
const summary = (b: Briefing) => ({ id: b.id, version: b.version, kind: b.kind, status: b.status, outcome: b.outcome, comparison: b.comparison, period_date: b.period_date, cutoff_at: b.cutoff_at, created_at: b.created_at, completed_at: b.completed_at, checked_at: b.checked_at, error_code: b.error_code })
const overview = (latest: Briefing | null, canGenerate: boolean, latestBriefing: Briefing | null = latest?.outcome === 'briefing' ? latest : null): BriefingOverviewResponse => ({
  can_generate: canGenerate, limits: { runs_per_day: 6, runs_in_last_day: 1, attempts_per_version: 3, run_seconds: 900, news_inputs: 40, background_families: 12, request_chars: 48000, carried_items: 200, token_cap: null, cost_cap: null }, daily_enabled: false, latest, latest_briefing: latestBriefing,
  history: [latest, latestBriefing].filter((b, i, all): b is Briefing => Boolean(b) && all.findIndex(o => o?.id === b!.id) === i).map(summary),
})
const panel = (projectId = 'p') => <MemoryRouter><ProjectBriefingPanel key={projectId} spaceId="s" projectId={projectId} /></MemoryRouter>

beforeEach(() => { vi.clearAllMocks() })

it('lets a reader read a cited briefing with honest wording, but offers no generation', async () => {
  api.project.mockResolvedValue(overview(briefing(), false))
  render(panel())
  expect(await screen.findByText('One launch dominates.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Generate briefing' })).not.toBeInTheDocument()
  expect(screen.getByText('Only Project writers can generate briefings.')).toBeInTheDocument()
  // Limits are what generating may use: shown to those who can generate.
  expect(screen.queryByTestId('briefing-limits')).not.toBeInTheDocument()
  // A reader may ask about a highlight, but not adopt it as a Project Task.
  expect(screen.getByRole('button', { name: 'Ask about this' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Adopt as Task' })).not.toBeInTheDocument()
  expect(screen.getByText('Rests on agent-provided material that nobody verified.')).toBeInTheDocument()
  expect(screen.getByText('Not enough Project context to judge the impact.')).toBeInTheDocument()
  expect(screen.getByText('Fact')).toBeInTheDocument()
  expect(screen.getByText('Inference')).toBeInTheDocument()
  expect(screen.getByText(/1 still being analysed/)).toBeInTheDocument()
  expect(screen.getByText(/facts themselves were not independently verified/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Gripper report' }).getAttribute('href')).toBe(`/library/items/${ITEM}?from=project&returnTo=%2Fprojects%2Fp%2Fsources%3Ftab%3Ddigest`)
})

it('states a withheld briefing instead of showing its text', async () => {
  api.project.mockResolvedValue(overview(briefing({ visibility: 'withheld', overview: null, highlights: [], evidence: [] }), false))
  render(panel())
  expect(await screen.findByText(/not everyone in the Project can read now/)).toBeInTheDocument()
  expect(screen.queryByText('One launch dominates.')).not.toBeInTheDocument()
})

it('lets a writer generate, shows progress, and refreshes until the version settles', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const queued = briefing({ status: 'queued', outcome: null, overview: null, highlights: [], evidence: [], run_status: 'running' })
    api.project.mockResolvedValueOnce(overview(null, true)).mockResolvedValueOnce(overview(queued, true)).mockResolvedValue(overview(briefing(), true))
    api.generate.mockResolvedValue({ created: true, briefing: queued })
    render(panel())
    // Before generating: the server's own limits, read with the overview, and no money claimed.
    const limits = await screen.findByTestId('briefing-limits')
    expect(limits).toHaveTextContent('Limits the server enforces: 1 of 6 runs started in the last 24 hours (retries count)')
    for (const text of ['3 attempts per version', 'up to 15 minutes per run', 'up to 40 new items and 12 for comparison per version, 200 carried over', 'a request of at most 48,000 characters', 'There is no token or cost cap during a run']) {
      expect(limits).toHaveTextContent(text)
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Generate briefing' }))
    expect(await screen.findByText('Synthesizing… (Run running)')).toBeInTheDocument()
    expect(api.generate).toHaveBeenCalledWith('s', 'p')
    expect(screen.getByRole('button', { name: 'Generate briefing' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(4500) })
    expect(await screen.findByText('One launch dominates.')).toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

it('drops a reply that arrives after the Project changed, unmount or logout', async () => {
  let finish: ((value: BriefingOverviewResponse) => void) | undefined
  api.project.mockReturnValueOnce(new Promise(resolve => { finish = resolve })).mockResolvedValue(overview(null, false))
  const rendered = render(panel('a'))
  rendered.rerender(panel('b'))
  await act(async () => { finish?.(overview(briefing(), true)) })
  expect(await screen.findByText('No briefing yet.')).toBeInTheDocument()
  expect(screen.queryByText('One launch dominates.')).not.toBeInTheDocument()

  let late: ((value: BriefingOverviewResponse) => void) | undefined
  api.project.mockReturnValueOnce(new Promise(resolve => { late = resolve }))
  rendered.rerender(panel('c'))
  clearSessionResidue()
  await act(async () => { late?.(overview(briefing(), true)) })
  await waitFor(() => expect(api.project).toHaveBeenCalledWith('s', 'c'))
  expect(screen.queryByText('One launch dominates.')).not.toBeInTheDocument()
})

it('keeps the last briefing readable under a later "nothing new" check', async () => {
  const check = briefing({ id: 'b2', version: 2, outcome: 'no_new_material', comparison: 'delta', overview: null, highlights: [], evidence: [], checked_at: '2026-10-30T09:00:00.000Z' })
  api.project.mockResolvedValue(overview(check, true, briefing()))
  render(panel())
  expect(await screen.findByText('Nothing new since the previous briefing.')).toBeInTheDocument()
  expect(screen.getByText(/Still current when checked/)).toBeInTheDocument()
  expect(screen.getByTestId('project-briefing-last')).toHaveTextContent('One launch dominates.')
  expect(screen.getByText('1 source domain')).toBeInTheDocument()
})

it('shows a held sealed day as waiting its turn, not as failed', async () => {
  const held = briefing({ id: 'b3', version: 3, kind: 'daily', period_date: '2026-10-29', status: 'blocked', outcome: null, error_code: 'briefing_scope_busy', overview: null, highlights: [], evidence: [] })
  api.project.mockResolvedValue(overview(held, true, briefing()))
  render(panel())
  const status = await screen.findByRole('status')
  expect(status).toHaveTextContent('The briefing for 2026-10-29 is held and will start in its turn.')
  expect(status).toHaveTextContent('Another briefing of this Project is being generated; this day starts when it ends.')
  expect(screen.queryByText("This day's briefing could not start.")).not.toBeInTheDocument()
})

describe('held days and work still moving on the server', () => {
  const heldDay = briefing({ id: 'day', version: 3, kind: 'daily', period_date: '2026-10-29', status: 'blocked', outcome: null, error_code: 'briefing_scope_busy', overview: null, highlights: [], evidence: [] })
  const runningManual = briefing({ id: 'm2', version: 2, status: 'queued', outcome: null, run_status: 'running', overview: null, highlights: [], evidence: [] })
  const withHistory = (latest: Briefing, history: Briefing[], canGenerate = false): BriefingOverviewResponse =>
    ({ ...overview(latest, canGenerate, briefing()), history: history.map(summary) })

  afterEach(() => { vi.useRealTimers() })

  it('follows a held day to its briefing for a reader, by reads only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const dayQueued = { ...heldDay, status: 'queued' as const, error_code: null, run_status: 'running' }
    const dayReady = briefing({ id: 'day', version: 3, kind: 'daily', period_date: '2026-10-29', overview: { text: 'The held day, briefed.', refs: ['S1'] } })
    api.project
      .mockResolvedValueOnce(withHistory(heldDay, [heldDay, runningManual, briefing()]))
      .mockResolvedValueOnce(withHistory(dayQueued, [dayQueued, briefing({ id: 'm2', version: 2 }), briefing()]))
      .mockResolvedValue(withHistory(dayReady, [dayReady, briefing({ id: 'm2', version: 2 }), briefing()]))
    render(panel())
    expect(await screen.findByText('The briefing for 2026-10-29 is held and will start in its turn.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate briefing/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(await screen.findByText('Synthesizing… (Run running)')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(await screen.findByText('The held day, briefed.')).toBeInTheDocument()
    expect(api.generate).not.toHaveBeenCalled()
    expect(api.setDaily).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
    // Settled: nothing is moving any more, so no further reads.
    const reads = api.project.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(api.project.mock.calls.length).toBe(reads)
  })

  it('keeps a selected held day selected while it updates, and keeps Generate off while a version runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const later = briefing({ id: 'later', version: 4, outcome: 'no_new_material', overview: null, highlights: [], evidence: [] })
    const state = withHistory(later, [later, heldDay, runningManual], true)
    api.project.mockResolvedValue(state)
    api.get.mockResolvedValueOnce(heldDay).mockResolvedValueOnce(heldDay)
      .mockResolvedValue({ ...heldDay, status: 'queued', error_code: null, run_status: 'queued' })
    render(panel())
    const picker = await screen.findByRole('combobox')
    expect(screen.getByRole('button', { name: /Generate briefing/ })).toBeDisabled()
    fireEvent.change(picker, { target: { value: 'day' } })
    expect(await screen.findByText('The briefing for 2026-10-29 is held and will start in its turn.')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
    expect(await screen.findByText('Synthesizing… (Run queued)')).toBeInTheDocument()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('day')
    expect(api.get).toHaveBeenCalledWith('s', 'p', 'day')
    expect(api.generate).not.toHaveBeenCalled()
  })

  it('does not poll a day blocked by a refusal someone must resolve; Refresh still re-reads it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const quota = { ...heldDay, error_code: 'briefing_daily_limit' }
    api.project.mockResolvedValue(withHistory(quota, [quota, briefing()]))
    render(panel())
    expect(await screen.findByText("This day's briefing could not start.")).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(api.project).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(api.project).toHaveBeenCalledTimes(2))
  })

  it('stops a pending re-read when the Project changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    api.project.mockImplementation(async (_space: string, project: string) =>
      project === 'a' ? withHistory(heldDay, [heldDay, runningManual]) : overview(null, false))
    const rendered = render(panel('a'))
    expect(await screen.findByText('The briefing for 2026-10-29 is held and will start in its turn.')).toBeInTheDocument()
    rendered.rerender(panel('b'))
    expect(await screen.findByText('No briefing yet.')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(api.project.mock.calls.filter(([, project]) => project === 'a')).toHaveLength(1)
    expect(screen.queryByText(/is held/)).not.toBeInTheDocument()
  })
})
