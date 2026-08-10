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
   * Creation asks one thing about shape: how the work advances. It never asks
   * what the Project is about, and it presets nothing else — the Project
   * Template concept it used to offer had been emptied three times over, and
   * every job it once held has another home.
   */
  it('creates with a Mode and presets nothing else', async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>)

    await openCreateDialog()
    expect(screen.getByRole('dialog')).toHaveClass('overflow-y-auto')
    expect(screen.getByText('How does this Project advance?')).toBeInTheDocument()
    expect(screen.queryByText(/source pack/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Academic Research/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Research/ })).toHaveAttribute('aria-pressed', 'true')

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

  it('sends the Mode the creator picked', async () => {
    render(<MemoryRouter><ProjectsPage /></MemoryRouter>)

    await openCreateDialog()
    await typeName('Ship it')
    await userEvent.click(screen.getByRole('button', { name: /^Delivery/ }))
    await submitCreate()

    await waitFor(() => {
      expect(projectsApi.create).toHaveBeenCalledWith(expect.objectContaining({ primary_mode: 'delivery' }))
    })
  })
})
