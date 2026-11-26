import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { AgentOut } from '../types/api'

const {
  getMock,
  updateMock,
  updateConfigMock,
  listVersionsMock,
  listRunsMock,
  listProposalsMock,
  listRuntimeProfilesMock,
  listHostsMock,
} = vi.hoisted(() => ({
  getMock: vi.fn(),
  updateMock: vi.fn(),
  updateConfigMock: vi.fn(),
  listVersionsMock: vi.fn(),
  listRunsMock: vi.fn(),
  listProposalsMock: vi.fn(),
  listRuntimeProfilesMock: vi.fn(),
  listHostsMock: vi.fn(),
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
  hostsApi: {
    list: listHostsMock,
    listRuntimeDefinitions: vi.fn(async () => ({ items: [] })),
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
    source_role_id: null, source_role_version_id: null, model: null,
    runtime_key: 'opencode',
    system_prompt: null, created_at: '', updated_at: '', can_manage: true, ...overrides,
  }
}

describe('AgentDetailPage — disable/enable toggle', () => {
  beforeEach(() => {
    getMock.mockReset(); updateMock.mockReset(); updateConfigMock.mockReset()
    listVersionsMock.mockResolvedValue([]); listRunsMock.mockResolvedValue([]); listProposalsMock.mockResolvedValue([])
    listRuntimeProfilesMock.mockResolvedValue([])
    listHostsMock.mockResolvedValue({ items: [] })
    updateMock.mockResolvedValue(agent())
    updateConfigMock.mockResolvedValue(agent())
  })

  it('stops an active agent after confirming what stopping keeps', async () => {
    getMock.mockResolvedValue(agent({ status: 'active' }))
    render(<AgentDetailPage />)
    fireEvent.click(await screen.findByRole('button', { name: /^stop$/i }))
    expect(updateMock).not.toHaveBeenCalled()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/configuration, Project and Room places and history are kept/i)
    updateMock.mockResolvedValue(agent({ status: 'disabled' }))
    fireEvent.click(within(dialog).getByRole('button', { name: /^stop$/i }))
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a1', { status: 'disabled' }))
    expect(await screen.findByRole('button', { name: /restore/i })).toBeInTheDocument()
    expect(screen.getByText(/this agent is stopped/i)).toBeInTheDocument()
  })

  it('restores a stopped agent', async () => {
    getMock.mockResolvedValue(agent({ status: 'disabled' }))
    render(<AgentDetailPage />)
    const btn = await screen.findByRole('button', { name: /restore/i })
    updateMock.mockResolvedValue(agent({ status: 'active' }))
    fireEvent.click(btn)
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('a1', { status: 'active' }))
  })

  it('shows a viewer who does not manage it a read-only page and says who does', async () => {
    getMock.mockResolvedValue(agent({ can_manage: false, created_by_user_id: 'u2' }))
    render(<AgentDetailPage />)
    expect(await screen.findByText(/view only\. only its owner can edit or manage it/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^stop$|restore/i })).toBeNull()
    // Editing controls are disabled, not hidden; navigation stays live.
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeDisabled()
    expect(screen.getByRole('link', { name: /my agents/i })).toHaveAttribute('href', '/my-agents')
  })

  it('does not offer the toggle for the system-managed assistant', async () => {
    getMock.mockResolvedValue(agent({ agent_kind: 'system_assistant' }))
    render(<AgentDetailPage />)
    await screen.findByText('My Agent')
    expect(screen.queryByRole('button', { name: /^stop$|restore/i })).toBeNull()
  })

  it('offers a chat entry for an ordinary (non-assistant) agent', async () => {
    getMock.mockResolvedValue(agent({ agent_kind: 'standard' }))
    render(<AgentDetailPage />)
    expect(await screen.findByRole('link', { name: /open chat/i })).toBeInTheDocument()
  })

  it('offers no direct chat where it could not start: a stopped agent or a plugin assistant', async () => {
    getMock.mockResolvedValue(agent({ status: 'disabled' }))
    const { unmount } = render(<AgentDetailPage />)
    await screen.findByRole('button', { name: /restore/i })
    expect(screen.queryByRole('link', { name: /open chat/i })).toBeNull()
    unmount()
    getMock.mockResolvedValue(agent({ source_role_id: 'phd_application.assistant', source_role_version_id: 'phd_application.assistant:v1' }))
    render(<AgentDetailPage />)
    await screen.findByRole('button', { name: /^stop$/i })
    expect(screen.queryByRole('link', { name: /open chat/i })).toBeNull()
  })


  it('keeps view controls usable for a viewer who does not manage it, and disables only writes', async () => {
    getMock.mockResolvedValue(agent({ can_manage: false, created_by_user_id: 'u2', current_version_id: 'v2' }))
    const version = (id: string, label: string) => ({ id, agent_id: 'a1', space_id: 's1', version_label: label, created_at: '2026-11-01T00:00:00Z',
      system_prompt: `prompt ${label}`, tool_policy_json: {}, schedule_config_json: {}, context_policy_json: {}, memory_policy_json: {}, output_policy_json: {} })
    listVersionsMock.mockResolvedValue([version('v2', 'v2'), version('v1', 'v1')])
    render(<AgentDetailPage />)
    await screen.findByText(/view only/i)
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Versions' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Versions' }))
    const restore = await screen.findByRole('button', { name: 'Restore' })
    expect(restore).toBeDisabled()
    const views = screen.getAllByRole('button', { name: 'View config' })
    expect(views[0]).toBeEnabled()
    fireEvent.click(views[1]!)
    expect(await screen.findByText(/prompt v1/)).toBeInTheDocument()
  })

  it('names a plugin Role as plain text, never a Role library link', async () => {
    getMock.mockResolvedValue(agent({ source_role_id: 'phd_application.assistant', source_role_version_id: 'phd_application.assistant:v1' }))
    render(<AgentDetailPage />)
    expect(await screen.findByText(/created from plugin role/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'phd_application.assistant' })).toBeNull()
  })
})
