import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

// vi.mock factories are hoisted above the module body, so anything they reference
// must be created via vi.hoisted (which runs first) to avoid a TDZ error.
const { agent, getMock, messagesMock, backendsMock, hostsMock, turnMock } = vi.hoisted(() => ({
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
  turnMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  agentsApi: { get: getMock, chat: vi.fn(), conversationBackends: backendsMock },
  sessionsApi: { messages: messagesMock },
  hostsApi: { list: hostsMock },
  runsApi: { turn: turnMock },
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
    turnMock.mockReset()
    turnMock.mockRejectedValue(new Error('no turn'))
    // jsdom doesn't implement Element.scrollTo, which ChatPanel calls on mount.
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  })

  it('keeps a reply\'s work on reload, and says when a turn is still blocked', async () => {
    // D3's fold has to survive a reload, not exist only in the page session
    // that watched the turn stream. The panel reads each saved reply's turn
    // back, exactly as the Room does.
    messagesMock.mockResolvedValue([
      {
        id: 'm1', role: 'user', content: 'Do the thing.',
        metadata_json: null, run_id: null,
      },
      {
        id: 'm2', role: 'assistant', content: 'Here is what I found.',
        metadata_json: null, run_id: 'run-past',
      },
    ])
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-past', state: 'done',
      source: 'run_events', blocked_on: null, cursor: 1, updated_at: null,
      parts: [{
        type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
        kind: null, status: 'succeeded', input: null, output: null,
      }],
    })

    renderPage('/agents/a1/chat?session=session-past')

    expect(await screen.findByText('Here is what I found.')).toBeInTheDocument()
    expect(await screen.findByText('show work (1 step)')).toBeInTheDocument()
    expect(turnMock).toHaveBeenCalledWith('run-past')
  })

  it('still says a reloaded turn is blocked, with somewhere to go', async () => {
    // A paused turn keeps its state across a reload. Reading a saved reply as
    // proof the turn finished would drop the approval link — the one thing a
    // paused turn exists to show.
    messagesMock.mockResolvedValue([{
      id: 'm2', role: 'assistant', content: 'I need your approval to continue.',
      metadata_json: null, run_id: 'run-paused',
    }])
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-paused', state: 'blocked',
      source: 'run_events', blocked_on: 'authorization', cursor: 0, updated_at: null,
      parts: [],
    })

    renderPage('/agents/a1/chat?session=session-paused')

    expect(await screen.findByText('approval needed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review request' })).toBeInTheDocument()
  })

  it('does not send while a reloaded turn is still waiting for a decision', async () => {
    // The note above the composer says the message is held. Before this, the
    // guard behind it only knew about a turn blocked in *this* session, so on
    // a reload the note appeared and the send went out anyway.
    messagesMock.mockResolvedValue([{
      id: 'm2', role: 'assistant', content: 'I need your approval to continue.',
      metadata_json: null, run_id: 'run-paused',
    }])
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-paused', state: 'blocked',
      source: 'run_events', blocked_on: 'authorization', cursor: 0, updated_at: null,
      parts: [],
    })

    renderPage('/agents/a1/chat?session=session-paused')
    await screen.findByText('approval needed')
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'never mind, do something else' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.getByText(/waiting for your decision/i)).toBeInTheDocument())
    expect(agentsApi.chat).not.toHaveBeenCalled()
  })

  it('does not leave a reloaded reply saying the Agent is still working', async () => {
    // `chatTurnFinalizer` writes the reply before it appends `chat_completed`,
    // so a turn read back can legitimately still say `working` beside a
    // finished answer. Nothing here streams history, so it would sit as a
    // permanent "Working…" with the fold withheld.
    messagesMock.mockResolvedValue([{
      id: 'm2', role: 'assistant', content: 'The answer is 42.',
      metadata_json: null, run_id: 'run-lagging',
    }])
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-lagging', state: 'working',
      source: 'run_events', blocked_on: null, cursor: 1, updated_at: null,
      parts: [{
        type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
        kind: null, status: 'succeeded', input: null, output: null,
      }],
    })

    renderPage('/agents/a1/chat?session=session-lagging')

    expect(await screen.findByText('The answer is 42.')).toBeInTheDocument()
    expect(await screen.findByText('show work (1 step)')).toBeInTheDocument()
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  })

  it('reads turns for the tail of a long conversation, not for every reply', async () => {
    // One read per reply is one `loadRunTurn` per reply. A long conversation
    // would fan out uncapped on every reload.
    messagesMock.mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      id: `m${index}`, role: 'assistant', content: `Reply ${index}`,
      metadata_json: null, run_id: `run-${index}`,
    })))
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-x', state: 'done',
      source: 'run_events', blocked_on: null, cursor: 0, updated_at: null, parts: [],
    })

    renderPage('/agents/a1/chat?session=session-long')

    expect(await screen.findByText('Reply 59')).toBeInTheDocument()
    expect(turnMock.mock.calls.length).toBeLessThanOrEqual(20)
    // The tail is what gets read, not an arbitrary slice.
    expect(turnMock).toHaveBeenCalledWith('run-59')
    expect(turnMock).not.toHaveBeenCalledWith('run-0')
  })

  it('still shows Thinking after a reload of a conversation whose history has turns', async () => {
    // The indicator asks about *this* turn, not any turn. Once history reads
    // its turns back, an older reply carrying one would otherwise suppress it
    // for every new message — nothing at all between the send and the first
    // frame.
    messagesMock.mockResolvedValue([{
      id: 'm1', role: 'assistant', content: 'Earlier answer.',
      metadata_json: null, run_id: 'run-earlier',
    }])
    turnMock.mockResolvedValue({
      schema_version: 'run_turn.v1', run_id: 'run-earlier', state: 'done',
      source: 'run_events', blocked_on: null, cursor: 0, updated_at: null, parts: [],
    })
    vi.mocked(agentsApi.chat).mockImplementation(() => new Promise(() => {}))

    renderPage('/agents/a1/chat?session=session-with-turns')
    await screen.findByText('Earlier answer.')
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'and now this' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(await screen.findByText('Thinking…')).toBeInTheDocument()
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
        event_stream_url: '/api/v1/runs/run-1/turn/stream',
        backend: {
          runtime_profile_id: 'runtime-1',
          adapter_type: 'model_api',
          credential_profile_id: null,
        },
      })
      options?.onTurn?.({
        schema_version: 'run_turn.v1',
        run_id: 'run-1',
        state: 'working',
        source: 'run_events',
        parts: [
          { type: 'tool_call', index: 0, call_id: 'c1', name: 'probe_tool',
            kind: null, status: 'succeeded', input: null, output: null },
          { type: 'text', index: 1, text: 'partial reply' },
        ],
        blocked_on: null,
        cursor: 1,
        updated_at: null,
      })
      throw new Error('stream disconnected')
    })

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await screen.findByText(/could not complete/i)
    expect(screen.getByText(/partial reply/)).toBeInTheDocument()
    expect(screen.getAllByText(/stream disconnected/)).toHaveLength(1)
    // A break is the third way a turn settles, and the steps explain it just
    // as they do on a reported failure.
    expect(screen.getByText('probe_tool')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('session=session-new')
  })

  it('keeps the work folded above a finished reply, not only while it streams', async () => {
    vi.mocked(agentsApi.chat).mockImplementation(async (_agentId, _body, options) => {
      options?.onAccepted?.({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-new',
        run_id: 'run-done',
        user_message_id: 'message-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-done/turn/stream',
        backend: { runtime_profile_id: 'runtime-1', adapter_type: 'model_api', credential_profile_id: null },
      })
      options?.onTurn?.({
        schema_version: 'run_turn.v1',
        run_id: 'run-done',
        state: 'working',
        source: 'run_events',
        parts: [{
          type: 'tool_call', index: 0, call_id: 'c1', name: 'search',
          kind: null, status: 'succeeded', input: null, output: null,
        }],
        blocked_on: null,
        cursor: 1,
        updated_at: null,
      })
      return {
        schema_version: 'chat_turn_completion.v1',
        session_id: 'session-new',
        run_id: 'run-done',
        ok: true,
        reply: 'Found three.',
        assistant_message: {
          schema_version: 'assistant_message.v1',
          id: 'message-assistant',
          session_id: 'session-new',
          run_id: 'run-done',
          content: 'Found three.',
          artifact_refs: [],
          tool_call_refs: [],
          created_at: '2026-07-26T10:00:02.000Z',
        },
      }
    })

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    // D3's finished state: the reply is the bubble, and the steps that
    // produced it fold above it — not discarded the moment they become
    // something to look back on.
    expect(await screen.findByText('Found three.')).toBeInTheDocument()
    expect(await screen.findByText('show work (1 step)')).toBeInTheDocument()
  })

  it('keeps the steps on a failed turn, because they are the explanation', async () => {
    vi.mocked(agentsApi.chat).mockImplementation(async (_agentId, _body, options) => {
      options?.onAccepted?.({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-new',
        run_id: 'run-fail',
        user_message_id: 'message-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-fail/turn/stream',
        backend: { runtime_profile_id: 'runtime-1', adapter_type: 'model_api', credential_profile_id: null },
      })
      options?.onTurn?.({
        schema_version: 'run_turn.v1',
        run_id: 'run-fail',
        state: 'working',
        source: 'run_events',
        parts: [{
          type: 'tool_call', index: 0, call_id: 'c1', name: 'write_file',
          kind: null, status: 'failed', input: null, output: null,
        }],
        blocked_on: null,
        cursor: 1,
        updated_at: null,
      })
      return {
        schema_version: 'chat_turn_completion.v1',
        session_id: 'session-new',
        run_id: 'run-fail',
        ok: false,
        error: 'Upstream refused.',
        error_code: 'provider_unavailable',
        assistant_message: null,
      }
    })

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    // D3: the same bubble carries the failure, and the steps stay — a turn
    // that failed is the one where they matter most.
    expect(await screen.findByText('Upstream refused.')).toBeInTheDocument()
    expect(screen.getByText('write_file')).toBeInTheDocument()
    // Still marked as a failure. The badge used to live only on the bubble
    // that had no turn, so keeping the turn quietly took it away.
    expect(screen.getByText(/could not complete/i)).toBeInTheDocument()
  })

  it('hands the composer back when a turn blocks, and says where to act', async () => {
    // A blocked turn is waiting on the person. Its request is still open — so
    // the panel cannot resolve it — but the person has to be able to go and
    // approve the thing it is waiting for, which means the composer comes
    // back and the turn says where to go.
    let resume: (() => void) | undefined
    vi.mocked(agentsApi.chat).mockImplementation(async (_agentId, _body, options) => {
      options?.onAccepted?.({
        schema_version: 'chat_turn_accepted.v1',
        session_id: 'session-new',
        run_id: 'run-blocked',
        user_message_id: 'message-1',
        status: 'queued',
        event_stream_url: '/api/v1/runs/run-blocked/turn/stream',
        backend: { runtime_profile_id: 'runtime-1', adapter_type: 'model_api', credential_profile_id: null },
      })
      options?.onTurn?.({
        schema_version: 'run_turn.v1',
        run_id: 'run-blocked',
        state: 'blocked',
        source: 'run_events',
        parts: [],
        blocked_on: 'authorization',
        cursor: 0,
        updated_at: null,
      })
      resume = () => options?.onTurn?.({
        schema_version: 'run_turn.v1',
        run_id: 'run-blocked',
        state: 'working',
        source: 'run_events',
        parts: [{ type: 'text', index: 0, text: 'Carrying on.' }],
        blocked_on: null,
        cursor: 1,
        updated_at: null,
      })
      // Still open: the turn resumes when they decide.
      return new Promise(() => {}) as never
    })

    renderPage()
    const input = await enabledComposer()
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    expect(await screen.findByText('approval needed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review request' })).toBeInTheDocument()

    // The turn's request is still open, so a second message would be a second
    // turn against the same conversation. Refused, and said — not silently
    // swallowed at the send guard.
    expect(await screen.findByText(/waiting for your decision/i)).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText(/ask your assistant/i), { target: { value: 'and another' } })
    fireEvent.keyDown(screen.getByPlaceholderText(/ask your assistant/i), { key: 'Enter', shiftKey: false })
    expect(agentsApi.chat).toHaveBeenCalledTimes(1)
    // No spinner beside it: the turn says for itself that it has stopped,
    // and a "Thinking…" bubble next to that would say the opposite.
    await waitFor(() => {
      expect(screen.queryByText(/thinking/i)).not.toBeInTheDocument()
    })

    // And once it resumes, the composer is still held — the request is open
    // again, so a second message would still be a second turn. This window is
    // the one a `sending` flag that meant "open and not blocked" left
    // uncovered: the note is gone, so only the guard is left to refuse, and a
    // guard the person cannot see is a message that vanishes.
    act(() => { resume?.() })
    await waitFor(() => {
      expect(screen.queryByText(/waiting for your decision/i)).not.toBeInTheDocument()
    })
    fireEvent.change(screen.getByPlaceholderText(/ask your assistant/i), { target: { value: 'once more' } })
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
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
