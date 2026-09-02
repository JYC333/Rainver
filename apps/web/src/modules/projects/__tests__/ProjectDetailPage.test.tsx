import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProjectDetailPage from '../ProjectDetailPage'
import { projectsApi } from '../../../api/client'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 'space-1',
    activeSpaceName: 'Space One',
    userId: 'user-1',
    spaces: [{ id: 'space-1', role: 'member' }],
  }),
}))

vi.mock('../../../core/spaceNav', () => ({
  useSpaceNavigate: () => vi.fn(),
  SpaceLink: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    get: vi.fn(),
    getOverview: vi.fn(),
    operations: vi.fn(),
    update: vi.fn(),
    createBriefVersion: vi.fn(),
    listBriefVersions: vi.fn(),
    submitBriefForReview: vi.fn(),
    publishBrief: vi.fn(),
    listInstructionVersions: vi.fn(),
    createInstructionVersion: vi.fn(),
    submitInstructionForReview: vi.fn(),
    publishInstruction: vi.fn(),
    archive: vi.fn(),
    getBoard: vi.fn(),
    updates: vi.fn(),
  },
}))

const project: Awaited<ReturnType<typeof projectsApi.get>> = {
  id: 'project-1',
  space_id: 'space-1',
  owner_user_id: 'user-1',
  name: 'Project One',
  description: null,
  status: 'active',
  current_focus: null as string | null,
  settings_json: null,
  active_brief_version_id: null,
  created_at: '2026-06-30T00:00:00.000Z',
  updated_at: '2026-06-30T00:00:00.000Z',
  archived_at: null,
}

const BRIEF_AGGREGATE = {
  project_status: 'active',
  current_focus: null,
  confirmed_decisions: [] as string[],
  workspace_identity: {},
  workspace_boundary: {},
  source_refs: [] as Array<Record<string, unknown>>,
}

function setup(overrides: {
  project?: Partial<typeof project>
  overview?: Partial<Awaited<ReturnType<typeof projectsApi.getOverview>>>
} = {}) {
  vi.mocked(projectsApi.get).mockResolvedValue({ ...project, ...overrides.project } as never)
  vi.mocked(projectsApi.getOverview).mockResolvedValue({
    project: { id: 'project-1', name: 'Project One', status: 'active' },
    brief: { version: '1', goal: 'Understand agent evidence use', scope_included: null, success_definition: null },
    attention: [{ id: 'attention-1', attention_class: 'gate', title: 'Screening gate waiting', summary: null, href: '/projects/project-1/research?tab=runs&open=op-1' }],
    ...overrides.overview,
  } as never)
  vi.mocked(projectsApi.getBoard).mockResolvedValue({
    project: { id: 'project-1', name: 'Project One' },
    columns: [], cards: [], viewer_user_id: 'user-1', viewer_can_write: true,
    filters: { all: 0, mine: 0, agent_held: 0, needs_me: 0 },
  } as never)
  vi.mocked(projectsApi.updates).mockResolvedValue({ items: [], next_cursor: null, viewer_can_write: true } as never)
  vi.mocked(projectsApi.listBriefVersions).mockResolvedValue([])
  vi.mocked(projectsApi.listInstructionVersions).mockResolvedValue([])
}

