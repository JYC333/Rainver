import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentOut, AgentVersionOut } from '../types/api'

// The runtime profile form used to hard-code three runtimes. It reads the
// live adapter catalog now, so an enabled ACP registry agent and OpenCode are
// as selectable as the two it used to know about, and what a runtime supports
// comes from the catalog row rather than from its name.
const { getMock, listVersionsMock, listRuntimeProfilesMock, listRuntimeDefinitionsMock, executionTargetsMock, updateRuntimeProfileMock, createRuntimeProfileMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  listVersionsMock: vi.fn(),
  listRuntimeProfilesMock: vi.fn(),
  listRuntimeDefinitionsMock: vi.fn(),
  executionTargetsMock: vi.fn(),
  updateRuntimeProfileMock: vi.fn(),
  createRuntimeProfileMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  agentsApi: {
    get: getMock,
    update: vi.fn(),
    updateConfig: vi.fn(),
    listVersions: listVersionsMock,
    listRunsForAgent: vi.fn(async () => []),
    listRuntimeProfiles: listRuntimeProfilesMock,
    updateRuntimeProfile: updateRuntimeProfileMock,
    createRuntimeProfile: createRuntimeProfileMock,
    listProposals: vi.fn(async () => []),
  },
  hostsApi: {
    list: vi.fn(async () => ({ items: [
      {
        id: 'host-server', owner_user_id: null, name: 'Server Runtime', kind: 'server', status: 'online',
        last_heartbeat_at: null, platform: 'linux', arch: 'x64', daemon_version: '1',
        capabilities_json: null, created_at: '', updated_at: '',
      },
      {
        id: 'host-laptop', owner_user_id: 'u1', name: 'Laptop', kind: 'remote', status: 'online',
        last_heartbeat_at: null, platform: 'linux', arch: 'x64', daemon_version: '1',
        capabilities_json: null, created_at: '', updated_at: '',
      },
    ] })),
    listRuntimeDefinitions: listRuntimeDefinitionsMock,
    executionTargets: executionTargetsMock,
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
  runtime_key: 'opencode',
  system_prompt: null, created_at: '', updated_at: '',
}
const VERSION = {
  id: 'v1', agent_id: 'a1', space_id: 's1', version_label: 'v1',
  system_prompt: null, prompt_provenance_json: null,
  context_policy_json: {}, memory_policy_json: {}, capabilities_json: [], tool_permissions_json: {},
  tool_policy_json: {}, output_policy_json: {}, schedule_config_json: {},
  output_schema_json: {}, source_proposal_id: null, source_activity_id: null, created_at: '',
} as unknown as AgentVersionOut

// The registry's own answer: only OpenCode's contract admits a Rainver
// ModelProvider binding, and the server answers 422 for anything else.
const CATALOG = [
  { runtime_key: 'claude_code', display_name: 'Claude Code', command: 'claude-agent-acp', capability_probe: 'claude', remote_eligible: true, supports_runtime_native: true, supports_model_provider: false, provider_api: 'claude_compatible' as const },
  { runtime_key: 'opencode', display_name: 'OpenCode', command: 'opencode', capability_probe: 'opencode', remote_eligible: true, supports_runtime_native: true, supports_model_provider: true, provider_api: null },
  { runtime_key: 'acp_cursor', display_name: 'Cursor', command: 'acp_cursor', capability_probe: 'acp_cursor', remote_eligible: false, supports_runtime_native: true, supports_model_provider: false, provider_api: null },
]

async function openRuntimeTab(selectServerHost = true) {
  render(<AgentDetailPage />)
  // Radix tabs switch on pointer events, not a synthetic click.
  await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
  if (selectServerHost) {
    await userEvent.click(await screen.findByRole('button', { name: 'Execution host' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Server Runtime · online' }))
  }
  const runtimeSelect = await screen.findByRole('button', { name: 'Runtime' })
  await waitFor(() => expect(runtimeSelect).toBeEnabled())
  await userEvent.click(runtimeSelect)
}

describe('AgentDetailPage — runtime profile Runtime select', () => {
  beforeEach(() => {
    getMock.mockResolvedValue(AGENT)
    listVersionsMock.mockResolvedValue([VERSION])
    listRuntimeProfilesMock.mockResolvedValue([])
    listRuntimeDefinitionsMock.mockResolvedValue({ items: CATALOG })
    updateRuntimeProfileMock.mockReset()
    updateRuntimeProfileMock.mockResolvedValue({})
    createRuntimeProfileMock.mockReset()
    createRuntimeProfileMock.mockResolvedValue({})
    executionTargetsMock.mockResolvedValue({ targets: [{
      host_id: 'host-server', host_name: 'Server Runtime', host_kind: 'server', host_online: true,
      locations: [], managed_workspace_available: true,
      runtimes: CATALOG.map(runtime => ({
        runtime_key: runtime.runtime_key,
        display_name: runtime.display_name,
        installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true }],
      })),
    }] })
  })

  it('offers ACP runtimes from the catalog, registry agents included', async () => {
    await openRuntimeTab()
    expect(await screen.findByRole('option', { name: 'Claude Code' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Cursor' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'OpenCode' })).toBeInTheDocument()
  })

  it('offers provider mode only for catalog runtimes that support it', async () => {
    await openRuntimeTab()
    expect(await screen.findByRole('option', { name: 'Cursor' })).toBeInTheDocument()
    // OpenCode is the one runtime whose contract admits a Provider binding.
    await userEvent.click(screen.getByRole('option', { name: 'OpenCode' }))
    expect(screen.getByRole('button', { name: 'Backend mode' })).toBeInTheDocument()
    expect(screen.queryByTestId('provider-selector')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Backend mode' }))
    await userEvent.click(screen.getByRole('option', { name: 'Rainver ModelProvider proxy' }))
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Runtime' }))
    await userEvent.click(screen.getByRole('option', { name: 'Cursor' }))
    // A registry agent runs on its own login: no provider selector.
    expect(screen.queryByTestId('provider-selector')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Backend mode' })).toBeNull()
  })

  it('keeps ModelProvider mode when the execution target is a paired Host', async () => {
    // A paired Host is handed a short-lived proxy lease address, never a key
    // (AGENT_RUNTIME_AUTHORITY, "Paired Host path"), so admission accepts
    // `model_provider` on either Host kind and only refuses an *unbound*
    // Profile. The composer used to force the binding back to native here.
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Proxied', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
      backend_mode: 'model_provider', model: { provider_id: 'prov-1', model: 'gpt-4o' },
      provider_binding: { state: 'bound', provider_id: 'prov-1', model: 'gpt-4o' },
      enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
      workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
    }])
    const runtimes = [{
      runtime_key: 'opencode', display_name: 'OpenCode',
      installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true }],
    }]
    executionTargetsMock.mockResolvedValue({ targets: [
      { host_id: 'host-server', host_name: 'Server Runtime', host_kind: 'server', host_online: true, locations: [], managed_workspace_available: true, runtimes },
      { host_id: 'host-laptop', host_name: 'Laptop', host_kind: 'remote', host_online: true, locations: [], managed_workspace_available: true, runtimes },
    ] })

    render(<AgentDetailPage />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Execution host' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Laptop · online' }))

    expect(await screen.findByRole('button', { name: 'Backend mode' })).toHaveTextContent('Rainver ModelProvider proxy')
    expect(screen.queryByText(/switched back to runtime-native mode/i)).toBeNull()
    expect(screen.getByTestId('provider-selector')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Save runtime profile' }))
    await waitFor(() => expect(updateRuntimeProfileMock).toHaveBeenCalledWith('a1', 'p1', expect.objectContaining({
      backend_mode: 'model_provider',
      execution_host_id: 'host-laptop',
      model_provider_id: 'prov-1',
      model_name: 'gpt-4o',
    })))
  })

  it('does not offer ModelProvider mode for a runtime whose contract refuses it', async () => {
    // claude_code is `cli_profile` only: the server answers `model_provider`
    // with 422, so the composer must not present it as a choice at all.
    await openRuntimeTab()
    await userEvent.click(await screen.findByRole('option', { name: 'Claude Code' }))
    expect(screen.queryByRole('button', { name: 'Backend mode' })).toBeNull()
    expect(screen.queryByTestId('provider-selector')).toBeNull()
  })

  it('keeps the way out of provider mode when the runtime catalog fails to load', async () => {
    // Without the catalog every backend-mode control used to disappear while
    // the Profile still claimed provider mode, so save() could only ever fail.
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Proxied', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
      backend_mode: 'model_provider', model: { provider_id: 'prov-1', model: 'gpt-4o' },
      provider_binding: { state: 'bound', provider_id: 'prov-1', model: 'gpt-4o' },
      enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
      workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
    }])
    listRuntimeDefinitionsMock.mockRejectedValue(new Error('catalog offline'))
    render(<AgentDetailPage />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))

    expect(await screen.findByText(/runtime catalog could not be loaded/i)).toBeInTheDocument()
    expect(screen.getByText(/Switch this Profile back to the runtime native account/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Backend mode' }))
    await userEvent.click(screen.getByRole('option', { name: 'Runtime native account' }))

    await userEvent.click(screen.getByRole('button', { name: 'Save runtime profile' }))
    await waitFor(() => expect(updateRuntimeProfileMock).toHaveBeenCalledWith('a1', 'p1', expect.objectContaining({
      backend_mode: 'runtime_native',
      model_provider_id: null,
      model_name: null,
    })))
  })

  it('reads the Profile\u2019s own provider binding for the saved backend', async () => {
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Proxied', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
      backend_mode: 'model_provider', model: null,
      provider_binding: { state: 'bound', provider_id: 'prov-1', model: 'gpt-4o' },
      enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
      workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
    }])
    render(<AgentDetailPage />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
    expect(await screen.findByText(/Saved provider binding: prov-1 · gpt-4o/)).toBeInTheDocument()
  })

  it('starts a new Profile from the default Profile, not from the one on screen', async () => {
    // "New profile" clears the Profile selection, and the reset effect keyed on
    // that selection fires on the same transition. While the defaults lived in
    // the click handler the effect overwrote every one of them: the name went
    // back to the previous Profile's, the execution target went to null, and
    // the picker — which ignores a null value — kept showing the Host of the
    // Profile that was open. Save then refused a form that looked configured.
    const runtimes = [{
      runtime_key: 'opencode', display_name: 'OpenCode',
      installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true }],
    }]
    listRuntimeProfilesMock.mockResolvedValue([
      {
        id: 'p1', agent_id: 'a1', name: 'Server default', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
        backend_mode: 'runtime_native', model: null, provider_binding: null,
        enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
        workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
      },
      {
        id: 'p2', agent_id: 'a1', name: 'Laptop', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
        backend_mode: 'runtime_native', model: null, provider_binding: null,
        enabled: true, is_default: false, execution_host_id: 'host-laptop', workspace_location_id: null,
        workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
      },
    ])
    executionTargetsMock.mockResolvedValue({ targets: [
      { host_id: 'host-server', host_name: 'Server Runtime', host_kind: 'server', host_online: true, locations: [], managed_workspace_available: true, runtimes },
      { host_id: 'host-laptop', host_name: 'Laptop', host_kind: 'remote', host_online: true, locations: [], managed_workspace_available: true, runtimes },
    ] })

    render(<AgentDetailPage />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    await userEvent.click(await screen.findByRole('option', { name: /Laptop · opencode/ }))
    expect(await screen.findByRole('button', { name: 'Execution host' })).toHaveTextContent('Laptop · online')

    await userEvent.click(screen.getByRole('button', { name: 'New profile' }))

    expect(screen.getByPlaceholderText('Default')).toHaveValue('New runtime profile')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execution host' })).toHaveTextContent('Server Runtime · online'))

    await userEvent.click(screen.getByRole('button', { name: 'Save runtime profile' }))
    await waitFor(() => expect(createRuntimeProfileMock).toHaveBeenCalledWith('a1', expect.objectContaining({
      name: 'New runtime profile',
      runtime_key: 'opencode',
      backend_mode: 'runtime_native',
      execution_host_id: 'host-server',
      workspace_mode: 'managed',
      runtime_installation: 'managed:1.0.0',
      is_default: false,
    })))
    expect(updateRuntimeProfileMock).not.toHaveBeenCalled()
  })

  it('waits for the runtime catalog before saying a runtime refuses ModelProvider mode', async () => {
    // `cliAdapters` starts empty, and an empty catalog used to be read as
    // "this runtime does not support a Provider binding": every open of a
    // `model_provider` Profile flashed that alert until the first answer
    // landed. Not-yet-asked and answered-no are different facts.
    let resolveCatalog: ((value: { items: typeof CATALOG }) => void) | null = null
    listRuntimeDefinitionsMock.mockReturnValue(new Promise(resolve => { resolveCatalog = resolve }))
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Proxied', runtime_key: 'opencode', runtime_config_json: {}, runtime_policy_json: {},
      backend_mode: 'model_provider', model: { provider_id: 'prov-1', model: 'gpt-4o' },
      provider_binding: { state: 'bound', provider_id: 'prov-1', model: 'gpt-4o' },
      enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
      workspace_mode: 'managed', runtime_installation: 'managed:1.0.0',
    }])

    render(<AgentDetailPage />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Runtime' }))
    expect(await screen.findByRole('button', { name: 'Backend mode' })).toHaveTextContent('Rainver ModelProvider proxy')
    expect(screen.queryByText(/does not support a Rainver ModelProvider binding/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()

    resolveCatalog!({ items: CATALOG })
    expect(await screen.findByTestId('provider-selector')).toBeInTheDocument()
    expect(screen.queryByText(/does not support a Rainver ModelProvider binding/)).toBeNull()
  })

  it('keeps a saved profile on a runtime that has left the catalog', async () => {
    listRuntimeProfilesMock.mockResolvedValue([{
      id: 'p1', agent_id: 'a1', name: 'Kilo', runtime_key: 'acp_kilo', runtime_config_json: {}, runtime_policy_json: {},
      model: null, enabled: true, is_default: true, execution_host_id: 'host-server', workspace_location_id: null,
      workspace_mode: 'managed', runtime_installation: 'managed:2.0.0',
    }])
    await openRuntimeTab(false)
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Profile' }))
    await userEvent.click(screen.getByRole('option', { name: /Kilo · default · acp_kilo/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Runtime' }))
    expect(await screen.findByRole('option', { name: 'acp_kilo (not in runtime catalog)' })).toBeInTheDocument()
  })
})
