import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AgentOut } from '../types/api'

const {
  getMock,
  updateMock,
  updateConfigMock,
  listVersionsMock,
  listRunsMock,
  listProposalsMock,
  listRuntimeProfilesMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  updateMock: vi.fn(),
  updateConfigMock: vi.fn(),
  listVersionsMock: vi.fn(),
  listRunsMock: vi.fn(),
  listProposalsMock: vi.fn(),
  listRuntimeProfilesMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  agentsApi: {
    get: getMock,
    update: updateMock,
    updateConfig: updateConfigMock,
    listVersions: listVersionsMock,
    listRunsForAgent: listRunsMock,
    listRuntimeProfiles: listRuntimeProfilesMock,
    listProposals: listProposalsMock,
  },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({
    activeSpaceId: 's1',
    activeSpaceName: 'Space One',
    userId: 'u1',
    spaces: [{ id: 's1', name: 'Space One', type: 'team', role: 'member' }],
  }),
}))

// Keep the heavy child panels out of this focused test.
vi.mock('../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))
vi.mock('../modules/agents/ConfigCards', () => ({
  InputsView: () => null, OutputsView: () => null, ScheduleView: () => null, SafetyView: () => null,
}))
vi.mock('../modules/agents/AssistantSettingsPanel', () => ({ default: () => null }))
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ agentId: 'a1' }),
}))

import AgentDetailPage from '../modules/agents/AgentDetailPage'

function agent(overrides: Partial<AgentOut> = {}): AgentOut {
  return {
    id: 'a1', space_id: 's1', project_id: null, created_by_user_id: 'u1', name: 'My Agent',
    description: 'desc', visibility: 'private', access_level: 'full', role_instruction: null,
    status: 'active', agent_kind: 'standard', current_version_id: 'v1',
    source_template_id: null, source_template_version_id: null, model: null,
    adapter_type: 'model_api', requires_model_provider: true,
    system_prompt: null, created_at: '', updated_at: '', ...overrides,
  }
}

describe('AgentDetailPage — disable/enable toggle', () => {
  beforeEach(() => {
    getMock.mockReset(); updateMock.mockReset(); updateConfigMock.mockReset()
    listVersionsMock.mockResolvedValue([]); listRunsMock.mockResolvedValue([]); listProposalsMock.mockResolvedValue([])
    listRuntimeProfilesMock.mockResolvedValue([])
    updateMock.mockResolvedValue(agent())
    updateConfigMock.mockResolvedValue(agent())
  })

  it('disables an active agent through agentsApi.update', async () => {
    getMock.mockResolvedValue(agent({ status: 'active' }))
    render(<AgentDetailPage />)
    const btn = await screen.findByRole('button', { name: /disable/i })
    // Re-read after the toggle returns the disabled agent.
    getMock.mockResolvedValue(agent({ status: 'disabled' }))
    fireEvent.click(btn)
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a1', { status: 'disabled' }))
  })

  it('shows Enable for a non-active agent and re-activates it', async () => {
    getMock.mockResolvedValue(agent({ status: 'disabled' }))
    render(<AgentDetailPage />)
    const btn = await screen.findByRole('button', { name: /enable/i })
    getMock.mockResolvedValue(agent({ status: 'active' }))
    fireEvent.click(btn)
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a1', { status: 'active' }))
  })

  it('does not offer the toggle for the system-managed assistant', async () => {
    getMock.mockResolvedValue(agent({ agent_kind: 'system_assistant' }))
    render(<AgentDetailPage />)
    await screen.findByText('My Agent')
    expect(screen.queryByRole('button', { name: /disable|enable/i })).toBeNull()
  })

  it('offers a chat entry for an ordinary (non-assistant) agent', async () => {
    getMock.mockResolvedValue(agent({ agent_kind: 'standard' }))
    render(<AgentDetailPage />)
    expect(await screen.findByRole('link', { name: /open chat/i })).toBeInTheDocument()
  })

})
