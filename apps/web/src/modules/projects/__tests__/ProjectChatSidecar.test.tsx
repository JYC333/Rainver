import type { ConversationInputPart } from '@rainver/protocol'
import { readConversationDraft, writeConversationDraft } from '../../conversation/conversationDraft'
import { ConversationSurface } from '../../conversation/ConversationSurface'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectChatSidecar, { focusRefsFor } from '../sidecar/ProjectChatSidecar'
import { ProjectFolderConversationProvider, useProjectFolderConversation, type CurrentFileAttachment } from '../ProjectFolderConversationContext'
import { conversationInputApi, projectsApi, proposalsApi, roomsApi, runsApi, sessionsApi } from '../../../api/client'
import { projectTaskHref } from '../taskHref'
import { subscribeProjectFolderContentChanged } from '../../../core/projectFolderEvents'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../../../contexts/SpaceContext', () => ({
  useSpace: () => ({ spaceId: 'space-1', userId: 'user-1' }),
}))
vi.mock('../ProjectConversationBackendCard', () => ({
  default: () => <div>Project Agent runtime details</div>,
}))
// The rich composer is TipTap, which jsdom cannot type into; the send path
// is what is under test here, not the editor.
vi.mock('../../agent_groups/RoomMessageComposer', async () => {
  // The real route rule and helpers; only the editor is stood in for.
  const actual = await vi.importActual<typeof import('../../agent_groups/RoomMessageComposer')>('../../agent_groups/RoomMessageComposer')
  const { agentMentionRoute, normalizeMentionText } = await vi.importActual<typeof import('@rainver/protocol')>('@rainver/protocol')
  type Value = ReturnType<typeof actual.emptyRoomMessageComposerValue>
  return {
    emptyRoomMessageComposerValue: actual.emptyRoomMessageComposerValue,
    roomMessageRoute: actual.roomMessageRoute,
    roomMessageRecipientIds: actual.roomMessageRecipientIds,
    // `@agent-<n>` stands in for a mention node: the real editor is covered
    // by its own test, this only has to hand the mentions over.
    RoomMessageComposer: ({ value, onChange, onInputPartsChange }: { value: Value; onChange: (value: Value) => void; onInputPartsChange?: (parts: ConversationInputPart[]) => void }) => (
      <>
      <button onClick={() => onInputPartsChange?.([{ kind: 'skill', skill_package_id: 'skill-1', package_hash: 'a'.repeat(64), display_name: 'Audit' }])}>Select Audit Skill</button>
      <button onClick={() => onChange({ ...value, routeChoice: 'direct' })}>Send directly instead</button>
      <textarea
        aria-label="Room message"
        onChange={event => {
          const text = event.target.value
          const tokens = text.split(/(@agent-\d+)/).filter(Boolean).map(part => part.startsWith('@agent-')
            ? { type: 'mention' as const, id: part.slice(1), label: part.slice(1) }
            : { type: 'text' as const, text: part })
          const mentionRoute = agentMentionRoute(tokens)
          onChange({
            text: normalizeMentionText(text),
            mentionIds: mentionRoute.mentioned_agent_ids,
            mentionRoute,
            routeChoice: null,
          })
        }}
      />
      </>
    ),
  }
})
vi.mock('../../../api/client', async () => {
  const { ApiRequestError } = await import('../../../test/apiClientMock')
  return {
  ApiRequestError,
  conversationInputApi: { imageBlob: vi.fn() },
  // Each addressed Room recipient's knowledge retrieval switch, off.
  runtimeContextApi: {
    retrievalSwitch: vi.fn(async () => ({ work_context_scope_id: 'scope-1', enabled: false, preferred_domains: [], setup_version: null })),
    setRetrievalSwitch: vi.fn(),
  },
  projectsApi: { mainlineRoom: vi.fn() },
  proposalsApi: { get: vi.fn(), accept: vi.fn(), reject: vi.fn() },
  runsApi: { get: vi.fn(), streamTurn: vi.fn(), turn: vi.fn(), authorizationRequests: vi.fn().mockResolvedValue([]) },
  roomsApi: {
    get: vi.fn(),
    summary: vi.fn(),
    create: vi.fn(),
    continueAfterProposal: vi.fn(),
    list: vi.fn(),
    conversations: vi.fn(),
    createConversation: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
    conversationQuota: vi.fn().mockResolvedValue({ warn_pct: 70, reserve_pct: 85, logins: [], holds: [] }),
  },
  sessionsApi: {
    executionContext: vi.fn(),
    initializeExecution: vi.fn(),
    mutateExecutionAttachments: vi.fn(),
  },
  }
})

