import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResearchRunsTab from '../researchArea/ResearchRunsTab'
import { inquiryApi, projectResearchApi, projectsApi } from '../../../api/client'
import { REVIEW_ATTENTION_CHANGED_EVENT } from '../../../core/reviewAttention'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user-1' }) }))
vi.mock('../../../api/client', () => ({
  projectsApi: { operations: vi.fn() },
  projectResearchApi: {
    workflows: vi.fn().mockResolvedValue([]),
    checkpoints: vi.fn().mockResolvedValue([]),
    decideCheckpoint: vi.fn(),
    retryOperation: vi.fn(),
    reconcileOperation: vi.fn(),
    cancelOperation: vi.fn(),
  },
  inquiryApi: { listOpenSteps: vi.fn().mockResolvedValue([]), listThreads: vi.fn().mockResolvedValue([]) },
}))

const workflow = {
  id: 'workflow-1', project_id: 'project-1', current_stage: 'screening',
  status: 'active', state_json: { research_question: 'Does batching improve throughput?' },
  primary_thread_id: 'thread-1', started_by_user_id: null, started_run_id: null,
  created_at: '', updated_at: '',
}
const checkpoint = {
  id: 'checkpoint-1', project_id: 'project-1', workflow_id: 'workflow-1', stage_key: 'screening',
  checkpoint_type: 'screening_gate', status: 'pending',
  machine_result_json: { operation_id: 'operation-1', total: 4, relevant: 3, maybe: 1 },
  review: null, user_decision: null, decision_reason: null, decided_by_user_id: null, decided_at: null,
  created_at: '', updated_at: '',
}

function renderTab(path = '/projects/project-1/research?tab=runs') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId/research" element={<ResearchRunsTab projectId="project-1" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectResearchApi.workflows).mockResolvedValue([workflow] as never)
  vi.mocked(projectResearchApi.checkpoints).mockResolvedValue([checkpoint] as never)
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([{
    id: 'thread-1', space_id: 'space-1', project_id: 'project-1', kind: 'hypothesis', statement: 'Does batching improve throughput?',
    lifecycle_status: 'active', attention_state: 'focused', priority: 0, primary_parent_id: null,
    owner_user_id: null, next_focus_kind: null, next_focus_note: null, blocked_reason: null,
    version: 1, created_from: 'user', created_by_user_id: 'user-1', created_at: '', updated_at: '',
  }] as never)
})

/**
 * These rows lived on an Operations Area beside Automations, Runs and alerts
 * — Space-level objects filtered to the Project. The research rows were the
 * only thing there that belonged to the Project, so they moved to Research.
 */
describe('Research Runs tab', () => {
  it('lists every research Workflow as its own row and lets a pending Checkpoint be decided there', async () => {
    vi.mocked(projectsApi.operations).mockResolvedValue([
      {
        id: 'operation-1', project_id: 'project-1', kind: 'research', title: 'Incremental literature search',
        status: 'waiting_review', progress_json: { workflow_id: 'workflow-1', current_stage: 'screening' },
        created_at: '2026-07-30T22:57:05.000Z', updated_at: '', steps: [],
      },
      {
        id: 'operation-baseline', project_id: 'project-1', kind: 'research', title: 'Initial literature search',
        status: 'completed', progress_json: { workflow_id: 'workflow-1', current_stage: 'complete' },
        created_at: '2026-07-30T20:24:33.000Z', updated_at: '', steps: [],
      },
    ] as never)
    vi.mocked(projectResearchApi.decideCheckpoint).mockResolvedValue({} as never)
    const reviewAttentionChanged = vi.fn()
    window.addEventListener(REVIEW_ATTENTION_CHANGED_EVENT, reviewAttentionChanged)

    renderTab()

    expect(await screen.findAllByText('Does batching improve throughput?')).toHaveLength(2)
    expect(screen.getAllByText('Review needed')).toHaveLength(1)
    // Question/Hypothesis definition lives on the Inquiry page — "New search"
    // routes there first instead of opening a dialog with no Thread to target.
    expect(screen.getByRole('link', { name: /New search/ })).toHaveAttribute('href', '/projects/project-1/inquiry?research_intent=1')

    fireEvent.click(screen.getByRole('button', { name: 'Approve screening' }))
    await waitFor(() => expect(projectResearchApi.decideCheckpoint).toHaveBeenCalledWith(
      'project-1', 'workflow-1', 'checkpoint-1', { decision: 'approved' },
    ))
    expect(toast.dismiss).toHaveBeenCalledWith('research-review:project-1:checkpoint-1')
    await waitFor(() => expect(reviewAttentionChanged).toHaveBeenCalled())
    window.removeEventListener(REVIEW_ATTENTION_CHANGED_EVENT, reviewAttentionChanged)
  })

  it('keeps the research review toast when the checkpoint decision fails', async () => {
    vi.mocked(projectsApi.operations).mockResolvedValue([{
      id: 'operation-1', project_id: 'project-1', kind: 'research', title: 'Initial literature search',
      status: 'waiting_review', progress_json: { workflow_id: 'workflow-1', current_stage: 'screening' },
      created_at: '', updated_at: '', steps: [],
    }] as never)
    vi.mocked(projectResearchApi.decideCheckpoint).mockRejectedValueOnce(new Error('Decision failed'))

    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Approve screening' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Decision failed'))
    expect(toast.dismiss).not.toHaveBeenCalled()
  })

  it('marks the operation an attention item opened', async () => {
    vi.mocked(projectsApi.operations).mockResolvedValue([{
      id: 'operation-1', project_id: 'project-1', kind: 'research', title: 'Initial literature search',
      status: 'waiting_review', progress_json: { workflow_id: 'workflow-1', current_stage: 'screening' },
      created_at: '', updated_at: '', steps: [],
    }] as never)
    renderTab('/projects/project-1/research?tab=runs&open=operation-1')
    await screen.findByRole('button', { name: 'Approve screening' })
    expect(document.getElementById('operation-operation-1')?.className).toContain('ring-2')
  })
})
