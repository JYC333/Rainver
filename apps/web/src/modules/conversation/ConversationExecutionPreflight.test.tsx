import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsApi, roomsApi, sessionsApi } from '../../api/client'
import { ConversationExecutionPreflight } from './ConversationExecutionPreflight'
import type { ConversationExecutionPreflightResponse, RoomDetail } from '../../types/api'

vi.mock('../../api/client', () => ({
  agentsApi: { listRuntimeProfiles: vi.fn() },
  roomsApi: { get: vi.fn(), createConversation: vi.fn() },
  sessionsApi: { executionContext: vi.fn(), initializeExecution: vi.fn(), mutateExecutionAttachments: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user-1' }) }))

const host = {
  host_id: 'host-1', host_name: 'Laptop', host_kind: 'remote', online: true,
  managed_workspace_available: true, daemon_last_heartbeat_at: null,
}
const detail = {
  room: { id: 'room-1', project_id: 'project-1' },
  agent_members: [{ role: 'manager', agent_id: 'agent-1', agent_name: 'Project Agent' }],
} as unknown as RoomDetail
const profile = {
  id: 'runtime-1', space_id: 'space-1', agent_id: 'agent-1', name: 'Claude on Laptop',
  adapter_type: 'claude_cli', execution_host_id: 'host-1', workspace_location_id: null,
  workspace_mode: 'managed', runtime_installation: 'claude', model: null,
  runtime_config_json: {}, runtime_policy_json: {}, enabled: true, is_default: true,
  created_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z',
}

function draftResponse(
  locations: ConversationExecutionPreflightResponse['available_primary_locations'] = [],
): ConversationExecutionPreflightResponse {
  return {
    summary: {
      session_id: 'session-1', state: 'draft', host, runtime: null, runtimes: [],
      primary: null, attachments: [], dispatch_locked: false, queue_paused_at: null,
      can_send: false, blocked_reason: 'Choose a CLI installation',
    },
    available_hosts: [host],
    available_runtime_profiles: [{
      agent_id: profile.agent_id,
      agent_name: profile.name,
      runtime_profile_id: profile.id,
      adapter_type: profile.adapter_type,
      runtime_installation: profile.runtime_installation,
      execution_host_id: profile.execution_host_id,
      workspace_mode: profile.workspace_mode as 'managed',
      workspace_location_id: profile.workspace_location_id,
      preferred: true,
      usable: true,
      reason: null,
    }],
    available_primary_locations: locations,
  }
}

function initializedResponse(online = true) {
  return {
    summary: {
      session_id: 'session-1', state: 'initialized',
      host: { ...host, online },
      runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', credential_profile_id: null, adapter_type: 'claude_cli', runtime_installation: 'claude' },
      runtimes: [
        { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', credential_profile_id: null, adapter_type: 'claude_cli', runtime_installation: 'claude' },
      ],
      primary: { kind: 'managed', managed_workspace_id: 'session-1', display_path: null },
      attachments: [], dispatch_locked: false, queue_paused_at: null,
      can_send: online, blocked_reason: online ? null : 'Execution Host is offline; reconnect it before sending',
    },
    available_hosts: [host], available_runtime_profiles: [{
      agent_id: profile.agent_id,
      agent_name: profile.name,
      runtime_profile_id: profile.id,
      adapter_type: profile.adapter_type,
      runtime_installation: profile.runtime_installation,
      execution_host_id: profile.execution_host_id,
      workspace_mode: profile.workspace_mode,
      workspace_location_id: profile.workspace_location_id,
      preferred: true,
      usable: online,
      reason: online ? null : 'The execution Host is offline',
    }], available_primary_locations: [{
      workspace_location_id: 'location-2', project_folder_id: 'folder-2', folder_name: 'Docs',
      execution_host_id: 'host-1', display_path: '/work/docs', execution_ready: true,
    }],
  }
}

function renderPanel(sessionId: string | null = 'session-1', onReadyChange = vi.fn(), detailOverride = detail) {
  return render(<MemoryRouter><ConversationExecutionPreflight
    projectId="project-1" roomId="room-1" sessionId={sessionId} detail={detailOverride} onReadyChange={onReadyChange}
  /></MemoryRouter>)
}

describe('ConversationExecutionPreflight', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(roomsApi.get).mockResolvedValue(detail)
    vi.mocked(agentsApi.listRuntimeProfiles).mockResolvedValue([profile] as never)
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(draftResponse() as never)
    vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
    vi.mocked(sessionsApi.mutateExecutionAttachments).mockResolvedValue({} as never)
  })

  it('opens an explicit draft and visibly preselects a sole managed Host/CLI', async () => {
    vi.mocked(roomsApi.createConversation).mockResolvedValue({ id: 'session-1' } as never)
    renderPanel(null)
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1'))
  })

  it('initializes a draft with the visible Host, managed Primary and CLI', async () => {
    const response = draftResponse()
    response.available_runtime_profiles.push({
      ...response.available_runtime_profiles[0]!,
      runtime_profile_id: null,
      adapter_type: 'codex_cli',
      runtime_installation: 'codex',
      preferred: false,
    })
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
    renderPanel()
    expect(await screen.findByText('Review before the first Run.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execution Host' })).toHaveTextContent('Laptop'))
    expect(screen.getByRole('button', { name: 'Primary workspace (cwd)' })).toHaveTextContent('Managed workspace')
    // The fallback is said out loud: with no Folder connected the Agent works
    // in a managed workspace, not in this Project's code, and the only place
    // to change that is Files & Code.
    expect(screen.getByTestId('preflight-no-folder')).toHaveTextContent('no Folder connected')
    expect(screen.getByRole('link', { name: 'Connect a Folder' })).toHaveAttribute('href', expect.stringContaining('/projects/project-1/files?setup=folder'))
    expect(screen.getByRole('button', { name: 'CLI installation' })).toHaveTextContent('Claude on Laptop')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm execution context' }))
    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledWith('session-1', {
      selection: { execution_host_id: 'host-1', primary: { kind: 'managed' } },
      runtime: {
        agent_id: 'agent-1', runtime_profile_id: 'runtime-1', credential_profile_id: null,
        adapter_type: 'claude_cli', runtime_installation: 'claude',
      },
    }))
  })

  it('uses a CLI detected on the selected Host without requiring a pre-created runtime profile', async () => {
    const location = {
      workspace_location_id: 'location-1', project_folder_id: 'folder-1', folder_name: 'Source',
      execution_host_id: 'host-1', display_path: '/work/source', execution_ready: true,
    }
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      ...draftResponse([location]),
      available_runtime_profiles: [{
        ...draftResponse().available_runtime_profiles[0],
        runtime_profile_id: null,
        workspace_mode: 'location',
        workspace_location_id: 'location-1',
      }],
    } as never)
    renderPanel()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Execution Host' })).toHaveTextContent('Laptop'))
    expect(screen.getByRole('button', { name: 'Primary workspace (cwd)' })).toHaveTextContent('Source')
    expect(screen.getByRole('button', { name: 'CLI installation' })).toHaveTextContent(/detected on Host/)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm execution context' }))
    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledWith('session-1', {
      selection: { execution_host_id: 'host-1', primary: { kind: 'location', workspace_location_id: 'location-1' } },
      runtime: {
        agent_id: 'agent-1', runtime_profile_id: null, credential_profile_id: null,
        adapter_type: 'claude_cli', runtime_installation: 'claude',
      },
    }))
  })

  it('leaves the Primary choice explicit when several Folders are available', async () => {
    const locations = [
      { workspace_location_id: 'location-a', project_folder_id: 'folder-a', folder_name: 'Source', execution_host_id: 'host-1', display_path: '/work/source', execution_ready: true },
      { workspace_location_id: 'location-b', project_folder_id: 'folder-b', folder_name: 'Docs', execution_host_id: 'host-1', display_path: '/work/docs', execution_ready: true },
    ]
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(draftResponse(locations) as never)
    vi.mocked(agentsApi.listRuntimeProfiles).mockResolvedValue([profile, {
      ...profile, id: 'runtime-source', name: 'Claude on Source', workspace_mode: 'location', workspace_location_id: 'location-a',
    }, {
      ...profile, id: 'runtime-docs', name: 'Claude on Docs', workspace_mode: 'location', workspace_location_id: 'location-b',
    }] as never)
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execution Host' })).toHaveTextContent('Laptop'))
    expect(screen.getByRole('button', { name: 'Primary workspace (cwd)' })).toHaveTextContent('Choose managed or a Folder')
    expect(screen.getByRole('button', { name: 'Confirm execution context' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Primary workspace (cwd)' }))
    expect(screen.getByRole('option', { name: /Source/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Docs/ })).toBeInTheDocument()
    expect(screen.queryByTestId('preflight-no-folder')).toBeNull()
  })

  it('requires and submits an explicit CLI for every participating Agent', async () => {
    const multiDetail = {
      ...detail,
      agent_members: [
        { role: 'manager', agent_id: 'agent-1', agent_name: 'Project Agent' },
        { role: 'specialist', agent_id: 'agent-2', agent_name: 'Research Agent' },
      ],
    } as unknown as RoomDetail
    const specialistProfile = {
      ...profile,
      id: 'runtime-research',
      agent_id: 'agent-2',
      name: 'Research CLI on Laptop',
    }
    const specialistBackup = {
      ...specialistProfile,
      id: 'runtime-research-backup',
      name: 'Research Codex on Laptop',
      adapter_type: 'codex_cli',
      runtime_installation: 'codex',
    }
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      ...draftResponse(),
      available_runtime_profiles: [
        { ...draftResponse().available_runtime_profiles[0], agent_id: 'agent-1' },
        { ...draftResponse().available_runtime_profiles[0], ...specialistProfile, agent_name: 'Research Agent', runtime_profile_id: specialistProfile.id },
        { ...draftResponse().available_runtime_profiles[0], ...specialistBackup, agent_name: 'Research Agent', runtime_profile_id: specialistBackup.id },
      ],
    } as never)
    renderPanel('session-1', vi.fn(), multiDetail)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Execution Host' })).toHaveTextContent('Laptop')
      expect(screen.getByRole('button', { name: 'Primary workspace (cwd)' })).toHaveTextContent('Managed workspace')
      expect(screen.getByRole('button', { name: 'CLI installation for Research Agent' })).toHaveTextContent('Choose a CLI installation')
    })
    fireEvent.click(screen.getByRole('button', { name: 'CLI installation for Research Agent' }))
    fireEvent.click(screen.getByRole('option', { name: /codex_cli/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm execution context' }))
    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledWith('session-1', expect.objectContaining({
      additional_runtimes: [{
        agent_id: 'agent-2', runtime_profile_id: 'runtime-research-backup', credential_profile_id: null,
        adapter_type: 'codex_cli', runtime_installation: 'codex',
      }],
    })))
  })

  it('blocks a draft with no reported CLI and keeps the Host recovery action visible', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      ...draftResponse(), available_runtime_profiles: [],
    } as never)
    renderPanel()
    expect(await screen.findByText(/reports no usable CLI installation/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm execution context' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Configure or reconnect Host' })).toHaveAttribute('href', '/command-center')
  })

  it('explains an offline Host as a daemon issue, not a browser issue', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse(false) as never)
    renderPanel()
    expect(await screen.findByText(/browser is still online/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Reconnect Host' })).toHaveAttribute('href', '/command-center')
    expect(screen.getByText(/Execution Host is offline/)).toBeInTheDocument()
  })

  it('collapses a healthy initialized execution context until the user asks for details', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse() as never)
    renderPanel()

    const disclosure = await screen.findByRole('button', { name: 'Execution context configured' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Primary cwd')).not.toBeInTheDocument()

    fireEvent.click(disclosure)
    expect(screen.getByText('Primary cwd')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse execution context' }))
    expect(screen.queryByText('Primary cwd')).not.toBeInTheDocument()
  })

  it('uses the participant name when the pinned profile is temporarily absent from the selectable catalog', async () => {
    const response = initializedResponse() as ConversationExecutionPreflightResponse
    response.available_runtime_profiles = []
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Execution context configured' }))
    expect(screen.getByText('Project Agent')).toBeInTheDocument()
    expect(screen.queryByText('agent-1')).not.toBeInTheDocument()
  })

  it('changes attachment access explicitly and keeps cwd unchanged', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse() as never)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'Execution context configured' }))
    const attach = await screen.findByText('Attached Folders')
    expect(attach).toBeInTheDocument()
    const folder = screen.getByRole('button', { name: 'Folder' })
    fireEvent.click(folder)
    fireEvent.click(screen.getByRole('option', { name: /Docs/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    await waitFor(() => expect(sessionsApi.mutateExecutionAttachments).toHaveBeenCalledWith('session-1', expect.objectContaining({
      action: 'attach', project_folder_id: 'folder-2', workspace_location_id: 'location-2', access_mode: 'read',
    })))
    expect(screen.getByText('Primary cwd')).toBeInTheDocument()
  })

  it('presents server-host attachments as read-only', async () => {
    const response = initializedResponse() as ConversationExecutionPreflightResponse
    response.summary.host = { ...host, host_kind: 'server' }
    response.summary.attachments = [{
      id: 'attachment-1', project_folder_id: 'folder-3', workspace_location_id: 'location-3',
      folder_name: 'Source', display_path: '/work/source', access_mode: 'read', status: 'active',
      granted_by_user_id: 'user-1', granted_at: '2026-08-31T00:00:00.000Z',
      updated_at: '2026-08-31T00:00:00.000Z', revoked_at: null,
    }]
    vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
    renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Execution context configured' }))
    expect(await screen.findByText(/Server-host attachments are read-only/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grant write' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Access' })).toHaveTextContent('Read')
  })
})
