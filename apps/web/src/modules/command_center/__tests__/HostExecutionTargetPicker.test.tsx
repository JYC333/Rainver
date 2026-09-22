import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../HostExecutionTargetPicker'

const mockedApi = vi.hoisted(() => ({
  executionTargets: vi.fn(),
  listRuntimeDefinitions: vi.fn(),
  installRuntime: vi.fn(),
  loginStream: vi.fn(),
  loginInput: vi.fn(),
  serverRuntimeProvisioning: vi.fn(),
}))

vi.mock('../LoginTerminalView', () => import('../../../test/loginTerminalStandIn'))

vi.mock('../../../api/client', () => ({
  hostsApi: {
    executionTargets: mockedApi.executionTargets,
    listRuntimeDefinitions: mockedApi.listRuntimeDefinitions,
    installRuntime: mockedApi.installRuntime,
    loginStream: mockedApi.loginStream,
    loginInput: mockedApi.loginInput,
    serverRuntimeProvisioning: mockedApi.serverRuntimeProvisioning,
  },
}))

vi.mock('../../../core/spaceNav', () => ({
  SpaceLink: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}))

function Harness({ initialValue = null }: { initialValue?: HostExecutionSelection | null }) {
  const [value, setValue] = React.useState<HostExecutionSelection | null>(initialValue)
  return <HostExecutionTargetPicker projectId="project-1" value={value} onChange={setValue} />
}

function provisioning(overrides: Record<string, unknown> = {}) {
  return {
    host_id: 'server-host',
    runtime_key: 'opencode',
    installation: {
      state: 'ready', desired_version: '1.0.0', installed_version: '1.0.0',
      active_version: '1.0.0', error: null, attempts: 0, ...overrides,
    },
    native_account: { installation_id: 'managed:1.0.0', logged_in: true, accounts: null },
  }
}

const SERVER_TARGET = {
  host_id: 'server-host', host_name: 'Server Runtime', host_kind: 'server', host_online: true,
  managed_workspace_available: true, locations: [],
  runtimes: [{ runtime_key: 'opencode', display_name: 'OpenCode', installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true }] }],
}

function renderServerPicker() {
  return render(<HostExecutionTargetPicker
    projectId={null}
    backendMode="model_provider"
    value={{ host_id: 'server-host', workspace_location_id: null, workspace_mode: 'managed', runtime_key: 'opencode', installation: 'managed:1.0.0' }}
    onChange={() => undefined}
  />)
}

