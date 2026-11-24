import React from "react"
import {SESSION_OPERATION_SCHEMAS} from '@rainver/protocol'
import { ConversationScope } from './ConversationScope'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, it, vi } from 'vitest'
import { roomsApi, sessionsApi } from '../../api/client'
import { ConversationExecutionPreflight, ConversationExecutionPreflightContent } from './ConversationExecutionPreflight'
import type { ConversationExecutionPreflightResponse, RoomDetail } from '../../types/api'

vi.mock('../../api/client', () => ({
  agentsApi: { listRuntimeProfiles: vi.fn() },
  roomsApi: { get: vi.fn(), createConversation: vi.fn(), resetAgentContext: vi.fn() },
  sessionsApi: { executionContext: vi.fn(), initializeExecution: vi.fn(), mutateExecutionAttachments: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user-1' }) }))

const host = {
  host_id: 'host-1', host_name: 'Laptop', host_kind: 'remote', online: true,
  managed_workspace_available: true, daemon_last_heartbeat_at: null,
}
const detail = {
  viewer_can_write: true,
  room: { id: 'room-1', project_id: 'project-1' },
  agent_members: [{ role: 'manager', agent_id: 'agent-1', agent_name: 'Project Agent' }],
} as unknown as RoomDetail
const profile = {
  id: 'runtime-1', space_id: 'space-1', agent_id: 'agent-1', name: 'Claude on Laptop',
  runtime_key: 'claude_cli', execution_host_id: 'host-1', workspace_location_id: null,
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
      runtime_key: profile.runtime_key,
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
      runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude_cli', runtime_installation: 'claude' },
      runtimes: [
        { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude_cli', runtime_installation: 'claude' },
      ],
      primary: { kind: 'managed', managed_workspace_id: 'session-1', display_path: null },
      attachments: [], dispatch_locked: false, queue_paused_at: null,
      can_send: online, blocked_reason: online ? null : 'Execution Host is offline; reconnect it before sending',
    },
    available_hosts: [host], available_runtime_profiles: [{
      agent_id: profile.agent_id,
      agent_name: profile.name,
      runtime_profile_id: profile.id,
      runtime_key: profile.runtime_key,
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

function panel(props: Partial<React.ComponentProps<typeof ConversationExecutionPreflight>> = {}) {
  return render(<MemoryRouter><ConversationScope spaceId="space-b"><ConversationExecutionPreflight
    projectId="project-1" roomId="room-1" sessionId="session-1" detail={detail} {...props} /></ConversationScope></MemoryRouter>)
}
async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: /Conversation settings ·/ }))
}
async function environment() {
  await openSettings()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runtime environment' }), { button: 0, ctrlKey: false })
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(roomsApi.get).mockResolvedValue(detail)
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(draftResponse())
  vi.mocked(sessionsApi.initializeExecution).mockResolvedValue({} as never)
})
it('loads readiness while closed and exposes only one compact settings entry', async () => {
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse() as never)
  const ready = vi.fn()
  panel({ onReadyChange: ready })
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  expect(screen.queryByText('Working folder')).not.toBeInTheDocument()
  await openSettings()
  expect(screen.getByText('Project Agent')).toBeVisible()
  expect(screen.queryByText('Execution Context')).not.toBeInTheDocument()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runtime environment' }), { button: 0 })
  expect(await screen.findByText('Working folder')).toBeVisible()
  expect(screen.queryByText(/Host and primary directory are fixed/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Edit participants' })).not.toBeInTheDocument()
})
it('initializes a unique compatible CLI with strict four-field runtime in the source Space', async () => {
  panel()
  await environment()
  const confirm = await screen.findByRole('button', { name: 'Confirm execution context' })
  await waitFor(() => expect(confirm).toBeEnabled())
  expect(screen.queryByRole('button', { name: 'CLI installation' })).not.toBeInTheDocument()
  fireEvent.click(confirm)
  await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
  const [id, body, scope] = vi.mocked(sessionsApi.initializeExecution).mock.calls[0]!
  expect(scope).toEqual(expect.objectContaining({spaceId:'space-b'}))
  expect(body.runtime).toEqual({agent_id:'agent-1',runtime_profile_id:'runtime-1',runtime_key:'claude_cli',runtime_installation:'claude'})
  SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:id,...body})
})
it('displays the configured runtime and ignores raw Host installations', async () => {
  const response=draftResponse()
  response.available_runtime_profiles.push({...response.available_runtime_profiles[0]!,runtime_profile_id:null,runtime_key:'codex_cli',runtime_installation:'codex',preferred:false})
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
  panel();await environment()
  expect(await screen.findByText('claude_cli · claude')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'CLI installation' })).not.toBeInTheDocument()
  expect(screen.queryByText(/codex_cli/)).not.toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Runtime settings' })).toHaveAttribute('href', '/spaces/space-b/projects/project-1?settings=runtime')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm execution context' }))
  await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
  expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].runtime.runtime_profile_id).toBe('runtime-1')
})
it('uses the selected Files Folder with a runtime that defaults to a managed workspace', async () => {
  const response=draftResponse([{workspace_location_id:'loc',project_folder_id:'folder',folder_name:'Source',execution_host_id:'host-1',display_path:'/code',execution_ready:true}])
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
  panel({preferredProjectFolderId:'folder'});await environment()
  await waitFor(()=>expect(screen.getByRole('button',{name:'Working folder'})).toHaveTextContent('Source'))
  fireEvent.click(screen.getByRole('button',{name:'Confirm execution context'}))
  await waitFor(()=>expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
  expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].selection.primary).toEqual({kind:'location',workspace_location_id:'loc'})
  expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].runtime.runtime_profile_id).toBe('runtime-1')
})
it('takes Room defaults into a draft, searches candidates only after Add, and reports an explicit roster', async () => {
  const roster={...detail,room:{...detail.room,conversation_defaults_json:[{agent_id:'optional',participating:false,runtime_profile_id:null,session_config:[]}]},agent_members:[...detail.agent_members,{agent_id:'optional',agent_name:'Codex',role:'member'}]} as RoomDetail
  const changed=vi.fn();panel({detail:roster,onSummaryChange:changed})
  await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({participant_agent_ids:['agent-1']})))
  await openSettings()
  expect(screen.queryByText('Codex')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}))
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'code'}})
  fireEvent.click(screen.getByRole('button',{name:'Codex'}));fireEvent.click(screen.getByRole('button',{name:'Add to conversation'}))
  await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({participant_agent_ids:['agent-1','optional']})))
  expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
})
it.each(['session','room','permission'] as const)('discards draft edits on %s boundary changes and ignores old responses',async change=>{
  const roster={...detail,room:{...detail.room,conversation_defaults_json:[{agent_id:'optional',participating:false,runtime_profile_id:null,session_config:[]}]},agent_members:[...detail.agent_members,{agent_id:'optional',agent_name:'Codex',role:'member'}]} as RoomDetail
  const changed=vi.fn()
  const renderPanel=(next:boolean)=><MemoryRouter><ConversationScope actionRole={next&&change==='permission'?'viewer':'member'}><ConversationExecutionPreflightContent projectId="project-1" roomId={next&&change==='room'?'room-2':'room-1'} sessionId={next&&change==='session'?'session-2':'session-1'} detail={roster} onSummaryChange={changed}/></ConversationScope></MemoryRouter>
  const view=render(renderPanel(false));await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({participant_agent_ids:['agent-1']})))
  await openSettings();fireEvent.click(screen.getByRole('button',{name:'Add Agent from Room'}));fireEvent.click(screen.getByRole('button',{name:'Codex'}));fireEvent.click(screen.getByRole('button',{name:'Add to conversation'}))
  await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({participant_agent_ids:['agent-1','optional']})))
  let resolveOld!:(value:ConversationExecutionPreflightResponse)=>void
  vi.mocked(sessionsApi.executionContext).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve}))
  fireEvent(window,new Event('focus'));await waitFor(()=>expect(resolveOld).toBeDefined())
  view.rerender(renderPanel(true))
  await waitFor(()=>expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({state:'draft',participant_agent_ids:['agent-1']})))
  await act(async()=>resolveOld(initializedResponse() as never))
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({state:'draft',participant_agent_ids:['agent-1']}))
})
it('shows offline recovery and clears protected state after a refused refresh',async()=>{
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse(false) as never)
  const ready=vi.fn();panel({onReadyChange:ready});await environment()
  expect(await screen.findByRole('link',{name:'Reconnect device'})).toHaveAttribute('href',expect.stringContaining('host-1'))
  vi.mocked(sessionsApi.executionContext).mockRejectedValueOnce(new Error('Permission revoked'))
  fireEvent(window,new Event('focus'))
  expect(await screen.findByText('Permission revoked')).toBeVisible()
  expect(screen.queryByText('Working folder')).not.toBeInTheDocument()
  expect(ready).toHaveBeenLastCalledWith(false)
  fireEvent(window,new Event('focus'))
  expect(await screen.findByText('Working folder')).toBeVisible()
})
it.each([true,false])('blocks writes for active run %s or worker identity',async active=>{
  const response=initializedResponse();response.summary.dispatch_locked=active
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
  render(<MemoryRouter><ConversationScope actionRole={active?'member':'worker'}><ConversationExecutionPreflight projectId="project-1" roomId="room-1" sessionId="session-1" detail={detail}/></ConversationScope></MemoryRouter>)
  await openSettings();await waitFor(()=>expect(screen.getByRole('button',{name:'Add Agent from Room'})).toBeDisabled())
  expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
})
it('allows selecting a model during dispatch while keeping participant edits locked', async () => {
  const response = initializedResponse()
  response.summary.dispatch_locked = true
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
  const onChange = vi.fn()
  panel({ agentConfigurations: [{
    id: 'agent-1', name: 'Project Agent', onChange, onSave: vi.fn(),
    value: [{ id: 'model', category: 'model', type: 'select', value: 'old' }],
    options: [{ id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'old', description: null,
      options: ['old', 'new'].map(value => ({ value, name: value, description: null, group: null })) }],
  }] })
  await openSettings()
  expect(await screen.findByRole('button', { name: 'Add Agent from Room' })).toBeDisabled()
  const model = screen.getByRole('button', { name: 'Model' })
  expect(model).toBeEnabled()
  expect(screen.getByText(/Running and queued work keeps its model/)).toBeVisible()
  fireEvent.click(model)
  fireEvent.click(await screen.findByText('new'))
  expect(onChange).toHaveBeenCalledWith([{ id: 'model', category: 'model', type: 'select', value: 'new' }])
})

