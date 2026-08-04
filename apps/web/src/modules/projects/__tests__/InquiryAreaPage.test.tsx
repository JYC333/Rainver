import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import InquiryAreaPage from '../InquiryAreaPage'
import { inquiryApi, notesApi, projectsApi, projectResearchApi, spacesApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1' }),
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
    createBriefVersion: vi.fn(),
    corpus: vi.fn(),
  },
  inquiryApi: {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    recordIteration: vi.fn(),
    listIterations: vi.fn(),
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
    generateAdvice: vi.fn(),
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
  template_key: 'blank',
  primary_mode: 'inquiry' as const,
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
  vi.mocked(projectsApi.corpus).mockResolvedValue({ items: [], total: 0, limit: 200, offset: 0 })
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION])
  vi.mocked(inquiryApi.getThread).mockResolvedValue(QUESTION_DETAIL)
  vi.mocked(inquiryApi.listIterations).mockResolvedValue([])
  vi.mocked(inquiryApi.listSignals).mockResolvedValue([])
  vi.mocked(inquiryApi.listCandidates).mockResolvedValue([])
  vi.mocked(inquiryApi.getFocus).mockResolvedValue({ personal_focus: [], shared_focus_wip_limit: 3 })
  vi.mocked(inquiryApi.latestDeltaBrief).mockResolvedValue(null)
  vi.mocked(inquiryApi.getAdvice).mockResolvedValue(null)
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

  it('turns a confirmed Next Focus into a direct call to action', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({
      ...QUESTION_DETAIL, next_focus_kind: 'search_acquisition', next_focus_note: 'Start with 2020+ reviews',
    })
    renderPage()

    const cta = await screen.findByRole('link', { name: /Start literature search/ })
    expect(cta).toHaveAttribute('href', '/projects/project-1?research=new&thread=thread-1')
    expect(screen.getByText('“Start with 2020+ reviews”')).toBeInTheDocument()
  })

  it('sends search_acquisition to Operations once a search is actually running', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({ ...QUESTION_DETAIL, next_focus_kind: 'search_acquisition' })
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([{
      id: 'workflow-1', project_id: 'project-1', workflow_type: 'literature_review', current_stage: 'screening',
      status: 'active', mode: 'autonomous', state_json: {}, primary_thread_id: 'thread-1',
      started_by_user_id: null, started_run_id: null,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    }])
    renderPage()

    expect(await screen.findByRole('link', { name: /Watch the running search/ }))
      .toHaveAttribute('href', '/projects/project-1/operations')
    expect(screen.queryByRole('link', { name: /Start literature search/ })).not.toBeInTheDocument()
  })

  it('offers state-derived suggestions when no Next Focus has been decided', async () => {
    renderPage()

    await screen.findByText('Does caching help?')
    expect(await screen.findByText('Not decided yet.')).toBeInTheDocument()
    expect(screen.getByText('No evidence has reached this Thread yet.')).toBeInTheDocument()
  })

  it('records a plan change through work state without demanding a change summary', async () => {
    vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, next_focus_kind: 'synthesize', wip_limit_exceeded: false })
    renderPage()

    await screen.findByText('Not decided yet.')
    fireEvent.click(screen.getByRole('button', { name: /Choose something else/ }))
    fireEvent.click(screen.getByLabelText('Next focus'))
    fireEvent.click(await screen.findByRole('option', { name: 'Synthesize' }))

    await waitFor(() => expect(inquiryApi.updateWork).toHaveBeenCalledWith('project-1', 'thread-1', {
      next_focus_kind: 'synthesize',
      blocked_reason: null,
    }))
  })

  it('shows the blocking reason instead of a next step, and offers to unblock', async () => {
    vi.mocked(inquiryApi.getThread).mockResolvedValue({
      ...QUESTION_DETAIL, blocked_reason: 'Waiting on the Q1.2 experiment', next_focus_kind: null,
    })
    renderPage()

    expect(await screen.findByText('Waiting on the Q1.2 experiment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Unblock and pick a next step/ })).toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole('button', { name: /record what changed/i }))
    fireEvent.change(await screen.findByLabelText(/What changed and why/), { target: { value: 'Found supporting evidence' } })
    fireEvent.click(screen.getByRole('button', { name: /^Record Iteration$/ }))

    await waitFor(() => expect(inquiryApi.recordIteration).toHaveBeenCalledWith('project-1', 'thread-1', expect.objectContaining({
      change_summary: 'Found supporting evidence',
      answer_state: 'open',
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

  it('routes a semantic redefinition to the assessment workspace rather than editing in place', async () => {
    const user = userEvent.setup()
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
    const user = userEvent.setup()
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
    const user = userEvent.setup()
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
      created_by_user_id: 'user-1', created_at: '2026-07-23T00:00:00.000Z',
    })
    vi.mocked(projectsApi.createBriefVersion).mockResolvedValue({
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ship a reliable, fast coding agent', scope_included: 'Coding tasks', scope_excluded: null,
      success_definition: 'Agent completes tasks unattended', constraints: null, assumptions: null,
      created_by_user_id: 'user-1', created_at: '2026-07-23T00:05:00.000Z',
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
    }))
  })

  it('can relate a root Thread to its own descendants, which the parent picker excludes', async () => {
    const child = { ...QUESTION, id: 'thread-2', statement: 'Is eviction correct?', primary_parent_id: 'thread-1' }
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION, child])
    vi.mocked(inquiryApi.addRelation).mockResolvedValue({
      id: 'relation-1', from_thread_id: 'thread-1', to_thread_id: 'thread-2',
      relation_kind: 'decomposes_into', created_at: '2026-07-23T00:00:00.000Z',
    })
    const user = userEvent.setup()
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

  it('shows model advice as a suggestion, and adopting it goes through the work-state command', async () => {
    vi.mocked(inquiryApi.getAdvice).mockResolvedValue({
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'synthesize',
      rationale: 'Thirty-four supporting items are in hand and two scans found no contradiction.',
      cited_refs: ['signal-7'], thread_version: 1, status: 'open',
      trigger_kind: 'iteration_recorded', model_version: 'test-model', stale: false,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    })
    vi.mocked(inquiryApi.adoptAdvice).mockResolvedValue({
      thread: { ...QUESTION, next_focus_kind: 'synthesize' },
      advice: null,
    })
    renderPage()

    expect(await screen.findByText('Suggested next step')).toBeInTheDocument()
    expect(screen.getByText(/Thirty-four supporting items/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Adopt as next step/ }))
    await waitFor(() => expect(inquiryApi.adoptAdvice).toHaveBeenCalledWith('project-1', 'thread-1'))
    // Adoption never writes Next Focus from the client.
    expect(inquiryApi.updateWork).not.toHaveBeenCalled()
  })

  it('marks advice stale once the Thread has moved past the revision it reasoned about', async () => {
    vi.mocked(inquiryApi.getAdvice).mockResolvedValue({
      id: 'advice-1', project_id: 'project-1', thread_id: 'thread-1',
      recommended_focus_kind: 'read_evidence', rationale: 'Two contradicting papers arrived.',
      cited_refs: [], thread_version: 1, status: 'open',
      trigger_kind: 'candidate_created', model_version: null, stale: true,
      created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
    })
    renderPage()

    expect(await screen.findByText(/based on v1 — this Thread has changed since/)).toBeInTheDocument()
  })

  it('offers to ask for a suggestion when a Thread has none', async () => {
    renderPage()

    await screen.findByText('Does caching help?')
    fireEvent.click(await screen.findByRole('button', { name: /Ask for a suggested next step/ }))
    await waitFor(() => expect(inquiryApi.generateAdvice).toHaveBeenCalledWith('project-1', 'thread-1'))
  })

  it('guides a visitor who arrived to start a search but has no Thread picked', async () => {
    renderPage('/spaces/space-1/projects/project-1/inquiry?research_intent=1')

    expect(await screen.findByText(/Pick the Question or Hypothesis you want to search for/)).toBeInTheDocument()
  })
})
