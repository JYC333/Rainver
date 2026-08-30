import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

// vi.mock factories are hoisted above the module body, so anything they reference
// must be created via vi.hoisted (which runs first) to avoid a TDZ error.
const { agent, getMock, messagesMock, backendsMock, hostsMock } = vi.hoisted(() => ({
  agent: {
    id: 'a1', space_id: 'personal-1', created_by_user_id: 'u1', name: 'Assistant',
    description: null, visibility: 'private', role_instruction: null, status: 'active',
    agent_kind: 'system_assistant', current_version_id: 'v1', source_template_id: null,
    source_template_version_id: null, model: null, adapter_type: 'model_api',
    requires_model_provider: true, system_prompt: null, created_at: '', updated_at: '',
  },
  getMock: vi.fn(),
  messagesMock: vi.fn(),
  backendsMock: vi.fn(),
  hostsMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  agentsApi: { get: getMock, chat: vi.fn(), conversationBackends: backendsMock },
  sessionsApi: { messages: messagesMock },
  hostsApi: { list: hostsMock },
}))

vi.mock('../contexts/SpaceContext', () => ({
  useSpace: () => ({ activeSpaceId: 'personal-1', preferredSpaceId: 'personal-1', userId: 'u1' }),
}))

import AssistantChatPage from '../modules/agents/AssistantChatPage'
import { agentsApi } from '../api/client'

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const