it.each(['snapshot','committed'] as const)('submits a strict %s baseline without changing runtime identity',async mode=>{
  const response=initializedResponse() as ConversationExecutionPreflightResponse
  response.summary.primary={kind:'location',project_folder_id:'folder',workspace_location_id:'loc',display_path:'/code'}
  response.summary.git={source:'workspace_location',workspace_location_id:'loc',branch:'dev',commit_sha:'a'.repeat(40),dirty:true,execution_ready:true,observed_at:'2026-11-06T00:00:00Z'}
  const richRuntime={...response.summary.runtime!,runtime_key:'claude_code',session_config:[],context_tokens:123}
  response.summary.runtime=richRuntime
  response.summary.runtimes=[richRuntime]
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
  panel();await environment()
  fireEvent.click(await screen.findByRole('button',{name:mode==='snapshot'?'Include current changes':'Use committed version'}))
  await waitFor(()=>expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
  SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:'session-1',...vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]})
})
it('refreshes the saved model from preflight after a scoped setting save',async()=>{
  const response=initializedResponse() as ConversationExecutionPreflightResponse;response.summary.runtimes=[]
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
  panel();await openSettings();await screen.findByText('Project Agent')
  const changed=initializedResponse() as ConversationExecutionPreflightResponse
  changed.summary.runtimes[0]!.session_config=[{id:'model',type:'select',category:'model',value:'new-model'}]
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(changed)
  act(()=>window.dispatchEvent(new CustomEvent('conversation-settings-saved',{detail:{sessionId:'session-1',spaceId:'space-b'}})))
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Runtime environment' }), { button: 0 })
  fireEvent.click(screen.getByText('Agent session diagnostics and recovery'))
  expect(await screen.findByText(/new-model/)).toBeVisible()
})