describe('HostExecutionTargetPicker', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.executionTargets.mockResolvedValue({
      targets: [{
        host_id: 'host-1',
        host_name: 'Workstation',
        host_kind: 'remote',
        host_online: true,
        locations: [{
          id: 'location-1',
          project_folder_id: 'folder-1',
          folder_name: 'Financial System',
          display_path: '/workspace/financial-system',
          execution_ready: true,
        }],
        runtimes: [{
          runtime_key: 'claude_code',
          display_name: 'Claude Code',
          installations: [{ id: 'own', version: '1.0.0', logged_in: false }],
        }],
        managed_workspace_available: true,
      }],
    })
    mockedApi.listRuntimeDefinitions.mockResolvedValue({ items: [{
      runtime_key: 'claude_code',
      display_name: 'Claude Code',
      command: 'claude',
      capability_probe: 'claude',
      remote_eligible: true,
      supports_runtime_native: true,
      supports_model_provider: false,
    }] })
    mockedApi.loginStream.mockImplementation(async function* () {
      yield { type: 'hint', text: 'Sign in in the terminal.' }
    })
    mockedApi.serverRuntimeProvisioning.mockResolvedValue(provisioning())
  })

  it('hides the Location select entirely in managed mode', async () => {
    mockedApi.executionTargets.mockResolvedValueOnce({
      targets: [{
        host_id: 'host-1', host_name: 'Workstation', host_kind: 'remote', host_online: true,
        managed_workspace_available: true, locations: [],
        runtimes: [{ runtime_key: 'claude_code', display_name: 'Claude Code', installations: [{ id: 'own', version: '1.0.0', logged_in: true }] }],
      }],
    })
    mockedApi.listRuntimeDefinitions.mockResolvedValueOnce({ items: [] })
    render(<HostExecutionTargetPicker projectId="" value={null} onChange={() => undefined} />)
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))
    expect(await screen.findByLabelText('Workspace mode')).toHaveTextContent('Managed workspace on this host')
    expect(screen.queryByLabelText('Execution Location')).not.toBeInTheDocument()
  })

  it('says why no host is offered: no Project yet, or no directory registered for it', async () => {
    const { rerender } = render(<HostExecutionTargetPicker projectId="" value={null} onChange={() => undefined} />)
    expect(screen.getByText(/Space-level managed workspace/)).toBeInTheDocument()
    expect(mockedApi.executionTargets).toHaveBeenCalledWith(null)

    mockedApi.executionTargets.mockResolvedValueOnce({ targets: [] })
    mockedApi.listRuntimeDefinitions.mockResolvedValueOnce({ items: [] })
    rerender(<HostExecutionTargetPicker projectId="project-2" value={null} onChange={() => undefined} />)
    expect(await screen.findByText(/has a directory registered for this Project/)).toBeInTheDocument()
  })

  it('selects a Project Location and exposes the host copy login flow', async () => {
    render(<Harness />)

    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))

    await waitFor(() => expect(screen.getByLabelText('Execution Location')).toHaveTextContent('Financial System'))
    expect(screen.getByText('Login required')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Login' }))
    expect(await screen.findByTestId('runtime-login-terminal')).toBeInTheDocument()
    expect(mockedApi.loginStream).toHaveBeenCalledWith('host-1', 'claude_code', 'own', null, expect.any(AbortSignal))
  })

  it('does not require a native login for a ModelProvider-backed Server Profile', async () => {
    mockedApi.executionTargets.mockResolvedValueOnce({
      targets: [{
        host_id: 'server-host', host_name: 'Server Runtime', host_kind: 'server', host_online: true,
        managed_workspace_available: true, locations: [],
        runtimes: [{ runtime_key: 'opencode', display_name: 'OpenCode', installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: false }] }],
      }],
    })
    mockedApi.listRuntimeDefinitions.mockResolvedValueOnce({ items: [] })
    render(<HostExecutionTargetPicker
      projectId={null}
      backendMode="model_provider"
      value={{ host_id: 'server-host', workspace_location_id: null, workspace_mode: 'managed', runtime_key: 'opencode', installation: 'managed:1.0.0' }}
      onChange={() => undefined}
    />)

    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('managed:1.0.0')
    expect(screen.queryByText('Login required')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Login' })).not.toBeInTheDocument()
  })

  it('offers Install when a paired host reports no copy of the chosen runtime', async () => {
    // The composer is where someone discovers the runtime is missing, so the
    // install has to be reachable from here rather than only from the Hosts page.
    mockedApi.executionTargets.mockResolvedValueOnce({
      targets: [{
        host_id: 'host-1', host_name: 'Workstation', host_kind: 'remote', host_online: true,
        managed_workspace_available: true, locations: [], runtimes: [],
      }],
    })
    mockedApi.installRuntime.mockResolvedValue({ ok: true, installation: 'managed:1.0.0', error: null })
    render(<Harness />)
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))

    expect(await screen.findByText('No copy of this runtime is installed on this host.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(mockedApi.installRuntime).toHaveBeenCalledWith('host-1', 'claude_code'))
  })

  it('keeps the Install path reachable when switching from a bound target to a host with no copy', async () => {
    // Choosing a host that has no copy emits `onChange(null)` — an incomplete
    // selection. A parent holding a previously bound value then re-renders
    // with `value = null`, and the draft sync must not read that as "clear the
    // host you just picked": doing so unmounted the Install block and put the
    // Server Runtime back in the host select, leaving no way to install.
    mockedApi.executionTargets.mockResolvedValue({
      targets: [
        {
          host_id: 'server-host', host_name: 'Server Runtime', host_kind: 'server', host_online: true,
          managed_workspace_available: true, locations: [],
          runtimes: [{ runtime_key: 'claude_code', display_name: 'Claude Code', installations: [{ id: 'managed:1.0.0', version: '1.0.0', logged_in: true }] }],
        },
        {
          host_id: 'host-b', host_name: 'Laptop', host_kind: 'remote', host_online: true,
          managed_workspace_available: true, locations: [], runtimes: [],
        },
      ],
    })
    mockedApi.installRuntime.mockResolvedValue({ ok: true, installation: 'managed:1.0.0', error: null })
    render(<Harness initialValue={{
      host_id: 'server-host', workspace_location_id: null, workspace_mode: 'managed',
      runtime_key: 'claude_code', installation: 'managed:1.0.0',
    }} />)

    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Laptop · online' }))

    expect(await screen.findByLabelText('Execution host')).toHaveTextContent('Laptop · online')
    expect(await screen.findByText('No copy of this runtime is installed on this host.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await waitFor(() => expect(mockedApi.installRuntime).toHaveBeenCalledWith('host-b', 'claude_code'))
  })

  it('says the Server Runtime is still installing rather than that a login is needed', async () => {
    // Plan "Default path" §3: while Rainver's provisioner is still working,
    // an Agent surface shows installing/failed/incompatible — never a login
    // prompt for a copy that does not exist yet.
    mockedApi.executionTargets.mockResolvedValue({ targets: [SERVER_TARGET] })
    mockedApi.serverRuntimeProvisioning.mockResolvedValue(provisioning({
      state: 'installing', installed_version: null, active_version: null,
    }))
    renderServerPicker()

    const note = await screen.findByTestId('server-runtime-provisioning')
    expect(note).toHaveTextContent('installing')
    expect(note).toHaveTextContent(/Rainver is installing the Server Runtime.s OpenCode copy \(1\.0\.0\)/)
    expect(screen.queryByText('Login required')).toBeNull()
  })

  it('shows a failed Server Runtime provisioning with its error and where to retry', async () => {
    mockedApi.executionTargets.mockResolvedValue({ targets: [SERVER_TARGET] })
    mockedApi.serverRuntimeProvisioning.mockResolvedValue(provisioning({
      state: 'failed', installed_version: null, active_version: null,
      error: 'npm registry unreachable', attempts: 3,
    }))
    renderServerPicker()

    const note = await screen.findByTestId('server-runtime-provisioning')
    expect(note).toHaveTextContent('failed')
    expect(note).toHaveTextContent('npm registry unreachable')
    expect(within(note).getByRole('link', { name: /retry provisioning/i })).toHaveAttribute('href', '/command-center')
  })

  it('stays quiet when the pinned Server Runtime copy is healthy', async () => {
    mockedApi.executionTargets.mockResolvedValue({ targets: [SERVER_TARGET] })
    renderServerPicker()

    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('managed:1.0.0')
    expect(screen.queryByTestId('server-runtime-provisioning')).toBeNull()
  })

  it("says a paired Host routes only its owner's own Runs, up to medium risk", async () => {
    // ROUTING.md "Effective trust": the owner's own Run on their paired Host
    // is `medium`, another member's stays at the `low` baseline, and nothing
    // reaches `high`. Offering the Host without saying so produced a Profile
    // that saved and then died `route_no_candidate`.
    render(<Harness />)
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))

    const note = await screen.findByText(/On a paired Host only its owner's own Runs route/)
    expect(note).toHaveTextContent(/up to medium risk/)
    expect(note).toHaveTextContent(/another member's Run and any high or critical risk Agent will not route here/)
  })

  it('does not put the paired-Host trust warning on the Server Runtime', async () => {
    mockedApi.executionTargets.mockResolvedValue({ targets: [SERVER_TARGET] })
    renderServerPicker()

    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('managed:1.0.0')
    expect(screen.queryByText(/On a paired Host only its owner's own Runs route/)).toBeNull()
  })

  it('offers a managed workspace without a Project Location', async () => {
    render(<HostExecutionTargetPicker projectId={null} value={null} onChange={() => undefined} />)
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))
    fireEvent.change(await screen.findByLabelText('Workspace mode'), { target: { value: 'managed' } })
    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('own')
  })
})