function renderPage(entry = '/agents/a1/chat') {
  render(
    <MemoryRouter initialEntries={[entry]} future={routerFuture}>
      <Routes>
        <Route path="/agents/:agentId/chat" element={<AssistantChatPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

/**
 * The composer stays disabled until the backend catalog resolves, and `send`
 * drops anything typed before then — as it does for a person, who cannot type
 * into a disabled box at all. Waiting for it is what a person does; not
 * waiting made these tests race the component's own guard and fail whenever
 * the catalog resolved a tick late.
 */
async function enabledComposer(): Promise<HTMLElement> {
  const input = await screen.findByPlaceholderText(/ask your assistant/i)
  await waitFor(() => expect(input).not.toBeDisabled())
  return input
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}{location.search}</span>
}

describe('AssistantChatPage conversation backends', () => {
  beforeEach(() => {
    getMock.mockReset()
    messagesMock.mockReset()
    backendsMock.mockReset()
    vi.mocked(agentsApi.chat).mockReset()
    getMock.mockResolvedValue(agent)
    messagesMock.mockResolvedValue([])
    backendsMock.mockResolvedValue({ options: [{
      runtime_profile_id: 'runtime-1',
      name: 'Managed',
      adapter_type: 'model_api',
      model_name: 'gpt-test',
      requires_cli_credential: false,
      credential_profiles: [],
    }], binding: null })
    hostsMock.mockResolvedValue({ items: [] })
    // jsdom doesn't implement Element.scrollTo, which ChatPanel calls on mount.
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  })

  it('disables the composer when no eligible backend is configured', async () => {
    backendsMock.mockResolvedValue({ options: [], binding: null })
    renderPage()
    expect(await screen.findByText(/no eligible conversation backend/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/ask your assistant/i)).toBeDisabled()
  })

  it('shows the selected eligible backend and enables chat', async () => {
    renderPage()
    expect(await screen.findByPlaceholderText(/ask your assistant/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /conversation backend/i })).toHaveValue('runtime-1:')
    })
  })

  it('restores the user × session CLI backend binding', async () => {
    backendsMock.mockResolvedValue({ options: [{
      runtime_profile_id: 'runtime-cli',
      name: 'Subscription',
      adapter_type: 'claude_code',
      model_name: null,
      requires_cli_credential: true,
      credential_profiles: [
        { id: 'credential-default', name: 'Default', is_default: true },
        { id: 'credential-1', name: 'Personal', is_default: false },
      ],
    }], binding: {
      runtime_profile_id: 'runtime-cli',
      adapter_type: 'claude_code',
      credential_profile_id: 'credential-1',
    } })
    renderPage('/agents/a1/chat?session=s1')
    expect(await screen.findByPlaceholderText(/ask your assistant/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /conversation backend/i })).toHaveValue(
        'runtime-cli:credential-1',
      )
    })
    expect(backendsMock).toHaveBeenCalledWith('a1', {
      spaceId: 'personal-1',
      sessionId: 's1',
    })
  })

  it('waits for backend discovery before auto-sending a Home draft', async () => {
    let resolveBackends!: (value: Awaited<ReturnType<typeof agentsApi.conversationBackends>>) => void
    backendsMock.mockReturnValue(new Promise(resolve => {
      resolveBackends = resolve
    }))
    vi.mocked(agentsApi.chat).mockResolvedValue({
      ok: true,
      session_id: 'session-new',
      run_id: 'run-1',
      reply: 'done',
      assistant_message: null,
      action_previews: [],
    } as never)

    renderPage('/agents/a1/chat?draft=hello')
    expect(agentsApi.chat).not.toHaveBeenCalled()
    resolveBackends({
      options: [{
        runtime_profile_id: 'runtime-1',
        name: 'Managed',
        adapter_type: 'model_api',
        model_name: 'gpt-test',
        requires_cli_credential: false,
        credential_profiles: [],
      }],
      binding: null,
    })

    await waitFor(() => expect(agentsApi.chat).toHaveBeenCalledTimes(1))
    expect(agentsApi.chat).toHaveBeenCalledWith(
      'a1',
      expect.objectContaining({
        message: 'hello',
        backend: {
          runtime_profile_id: 'runtime-1',
          credential_profile_id: null,
        },
      }),
      expect.any(Object),
    )
  })

  it('shows an error bubble on ok:false and does not reload history', async () => {
    vi.mocked(agentsApi.chat).mockResolvedValue({
      ok: false,
      error: 'The run failed.',
      error_code: 'run_failed',
      session_id: 'session-new',
      run_id: 'run-1',
    } as never)

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    // Error bubble must appear.
    expect(await screen.findByText(/could not complete/i)).toBeInTheDocument()
    expect(await screen.findByText('The run failed.')).toBeInTheDocument()
    // History must NOT be reloaded for a session created during this chat.
    expect(messagesMock).not.toHaveBeenCalledWith('session-new')
  })

  it('marks an in-flight partial reply as failed when the stream disconnects', async () => {
    vi.mocked(agentsApi.chat).mockImplementation(async (_agentId, _body, options) => {
      options?.onAccepted?.({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-new',
        run_id: 'run-1',
        user_message_id: 'message-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-1/events/stream',
        backend: {
          runtime_profile_id: 'runtime-1',
          adapter_type: 'model_api',
          credential_profile_id: null,
        },
      })
      options?.onTextDelta?.('partial reply')
      throw new Error('stream disconnected')
    })

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await screen.findByText(/could not complete/i)
    expect(screen.getByText(/partial reply/)).toBeInTheDocument()
    expect(screen.getAllByText(/stream disconnected/)).toHaveLength(1)
    expect(screen.getByTestId('location')).toHaveTextContent('session=session-new')
  })

  it('loads persisted messages when opened with a session query param', async () => {
    messagesMock.mockResolvedValue([
      {
        id: 'm1',
        session_id: 's1',
        space_id: 'personal-1',
        user_id: 'u1',
        role: 'user',
        content: 'What did we decide?',
        metadata_json: null,
        created_at: '',
      },
      {
        id: 'm2',
        session_id: 's1',
        space_id: 'personal-1',
        user_id: 'u1',
        role: 'assistant',
        content: 'We moved chat turns to TS.',
        metadata_json: null,
        created_at: '',
      },
    ])

    renderPage('/agents/a1/chat?session=s1')

    expect(await screen.findByText('What did we decide?')).toBeInTheDocument()
    expect(screen.getByText('We moved chat turns to TS.')).toBeInTheDocument()
    expect(messagesMock).toHaveBeenCalledWith('s1')
  })

  it('shows managed workspace state and sends an explicit restore choice', async () => {
    backendsMock.mockResolvedValue({ options: [{
      runtime_profile_id: 'runtime-host',
      name: 'Host runtime',
      adapter_type: 'claude_code',
      model_name: null,
      requires_cli_credential: false,
      usable: true,
      host_bound: true,
      host_id: 'host-1',
      workspace_mode: 'managed',
      host_name: 'Workstation',
      host_online: true,
      host_owner_is_me: true,
      credential_profiles: [],
    }], binding: null })
    hostsMock.mockResolvedValue({ items: [{ id: 'host-1', owner_user_id: 'u1', name: 'Workstation', status: 'online', managed_workspaces_json: [{
      agent_id: 'a1', container_kind: 'direct', container_id: 'u1', archived_available: true,
    }] }] })
    vi.mocked(agentsApi.chat).mockResolvedValue({ ok: true, session_id: 's2', run_id: 'r2', reply: 'restored', assistant_message: null, action_previews: [] } as never)

    renderPage()
    const restore = await screen.findByLabelText(/restore previous managed workspace/i)
    fireEvent.click(restore)
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'continue' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    await waitFor(() => expect(agentsApi.chat).toHaveBeenCalledWith('a1', expect.objectContaining({ restore_workspace: true }), expect.any(Object)))
    expect(screen.getByText(/Managed workspace on Workstation/)).toBeInTheDocument()
  })
})
