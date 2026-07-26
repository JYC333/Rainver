import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DecisionAreaPage from '../DecisionAreaPage'
import LearningAreaPage from '../LearningAreaPage'
import KnowledgeReviewPage from '../KnowledgeReviewPage'
import { agentsApi, decisionCasesApi, experimentsApi, inquiryApi, knowledgeApi, knowledgePromotionApi, learningApi, notesApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({
  decisionCasesApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    addOption: vi.fn(),
    addCriterion: vi.fn(),
    score: vi.fn(),
    decide: vi.fn(),
    addCommitment: vi.fn(),
    createDelivery: vi.fn(),
  },
  inquiryApi: { listThreads: vi.fn() },
  agentsApi: { list: vi.fn() },
  experimentsApi: { listDefinitions: vi.fn(), listInterpretations: vi.fn() },
  knowledgeApi: { list: vi.fn() },
  notesApi: { list: vi.fn() },
  learningApi: {
    objectives: vi.fn(),
    items: vi.fn(),
    createObjective: vi.fn(),
    createItem: vi.fn(),
    review: vi.fn(),
  },
  knowledgePromotionApi: {
    list: vi.fn(),
    summary: vi.fn(),
    decide: vi.fn(),
    reopen: vi.fn(),
    openPacket: vi.fn(),
    closePacket: vi.fn(),
  },
}))

function renderPage(path: string, element: ReactNode) {
  return render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/projects/:projectId/*" element={element} />
  </Routes></MemoryRouter>)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(decisionCasesApi.list).mockResolvedValue([])
  vi.mocked(inquiryApi.listThreads).mockResolvedValue([])
  vi.mocked(agentsApi.list).mockResolvedValue([])
  vi.mocked(experimentsApi.listDefinitions).mockResolvedValue([])
  vi.mocked(knowledgeApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
  vi.mocked(notesApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
  vi.mocked(learningApi.objectives).mockResolvedValue([])
  vi.mocked(learningApi.items).mockResolvedValue([])
  vi.mocked(knowledgePromotionApi.summary).mockResolvedValue({
    pending: 0, promotion: 0, revalidation: 0, no_impact: 3,
    summary: '3 source changes were checked with no review required.',
  })
  vi.mocked(knowledgePromotionApi.openPacket).mockResolvedValue({
    id: 'packet-1', status: 'open', created_at: new Date(0).toISOString(), candidates: [],
  })
})

describe('Decision, Learning, and Knowledge Review Project Areas', () => {
  it('renders the Decision Area as a reachable Project route', async () => {
    renderPage('/projects/project-1/decisions', <DecisionAreaPage />)
    expect(await screen.findByRole('heading', { name: 'Decisions' })).toBeInTheDocument()
    await waitFor(() => expect(decisionCasesApi.list).toHaveBeenCalledWith('project-1'))
  })

  it('creates a Decision with selected Inquiry context instead of an entered ID', async () => {
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([{ id: 'thread-1', statement: 'Which market should we enter?' } as never])
    vi.mocked(decisionCasesApi.create).mockResolvedValue({ id: 'decision-1' } as never)
    vi.mocked(decisionCasesApi.get).mockResolvedValue({ id: 'decision-1', source_thread_ids: ['thread-1'] } as never)
    renderPage('/projects/project-1/decisions', <DecisionAreaPage />)

    fireEvent.change(await screen.findByPlaceholderText('Decision title'), { target: { value: 'Market choice' } })
    fireEvent.click(screen.getByLabelText('Which market should we enter?'))
    fireEvent.click(screen.getByRole('button', { name: /New case/ }))

    await waitFor(() => expect(decisionCasesApi.create).toHaveBeenCalledWith('project-1', {
      title: 'Market choice',
      framing: '',
      source_thread_ids: ['thread-1'],
    }))
  })

  it('renders the Learning Area as a reachable Project route', async () => {
    renderPage('/projects/project-1/learning', <LearningAreaPage />)
    expect(await screen.findByRole('heading', { name: 'Learning' })).toBeInTheDocument()
    await waitFor(() => expect(learningApi.items).toHaveBeenCalledWith('project-1'))
  })

  it('selects Learning Knowledge by title and version', async () => {
    vi.mocked(knowledgeApi.list).mockResolvedValue({
      items: [{ id: 'knowledge-1', project_id: null, title: 'Caching fundamentals', version: 3 } as never],
      total: 1, limit: 100, offset: 0,
    })
    renderPage('/projects/project-1/learning', <LearningAreaPage />)
    expect(await screen.findByRole('option', { name: 'Caching fundamentals · v3 · shared' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Knowledge item ID/i)).not.toBeInTheDocument()
  })

  it('opens a bounded Knowledge review checkpoint and renders its summary', async () => {
    renderPage('/projects/project-1/knowledge-review', <KnowledgeReviewPage />)
    expect(await screen.findByText('3 source changes were checked with no review required.')).toBeInTheDocument()
    expect(knowledgePromotionApi.openPacket).toHaveBeenCalledWith('project-1', 10)
  })

  it('selects Knowledge extraction source and Agent by name', async () => {
    vi.mocked(inquiryApi.listThreads).mockResolvedValue([{ id: 'thread-1', kind: 'question', statement: 'What changed?' } as never])
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: 'agent-1', name: 'Knowledge curator', status: 'active', current_version_id: 'v1', adapter_type: 'model_api' } as never])
    renderPage('/projects/project-1/knowledge-review', <KnowledgeReviewPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Extraction source' }))
    expect(await screen.findByRole('option', { name: 'Question · What changed?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Extraction agent' }))
    expect(await screen.findByRole('option', { name: 'Knowledge curator · model api' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Source ID|Agent ID/i)).not.toBeInTheDocument()
  })
})
