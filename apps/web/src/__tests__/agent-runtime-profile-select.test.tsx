import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentOut, AgentVersionOut } from '../types/api'

// The runtime profile form used to hard-code three runtimes. It reads the
// live adapter catalog now, so an enabled ACP registry agent and OpenCode are
// as selectable as the two it used to know about, and what a runtime supports
// comes from the catalog row rather than from its name.
const { getMock, listVersionsMock, listRuntimeProfilesMock, listRuntimeAdaptersMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  listVersionsMock: vi.fn(),
  listRuntimeProfilesMock: vi.fn(),
  listRuntimeAdaptersMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  agentsApi: {
    get: getMock,
    update: vi.fn(),
    updateConfig: vi.fn(),
    listVersions: listVersionsMock,
    listRunsForAgent: vi.fn(async () => []),
    listRuntimeProfiles: listRuntimeProfilesMock,
    listProposals: vi.fn(async () => []),
  },
  hostsApi: {
    list: vi.fn(async () => ({ items: [] })),
    listRuntimeAdapters: listRuntimeAdaptersMock,
  },
  runtimeToolsApi: {
    spacePolicies: vi.fn(async () => []),
  },
  providersApi: {
    list: vi.fn(async () => []),
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
vi.mock('../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={typeof to === 'string' ? to : '#'}>{children}</a>,
}))
vi.mock('../modules/agents/ConfigCards', () => ({
  InputsView: () => null, OutputsView: () => null, ScheduleView: () => null, SafetyView: () => null,
}))
vi.mock('../modules/agents/AssistantSettingsPanel', () => ({ default: () => null }))
vi.mock('../modules/providers/ProviderSelector', () => ({ default: () => <div data-testid="provider-selector" /> }))
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useParams: () => ({ agentId: 'a1' }),
}))

import AgentDetailPage from '../modules/agents/AgentDetailPage'

const AGENT: AgentOut = {
  id: 'a1', space_id: 's1', project_id: null, created_by_user_id: 'u1', name: 'My Agent',
  description: 'desc', visibility: 'private', access_level: 'full', role_instruction: null,
  status: 'active', agent_kind: 'standard', current_version_id: 'v1',
  source_template_id: null, source_template_version_id: null, model: null,
  adapter_type: 'model_api', requires_model_provider: true,
  system_prompt: null, created_at: '', updated_at: '',
}
const VERSION = {
  id: 'v1', agent_id: 'a1', space_id: 's1', version_label: 'v1', model_provider_id: null, model_name: null,
  system_prompt: null, prompt_provenance_json: null, model_config_json: {}, runtime_config_json: {},
  context_policy_json: {}, memory_policy_json: {}, capabilities_json: [], tool_permissions_json: {},
  runtime_policy_json: {}, tool_policy_json: {}, output_policy_json: {}, schedule_config_json: {},
  output_schema_json: {}, source_proposal_id: null, source_activity_id: null, created_at: '',
} as unknown as AgentVersionOut

const CATALOG = [
  { adapter_type: 'claude_code', display_name: 'Claude Code', command: 'claude-agent-acp', capability_probe: 'claude', remote_eligible: true, provider_binding: true, provider_api: 'claude_compatible' as const },
  { adapter_type: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true, provider_binding: true, provider_api: null },
  { adapter_type: 'acp_cursor', display_name: 'Cursor', command: 'acp_cursor', capability_probe: 'acp_cursor', remote_eligible: false, provider_binding: false, provider_api: null },
]

async function openRuntimeTab() {
  render(<AgentDetailPage />)
  // Radix tabs switch on pointer events, not a synthetic click.
  await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
  return await screen.findByRole('combobox', { name: 'Runtime' }) as HTMLSelectElement
}

describe('AgentDetailPage — runtime profile Runtime select', () => {
  beforeEach(() => {
    getMock.mockResolvedValue(AGENT)
    listVersionsMock.mockResolvedValue([VERSION])
    listRuntimeProfilesMock.mockResolvedValue([])
    listRuntimeAdaptersMock.mockResolvedValue({ items: CATALOG })
  })

  it('offers the API runtime plus every adapter in the catalog, registry agents included', async () => {
    const select = await openRuntimeTab()
    await screen.findByRole('option', { name: 'Cursor (acp_cursor)' })
    expect([...select.options].map(option => option.value)).toEqual(['model_api', 'claude_code', 'acp_cursor', 'opencode'])
  })

  it('takes provider support from the catalog row, not from the adapter name', async () => {
    const select = await openRuntimeTab()
    await screen.findByRole('option', { name: 'Cursor (acp_cursor)' })
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'acp_cursor' } })
    // A registry agent runs on its own login: no provider selector.
    expect(screen.queryByTestId('provider-selector')).toBeNull()
    fireEvent.change(select, { target: { value: 'opencode' } })
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
  })

  it('keeps a saved profile on a runtime that has left the catalog', async () => {
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Kilo', adapter_type: 'acp_kilo', runtime_config_json: {}, runtime_policy_json: {},
      model: null, enabled: true, is_default: true, execution_host_id: null, workspace_location_id: null, workspace_mode: null, runtime_installation: null,
    }])
    const select = await openRuntimeTab()
    await screen.findByRole('option', { name: 'Cursor (acp_cursor)' })
    expect(select.value).toBe('acp_kilo')
    expect(screen.getByRole('option', { name: 'acp_kilo (not in the runtime catalog)' })).toBeInTheDocument()
  })
})
