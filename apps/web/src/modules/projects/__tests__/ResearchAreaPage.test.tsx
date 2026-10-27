import { type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ResearchAreaPage from '../ResearchAreaPage'
import i18n from '../../../i18n'
import { projectResearchApi } from '../../../api/client'
import type { Project, ResearchReadingList, ResearchArea } from '../../../types/api'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))
vi.mock('../../../core/spaceNav', async () => {
  const { Link } = await import('react-router-dom')
  return {
    useSpaceNavigate: () => vi.fn(),
    SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => <Link to={to} {...props}>{children}</Link>,
  }
})

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { id: 'user-1' } }),
}))

// This file covers the Area's own documents. The workbench and standing panel
// are covered against the real components in
// ResearchAreaPage.workbench.test.tsx.
vi.mock('../FocusResearchWorkbench', () => ({
  FocusResearchWorkbench: () => <div>Focus workbench</div>,
  numberValue: () => 0,
  objectValue: () => ({}),
  researchOperationStage: () => null,
}))
vi.mock('../ProjectResearchStandingPanel', () => ({
  ProjectResearchStandingPanel: () => <div>Standing overview</div>,
}))
vi.mock('../../../api/client', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  },
  projectResearchApi: {
    initializeArea: vi.fn(), area: vi.fn(), readingList: vi.fn(),
    updateEvidenceCard: vi.fn(), createChecklistItem: vi.fn(), updateChecklistItem: vi.fn(), deleteChecklistItem: vi.fn(),
    askAi: vi.fn(), generateReportSnapshot: vi.fn(),
    workflows: vi.fn(), evidenceMatrix: vi.fn(), reports: vi.fn(), scanSummaries: vi.fn(),
    checkpoints: vi.fn(),
  },
  notesApi: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), jot: vi.fn(), linkingTo: vi.fn() },
  projectsApi: { get: vi.fn(), updateCorpusItem: vi.fn(), operations: vi.fn() },
  inquiryApi: {
    listOpenSteps: vi.fn().mockResolvedValue([]), listThreads: vi.fn() },
  sourcesApi: { channels: vi.fn(), projectSourceBindings: vi.fn(), projectItems: vi.fn() },
  providersApi: { usable: vi.fn(), vendors: vi.fn() },
}))

