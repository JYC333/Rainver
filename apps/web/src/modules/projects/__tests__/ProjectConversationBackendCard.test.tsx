import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectConversationBackendCard from '../ProjectConversationBackendCard'

const mockedApi = vi.hoisted(() => ({
  getSystemAssistant: vi.fn(),
  listRuntimeProfiles: vi.fn(),
  updateRuntimeProfile: vi.fn(),
  resolveHostRuntimeProfile: vi.fn(),
  executionTargets: vi.fn(),
  listRuntimeAdapters: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  agentsApi: {
    getSystemAssistant: mockedApi.getSystemAssistant,
    listRuntimeProfiles: mockedApi.listRuntimeProfiles,
    updateRuntimeProfile: mockedApi.updateRuntimeProfile,
    resolveHostRuntimeProfile: mockedApi.resolveHostRuntimeProfile,
  },
  hostsApi: {
    executionTargets: mockedApi.executionTargets,
    listRuntimeAdapters: mockedApi.listRuntimeAdapters,
  },
}))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'space-1', preferredSpaceId: 'space-1' }),
}))

function renderCard() {
  return render(<MemoryRouter><ProjectConversationBackendCard projectId="project-1" /></MemoryRouter>)
}

describe('ProjectConversationBackendCard', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.executionTargets.mockResolvedValue({ targets: [] })
    mockedApi.listRuntimeAdapters.mockResolvedValue({ items: [] })
  })

  it('offers backend setup before the Project Assistant exists', async () => {
    mockedApi.getSystemAssistant.mockResolvedValue({ assistant: null })
    renderCard()
    expect(await screen.findByText('Review conversation runtime before the first message.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /configure an api provider/i })).toHaveAttribute('href', '/spaces/space-1/providers')
    expect(screen.getByRole('link', { name: /grant a server cli credential/i })).toHaveAttribute('href', '/cli-profiles')
    expect(screen.getByRole('link', { name: /pair or sign in on a host cli/i }))
      .toHaveAttribute('href', '/spaces/space-1/command-center')
  })

  it('lists the Project Assistant profiles and sets a new default', async () => {
    mockedApi.getSystemAssistant.mockResolvedValue({ assistant: { id: 'assistant-1', name: 'ttt Assistant' } })
    mockedApi.listRuntimeProfiles.mockResolvedValue([
      { id: 'p-api', name: 'Default', adapter_type: 'model_api', execution_host_id: null, is_default: true },
      { id: 'p-host', name: 'On host', adapter_type: 'claude_code', execution_host_id: 'host-1', workspace_mode: 'managed', is_default: false },
    ])
    mockedApi.updateRuntimeProfile.mockResolvedValue({})
    renderCard()

    expect(await screen.findByText(/owner-only \(others fall back\)/)).toBeInTheDocument()
    const radios = screen.getAllByRole('radio')
    expect((radios[0] as HTMLInputElement).checked).toBe(true)
    fireEvent.click(radios[1]!)
    await waitFor(() => expect(mockedApi.updateRuntimeProfile).toHaveBeenCalledWith('assistant-1', 'p-host', { is_default: true }))
  })

  it('adds a Host backend on the selected Project Location instead of forcing an empty managed workspace', async () => {
    mockedApi.getSystemAssistant.mockResolvedValue({ assistant: { id: 'assistant-1', name: 'ttt Assistant' } })
    mockedApi.listRuntimeProfiles.mockResolvedValue([])
    mockedApi.executionTargets.mockResolvedValue({
      targets: [{
        host_id: 'host-1',
        host_name: 'test',
        host_online: true,
        locations: [{
          id: 'location-1', project_folder_id: 'folder-1', folder_name: 'Financial-System',
          display_path: '/home/yuchuan/Financial-System', execution_ready: true,
        }],
        adapters: [{
          adapter_type: 'claude_code',
          display_name: 'Claude Code',
          installations: [{ id: 'own', version: '1.0.0', logged_in: true }],
        }],
      }],
    })
    mockedApi.resolveHostRuntimeProfile.mockResolvedValue({})
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /add or change host workspace/i }))
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'test · online' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add backend' }))

    await waitFor(() => expect(mockedApi.resolveHostRuntimeProfile).toHaveBeenCalledWith('assistant-1', expect.objectContaining({
      execution_host_id: 'host-1',
      workspace_location_id: 'location-1',
      workspace_mode: 'location',
      adapter_type: 'claude_code',
      runtime_installation: 'own',
    })))
  })
})
