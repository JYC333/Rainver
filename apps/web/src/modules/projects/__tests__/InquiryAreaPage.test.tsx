import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { toast } from 'sonner'
import InquiryAreaPage from '../InquiryAreaPage'
import { inquiryApi, notesApi, projectsApi, projectResearchApi, spacesApi } from '../../../api/client'

const BRIEF_AGGREGATE = {
  project_status: 'active',
  current_focus: null,
  confirmed_decisions: [] as string[],
  primary_mode: 'research' as const,
  workspace_identity: {},
  workspace_boundary: {},
  source_refs: [] as Array<Record<string, unknown>>,
}

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const spaceNavigate = vi.fn()
vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useSpaceNavigate: () => spaceNavigate,
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1', userId: 'user-1',
    spaces: [{ id: 'space-1', role: 'member' }],
  }),
}))

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light' }),
}))

// The relation graph renders on canvas; this Area's tests are about which
// Threads and commands the page offers, not the renderer's internals.
vi.mock('../../../components/graph', () => ({
  GraphView: () => <div data-testid="graph-view" />,
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    get: vi.fn(),
    getActiveBriefVersion: vi.fn(),
    listBriefVersions: vi.fn(),
    createBriefVersion: vi.fn(),
    submitBriefForReview: vi.fn(),
    publishBrief: vi.fn(),
    corpus: vi.fn(),
  },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]),
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    recordIteration: vi.fn(),
    listIterations: vi.fn(),
    listSteps: vi.fn(),
    listSignals: vi.fn(),
    reviseDefinition: vi.fn(),
    updateWork: vi.fn(),
    transitionLifecycle: vi.fn(),
    addRelation: vi.fn(),
    removeRelation: vi.fn(),
    setPrimaryParent: vi.fn(),
    linkNote: vi.fn(),
    unlinkNote: vi.fn(),
    setPersonalFocus: vi.fn(),
    getFocus: vi.fn(),
    graph: vi.fn(),
    listCandidates: vi.fn(),
    getCandidate: vi.fn(),
    openReviewPacket: vi.fn(),
    closeReviewPacket: vi.fn(),
    decideCandidate: vi.fn(),
    reopenCandidate: vi.fn(),
    latestDeltaBrief: vi.fn(),
    generateDeltaBrief: vi.fn(),
    getAdvice: vi.fn(),
    adoptAdvice: vi.fn(),
    dismissAdvice: vi.fn(),
  },
  notesApi: { list: vi.fn() },
  projectResearchApi: { workflows: vi.fn() },
  spacesApi: { members: vi.fn() },
}))

const PROJECT = {
  id: 'project-1',
  space_id: 'space-1',
  owner_user_id: 'user-1',
  name: 'Inquiry Project',
  description: null,
  status: 'active' as const,
  current_focus: null,
  settings_json: null,
  primary_mode: 'research' as const,
  active_brief_version_id: null,
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
  archived_at: null,
}

const QUESTION = {
  id: 'thread-1',
  space_id: 'space-1',
  project_id: 'project-1',
  kind: 'question' as const,
  statement: 'Does caching help?',
  lifecycle_status: 'active' as const,
  attention_state: 'backlog' as const,
  priority: 1,
  primary_parent_id: null,
  owner_user_id: null,
  next_focus_kind: null,
  next_focus_note: null,
  blocked_reason: null,
  version: 1,
  created_from: 'user',
  created_by_user_id: 'user-1',
  created_at: '2026-07-23T00:00:00.000Z',
  updated_at: '2026-07-23T00:00:00.000Z',
}

const QUESTION_DETAIL = {
  ...QUESTION,
  question_state: { current_answer_summary: null, answer_state: 'open' as const, known_gaps: null, answerability: null, resolution_criteria: null },
  hypothesis_state: null,
  relations: [],
  note_links: [],
  in_personal_focus: false,
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'candidate-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
    candidate_kind: 'position_change', semantic_key: 'k', title: 'New evidence contradicts the position',
    summary: 'Two papers disagree', proposed_change: { answer_state: 'partial' },
    status: 'pending' as const, review_packet_id: null, resulting_iteration_id: null,
    resulting_thread_id: null, merged_into_candidate_id: null, decision_reason: null,
    defer_until: null, decided_by_user_id: null, decided_at: null,
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.get).mockResolvedValue(PROJECT)
  vi.mocked(projectsApi.getActiveBriefVersion).mockResolvedValue(null)
  vi.mocked(projectsApi.listBriefVersions).mockResolvedValue([])
  vi.mocked(projectsApi.corpus).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION])
  vi.mocked(inquiryApi.getThread).mockResolvedValue(QUESTION_DETAIL)
  vi.mocked(inquiryApi.listIterations).mockResolvedValue([])
  vi.mocked(inquiryApi.listSteps).mockResolvedValue([])
  vi.mocked(inquiryApi.listSignals).mockResolvedValue([])
  vi.mocked(inquiryApi.listCandidates).mockResolvedValue([])
  vi.mocked(inquiryApi.getFocus).mockResolvedValue({ personal_focus: [], shared_focus_wip_limit: 3 })
  vi.mocked(inquiryApi.latestDeltaBrief).mockResolvedValue(null)
  vi.mocked(inquiryApi.getAdvice).mockResolvedValue(null)
  vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, wip_limit_exceeded: false })
  vi.mocked(inquiryApi.dismissAdvice).mockResolvedValue({} as never)
  vi.mocked(inquiryApi.graph).mockResolvedValue({
    nodes: [], edges: [],
    view: { mode: 'local', limit: 0, generatedAt: '2026-07-23T00:00:00.000Z', truncated: false, totalNodeCount: 0 },
    layout: { mode: 'force' },
  })
  vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
  vi.mocked(projectResearchApi.workflows).mockResolvedValue([])
  vi.mocked(spacesApi.members).mockResolvedValue([])
})

