import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ProjectsPage from '../ProjectsPage'
import { projectsApi } from '../../../api/client'

const navigateMock = vi.fn()

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', activeSpaceName: 'Space One' }),
}))

vi.mock('../../../core/spaceNav', () => ({
  useSpaceNavigate: () => navigateMock,
}))

vi.mock('../../../api/client', () => ({
  projectsApi: {
    list: vi.fn(),
    create: vi.fn(),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectsApi.list).mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 })
  vi.mocked(projectsApi.create).mockResolvedValue({
    id: 'project-1',
    space_id: 'space-1',
    owner_user_id: 'user-1',
    name: 'Paper map',
    description: null,
    status: 'active',
    current_focus: null,
    settings_json: null,
    primary_mode: 'research',
    active_brief_version_id: null,
    archived_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  })
})

async function openCreateDialog() {
  await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
}

async function typeName(value: string) {
  await userEvent.type(screen.getByPlaceholderText('e.g. Research memory systems'), value)
}

async function submitCreate() {
  await userEvent.click(screen.getByRole('button', { name: /^create project$/i }))
}

describe('ProjectsPage', () => {
  /**
   * Creation asks for a name and presets nothing — the Project Template
   * concept it used to offer had been emptied three times over, and every
   * job it once held has another home. Mode starts as Research and is
   * changed from inside the Project.
   */
  it('creates with a name and presets nothing else', async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>)

    await openCreateDialog()
    expect(screen.getByRole('dialog')).toHaveClass('overflow-y-auto')

    await typeName('Paper map')
    await submitCreate()

    await waitFor(() => {
      expect(projectsApi.create).toHaveBeenCalledWith({
        name: 'Paper map',
        description: null,
        current_focus: null,
        settings_json: null,
        primary_mode: 'research',
        goal: null,
        scope_included: null,
        success_definition: null,
      })
    })
    expect(navigateMock).toHaveBeenCalledWith('/projects/project-1')
  })

  it('asks for a name and nothing that the Project cannot yet answer', async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>)
    await openCreateDialog()

    // Goal, scope, success and Mode were asked here before the work had a
    // shape, so they were guessed at. They are set from inside the Project,
    // where the Brief, the checklist and the Assistant can help; Mode starts
    // as Research and is changed from the Project shell.
    for (const label of ['Goal', 'Scope', 'Success definition', 'Current focus', 'How does this Project advance?']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /^Delivery/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Starts as a Research Project/)).toBeInTheDocument()
  })
})