it('never exposes draft participants or invented counts while an existing session loads or fails', async () => {
  let resolve!: (value: ConversationExecutionPreflightResponse) => void
  vi.mocked(sessionsApi.executionContext).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const roster = {...detail,agent_members:[...detail.agent_members,{agent_id:'worker',agent_name:'Worker',role:'member'}]} as RoomDetail
  panel({detail:roster})
  fireEvent.click(screen.getByRole('button', { name: 'Conversation settings' }))
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
  expect(screen.queryByRole('button', {name:'Choose an execution Host.'})).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Add Agent from Room' })).not.toBeInTheDocument()
  expect(screen.queryByText('Project Agent')).not.toBeInTheDocument()
  const response = initializedResponse() as ConversationExecutionPreflightResponse
  response.summary.participant_agent_ids = ['agent-1', 'worker']
  response.available_participant_agents = [{agent_id:'agent-1',retained_thread:true},{agent_id:'worker',retained_thread:true}]
  await act(async () => resolve(response))
  expect(screen.getByText('Conversation settings · 2')).toBeInTheDocument()
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response).mockRejectedValueOnce(new Error('Refresh failed'))
  fireEvent(window, new Event('focus'))
  await screen.findAllByText('Refresh failed')
  expect(screen.queryByRole('button', { name: 'Add Agent from Room' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Add Agent from Room' })).toBeEnabled()
  expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
  vi.mocked(sessionsApi.initializeExecution).mockImplementationOnce(async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({...response,summary:{...response.summary,participant_agent_ids:['agent-1'],participants_revision:'new-version'}})
    return {} as never
  })
  fireEvent.click(screen.getByText('Worker'))
  fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
  fireEvent.click(screen.getByRole('button',{name:'Confirm removal'}))
  await waitFor(()=>expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
  const payload=vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]
  expect(payload.participant_changes).toEqual([{agent_id:'worker',participating:false}])
  SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:'session-1',...payload})
  await screen.findByText('Conversation settings · 1')
})