const PROJECT = 'project-1'
const TASK = '11111111-1111-4111-8111-111111111111'

/**
 * The real route shape, not a convenient one. The sidecar's whole focus
 * feature depends on a Task page existing *inside* the Project shell — if it
 * does not, `focusRefsFor` never sees a Task path in production no matter what
 * a test renders it at.
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/spaces/:spaceId/projects/:projectId" element={<ProjectChatSidecar />}>
          <Route path="board" element={null} />
          <Route path="tasks/:taskId" element={null} />
        </Route>
        <Route path="/spaces/:spaceId/projects/:projectId/*" element={<ProjectChatSidecar />} />
      </Routes>
    </MemoryRouter>,
  )
}

function CurrentFileSeed({ attachment, folderIds }: { attachment: CurrentFileAttachment; folderIds: readonly string[] }) {
  const { setCurrentFileAttachment, setConversationFolderIds } = useProjectFolderConversation()
  useEffect(() => {
    setCurrentFileAttachment(attachment)
    setConversationFolderIds(folderIds)
  }, [attachment, folderIds, setConversationFolderIds, setCurrentFileAttachment])
  return null
}

function renderWithCurrentFile(path: string, attachment: CurrentFileAttachment) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectFolderConversationProvider projectId={PROJECT}>
        <CurrentFileSeed attachment={attachment} folderIds={[attachment.projectFolderId]} />
        <Routes>
          <Route path="/spaces/:spaceId/projects/:projectId/*" element={<ProjectChatSidecar />} />
        </Routes>
      </ProjectFolderConversationProvider>
    </MemoryRouter>,
  )
}

function currentFileAttachment(overrides: Partial<CurrentFileAttachment> = {}): CurrentFileAttachment {
  return {
    sourceKey: 'folder-1:location-1:src/app.ts',
    projectFolderId: 'folder-1',
    workspaceLocationId: 'location-1',
    relativePath: 'src/app.ts',
    displayName: 'app.ts',
    mediaType: 'text/plain',
    sourceState: 'saved',
    byteSize: 24,
    sha256: 'a'.repeat(64),
    draftId: null,
    draftVersion: null,
    contentSha256: null,
    status: 'clean',
    flushForSend: vi.fn().mockResolvedValue({
      kind: 'input_resource', source_state: 'saved', project_folder_id: 'folder-1', workspace_location_id: 'location-1',
      relative_path: 'src/app.ts', display_name: 'app.ts', media_type: 'text/plain', byte_size: 24, sha256: 'a'.repeat(64),
    }),
    ...overrides,
  }
}

function viewport(wide: boolean) {
  // jsdom has no matchMedia; the panel asks it whether it sits beside the
  // page (≥ lg) or would overlay it.
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes('1024px'),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  viewport(true)
  vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
    room: { id: 'room-1', title: 'Project Room', is_mainline: true }, joined: false, viewer_can_write: true,
  } as never)
  vi.mocked(roomsApi.conversations).mockResolvedValue({
    items: [
      { id: 'conv-2', title: 'Depth repair' },
      { id: 'conv-1', title: 'Main' },
    ], total: 2, limit: 50, offset: 0,
  } as never)
  vi.mocked(roomsApi.get).mockResolvedValue({
    room: { id: 'room-1', project_id: PROJECT, title: 'Project Room' }, user_members: [], agent_members: [],
  } as never)
  // The real endpoint always returns `conversation`. Do not omit it here.
  // The panel's handler for it re-triggers the read, and a missing one loops.
  vi.mocked(roomsApi.messages).mockResolvedValue({
    items: [], task_group_ids: [], limit: 50, offset: 0,
    conversation: { id: 'conv-2', room_id: 'room-1', title: 'Depth repair' },
  } as never)
  vi.mocked(sessionsApi.executionContext).mockResolvedValue({
    summary: {
      session_id: 'conv-2', state: 'initialized',
      host: { host_id: 'host-1', host_name: 'Local Host', host_kind: 'server', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: null },
      runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude', runtime_installation: 'claude' },
      primary: { kind: 'managed', managed_workspace_id: 'conv-2', display_path: null }, attachments: [],
      dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
    },
    available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
  } as never)
})

describe('focus refs', () => {
  it('names the Task when one is being looked at, and nothing otherwise', () => {
    // "Is this one done?" resolves without the
    // person restating which Task they mean.
    expect(focusRefsFor(`/spaces/s/projects/${PROJECT}/tasks/${TASK}`))
      .toEqual([{ type: 'task', id: TASK }])
    // The Room is already bound to the Project, so there is nothing to add.
    expect(focusRefsFor(`/spaces/s/projects/${PROJECT}/board`)).toEqual([])
  })

  it('reads back exactly the path the Board sends a card to', () => {
    // The focus regex must match a path the app actually produces. The two
    // helpers stay tied, so a change to either is caught here.
    expect(focusRefsFor(`/spaces/space-1${projectTaskHref(PROJECT, TASK)}`))
      .toEqual([{ type: 'task', id: TASK }])
  })
})

describe('Project chat sidecar', () => {
  it('binds to the mainline Room and its newest conversation', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    // The mainline is the server's answer, not "whichever Room I am in that
    // was most recently active".
    await waitFor(() => expect(projectsApi.mainlineRoom).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ spaceId: 'space-1' })))
    await waitFor(() => expect(roomsApi.conversations).toHaveBeenCalledWith('room-1', { limit: 50 }, expect.any(Object)))
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'conv-2', { limit: 50, offset: 0 }, expect.any(Object)))
  })

  it('opens the composer on a Project nobody has spoken in, creating nothing', async () => {
    // The Room is never what is missing — a Project is created with its
    // mainline (ADR 0018 decision 4) — and a conversation is not created
    // ahead of the message that fills it (decision 5). So a writer arriving
    // at a silent Project gets a composer, and no request is made at all.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/tasks/${TASK}`)
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
    expect(screen.getByText('Project Agent runtime details')).toBeVisible()
    expect(screen.getByText('Runtime & workspace').closest('details')).toHaveAttribute('open')
    expect(roomsApi.create).not.toHaveBeenCalled()
    // Nothing to load, so nothing was asked for.
    expect(roomsApi.messages).not.toHaveBeenCalled()
  })

  it('gives a Project reader the composer, because asking the Agent is what the panel is for', async () => {
    // Speaking is Room membership, and opening the Project enrols any reader
    // in the mainline. Do not gate the composer on Project *write* authority.
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    vi.mocked(projectsApi.mainlineRoom).mockResolvedValue({
      room: { id: 'room-1', title: 'Project Room', is_mainline: true }, joined: true, viewer_can_write: false,
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByLabelText('Room message')).toBeInTheDocument()
  })

  it('keeps the first-message draft and shows the canonical Host recovery destination in the sidecar', async () => {
    vi.mocked(roomsApi.conversations).mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const composer = await screen.findByLabelText('Room message')
    fireEvent.change(composer, { target: { value: 'Please inspect the workspace.' } })
    expect(screen.getByRole('button', { name: 'Configure conversation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(composer).toHaveValue('Please inspect the workspace.')
    expect(screen.getByRole('link', { name: /configure or reconnect host/i })).toHaveAttribute('href', '/spaces/space-1/command-center')
    expect(screen.queryByRole('link', { name: /project runtime settings/i })).not.toBeInTheDocument()
  })

  it('shows a failed mainline read as an error, not as an empty Project', async () => {
    // A Project without a mainline Room is a 500. Do not render that failure
    // as an empty Project: the empty state's button is disabled for a viewer,
    // so the failure would look like a dead end.
    vi.mocked(projectsApi.mainlineRoom).mockRejectedValue(new Error('Project has no mainline Room'))
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByText('Project has no mainline Room')).toBeInTheDocument()
  })

  it('reads the transcript a bounded number of times', async () => {
    // The panel binds to whatever conversation the reader reports, and the
    // reader reports on every load. Holding that callback in a dependency
    // list made each report re-run the read: the panel spun from first paint,
    // clearing and refetching the message list on every iteration.
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())
    // Each read resolves a promise, so draining the microtask queue a few
    // times is enough for a self-feeding one to run away — no real waiting,
    // and no dependence on the 5s poll.
    for (let turn = 0; turn < 20; turn += 1) {
      await act(async () => { await Promise.resolve() })
    }
    expect(vi.mocked(roomsApi.messages).mock.calls.length).toBeLessThan(4)
  })

  it('sends the focus alongside the message', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/tasks/${TASK}`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'is this done?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-2', {
      content: 'is this done?',
      routing_mode: 'direct',
      backends: [],
      focus_refs: [{ type: 'task', id: TASK }],
      queue: true,
    }, expect.any(Object)))
  })

  it('routes a mention typed in the panel, the same as the full Room page', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: '@agent-2 check the style' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-2', expect.objectContaining({
      content: '@agent-2 check the style',
      routing_mode: 'direct',
      recipient_segments: [{ recipient_agent_ids: ['agent-2'], content: '@agent-2 check the style' }],
    }), expect.any(Object)))
    expect(vi.mocked(roomsApi.sendMessage).mock.lastCall![2]).not.toHaveProperty('coordination_target_agent_ids')
  })

  it('hands a mid-sentence mention to the manager, naming the Agent and keeping the words', async () => {
    // The incident: "dispatch @Codex" reached only Codex, as "你可以派 去查".
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: '提交吧，提交完我觉得得再查一轮，你可以派 @agent-2 去查' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalled())
    const payload = vi.mocked(roomsApi.sendMessage).mock.lastCall![2]
    expect(payload).toMatchObject({
      content: '提交吧，提交完我觉得得再查一轮，你可以派 @agent-2 去查',
      routing_mode: 'agent_coordination',
      coordination_target_agent_ids: ['agent-2'],
    })
    expect(payload).not.toHaveProperty('recipient_segments')
  })

  it('sends a mid-sentence mention directly when the person chose that', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'you could send @agent-2 to check' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send directly instead' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalled())
    const payload = vi.mocked(roomsApi.sendMessage).mock.lastCall![2]
    expect(payload).toMatchObject({
      routing_mode: 'direct',
      recipient_segments: [{ recipient_agent_ids: ['agent-2'], content: 'you could send @agent-2 to check' }],
    })
    expect(payload).not.toHaveProperty('coordination_target_agent_ids')
  })

  it('keeps the addressed segment when only a Skill is selected', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({} as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: '@agent-2 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select Audit Skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-2', expect.objectContaining({
      recipient_segments: [{ recipient_agent_ids: ['agent-2'], content: '@agent-2' }],
      input_parts: [expect.objectContaining({ kind: 'skill', skill_package_id: 'skill-1' })],
    }), expect.any(Object)))
  })

  it('preserves newly selected Skill and text while old draft validation finishes', async () => {
    let finish!: (blob: Blob) => void
    vi.mocked(conversationInputApi.imageBlob).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const destination = 'room:room-1:conv-2'
    writeConversationDraft({ destination, text: 'Old draft', input_parts: [{ kind: 'image', media_id: 'old-image', filename: 'old.png', media_type: 'image/png', byte_size: 4, sha256: 'b'.repeat(64) }] })
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(conversationInputApi.imageBlob).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'New text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select Audit Skill' }))
    await act(async () => { finish(new Blob()) })
    expect(screen.queryByAltText('old.png')).not.toBeInTheDocument()
    await waitFor(() => expect(readConversationDraft(destination)).toMatchObject({ text: 'New text', input_parts: [{ kind: 'skill', skill_package_id: 'skill-1' }] }))
  })

  it('keeps edits made during old draft validation when the parent re-renders before it finishes', async () => {
    let finish!: (blob: Blob) => void
    vi.mocked(conversationInputApi.imageBlob).mockReturnValue(new Promise(resolve => { finish = resolve }))
    const destination = 'room:room-1:conv-2'
    writeConversationDraft({ destination, text: 'Old draft', input_parts: [{ kind: 'image', media_id: 'old-image', filename: 'old.png', media_type: 'image/png', byte_size: 4, sha256: 'b'.repeat(64) }] })
    // A fresh source list on every render, as callers derive it inline.
    const panel = () => <MemoryRouter><ConversationSurface roomId="room-1" conversationId="conv-2" variant="panel"
      inputFileSources={[{ projectFolderId: 'folder-1', workspaceLocationId: 'location-1', label: 'Source' }]} /></MemoryRouter>
    const view = render(panel())
    await waitFor(() => expect(conversationInputApi.imageBlob).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Room message'), { target: { value: 'New text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select Audit Skill' }))
    view.rerender(panel())
    await act(async () => { finish(new Blob()) })
    expect(screen.queryByAltText('old.png')).not.toBeInTheDocument()
    await waitFor(() => expect(readConversationDraft(destination)).toMatchObject({ text: 'New text', input_parts: [{ kind: 'skill', skill_package_id: 'skill-1' }] }))
    expect(conversationInputApi.imageBlob).toHaveBeenCalledTimes(1)
  })

  it('shows the Files current-file bar and includes the acknowledged resource by default', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      summary: {
        session_id: 'conv-2', state: 'initialized',
        host: { host_id: 'host-1', host_name: 'Local Host', host_kind: 'server', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: null },
        runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude', runtime_installation: 'claude' },
        primary: { kind: 'location', project_folder_id: 'folder-1', workspace_location_id: 'location-1', display_path: '/workspace/source' },
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
      },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    } as never)
    const attachment = currentFileAttachment()
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({ message: { id: 'm-1', session_id: 'conv-2', role: 'user', content: 'inspect', input_parts: [] }, conversation: { id: 'conv-2', title: 'Depth repair' }, task_group_ids: [], run_ids: [] } as never)
    renderWithCurrentFile(`/spaces/space-1/projects/${PROJECT}/files`, attachment)
    expect(await screen.findByTestId('current-file-bar')).toHaveTextContent('src/app.ts')
    expect(screen.getByRole('button', { name: 'Remove current file' })).toBeInTheDocument()
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'inspect' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-2', expect.objectContaining({
      content: 'inspect',
      input_parts: [expect.objectContaining({ kind: 'input_resource', source_state: 'saved', relative_path: 'src/app.ts' })],
    }), expect.any(Object)))
    expect(attachment.flushForSend).toHaveBeenCalledTimes(1)
  })

  it('can remove and re-add the current file without changing the editor', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      summary: {
        session_id: 'conv-2', state: 'initialized',
        host: { host_id: 'host-1', host_name: 'Local Host', host_kind: 'server', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: null },
        runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude', runtime_installation: 'claude' },
        primary: { kind: 'location', project_folder_id: 'folder-1', workspace_location_id: 'location-1', display_path: '/workspace/source' },
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
      },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    } as never)
    const attachment = currentFileAttachment()
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({ message: { id: 'm-1', session_id: 'conv-2', role: 'user', content: 'text', input_parts: [] }, conversation: { id: 'conv-2', title: 'Depth repair' }, task_group_ids: [], run_ids: [] } as never)
    renderWithCurrentFile(`/spaces/space-1/projects/${PROJECT}/files`, attachment)
    const bar = await screen.findByTestId('current-file-bar')
    // The bar paints with the Room; the toggle stays disabled until the
    // conversation's execution context says the file's Folder is in it.
    await waitFor(() => expect(within(bar).getByRole('button', { name: 'Remove current file' })).toBeEnabled())
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove current file' }))
    expect(within(bar).getByRole('button', { name: 'Add current file' })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: 'Add current file' }))
    expect(within(bar).getByRole('button', { name: 'Remove current file' })).toBeInTheDocument()
  })

  it('announces Folder content changes when the Conversation run settles', async () => {
    vi.mocked(sessionsApi.executionContext).mockResolvedValue({
      summary: {
        session_id: 'conv-2', state: 'initialized',
        host: { host_id: 'host-1', host_name: 'Local Host', host_kind: 'server', online: true, managed_workspace_available: true, daemon_last_heartbeat_at: null },
        runtime: { agent_id: 'agent-1', runtime_profile_id: 'runtime-1', runtime_key: 'claude', runtime_installation: 'claude' },
        primary: { kind: 'location', project_folder_id: 'folder-1', workspace_location_id: 'location-1', display_path: '/workspace/source' },
        attachments: [], dispatch_locked: false, queue_paused_at: null, can_send: true, blocked_reason: null,
      },
      available_hosts: [], available_runtime_profiles: [], available_primary_locations: [],
    } as never)
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-3', session_id: 'conv-2', role: 'user', content: 'Create a file', metadata_json: {} },
      conversation: { id: 'conv-2', title: 'Depth repair' }, task_group_ids: [], run_ids: ['run-1'],
    } as never)
    vi.mocked(runsApi.streamTurn).mockImplementation(async (_runId, options) => {
      options.onTurn({ state: 'done' } as never)
    })
    const changed = vi.fn()
    const stop = subscribeProjectFolderContentChanged(changed)

    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(sessionsApi.executionContext).toHaveBeenCalledWith('conv-2', expect.any(Object)))
    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'Create a file' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(changed).toHaveBeenCalledWith({ projectFolderIds: ['folder-1'] }))
    stop()
  })

  it('opens the full Room on the conversation being read', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalledWith('room-1', 'conv-2', { limit: 50, offset: 0 }, expect.any(Object)))
    // Full Room opens the conversation being read. Do not land on the Rooms list.
    expect(screen.getByRole('link', { name: /Full Room/ }))
      .toHaveAttribute('href', `/projects/${PROJECT}/rooms?room=room-1&conversation=conv-2`)
  })

  it('is as wide as you last made it, within bounds, and never lengthens the page', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const aside = await screen.findByTestId('project-chat-sidecar')
    // Stuck to the top of the scroll container at a bounded height, so the
    // message list scrolls inside it instead of stretching the page.
    expect(aside.className).toContain('lg:sticky')
    expect(aside.className).toContain('lg:h-[var(--sidecar-h,100dvh)]')
    expect(aside.querySelector('.overflow-y-auto')).not.toBeNull()

    const handle = screen.getByRole('separator', { name: 'Resize Project chat' })
    expect(handle).toHaveAttribute('aria-valuenow', '352')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '384')
    expect(localStorage.getItem('project.sidecar.width')).toBe('384')
    // Bounded: it cannot be dragged into the page or out of usefulness.
    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '640')
  })

  it('tells the two speakers apart by more than a label', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        { id: 'm1', role: 'user', content: 'Which shell do you use?', created_at: '2026-08-27T09:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'Direct API calls, no shell.', created_at: '2026-08-27T09:00:05.000Z' },
      ], task_group_ids: [], limit: 50, offset: 0,
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const mine = (await screen.findByText('Which shell do you use?')).closest('[data-role]')
    const theirs = screen.getByText('Direct API calls, no shell.').closest('[data-role]')
    expect(mine).toHaveAttribute('data-role', 'user')
    expect(theirs).toHaveAttribute('data-role', 'agent')
    // Opposite alignment, so a column of mixed-language text still reads.
    expect(mine?.className).toContain('justify-end')
    expect(theirs?.className).toContain('justify-start')
  })

  it('marks a reply that is a question for the person, and only that one', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [
        { id: 'm1', role: 'user', content: 'Clean up the parser.', created_at: '2026-08-27T09:00:00.000Z' },
        {
          id: 'm2', role: 'assistant', content: 'Which parser should I keep?\n\n- Pratt\n- Recursive descent',
          created_at: '2026-08-27T09:00:05.000Z', metadata_json: { awaiting_answer: true },
        },
        { id: 'm3', role: 'assistant', content: 'Done.', created_at: '2026-08-27T09:00:09.000Z', metadata_json: {} },
      ], task_group_ids: [], limit: 50, offset: 0,
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const question = (await screen.findByText('Which parser should I keep?')).closest('[data-role]')
    expect(question).toHaveTextContent('waiting for an answer')
    expect(screen.getByText('Done.').closest('[data-role]')).not.toHaveTextContent('waiting for an answer')
  })

  it('decides a proposal the turn produced, right here, and lets the Agent continue', async () => {
    // The card is the decision. Do not send the person to the Space-level
    // Review page to decide a proposal this turn produced.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm2', role: 'assistant', content: 'I proposed one question.', created_at: '2026-08-27T09:00:05.000Z',
        metadata_json: { action_previews: [{
          action_id: 'inquiry.promote_knowledge', status: 'proposed', proposal_id: 'proposal-1',
          proposal_type: 'knowledge_create', title: 'Research question: does batching help?',
        }] },
      }], task_group_ids: [], limit: 50, offset: 0,
    } as never)
    vi.mocked(proposalsApi.get).mockResolvedValue({ id: 'proposal-1', status: 'pending' } as never)
    vi.mocked(proposalsApi.accept).mockResolvedValue({} as never)
    vi.mocked(roomsApi.continueAfterProposal).mockResolvedValue({ run_ids: ['run-2'], conversation: null } as never)

    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    const previews = await screen.findByTestId('previews-m2')
    expect(previews).toHaveTextContent('Research question: does batching help?')
    fireEvent.click(await within(previews).findByRole('button', { name: /accept|接受|确认/i }))
    await waitFor(() => expect(proposalsApi.accept).toHaveBeenCalledWith('proposal-1', expect.any(Object)))
    await waitFor(() => expect(roomsApi.continueAfterProposal)
      .toHaveBeenCalledWith('room-1', 'conv-2', { proposal_id: 'proposal-1', backends: [] }, expect.any(Object)))
  })

  it('starts a separate thread by clearing the composer, not by creating one', async () => {
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({
      message: { id: 'm-1', session_id: 'conv-3', role: 'user', content: 'A new topic', metadata_json: {} },
      conversation: { id: 'conv-3', title: null },
      task_group_ids: [], run_ids: [],
    } as never)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Start a separate thread' }))

    vi.mocked(roomsApi.createConversation).mockResolvedValue({ id: 'conv-3', room_id: 'room-1', title: 'New conversation' } as never)
    fireEvent.click(screen.getByRole('button', { name: 'Configure conversation' }))
    await waitFor(() => expect(roomsApi.createConversation).toHaveBeenCalledWith('room-1', expect.any(Object)))

    fireEvent.change(await screen.findByLabelText('Room message'), { target: { value: 'A new topic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // Explicit setup created the draft before the message, so the send is
    // addressed to the selected conversation rather than creating one behind
    // the user's back.
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-1', 'conv-3', expect.anything(), expect.any(Object)))
    await waitFor(() => expect(localStorage.getItem('project.sidecar.room.room-1.conversation')).toBe('conv-3'))
  })

  it('stays a button on a narrow viewport, where open would mean covering the page', async () => {
    viewport(false)
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByRole('button', { name: 'Open Project chat' })).toBeInTheDocument()
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
  })

  it('is open on first arrival beside the page, and stays closed once closed', async () => {
    // Conversation is the way in, so the panel is there before anyone asks.
    renderAt(`/spaces/space-1/projects/${PROJECT}/board`)
    expect(await screen.findByTestId('project-chat-sidecar')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close Project chat' }))
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
    expect(localStorage.getItem(`project.sidecar.${PROJECT}.open`)).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Open Project chat' }))
    expect(await screen.findByTestId('project-chat-sidecar')).toBeInTheDocument()
    expect(localStorage.getItem(`project.sidecar.${PROJECT}.open`)).toBe('true')
  })

  it('stays out of the Rooms Area, which is already the Room', async () => {
    renderAt(`/spaces/space-1/projects/${PROJECT}/rooms`)
    expect(screen.queryByTestId('project-chat-sidecar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open Project chat' })).not.toBeInTheDocument()
    expect(roomsApi.list).not.toHaveBeenCalled()
  })

  it('offers to attach a picked message to another thread, but not to start one', async () => {
    // The panel can reach the Room's other threads, so a pick has somewhere
    // to go; starting a thread is not one of this surface's affordances, so
    // that action is not offered rather than offered and dead.
    vi.mocked(roomsApi.messages).mockResolvedValue({
      items: [{
        id: 'm-1', space_id: 'space-1', session_id: 'conv-1', role: 'user',
        user_id: 'user-1', content: 'Pick me', metadata_json: {},
        created_at: '2026-08-29T09:00:00.000Z',
      }],
      total: 1, limit: 50, offset: 0,
    } as never)
    renderAt('/spaces/space-1/projects/project-1/board')

    fireEvent.click((await screen.findAllByLabelText('Pick this message'))[0]!)
    expect(await screen.findByLabelText('Attach to a thread')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use in a new thread/ })).not.toBeInTheDocument()
  })
})

describe('conversation panels with an explicit source Space', () => {
  it('keeps Room reads, Run streams and sends in the source Space without changing the route', async () => {
    vi.mocked(roomsApi.messages).mockResolvedValue({ items: [{ id: 'message-b', session_id: 'conversation-b', role: 'user',
      content: 'Start here', created_at: '2026-10-21T12:00:00Z', metadata_json: { run_ids: ['run-b'] } }], task_group_ids: [], limit: 50, offset: 0 } as never)
    vi.mocked(runsApi.get).mockResolvedValue({ id: 'run-b', space_id: 'source-b', status: 'running', agent_id: 'agent-b' } as never)
    vi.mocked(runsApi.streamTurn).mockImplementation(() => new Promise(() => {}))
    vi.mocked(roomsApi.sendMessage).mockResolvedValue({ message: { id: 'reply-b', session_id: 'conversation-b', role: 'user', content: 'Reply in B', metadata_json: {}, created_at: '2026-10-21T12:01:00Z' }, run_ids: [], task_group_ids: [], conversation: null } as never)
    render(<MemoryRouter initialEntries={['/spaces/active-a/projects/project-a']}>
      <ConversationSurface spaceId="source-b" roomId="room-b" conversationId="conversation-b" variant="panel" />
    </MemoryRouter>)
    await screen.findByText('Start here')
    await waitFor(() => expect(runsApi.streamTurn).toHaveBeenCalledWith('run-b', expect.objectContaining({ spaceId: 'source-b', signal: expect.any(AbortSignal) })))
    expect(roomsApi.get).toHaveBeenCalledWith('room-b', expect.objectContaining({ spaceId: 'source-b' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Room message' }), { target: { value: 'Reply in B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(roomsApi.sendMessage).toHaveBeenCalledWith('room-b', 'conversation-b', expect.objectContaining({ content: 'Reply in B' }), expect.objectContaining({ spaceId: 'source-b' })))
  })
  it('cancels the previous Space and ignores a late message page and its parent callback', async () => {
    let finish!: (value: never) => void
    vi.mocked(roomsApi.messages).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const updated = vi.fn()
    const panel = (spaceId: string, conversationId: string) => <MemoryRouter><ConversationSurface spaceId={spaceId} roomId="room" conversationId={conversationId} variant="panel" onConversationUpdated={updated} /></MemoryRouter>
    const view = render(panel('source-a', 'conversation-a'))
    await waitFor(() => expect(roomsApi.messages).toHaveBeenCalled())
    const options = vi.mocked(roomsApi.messages).mock.calls[0]![3]!
    view.rerender(panel('source-b', 'conversation-b'))
    expect(options.signal!.aborted).toBe(true)
    await act(async () => finish({ items: [{ id: 'old', role: 'user', session_id: 'conversation-a', content: 'Old private response', metadata_json: {}, created_at: '2026-10-21T12:00:00Z' }], conversation: { id: 'conversation-a' }, limit: 50, offset: 0 } as never))
    expect(screen.queryByText('Old private response')).not.toBeInTheDocument()
    expect(updated).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'conversation-a' }))
  })
  it('does not provision or execute an uninitialized panel just to read it', () => {
    render(<MemoryRouter><ConversationSurface spaceId="source-b" roomId="room-b" conversationId={null} executionReady={false} variant="panel" /></MemoryRouter>)
    expect(roomsApi.createConversation).not.toHaveBeenCalled()
    expect(roomsApi.sendMessage).not.toHaveBeenCalled()
    expect(runsApi.streamTurn).not.toHaveBeenCalled()
  })
})