const area = {
  notes_collection_id: 'col-1',
  notes: [],
  checklist: [{ id: 'task-1', text: 'Check evidence', status: 'open', sort_order: 0, origin: 'agent', origin_run_id: 'run-1', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-19T00:00:00.000Z' }],
  reports: [{ id: 'report-1', research_question: 'How?', research_question_version: 1, status: 'awaiting_review', run_kind: 'baseline', created_at: '2026-07-19T00:00:00.000Z' }],
} as ResearchArea
const reading = {
  items: [{ id: 'corpus-1', source_item_id: 'source-1', triage_status: 'relevant', read_status: 'unread', source_item: { title: 'Paper one', excerpt: 'Evidence excerpt' }, evidence_card: { why_md: 'Relevant', how_md: 'Trial', what_md: 'Result', stance: null } }],
  total: 1, limit: 50, offset: 0,
} as unknown as ResearchReadingList

describe('ResearchAreaPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
    window.localStorage.clear()
    const api = await import('../../../api/client')
    vi.mocked(api.projectsApi.get).mockResolvedValue({ id: 'project-1', name: 'Study', current_focus: 'How?' } as Project)
    vi.mocked(projectResearchApi.initializeArea).mockResolvedValue(area)
    vi.mocked(projectResearchApi.area).mockResolvedValue(area)
    vi.mocked(projectResearchApi.readingList).mockResolvedValue(reading)
    vi.mocked(projectResearchApi.updateChecklistItem).mockImplementation(async (_projectId, _itemId, body) => ({ ...area.checklist[0], ...body }))
    vi.mocked(projectResearchApi.generateReportSnapshot).mockResolvedValue({ id: 'operation-1' } as never)
    vi.mocked(api.providersApi.usable).mockResolvedValue([{ id: 'provider-1', name: 'Provider', enabled: true }] as never)
    vi.mocked(api.providersApi.vendors).mockResolvedValue([])
    vi.mocked(api.notesApi.linkingTo).mockResolvedValue([])
    // useProjectResearch loads the workbench's own state on this route.
    vi.mocked(projectResearchApi.workflows).mockResolvedValue([])
    vi.mocked(projectResearchApi.evidenceMatrix).mockResolvedValue([])
    vi.mocked(projectResearchApi.reports).mockResolvedValue([])
    vi.mocked(projectResearchApi.scanSummaries).mockResolvedValue([])
    vi.mocked(projectResearchApi.checkpoints).mockResolvedValue([])
    vi.mocked(api.projectsApi.operations).mockResolvedValue([])
    vi.mocked(api.inquiryApi.listThreads).mockResolvedValue([])
    vi.mocked(api.sourcesApi.channels).mockResolvedValue([])
    vi.mocked(api.sourcesApi.projectSourceBindings).mockResolvedValue([])
    vi.mocked(api.sourcesApi.projectItems).mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 })
  })

  function renderPage(search = '?tab=standing') {
    render(
      <MemoryRouter initialEntries={[`/projects/project-1/research${search}`]}>
        <Routes><Route path="/projects/:projectId/research" element={<ResearchAreaPage />} /></Routes>
      </MemoryRouter>,
    )
  }

  it('keeps a default visit content-free and opens deep research only on demand', async () => {
    renderPage('')
    expect(screen.getByRole('link', { name: 'Read project updates' })).toHaveAttribute('href', '/projects/project-1/sources')
    expect(screen.getByRole('link', { name: 'Past reports' })).toHaveAttribute('href', '/projects/project-1/research?tab=reports')
    expect(screen.getByRole('link', { name: 'Research runs' })).toHaveAttribute('href', '/projects/project-1/research?tab=runs')
    expect(screen.getByRole('link',{name:'Choose a project question'})).toHaveAttribute('href','/projects/project-1/inquiry')
    expect(projectResearchApi.initializeArea).not.toHaveBeenCalled()
    expect(projectResearchApi.workflows).not.toHaveBeenCalled()
    expect(projectResearchApi.readingList).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('link', { name: 'Continue research' }))
    expect(await screen.findByRole('tab', { name: 'Standing overview' })).toBeInTheDocument()
    expect(projectResearchApi.initializeArea).toHaveBeenCalledWith('project-1')
    fireEvent.click(screen.getByRole('tab', { name: 'Reports' }))
    expect(await screen.findByText('How?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Standing overview' }))
    expect(screen.queryByRole('link', { name: 'Continue research' })).not.toBeInTheDocument()
  })

  it('renders the monitoring and optional research entry in Chinese without creating an area', async () => {
    await i18n.changeLanguage('zh-CN')
    renderPage('')
    expect(screen.getByRole('link', { name: '查看项目更新' })).toHaveAttribute('href', '/projects/project-1/sources')
    expect(screen.getByRole('link', { name: '继续已有研究' })).toHaveAttribute('href', '/projects/project-1/research?tab=focus')
    expect(projectResearchApi.initializeArea).not.toHaveBeenCalled()
  })

  /**
   * There is no Notebook tab. Notes are a Project-level surface. Do not add
   * a second door to them here.
   */
  it('has no Notebook tab and links to the Project notes surface instead', async () => {
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Reading List' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /Notebook/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Notes/ })).toHaveAttribute('href', '/projects/project-1/notes')
  })

  it('keeps corpus review, checklist, and report snapshot actions in area tabs', async () => {
    renderPage()
    // Standing discovery is the Area's landing view; the documents sit beside
    // it in the same tab bar rather than on a page of their own.
    await userEvent.click(await screen.findByRole('tab', { name: 'Reading List' }))
    expect(await screen.findByText('Paper one')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Checklist' }))
    expect(await screen.findByText('Check evidence')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    await userEvent.click(screen.getByRole('button', { name: /Generate new snapshot/ }))
    await waitFor(() => expect(projectResearchApi.generateReportSnapshot).toHaveBeenCalledWith('project-1'))
  })

  it('keeps both checklist items done when two toggles overlap', async () => {
    const api = await import('../../../api/client')
    const second = { ...area.checklist[0]!, id: 'task-2', text: 'Compare methods', sort_order: 1 }
    const twoItems = { ...area, checklist: [area.checklist[0]!, second] } as ResearchArea
    vi.mocked(api.projectResearchApi.area).mockResolvedValue(twoItems)
    vi.mocked(api.projectResearchApi.initializeArea).mockResolvedValue(twoItems)
    const answers: Array<() => void> = []
    vi.mocked(projectResearchApi.updateChecklistItem).mockImplementation((_projectId, itemId, body) => new Promise(resolve => {
      const item = twoItems.checklist.find(entry => entry.id === itemId)!
      answers.push(() => resolve({ ...item, ...body }))
    }))
    renderPage()

    await userEvent.click(await screen.findByRole('tab', { name: 'Checklist' }))
    await screen.findByText('Check evidence')
    const done = () => screen.getByRole('region', { name: 'Done checklist items' })
    fireEvent.click(screen.getByRole('button', { name: 'Mark Check evidence done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mark Compare methods done' }))
    await waitFor(() => expect(answers).toHaveLength(2))
    answers.forEach(answer => answer())

    // Each answer is applied to the list as it is then, not to the list each
    // request started from: the first one stays done when the second lands.
    await waitFor(() => expect(within(done()).getByText('Compare methods')).toBeInTheDocument())
    expect(within(done()).getByText('Check evidence')).toBeInTheDocument()
  })

  it('shows the uninitialized empty state instead of loading forever for readers', async () => {
    const { ApiRequestError } = await import('../../../api/client')
    vi.mocked(projectResearchApi.initializeArea).mockRejectedValue(new ApiRequestError('not initialized', 404))
    renderPage()
    expect(await screen.findByText('Research Area not initialized')).toBeInTheDocument()
  })

  it('does not disguise server failures as an uninitialized area', async () => {
    const { ApiRequestError } = await import('../../../api/client')
    vi.mocked(projectResearchApi.initializeArea).mockRejectedValue(new ApiRequestError('service unavailable', 503))
    renderPage()
    expect(await screen.findByText('Research Area unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Research Area not initialized')).not.toBeInTheDocument()
  })
})