it('restores send readiness after a failed refresh and retry', async () => {
  const ready = vi.fn()
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(initializedResponse() as never)
  panel({ onReadyChange: ready }); await openSettings()
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
  vi.mocked(sessionsApi.executionContext).mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(false))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(ready).toHaveBeenLastCalledWith(true))
})

it.each(['ambiguous', 'unavailable default', 'persisted'] as const)('uses server candidate priority: %s', async mode => {
  const response = draftResponse()
  response.available_runtime_profiles[0]!.preferred = mode === 'unavailable default'
  response.available_runtime_profiles[0]!.usable = mode !== 'unavailable default'
  response.available_runtime_profiles.push({ ...response.available_runtime_profiles[0]!, runtime_profile_id: mode === 'ambiguous' ? 'other' : null, preferred: false, usable: true, runtime_key: 'codex_cli', runtime_installation: 'codex' })
  if (mode === 'unavailable default') response.available_runtime_profiles.push({ ...response.available_runtime_profiles[1]!, runtime_key: 'opencode_cli', runtime_installation: 'opencode' })
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
  panel(); await environment()
  const confirm = screen.getByRole('button', { name: 'Confirm execution context' })
  if (mode === 'persisted') {
    await waitFor(() => expect(confirm).toBeEnabled())
    fireEvent.click(confirm)
    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
    expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].runtime.runtime_profile_id).toBe('runtime-1')
  } else if (mode === 'ambiguous') {
    expect(confirm).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /CLI installation for/ }))
    fireEvent.click(screen.getByRole('option', { name: 'codex_cli · codex' }))
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
    expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].runtime.runtime_profile_id).toBe('other')
  } else {
    expect(confirm).toBeDisabled()
    expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
  }
})

it('ignores draft creation completion from an old permission scope', async () => {
  let resolveOld!: (value: never) => void
  vi.mocked(roomsApi.createConversation).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  const created = vi.fn()
  const content = (role: string) => <MemoryRouter><ConversationScope actionRole={role}><ConversationExecutionPreflight projectId="project-1" roomId="room-1" sessionId={null} detail={detail} onConversationCreated={created}/></ConversationScope></MemoryRouter>
  const view = render(content('member')); await environment()
  fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
  await waitFor(() => expect(resolveOld).toBeDefined())
  view.rerender(content('viewer'))
  await act(async () => resolveOld({id: 'old-draft'} as never))
  expect(created).not.toHaveBeenCalled()
  expect(roomsApi.get).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Configure conversation' })).toBeDisabled()
})

it('keeps settings open after explicitly creating a draft', async () => {
  vi.mocked(roomsApi.createConversation).mockResolvedValue({ id: 'session-1' } as never)
  function Harness() {
    const [id, setId] = React.useState<string | null>(null)
    return <ConversationExecutionPreflight projectId="project-1" roomId="room-1" sessionId={id} detail={detail} onConversationCreated={next => setId(next.id)} />
  }
  render(<MemoryRouter><Harness /></MemoryRouter>)
  await environment()
  fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
  await waitFor(() => expect(sessionsApi.executionContext).toHaveBeenCalled())
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(await screen.findByRole('button', { name: 'Add Agent from Room' })).toBeEnabled()
})

it('keeps refresh and new conversation navigation available during the current run', async () => {
  const response = initializedResponse(); response.summary.dispatch_locked = true
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response as never)
  const create = vi.fn(); panel({ disabled: true, onNewConversation: create }); await environment()
  expect(screen.getByRole('button', { name: 'Refresh execution context' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'New conversation with another environment' }))
  expect(create).toHaveBeenCalledOnce()
})