function renderPage() {
  return render(
    <MemoryRouter
      initialEntries={['/spaces/space-1/projects/project-1']}
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
    >
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

/**
 * Pulse: the header and goal line are the page's own; the situation comes
 * from `ProjectPulse`. Nothing here duplicates the sidebar or an Area.
 */
describe('ProjectDetailPage (Pulse)', () => {
  it('shows the goal and the situation, and fetches nothing an Area owns', async () => {
    setup()
    renderPage()

    expect(await screen.findByText('Project One')).toBeInTheDocument()
    expect(screen.getByText('Understand agent evidence use')).toBeInTheDocument()
    // The same attention list the sidebar shows, unfiltered, so the two cannot
    // disagree about whether anything is pending.
    expect(await screen.findByText('Screening gate waiting')).toBeInTheDocument()
    await waitFor(() => {
      expect(projectsApi.get).toHaveBeenCalledWith('project-1')
      expect(projectsApi.getBoard).toHaveBeenCalledWith('project-1')
    })
    expect(projectsApi.operations).not.toHaveBeenCalled()
  })

  it('carries none of the old Overview blocks', async () => {
    setup()
    renderPage()
    expect(await screen.findByText('Project One')).toBeInTheDocument()
    // "Next" was Mode-generated links to Areas the sidebar lists; "Recent
    // activity" was the raw-material queue under another name; "In this
    // project" was the Areas list again with counts. Each doubled something
    // already on the screen.
    expect(screen.queryByRole('heading', { name: 'Next' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'In this project' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Define a question to research' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Research workflows/ })).toBeNull()
    // The Room has its own ways in (the sidecar, the Rooms Area); a third
    // button on the front page was one more copy of the same door.
    expect(screen.queryByRole('link', { name: 'Rooms' })).toBeNull()
  })

  it('offers no Project type to set, anywhere', async () => {
    // A Project has no type field (ADR 0019): what kind of work it is shows
    // in its goal and in what it comes to hold, not in a Settings dropdown.
    setup()
    renderPage()
    expect(await screen.findByText('Project One')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    expect(screen.queryByLabelText('How this Project advances')).toBeNull()
  })

  /**
   * Each of these has a dedicated Area with its own route. Rendering them here
   * too made the front page a second, weaker copy of four other pages and made
   * every Project visit pay for their data.
   */
  it('hosts no surface that a dedicated Area owns', async () => {
    setup()
    renderPage()

    expect(await screen.findByText('Project One')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Standing overview' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Focus workbench' })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^sources$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^link source$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^save url$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^new folder$/i })).toBeNull()
    expect(screen.queryByText('Saved intake configuration')).toBeNull()
  })

  it('keeps project current_focus visibly separate from the Inquiry-owned research question', async () => {
    setup({ project: { current_focus: 'How should agents use source evidence?' } })
    renderPage()

    expect(await screen.findByText('How should agents use source evidence?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit question/i })).toBeNull()
    expect(screen.getByRole('button', { name: /edit focus/i })).toBeInTheDocument()
  })

  it('uses the unified confirmation dialog before archiving a project', async () => {
    setup()
    vi.mocked(projectsApi.archive).mockResolvedValueOnce({} as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /^archive$/i }))
    expect(screen.getByRole('heading', { name: /archive “project one”/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /archive project/i }))

    await waitFor(() => expect(projectsApi.archive).toHaveBeenCalledWith('project-1'))
  })

  it('edits name, description, and focus without offering Area-owned settings', async () => {
    setup()
    vi.mocked(projectsApi.update).mockResolvedValueOnce({ ...project, name: 'Renamed' } as never)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(screen.getByLabelText('Current focus')).toBeInTheDocument()
    expect(screen.queryByText('Saved intake configuration')).toBeNull()
    expect(screen.queryByLabelText('New item limit')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(projectsApi.update).toHaveBeenCalledWith('project-1', {
      name: 'Project One',
      description: null,
      current_focus: null,
    }))
  })

  it('edits the Brief goal from the Overview by creating a new version without clearing hidden Brief fields', async () => {
    const brief = {
      id: 'brief-1',
      space_id: 'space-1',
      project_id: 'project-1',
      version: 'v1',
      goal: 'Understand agent evidence use',
      scope_included: 'Managed runs',
      scope_excluded: 'Vendor internals',
      success_definition: 'Evidence is traceable',
      constraints: 'No ambient credentials',
      assumptions: 'Providers may fail over',
      ...BRIEF_AGGREGATE,
      status: 'published' as const,
      reviewed_by_user_id: 'user-1',
      reviewed_at: '2026-06-30T00:00:00.000Z',
      published_by_user_id: 'user-1',
      published_at: '2026-06-30T00:00:00.000Z',
      created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
    }
    const updated = { ...brief, id: 'brief-2', version: 'v2', goal: 'Make evidence traceable', status: 'draft' as const, reviewed_by_user_id: null, reviewed_at: null, published_by_user_id: null, published_at: null }
    const reviewed = { ...updated, status: 'in_review' as const, reviewed_by_user_id: 'user-1', reviewed_at: '2026-06-30T00:05:00.000Z' }
    const published = { ...reviewed, status: 'published' as const, published_by_user_id: 'user-1', published_at: '2026-06-30T00:06:00.000Z' }
    setup({ overview: { brief } })
    vi.mocked(projectsApi.createBriefVersion).mockResolvedValueOnce(updated)
    vi.mocked(projectsApi.submitBriefForReview).mockResolvedValueOnce(reviewed)
    vi.mocked(projectsApi.publishBrief).mockResolvedValueOnce(published)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit goal' }))
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: '  Make evidence traceable  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))

    await waitFor(() => expect(projectsApi.createBriefVersion).toHaveBeenCalledWith('project-1', {
      goal: 'Make evidence traceable',
      scope_included: 'Managed runs',
      scope_excluded: 'Vendor internals',
      success_definition: 'Evidence is traceable',
      constraints: 'No ambient credentials',
      assumptions: 'Providers may fail over',
      confirmed_decisions: [],
      workspace_identity: {},
      workspace_boundary: {},
      source_refs: [],
    }))
    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(projectsApi.publishBrief).toHaveBeenCalledWith('project-1', 'brief-2'))
  })

  it('lets an owner reopen a submitted Brief and complete the publish handoff', async () => {
    const submitted = {
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Ready for owner review', scope_included: null, scope_excluded: null,
      success_definition: null, constraints: null, assumptions: null,
      ...BRIEF_AGGREGATE,
      status: 'in_review' as const, reviewed_by_user_id: 'user-2',
      reviewed_at: '2026-06-30T00:05:00.000Z', published_by_user_id: null,
      published_at: null, created_by_user_id: 'user-2', created_at: '2026-06-30T00:00:00.000Z',
    }
    const published = { ...submitted, status: 'published' as const, published_by_user_id: 'user-1', published_at: '2026-06-30T00:06:00.000Z' }
    setup()
    vi.mocked(projectsApi.listBriefVersions).mockResolvedValueOnce([submitted])
    vi.mocked(projectsApi.publishBrief).mockResolvedValueOnce(published)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit goal' }))
    expect(await screen.findByDisplayValue('Ready for owner review')).toBeDisabled()
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))

    await waitFor(() => expect(projectsApi.publishBrief).toHaveBeenCalledWith('project-1', 'brief-2'))
  })

  it('restores an unsent Brief draft instead of creating another version', async () => {
    const draft = {
      id: 'brief-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      goal: 'Unsent draft goal', scope_included: 'Pending scope', scope_excluded: 'Pending exclusion',
      success_definition: 'Pending success', constraints: 'Pending constraint', assumptions: 'Pending assumption',
      ...BRIEF_AGGREGATE,
      status: 'draft' as const, reviewed_by_user_id: null, reviewed_at: null,
      published_by_user_id: null, published_at: null, created_by_user_id: 'user-1',
      created_at: '2026-06-30T00:00:00.000Z',
    }
    setup()
    vi.mocked(projectsApi.listBriefVersions).mockResolvedValueOnce([draft])
    vi.mocked(projectsApi.createBriefVersion).mockResolvedValueOnce({ ...draft, id: 'brief-3', version: 'v3', goal: 'Corrected draft goal' })
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit goal' }))
    expect(await screen.findByDisplayValue('Unsent draft goal')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Submit for review' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save goal' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create corrected version' }))
    expect(screen.getByDisplayValue('Unsent draft goal')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Save goal' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Corrected draft goal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
    await waitFor(() => expect(projectsApi.createBriefVersion).toHaveBeenCalledWith('project-1', {
      goal: 'Corrected draft goal',
      scope_included: 'Pending scope',
      scope_excluded: 'Pending exclusion',
      success_definition: 'Pending success',
      constraints: 'Pending constraint',
      assumptions: 'Pending assumption',
      confirmed_decisions: [],
      workspace_identity: {},
      workspace_boundary: {},
      source_refs: [],
    }))
  })

  it('restores a submitted Project Instruction so the owner can publish it', async () => {
    const submitted = {
      id: 'instruction-2', space_id: 'space-1', project_id: 'project-1', version: 'v2',
      title: 'Delivery rules', instruction_text: 'Use the release checklist.',
      status: 'in_review' as const, reviewed_by_user_id: 'user-1',
      reviewed_at: '2026-06-30T00:05:00.000Z', published_by_user_id: null,
      published_at: null, created_by_user_id: 'user-1', created_at: '2026-06-30T00:00:00.000Z',
    }
    vi.mocked(projectsApi.listInstructionVersions).mockResolvedValueOnce([submitted])
    vi.mocked(projectsApi.publishInstruction).mockResolvedValueOnce({
      ...submitted, status: 'published', published_by_user_id: 'user-1', published_at: '2026-06-30T00:06:00.000Z',
    })
    setup()
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Instruction' }))
    expect(await screen.findByDisplayValue('Delivery rules')).toBeDisabled()
    expect(screen.getByDisplayValue('Use the release checklist.')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    await waitFor(() => expect(projectsApi.publishInstruction).toHaveBeenCalledWith('project-1', 'instruction-2'))
  })

  it('does not offer Project Instruction mutation to an ordinary member', async () => {
    setup({ project: { owner_user_id: 'user-2' } })
    renderPage()

    await screen.findByText('Project One')
    expect(screen.queryByRole('button', { name: 'Instruction' })).not.toBeInTheDocument()
  })

  it('offers Project Instruction mutation to an active Project co-owner', async () => {
    setup({ project: { owner_user_id: 'user-2', current_user_can_approve_context: true } })
    renderPage()

    expect(await screen.findByRole('button', { name: 'Instruction' })).toBeInTheDocument()
  })
})