function renderPage(path = '/spaces/space-1/projects/project-1/inquiry') {
  return render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId/inquiry" element={<InquiryAreaPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('InquiryAreaPage', () => {
  it('lists Threads and shows the selected Thread detail', async () => {
    renderPage()

    expect(await screen.findByText('Does caching help?')).toBeInTheDocument()
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledWith('project-1', 'thread-1'))
  })

  it('groups the navigator by attention state and pins the personal Focus Set on top', async () => {
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([
      QUESTION,
      { ...QUESTION, id: 'thread-2', statement: 'Is eviction correct?', attention_state: 'focused', next_focus_kind: 'synthesize' },
    ])
    vi.mocked(inquiryApi.getFocus).mockResolvedValue({
      personal_focus: [{ ...QUESTION, id: 'thread-2', statement: 'Is eviction correct?' }],
      shared_focus_wip_limit: 3,
    })
    renderPage()

    expect(await screen.findByRole('region', { name: 'My Focus' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Focused' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Backlog' })).toBeInTheDocument()
  })

  it('opens search setup without claiming that acquisition already started', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({
      ...QUESTION_DETAIL, next_focus_kind: 'search_acquisition', next_focus_note: 'Start with 2020+ reviews',
    })
    renderPage()

    // Inspecting Acquire changes the panel, but opening its setup is only
    // navigation. The Research start command owns the eventual background
    // Step once a Workflow and Operation actually exist.
    fireEvent.click(await screen.findByRole('tab', { name: /^Acquire/ }))
    expect(screen.getByText('Start with 2020+ reviews')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Set up evidence search' }))
    await waitFor(() => expect(spaceNavigate)
      .toHaveBeenCalledWith('/projects/project-1/research?research=new&thread=thread-1'))
    expect(inquiryApi.updateWork).not.toHaveBeenCalled()
  })

  it('sends search_acquisition to Operations once a search is actually running', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({ ...QUESTION_DETAIL, next_focus_kind: 'search_acquisition' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /^Acquire/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Watch the running search/ }))
    await waitFor(() => expect(spaceNavigate).toHaveBeenCalledWith('/projects/project-1/research?tab=runs'))
  })

  it('keeps recommending while a step is in progress, instead of falling silent', async () => {
    // The old card replaced its guidance with the chosen step, which is exactly
    // when the system knows the most. A step in progress and a different
    // recommendation must both be on screen.
    vi.mocked(inquiryApi.getThread).mockResolvedValue({
      ...QUESTION_DETAIL, attention_state: 'focused', next_focus_kind: 'synthesize',
    })
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'intake',
      status: 'not_started', state_json: { question_refine_skipped: false }, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    // Evidence has landed and one change from it is still waiting, which is
    // what puts the Thread in Digest while a different step is in progress.
    vi.mocked(inquiryApi.listSignals).mockResolvedValue([{
      id: 'signal-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
      corpus_item_id: 'corpus-1', classification: 'supports', is_material: true, confidence: 0.8,
      model_version: 'v1', source_provenance: {}, dedupe_key: 'k1', producer_idempotency_key: null,
      status: 'consolidated', candidate_id: null, created_by_user_id: null, created_by_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z',
    }])
    vi.mocked(inquiryApi.listCandidates).mockResolvedValue([{
      id: 'cand-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
      candidate_kind: 'position_change', semantic_key: 'k', title: 'New evidence', summary: null,
      proposed_change: {}, status: 'pending', review_packet_id: null, resulting_iteration_id: null,
      resulting_thread_id: null, merged_into_candidate_id: null, decision_reason: null,
      defer_until: null, decided_by_user_id: null, decided_at: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    renderPage()

    expect(await screen.findByText('Suggested next')).toBeInTheDocument()
    expect(screen.getByText('1 material change on this Thread awaits review.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Digest/ })).toHaveAttribute('aria-current', 'step')
    fireEvent.click(screen.getByRole('tab', { name: /^Conclude/ }))
    expect(await screen.findByText('In progress')).toBeInTheDocument()
  })

  it('keeps pause in the Thread menu without calling off its work', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({ ...QUESTION_DETAIL, attention_state: 'focused' })
    vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, wip_limit_exceeded: false })
    renderPage()

    const user = userEvent.setup({ delay: null })
    await screen.findByText('Suggested next')
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Pause' }))

    // Clearing the step is the command that stops background work, so pausing
    // must not send it.
    await waitFor(() => expect(inquiryApi.updateWork)
      .toHaveBeenCalledWith('project-1', 'thread-1', { attention_state: 'backlog' }))
  })

  it('shows the stage row and a reasoned recommendation without being asked', async () => {
    renderPage()

    await screen.findByText('Does caching help?')
    // The stage row is the standing answer to "where am I", and the
    // recommendation carries a reason the user can check on this page.
    expect(await screen.findByRole('tab', { name: /^Clarify/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Round 1')).toBeInTheDocument()
    expect(screen.getByText('Suggested next')).toBeInTheDocument()
    expect(screen.getByText('This question’s wording has not been assessed yet.')).toBeInTheDocument()
  })

  it('explains what a stage is for when its chip is opened, instead of a one-time tour', async () => {
    renderPage()

    await screen.findByText('Does caching help?')
    fireEvent.click(await screen.findByRole('tab', { name: /^Digest/ }))
    expect(await screen.findByText(/Read what arrived/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing is left waiting for review/)).toBeInTheDocument()
  })

  it('uses the stage row as the only stage switcher without mutating Thread work', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('tab', { name: /^Land/ }))

    expect(screen.getByRole('tab', { name: /^Land/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Land' })).toBeInTheDocument()
    expect(screen.getByText(/Put the conclusion somewhere it does work/)).toBeInTheDocument()
    expect(inquiryApi.updateWork).not.toHaveBeenCalled()
  })

  it('supports roving keyboard navigation across the stage tabs', async () => {
    renderPage()

    const clarify = await screen.findByRole('tab', { name: /^Clarify/ })
    clarify.focus()
    fireEvent.keyDown(clarify, { key: 'ArrowRight' })

    const acquire = screen.getByRole('tab', { name: /^Acquire/ })
    expect(acquire).toHaveFocus()
    expect(acquire).toHaveAttribute('aria-selected', 'true')
    expect(clarify).toHaveAttribute('tabindex', '-1')
    expect(inquiryApi.updateWork).not.toHaveBeenCalled()
  })

  it('keeps a manually inspected stage pinned while refreshed actual state changes', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: /^Land/ }))

    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'intake',
      status: 'not_started', state_json: { question_refine_skipped: false }, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    vi.mocked(inquiryApi.listSignals).mockResolvedValue([{
      id: 'signal-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
      corpus_item_id: 'corpus-1', classification: 'supports', is_material: true, confidence: 0.8,
      model_version: 'v1', source_provenance: {}, dedupe_key: 'k1', producer_idempotency_key: null,
      status: 'consolidated', candidate_id: null, created_by_user_id: null, created_by_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z',
    }])

    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => expect(screen.getByText('Current: Conclude')).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: /^Land/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('starts the recommended step through work state, no change summary demanded', async () => {
    vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, next_focus_kind: 'clarify_or_decompose', wip_limit_exceeded: false })
    renderPage()

    await screen.findByText('Suggested next')
    fireEvent.click(screen.getByRole('button', { name: /Bring into Focus and start/ }))

    await waitFor(() => expect(inquiryApi.updateWork).toHaveBeenCalledWith('project-1', 'thread-1', {
      next_focus_kind: 'clarify_or_decompose',
      blocked_reason: null,
      attention_state: 'focused',
    }))
  })

  it('keeps explained alternatives inside their owning stage', async () => {
    // A refined Question sits in Acquire, where finding evidence and producing
    // it are genuine peers — so there is a real alternative to explain.
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'intake',
      status: 'not_started', state_json: { question_refine_skipped: false }, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, wip_limit_exceeded: false })
    renderPage()

    await screen.findByText('Suggested next')
    // Acquire owns both ways to obtain evidence; no second cross-stage chooser
    // or management row competes with them.
    expect(await screen.findByText(/settled faster by measuring/)).toBeInTheDocument()
    expect(screen.queryByText('Something in another stage')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
  })

  it('keeps the stage workspace readable while blocked and unblocks without starting work', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({
      ...QUESTION_DETAIL, attention_state: 'blocked', blocked_reason: 'Waiting on the Q1.2 experiment', next_focus_kind: null,
    })
    renderPage()

    expect(await screen.findByText('Waiting on the Q1.2 experiment')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Clarify/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open the assessment workspace' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }))
    await waitFor(() => expect(inquiryApi.updateWork).toHaveBeenCalledWith('project-1', 'thread-1', {
      attention_state: 'focused', blocked_reason: null,
    }))
  })

  it('records a cognitive Iteration with a required change summary', async () => {
    vi.mocked(inquiryApi.recordIteration).mockResolvedValue({
      id: 'iter-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
      trigger_kind: 'user_edit', trigger_ref: null, input_refs_json: [],
      previous_position_json: {}, new_position_json: {}, confidence_delta: null,
      change_summary: 'Found supporting evidence', reasoning_summary: null, unresolved_gaps: null,
      confirmed_next_focus: null, created_by_user_id: 'user-1', created_by_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z',
      thread: QUESTION,
    })
    renderPage()

    await screen.findByText('Does caching help?')
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    await user.click(await screen.findByRole('menuitem', { name: /Close out round 1 early/ }))
    // A round records how the position moved, so the state has to move.
    fireEvent.click(await screen.findByRole('button', { name: 'Partial' }))
    fireEvent.change(await screen.findByLabelText(/What changed this round/), { target: { value: 'Found supporting evidence' } })
    fireEvent.click(screen.getByRole('button', { name: /^Record this round$/ }))

    await waitFor(() => expect(inquiryApi.recordIteration).toHaveBeenCalledWith('project-1', 'thread-1', expect.objectContaining({
      change_summary: 'Found supporting evidence',
      answer_state: 'partial',
    })))
  })

  it('edits wording in place as a wording_only revision', async () => {
    vi.mocked(inquiryApi.reviseDefinition).mockResolvedValue({ thread: QUESTION, superseded_by_thread_id: null })
    renderPage()

    await screen.findByText('Does caching help?')
    fireEvent.click(screen.getByRole('button', { name: 'Edit wording' }))
    fireEvent.change(screen.getByLabelText('Thread statement'), { target: { value: 'Does caching actually help?' } })
    fireEvent.click(screen.getByRole('button', { name: /Save wording/ }))

    await waitFor(() => expect(inquiryApi.reviseDefinition).toHaveBeenCalledWith('project-1', 'thread-1', {
      revision_kind: 'wording_only',
      new_statement: 'Does caching actually help?',
    }))
  })

  it('preserves a wording draft when live-work polling refreshes the Thread', async () => {
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(() => 42 as unknown as ReturnType<typeof window.setInterval>)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit wording' }))
    fireEvent.change(screen.getByLabelText('Thread statement'), { target: { value: 'Unsaved wording draft' } })
    await waitFor(() => expect(interval).toHaveBeenCalledWith(expect.any(Function), 5_000))
    const refreshTick = interval.mock.calls.find(([, delay]) => delay === 5_000)?.[0]
    if (typeof refreshTick === 'function') refreshTick()

    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledTimes(2))
    expect(screen.getByDisplayValue('Unsaved wording draft')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Save wording/ })).toBeInTheDocument()
    interval.mockRestore()
  })

  it('routes a semantic redefinition to the assessment workspace rather than editing in place', async () => {
    const user = userEvent.setup({ delay: null })
    renderPage()

    await screen.findByText('Does caching help?')
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /Redefine this question/ }))
      .toHaveAttribute('href', '/projects/project-1/inquiry/thread-1/assess')
  })

  it('captures a lifecycle reason in a dialog instead of a browser prompt', async () => {
    vi.mocked(inquiryApi.transitionLifecycle).mockResolvedValue({
      ...QUESTION, lifecycle_status: 'resolved', attention_state: 'resolved',
    })
    const promptSpy = vi.spyOn(window, 'prompt')
    const user = userEvent.setup({ delay: null })
    renderPage()

    await screen.findByText('Does caching help?')
    await user.click(screen.getByRole('button', { name: 'Thread actions' }))
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Mark resolved/ }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'Resolution criterion met' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(inquiryApi.transitionLifecycle).toHaveBeenCalledWith(
      'project-1', 'thread-1', 'resolved', 'Resolution criterion met',
    ))
    expect(promptSpy).not.toHaveBeenCalled()
  })

  it('groups this Thread’s evidence by what it does to the position', async () => {
    vi.mocked(inquiryApi.listSignals).mockResolvedValue([
      {
        id: 'signal-1', space_id: 'space-1', project_id: 'project-1', thread_id: 'thread-1',
        corpus_item_id: 'corpus-1', classification: 'contradicts', is_material: true, confidence: 0.8,
        model_version: 'v1', source_provenance: {}, dedupe_key: 'k1', producer_idempotency_key: null,
        status: 'consolidated', candidate_id: null, created_by_user_id: null, created_by_run_id: null,
        created_at: '2026-07-23T00:00:00.000Z',
      },
    ])
    vi.mocked(projectsApi.corpus).mockResolvedValue({
      items: [{
        id: 'corpus-1', space_id: 'space-1', project_id: 'project-1', object_id: null,
        source_item_id: 'item-1', evidence_id: null, source_connection_id: null, source_decision_id: null,
        role: 'reference' as const, status: 'active' as const, triage_status: 'included' as const,
        read_status: 'read' as const, relevance: 'relevant' as const, confidence: null, reason: null,
        added_by_user_id: null, metadata_json: {}, created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z', last_reviewed_at: null, last_read_at: null,
        object: null,
        source_item: { id: 'item-1', item_type: 'paper', title: 'Caching considered harmful', source_uri: null, source_domain: null, excerpt: null },
        evidence: null,
      }],
      total: 1, limit: 200, offset: 0,
    })
    renderPage()

    await screen.findByText('Does caching help?')
    expect(await screen.findByText('Challenges this position (1)')).toBeInTheDocument()
    expect(screen.getByText('Caching considered harmful')).toBeInTheDocument()
  })

  it('moves Candidate review to its own view and links there from the affected Thread', async () => {
    vi.mocked(inquiryApi.listCandidates).mockImplementation(async (_projectId, status = 'pending') =>
      (status === 'pending' ? [candidate()] : []))
    renderPage()

    await screen.findByText('Does caching help?')
    expect(await screen.findByRole('tab', { name: 'Review (1)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /1 material change on this Thread awaits your decision/ }))

    expect(await screen.findByText('New evidence contradicts the position')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start a review checkpoint' })).toBeInTheDocument()
  })

  it('continues the delta window from the previous Brief instead of re-summarizing everything', async () => {
    vi.mocked(inquiryApi.latestDeltaBrief).mockResolvedValue({
      id: 'brief-1', project_id: 'project-1', coverage_start: null,
      coverage_end: '2026-07-20T00:00:00.000Z',
      content: {
        schema_version: 'inquiry_delta_brief.v1',
        input_and_coverage_window: { coverage_start: null, coverage_end: '2026-07-20T00:00:00.000Z', signal_count: 4 },
        reinforced_positions: [], challenged_positions: [], gap_changes: [],
        decisions_required: 0, no_change_statement: null, source_and_thread_refs: [],
      },
      created_at: '2026-07-20T00:00:00.000Z',
    })
    vi.mocked(inquiryApi.generateDeltaBrief).mockResolvedValue({
      id: 'brief-2', project_id: 'project-1', coverage_start: '2026-07-20T00:00:00.000Z',
      coverage_end: '2026-07-23T00:00:00.000Z',
      content: {
        schema_version: 'inquiry_delta_brief.v1',
        input_and_coverage_window: { coverage_start: '2026-07-20T00:00:00.000Z', coverage_end: '2026-07-23T00:00:00.000Z', signal_count: 1 },
        reinforced_positions: [], challenged_positions: [{ thread_id: 'thread-1', statement: 'Does caching help?', count: 1 }],
        gap_changes: [], decisions_required: 1, no_change_statement: null, source_and_thread_refs: [],
      },
      created_at: '2026-07-23T00:00:00.000Z',
    })
    renderPage('/spaces/space-1/projects/project-1/inquiry?view=review')

    fireEvent.click(await screen.findByRole('button', { name: /Summarize what’s new since this/ }))

    await waitFor(() => expect(inquiryApi.generateDeltaBrief)
      .toHaveBeenCalledWith('project-1', '2026-07-20T00:00:00.000Z'))
    expect(await screen.findByText('Challenged')).toBeInTheDocument()
  })

  it('opens the review view from an Attention Candidate deep link', async () => {
    vi.mocked(inquiryApi.listCandidates).mockImplementation(async (_projectId, status = 'pending') =>
      (status === 'pending' ? [candidate()] : []))
    renderPage('/spaces/space-1/projects/project-1/inquiry?candidate=candidate-1')

    expect(await screen.findByText('New evidence contradicts the position')).toBeInTheDocument()
  })

  it('shows the structure map, and draws relations from the Inquiry graph projection', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(inquiryApi.listCandidates).mockImplementation(async (_projectId, status = 'pending') =>
      (status === 'pending' ? [candidate()] : []))
    renderPage('/spaces/space-1/projects/project-1/inquiry?view=map')

    expect(await screen.findByRole('tab', { name: 'Structure' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Relations' }))
    await waitFor(() => expect(inquiryApi.graph).toHaveBeenCalledWith('project-1'))
  })

  it('opens the new Thread dialog with Hypothesis preselected from Experiments', async () => {
    renderPage('/spaces/space-1/projects/project-1/inquiry?new=hypothesis')

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('What is the proposed claim?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hypothesis' })).toHaveClass('bg-primary')
  })

  it('creates a new Thread through the dialog', async () => {
    vi.mocked(inquiryApi.createThread).mockResolvedValue({ ...QUESTION, id: 'thread-2', statement: 'New question' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /new thread/i }))
    fireEvent.change(screen.getByPlaceholderText('What is the current question?'), { target: { value: 'New question' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(inquiryApi.createThread).toHaveBeenCalledWith('project-1', { kind: 'question', statement: 'New question' }))
  })

  it('keeps the Setup checklist goal deep link working without giving the goal a permanent card', async () => {
    vi.mocked(projectsApi.getActiveBriefVersion).mockResolvedValue({
      id: 'brief-1', space_id: 'space-1', project_id: 'project-1', version: 'v1',
      goal: 'Ship a reliable coding agent', scope_included: 'Coding tasks', scope_excluded: null,
      success_definition: 'Agent completes tasks unattended', constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'published', reviewed_by_user_id: 'user-1', reviewed_at: '2026-07-23T00:00:00.000Z',
      published_by_user_id: 'user-1', published_at: '2026-07-23T00:00:00.000Z',
      created_by_user_id: 'user-1', created_at: '2026-07-23T00:00:00.000Z',
    })
    vi.mocked(projectsApi.createBriefVersion).mockResolvedValue({
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ship a reliable, fast coding agent', scope_included: 'Coding tasks', scope_excluded: null,
      success_definition: 'Agent completes tasks unattended', constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'draft', reviewed_by_user_id: null, reviewed_at: null,
      published_by_user_id: null, published_at: null,
      created_by_user_id: 'user-1', created_at: '2026-07-23T00:05:00.000Z',
    })
    vi.mocked(projectsApi.submitBriefForReview).mockResolvedValue({
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ship a reliable, fast coding agent', scope_included: 'Coding tasks', scope_excluded: null,
      success_definition: 'Agent completes tasks unattended', constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'in_review', reviewed_by_user_id: 'user-1', reviewed_at: '2026-07-23T00:06:00.000Z',
      published_by_user_id: null, published_at: null, created_by_user_id: 'user-1', created_at: '2026-07-23T00:05:00.000Z',
    })
    vi.mocked(projectsApi.publishBrief).mockResolvedValue({
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ship a reliable, fast coding agent', scope_included: 'Coding tasks', scope_excluded: null,
      success_definition: 'Agent completes tasks unattended', constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'published', reviewed_by_user_id: 'user-1', reviewed_at: '2026-07-23T00:06:00.000Z',
      published_by_user_id: 'user-1', published_at: '2026-07-23T00:07:00.000Z', created_by_user_id: 'user-1', created_at: '2026-07-23T00:05:00.000Z',
    })
    renderPage('/spaces/space-1/projects/project-1/inquiry?setup=goal')

    const textarea = await screen.findByPlaceholderText('What is this project ultimately trying to achieve?')
    fireEvent.change(textarea, { target: { value: 'Ship a reliable, fast coding agent' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // Editing the goal alone must not blank out the rest of the immutable Brief.
    await waitFor(() => expect(projectsApi.createBriefVersion).toHaveBeenCalledWith('project-1', {
      goal: 'Ship a reliable, fast coding agent',
      scope_included: 'Coding tasks',
      scope_excluded: null,
      success_definition: 'Agent completes tasks unattended',
      constraints: null,
      assumptions: null,
      confirmed_decisions: [],
      workspace_identity: {},
      workspace_boundary: {},
      source_refs: [],
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(projectsApi.publishBrief).toHaveBeenCalledWith('project-1', 'brief-2'))
  })

  it('lets an active Project co-owner publish a submitted Brief from Setup', async () => {
    const submitted = {
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ready for co-owner review', scope_included: null, scope_excluded: null,
      success_definition: null, constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'in_review' as const, reviewed_by_user_id: 'user-2',
      reviewed_at: '2026-07-23T00:05:00.000Z', published_by_user_id: null,
      published_at: null, created_by_user_id: 'user-2', created_at: '2026-07-23T00:00:00.000Z',
    }
    vi.mocked(projectsApi.get).mockResolvedValue({
      ...PROJECT,
      owner_user_id: 'user-2',
      current_user_can_approve_context: true,
    })
    vi.mocked(projectsApi.listBriefVersions).mockResolvedValueOnce([submitted])
    vi.mocked(projectsApi.publishBrief).mockResolvedValueOnce({
      ...submitted,
      status: 'published',
      published_by_user_id: 'user-1',
      published_at: '2026-07-23T00:06:00.000Z',
    })
    renderPage('/spaces/space-1/projects/project-1/inquiry?setup=goal')

    expect(await screen.findByDisplayValue('Ready for co-owner review')).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))

    await waitFor(() => expect(projectsApi.publishBrief).toHaveBeenCalledWith('project-1', 'brief-2'))
  })

  it('can relate a root Thread to its own descendants, which the parent picker excludes', async () => {
    const child = { ...QUESTION, id: 'thread-2', statement: 'Is eviction correct?', primary_parent_id: 'thread-1' }
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION, child])
    vi.mocked(inquiryApi.addRelation).mockResolvedValue({
      id: 'relation-1', from_thread_id: 'thread-1', to_thread_id: 'thread-2',
      relation_kind: 'decomposes_into', created_at: '2026-07-23T00:00:00.000Z',
    })
    const user = userEvent.setup({ delay: null })
    renderPage()

    await screen.findByRole('tab', { name: /Relations/ })
    await user.click(screen.getByRole('tab', { name: /Relations/ }))

    // The primary-parent tree must stay acyclic, so the descendant is not a
    // parent option — but decomposes_into pointing at it is the normal case.
    fireEvent.click(await screen.findByLabelText('Relation target'))
    fireEvent.click(await screen.findByRole('option', { name: /Is eviction correct/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }))

    await waitFor(() => expect(inquiryApi.addRelation).toHaveBeenCalledWith('project-1', {
      from_thread_id: 'thread-1',
      to_thread_id: 'thread-2',
      relation_kind: 'related_to',
    }))
  })

  it('uses valid model advice as the single suggestion without exposing a second advice system', async () => {
    vi.mocked(inquiryApi.getAdvice).mockResolvedValue({
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'synthesize',
      rationale: 'Thirty-four supporting items are in hand and two scans found no contradiction.',
      cited_refs: ['signal-7'], thread_version: 1, status: 'open',
      trigger_kind: 'iteration_recorded', model_version: 'test-model', stale: false,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    })
    vi.mocked(inquiryApi.adoptAdvice).mockResolvedValue({
      thread: { ...QUESTION, next_focus_kind: 'synthesize', wip_limit_exceeded: true },
      advice: null,
    })
    renderPage()

    expect(await screen.findByText('Suggested next')).toBeInTheDocument()
    expect(await screen.findByText(/Thirty-four supporting items/)).toBeInTheDocument()
    expect(screen.queryByText('The model would')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'View Conclude' }))
    fireEvent.click(await screen.findByRole('button', { name: /Bring into Focus and start/ }))
    await waitFor(() => expect(inquiryApi.adoptAdvice).toHaveBeenCalledWith('project-1', 'thread-1'))
    expect(toast.warning).toHaveBeenCalledWith(
      'Shared Focus WIP limit exceeded — consider moving another Thread to Monitoring',
    )
    // Adoption is the one server command that focuses and starts the
    // advice-origin Step atomically.
    expect(inquiryApi.updateWork).not.toHaveBeenCalled()
  })

  it('shows one suggestion when model and rules agree', async () => {
    vi.mocked(inquiryApi.getAdvice).mockResolvedValue({
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'clarify_or_decompose',
      rationale: 'The wording is ambiguous.',
      cited_refs: [], thread_version: 1, status: 'open',
      trigger_kind: 'iteration_recorded', model_version: 'test-model', stale: false,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    })
    renderPage()

    await screen.findByText('Suggested next')
    expect(screen.getByText('The wording is ambiguous.')).toBeInTheDocument()
    expect(screen.queryByText('The model would')).not.toBeInTheDocument()
  })

  it('dismisses the unified suggestion and immediately reveals the deterministic fallback', async () => {
    const modelAdvice = {
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'synthesize' as const,
      rationale: 'Enough evidence has accumulated to write a position.',
      cited_refs: [], thread_version: 1, status: 'open' as const,
      trigger_kind: 'iteration_recorded', model_version: 'test-model', stale: false,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }
    vi.mocked(inquiryApi.getAdvice).mockResolvedValueOnce(modelAdvice).mockResolvedValue(null)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Ignore suggestion' }))

    await waitFor(() => expect(inquiryApi.dismissAdvice).toHaveBeenCalledWith('project-1', 'thread-1'))
    expect(await screen.findByText('This question’s wording has not been assessed yet.')).toBeInTheDocument()
    expect(screen.queryByText(modelAdvice.rationale)).not.toBeInTheDocument()
  })

  it('polls read state only while work is live', async () => {
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(() => 42 as unknown as ReturnType<typeof window.setInterval>)
    renderPage()

    await waitFor(() => expect(interval).toHaveBeenCalledWith(expect.any(Function), 5_000))
    const workflowReads = vi.mocked(projectResearchApi.workflows).mock.calls.length
    const refreshTick = interval.mock.calls.find(([, delay]) => delay === 5_000)?.[0]
    if (typeof refreshTick === 'function') refreshTick()
    await waitFor(() => expect(projectResearchApi.workflows).toHaveBeenCalledTimes(workflowReads + 1))
    interval.mockRestore()
  })

  it('neither ticks nor spins a stage on a step only the user can end', async () => {
    // The Clarify step stays open until the round closes. Reading it as
    // completion ticked the stage on the click, and reading it as running left
    // a spinner beside that tick with nothing able to stop it.
    vi.mocked(inquiryApi.listSteps).mockResolvedValue([{
      id: 'step-1', project_id: 'project-1', thread_id: 'thread-1',
      kind: 'clarify_or_decompose', status: 'in_progress', slot: 'primary', note: null,
      target_ref_kind: null, target_ref_id: null, iteration_id: null, origin: 'user',
      started_at: '2026-07-23T00:00:00.000Z', completed_at: null,
      created_at: '2026-07-23T00:00:00.000Z',
    }])
    const interval = vi.spyOn(window, 'setInterval')
    renderPage()

    const clarify = await screen.findByRole('tab', { name: /^Clarify/ })
    expect(clarify).not.toHaveAccessibleName(/work running/)
    expect(clarify).not.toHaveAccessibleName(/completed this round/)
    expect(clarify).toHaveAccessibleName(/worked on this round/)
    expect(interval).not.toHaveBeenCalledWith(expect.any(Function), 5_000)
    interval.mockRestore()
  })

  it('does not poll a paused research workflow or label it running', async () => {
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'paused', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    const interval = vi.spyOn(window, 'setInterval')
    renderPage()

    await screen.findByRole('tab', { name: /^Clarify/ })
    expect(interval).not.toHaveBeenCalledWith(expect.any(Function), 5_000)
    expect(screen.getByRole('tab', { name: /^Acquire/ })).not.toHaveAccessibleName(/work running/)
    interval.mockRestore()
  })

  it('runs a trailing refresh when a new refresh arrives during an in-flight read', async () => {
    let releaseRead: ((value: typeof QUESTION_DETAIL) => void) | undefined
    const heldRead = new Promise<typeof QUESTION_DETAIL>(resolve => { releaseRead = resolve })
    vi.mocked(inquiryApi.getThread)
      .mockResolvedValueOnce(QUESTION_DETAIL)
      .mockReturnValueOnce(heldRead)
      .mockResolvedValue({ ...QUESTION_DETAIL, statement: 'Fresh state after mutation' })
    renderPage()
    await screen.findByText('Does caching help?')

    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledTimes(2))
    document.dispatchEvent(new Event('visibilitychange'))
    releaseRead?.(QUESTION_DETAIL)

    expect(await screen.findByText('Fresh state after mutation')).toBeInTheDocument()
    expect(inquiryApi.getThread).toHaveBeenCalledTimes(3)
  })

  it('does not let an older Thread refresh overwrite the newly selected Thread', async () => {
    const secondThread = {
      ...QUESTION,
      id: 'thread-2',
      statement: 'Is eviction correct?',
    }
    const secondDetail = { ...QUESTION_DETAIL, ...secondThread }
    let releaseOldRead: ((value: typeof QUESTION_DETAIL) => void) | undefined
    const oldRead = new Promise<typeof QUESTION_DETAIL>(resolve => { releaseOldRead = resolve })
    let holdOldThreadRefresh = false
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION, secondThread])
    vi.mocked(inquiryApi.getThread).mockImplementation((_projectId, threadId) => {
      if (threadId === 'thread-2') return Promise.resolve(secondDetail)
      return holdOldThreadRefresh ? oldRead : Promise.resolve(QUESTION_DETAIL)
    })
    renderPage()
    await screen.findByRole('button', { name: 'Edit wording' })
    fireEvent.click(screen.getByRole('button', { name: /Backlog \(2\)/ }))

    const readsBeforeRefresh = vi.mocked(inquiryApi.getThread).mock.calls.length
    holdOldThreadRefresh = true
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledTimes(readsBeforeRefresh + 1))
    fireEvent.click(screen.getByRole('button', { name: /Is eviction correct/ }))
    await waitFor(() => expect(screen.getAllByText('Is eviction correct?')).toHaveLength(2))
    const secondThreadReads = vi.mocked(inquiryApi.getThread).mock.calls
      .filter(([, threadId]) => threadId === 'thread-2').length
    fireEvent.click(screen.getByRole('button', { name: /Bring into Focus and start/ }))
    await waitFor(() => expect(inquiryApi.updateWork).toHaveBeenCalledWith(
      'project-1', 'thread-2', expect.any(Object),
    ))
    await waitFor(() => expect(vi.mocked(inquiryApi.getThread).mock.calls
      .filter(([, threadId]) => threadId === 'thread-2')).toHaveLength(secondThreadReads + 1))

    releaseOldRead?.(QUESTION_DETAIL)
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledTimes(readsBeforeRefresh + 3))
    expect(screen.getAllByText('Is eviction correct?')).toHaveLength(2)
    expect(screen.getAllByText('Does caching help?')).toHaveLength(1)
  })

  it('keeps the last active-work snapshot when a Research refresh fails transiently', async () => {
    const activeWorkflow = {
      id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
      status: 'active', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([activeWorkflow])
    const interval = vi.spyOn(window, 'setInterval').mockImplementation(() => 42 as unknown as ReturnType<typeof window.setInterval>)
    renderPage()

    await waitFor(() => expect(screen.getByRole('tab', { name: /^Acquire/ })).toHaveAccessibleName(/work running/))
    vi.mocked(projectResearchApi.workflows).mockRejectedValue(new Error('temporary read failure'))
    const readsBeforeFailure = vi.mocked(projectResearchApi.workflows).mock.calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(projectResearchApi.workflows).toHaveBeenCalledTimes(readsBeforeFailure + 1))

    expect(screen.getByRole('tab', { name: /^Acquire/ })).toHaveAccessibleName(/work running/)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 5_000)
    interval.mockRestore()
  })

  it('hides advice that reasoned about a superseded revision instead of labelling it stale', async () => {
    vi.mocked(inquiryApi.getAdvice).mockResolvedValue({
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'read_evidence', rationale: 'Two contradicting papers arrived.',
      cited_refs: [], thread_version: 1, status: 'open',
      trigger_kind: 'candidate_created', model_version: null, stale: true,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    })
    renderPage()

    // Stale advice is not a valid suggestion; the deterministic fallback is
    // shown immediately and there is no manual re-analysis control.
    await screen.findByText('Suggested next')
    expect(screen.getByText('This question’s wording has not been assessed yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Two contradicting papers arrived/)).not.toBeInTheDocument()
  })

  it('removes manual re-analysis and the duplicate Change surface', async () => {
    renderPage()

    await screen.findByText('Does caching help?')
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ask the model/ })).not.toBeInTheDocument()
  })

  it('guides a visitor who arrived to start a search but has no Thread picked', async () => {
    renderPage('/spaces/space-1/projects/project-1/inquiry?research_intent=1')

    expect(await screen.findByText(/Pick the Question or Hypothesis you want to search for/)).toBeInTheDocument()
  })
})