it.each(['remote', 'server'] as const)('changes attachment access explicitly without changing cwd on %s Host', async kind => {
  const response = initializedResponse() as ConversationExecutionPreflightResponse
  response.summary.host = { ...host, host_kind: kind }
  response.summary.attachments = [{ id: 'attachment-1', project_folder_id: 'folder-3', workspace_location_id: 'location-3', folder_name: 'Source', display_path: '/work/source', access_mode: 'read', status: 'active', granted_by_user_id: 'user-1', granted_at: '2026-08-31T00:00:00.000Z', updated_at: '2026-08-31T00:00:00.000Z', revoked_at: null }]
  vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
  panel(); await environment()
  fireEvent.click(await screen.findByRole('button', { name: 'Grant write' }))
  await waitFor(() => expect(sessionsApi.mutateExecutionAttachments).toHaveBeenCalledWith('session-1', expect.objectContaining({ action: 'set_access', attachment_id: 'attachment-1', access_mode: 'write' }), expect.any(Object)))
  expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
  expect(screen.getByText('Working folder')).toBeVisible()
})
it.each(['snapshot','committed'] as const)('confirms a dirty draft through initialize with the explicit %s baseline',async mode=>{
 const response=draftResponse([{workspace_location_id:'loc',project_folder_id:'folder',folder_name:'Source',execution_host_id:'host-1',display_path:'/code',execution_ready:true,git:{source:'workspace_location',workspace_location_id:'loc',branch:'dev',commit_sha:'a'.repeat(40),dirty:true,execution_ready:true,observed_at:'2026-11-06T00:00:00Z'}}])
 response.available_runtime_profiles[0]!.workspace_mode='location';response.available_runtime_profiles[0]!.workspace_location_id='loc'
 vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
 panel();await environment()
 expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'Confirm execution context'})).toBeDisabled()
 fireEvent.click(screen.getByRole('button',{name:mode==='committed'?'Use committed version':'Include current changes'}))
 expect(sessionsApi.initializeExecution).not.toHaveBeenCalled()
 const confirm=screen.getByRole('button',{name:'Confirm execution context'})
 await waitFor(()=>expect(confirm).toBeEnabled());fireEvent.click(confirm)
 await waitFor(()=>expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce())
 const payload=vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1]
 expect(payload.workspace_baseline).toBe(mode)
 expect(payload.selection.primary).toEqual({kind:'location',workspace_location_id:'loc'})
 SESSION_OPERATION_SCHEMAS['conversation.execution.initialize'].input.parse({session_id:'session-1',...payload})
})
it('keeps saved-but-refresh-failed feedback after the participant editor is unmounted and retries only the read',async()=>{
 const response=initializedResponse() as ConversationExecutionPreflightResponse
 response.summary.participant_agent_ids=['agent-1','worker'];response.summary.participants_revision='old'
 response.available_participant_agents=[{agent_id:'agent-1',retained_thread:true},{agent_id:'worker',retained_thread:true}]
 const roster={...detail,agent_members:[...detail.agent_members,{agent_id:'worker',agent_name:'Worker',role:'member'}]} as RoomDetail
 vi.mocked(sessionsApi.executionContext).mockResolvedValue(response)
 vi.mocked(sessionsApi.initializeExecution).mockImplementationOnce(async()=>{
  vi.mocked(sessionsApi.executionContext).mockResolvedValue({...response,summary:{...response.summary,participant_agent_ids:['agent-1'],participants_revision:'new'}}).mockRejectedValueOnce(new Error('Refresh failed'))
  return {} as never
 })
 panel({detail:roster});await openSettings()
 fireEvent.click(await screen.findByText('Worker'))
 fireEvent.click(screen.getAllByRole('button',{name:'Remove'})[0])
 fireEvent.click(screen.getByRole('button',{name:'Confirm removal'}))
 await screen.findAllByText('Saved. Refresh failed; refresh before choosing another change.')
 expect(screen.queryByRole('button',{name:'Confirm removal'})).not.toBeInTheDocument()
 expect(screen.queryByRole('button',{name:'Add Agent from Room'})).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Retry'}))
 await screen.findByText('Conversation settings · 1')
 expect(sessionsApi.initializeExecution).toHaveBeenCalledOnce()
 expect(vi.mocked(sessionsApi.initializeExecution).mock.calls[0]![1].participants_revision).toBe('old')
})
