import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import InquiryAreaPage from '../InquiryAreaPage'
import { inquiryApi, notesApi, projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    get: vi.fn(),
  },
  inquiryApi: {
    listThreads: vi.fn(),
    getThread: vi.fn(),
    createThread: vi.fn(),
    recordIteration: vi.fn(),
    listIterations: vi.fn(),
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
    listCandidates: vi.fn(),
    getCandidate: vi.fn(),
    openReviewPacket: vi.fn(),
    closeReviewPacket: vi.fn(),
    decideCandidate: vi.fn(),
    generateDeltaBrief: vi.fn(),
  },
  notesApi: { list: vi.fn() },
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
  priority: 0,
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.get).mockResolvedValue(PROJECT)
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([QUESTION])
  vi.mocked(inquiryApi.getThread).mockResolvedValue(QUESTION_DETAIL)
  vi.mocked(inquiryApi.listIterations).mockResolvedValue([])
  vi.mocked(inquiryApi.listCandidates).mockResolvedValue([])
  vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
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
  it('opens the new Thread dialog with Hypothesis preselected from Experiments', async () => {
    renderPage('/spaces/space-1/projects/project-1/inquiry?new=hypothesis')

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('What is the proposed claim?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hypothesis' })).toHaveClass('bg-primary')
  })

  it('lists Threads and shows the selected Thread detail', async () => {
    renderPage()

    expect(await screen.findByText('Does caching help?')).toBeInTheDocument()
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledWith('project-1', 'thread-1'))
    expect(screen.getByRole('button', { name: /record iteration/i })).toBeInTheDocument()
  })

  it('creates a new Thread through the dialog', async () => {
    vi.mocked(inquiryApi.createThread).mockResolvedValue({ ...QUESTION, id: 'thread-2', statement: 'New question' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /new thread/i }))
    fireEvent.change(screen.getByPlaceholderText('What is the current question?'), { target: { value: 'New question' } })
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(inquiryApi.createThread).toHaveBeenCalledWith('project-1', { kind: 'question', statement: 'New question' }))
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
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledWith('project-1', 'thread-1'))
    fireEvent.change(screen.getByPlaceholderText('What changed and why? (required)'), { target: { value: 'Found supporting evidence' } })
    fireEvent.click(screen.getByRole('button', { name: /record iteration/i }))

    await waitFor(() => expect(inquiryApi.recordIteration).toHaveBeenCalledWith('project-1', 'thread-1', expect.objectContaining({
      change_summary: 'Found supporting evidence',
      answer_state: 'open',
    })))
  })

  it('persists Next Focus through work state and uses the dedicated lifecycle command', async () => {
    vi.mocked(inquiryApi.updateWork).mockResolvedValue({ ...QUESTION, next_focus_kind: 'synthesize', wip_limit_exceeded: false })
    vi.mocked(inquiryApi.transitionLifecycle).mockResolvedValue({
      ...QUESTION,
      lifecycle_status: 'resolved',
      attention_state: 'resolved',
    })
    vi.spyOn(window, 'prompt').mockReturnValue('Resolution criterion met')
    renderPage()

    await screen.findByText('Does caching help?')
    await waitFor(() => expect(inquiryApi.getThread).toHaveBeenCalledWith('project-1', 'thread-1'))
    fireEvent.click(screen.getByLabelText('Confirmed next focus'))
    fireEvent.click(await screen.findByRole('option', { name: /^synthesize$/i }))
    fireEvent.click(screen.getByRole('button', { name: /save work state/i }))
    await waitFor(() => expect(inquiryApi.updateWork).toHaveBeenCalledWith('project-1', 'thread-1', expect.objectContaining({
      next_focus_kind: 'synthesize',
      blocked_reason: null,
    })))

    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }))
    await waitFor(() => expect(inquiryApi.transitionLifecycle).toHaveBeenCalledWith(
      'project-1',
      'thread-1',
      'resolved',
      'Resolution criterion met',
    ))
  })
})
