import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import HostExecutionTargetPicker, { type HostExecutionSelection } from '../HostExecutionTargetPicker'

const mockedApi = vi.hoisted(() => ({
  executionTargets: vi.fn(),
  listRuntimeAdapters: vi.fn(),
  installRuntime: vi.fn(),
  loginStream: vi.fn(),
  loginInput: vi.fn(),
}))

vi.mock('../../../api/client', () => ({
  hostsApi: {
    executionTargets: mockedApi.executionTargets,
    listRuntimeAdapters: mockedApi.listRuntimeAdapters,
    installRuntime: mockedApi.installRuntime,
    loginStream: mockedApi.loginStream,
    loginInput: mockedApi.loginInput,
  },
}))

function Harness() {
  const [value, setValue] = React.useState<HostExecutionSelection | null>(null)
  return <HostExecutionTargetPicker projectId="project-1" value={value} onChange={setValue} />
}

describe('HostExecutionTargetPicker', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockedApi.executionTargets.mockResolvedValue({
      targets: [{
        host_id: 'host-1',
        host_name: 'Workstation',
        host_online: true,
        locations: [{
          id: 'location-1',
          project_folder_id: 'folder-1',
          folder_name: 'Financial System',
          display_path: '/workspace/financial-system',
          execution_ready: true,
        }],
        adapters: [{
          adapter_type: 'claude_code',
          display_name: 'Claude Code',
          installations: [{ id: 'own', version: '1.0.0', logged_in: false }],
        }],
        managed_workspace_available: true,
      }],
    })
    mockedApi.listRuntimeAdapters.mockResolvedValue({ items: [{
      adapter_type: 'claude_code',
      display_name: 'Claude Code',
      command: 'claude',
      capability_probe: 'claude',
      remote_eligible: true,
    }] })
    mockedApi.loginStream.mockImplementation(async function* () {
      yield { type: 'hint', text: 'Sign in in the terminal.' }
    })
  })

  it('hides the Location select entirely in managed mode', async () => {
    mockedApi.executionTargets.mockResolvedValueOnce({
      targets: [{
        host_id: 'host-1', host_name: 'Workstation', host_online: true,
        managed_workspace_available: true, locations: [],
        adapters: [{ adapter_type: 'claude_code', display_name: 'Claude Code', installations: [{ id: 'own', version: '1.0.0', logged_in: true }] }],
      }],
    })
    mockedApi.listRuntimeAdapters.mockResolvedValueOnce({ items: [] })
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
    mockedApi.listRuntimeAdapters.mockResolvedValueOnce({ items: [] })
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
    expect(mockedApi.loginStream).toHaveBeenCalledWith('host-1', 'claude_code', 'own')
  })

  it('offers a managed workspace without a Project Location', async () => {
    render(<HostExecutionTargetPicker projectId={null} value={null} onChange={() => undefined} />)
    fireEvent.click(await screen.findByLabelText('Execution host'))
    fireEvent.click(screen.getByRole('option', { name: 'Workstation · online' }))
    fireEvent.change(await screen.findByLabelText('Workspace mode'), { target: { value: 'managed' } })
    expect(await screen.findByLabelText('Runtime installation')).toHaveTextContent('own')
  })
})
