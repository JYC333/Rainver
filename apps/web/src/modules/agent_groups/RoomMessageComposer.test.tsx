import { MemoryRouter } from 'react-router-dom'
import { ConversationScope } from '../conversation/ConversationScope'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Utf8 } from '../project_files/draftController'
import { RoomMessageComposer, emptyRoomMessageComposerValue, roomMessageRoute } from './RoomMessageComposer'
import { capabilitiesFrameworkApi, conversationInputApi, projectFoldersApi } from '../../api/client'
import type { ConversationInputPart } from '@rainver/protocol'
import type { FileNode } from '../../types/api'

// The empty Skill menu links to the library through the app's Space-aware router.
vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ activeSpaceId: 'space-a', preferredSpaceId: 'space-a' }) }))

vi.mock('../../api/client', () => ({
  capabilitiesFrameworkApi: { availableSkills: vi.fn().mockResolvedValue([]) },
  conversationInputApi: {
    searchFiles: vi.fn(),
  },
  projectFoldersApi: {
    tree: vi.fn(),
    locations: vi.fn(),
    file: vi.fn(),
  },
}))

// Enter=send / Shift+Enter=newline is a system-wide default (see sibling
// composers' own keydown tests where they exist). This is the trickiest of
// the five composers to verify: it's a TipTap/ProseMirror editor, not a plain
// textarea, so Shift+Enter's newline has to fall through to StarterKit's
// HardBreak keymap rather than being handled by native textarea behavior.
function Harness() {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  const [submitCount, setSubmitCount] = useState(0)
  return (
    <>
      <RoomMessageComposer
        value={value}
        onChange={setValue}
        agents={[]}
        members={[]}
        disabled={false}
        resetToken={0}
        onSubmit={() => setSubmitCount(count => count + 1)}
      />
      <div data-testid="submit-calls">{submitCount}</div>
    </>
  )
}

function FileHarness({ sessionId, discoverLocation = false, initialText, initialParts = [] }: {
  sessionId?: string; discoverLocation?: boolean; initialText?: string; initialParts?: ConversationInputPart[]
}) {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  const [parts, setParts] = useState<ConversationInputPart[]>(initialParts)
  return <>
    <RoomMessageComposer
      value={value}
      onChange={setValue}
      agents={[{ id: 'agent-1', name: 'Builder', status: 'active' }]}
      members={[{ agent_id: 'agent-1', status: 'active' }]}
      disabled={false}
      resetToken={0}
      restore={initialText === undefined ? undefined : { token: 1, text: initialText }}
      onSubmit={() => undefined}
      sessionId={sessionId}
      projectId="project-1"
      projectFolderId="folder-1"
      fileSources={[{ projectFolderId: 'folder-1', workspaceLocationId: discoverLocation ? undefined : 'location-1', label: 'Primary · repo' }]}
      inputParts={parts}
      onInputPartsChange={setParts}
    />
    <output data-testid="room-value">{JSON.stringify(value)}</output>
    <output data-testid="room-input-parts">{JSON.stringify(parts)}</output>
  </>
}

function EmptyResultsFileHarness() {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  return <RoomMessageComposer
    value={value}
    onChange={setValue}
    agents={[]}
    members={[]}
    disabled={false}
    resetToken={0}
    onSubmit={() => undefined}
    projectId="project-1"
    fileSources={[{ projectFolderId: 'folder-1', workspaceLocationId: 'location-1', label: 'Primary · repo' }]}
  />
}

function RoutingHarness({ restore = null }: { restore?: { token: number; text: string; routeChoice?: 'direct' | 'agent_coordination' | null } | null }) {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  return <>
    <RoomMessageComposer
      value={value}
      onChange={setValue}
      agents={[{ id: 'agent-1', name: 'Builder', status: 'active' }, { id: 'agent-2', name: 'Critic', status: 'active' }]}
      members={[{ agent_id: 'agent-1', status: 'active' }, { agent_id: 'agent-2', status: 'active' }]}
      disabled={false}
      resetToken={0}
      restore={restore}
      onSubmit={() => undefined}
      managerAgentId="agent-manager"
    />
    <output data-testid="room-routing">{JSON.stringify(value)}</output>
    <output data-testid="room-route">{JSON.stringify(roomMessageRoute(value, 'agent-manager'))}</output>
  </>
}

async function getEditor() {
  await screen.findByText('Message...', {}, { timeout: 5000 })
  return document.querySelector('.ProseMirror') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(capabilitiesFrameworkApi.availableSkills).mockResolvedValue([])
  vi.mocked(projectFoldersApi.tree).mockResolvedValue({
    name: 'repo', path: '.', type: 'dir', children: [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file', size: 20 }],
  })
  vi.mocked(projectFoldersApi.file).mockResolvedValue({
    path: 'src/App.tsx', content: 'export const App = 1', size: 20, line_count: 1, sha256: 'e'.repeat(64),
  })
})

describe('RoomMessageComposer keyboard behavior', () => {
  it('inserts a Skill at a middle caret using the keyboard and keeps surrounding text', async () => {
    const skill = { kind: 'skill' as const, skill_package_id: 'skill-1', package_hash: 'a'.repeat(64), display_name: 'Audit' }
    vi.mocked(capabilitiesFrameworkApi.availableSkills).mockResolvedValue([skill])
    const user = userEvent.setup({ delay: null })
    render(<FileHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.type(editor, 'Before /Aud after')
    // jsdom has no native arrow-key caret movement in contenteditable.
    document.getSelection()!.collapse(editor.querySelector('p')!.firstChild!, 'Before /Aud'.length)
    fireEvent(document, new Event('selectionchange'))
    await screen.findByRole('option', { name: /Audit/ })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(JSON.parse(screen.getByTestId('room-value').textContent!)).toMatchObject({ text: 'Before /Audit after', mentionIds: [] })
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent!)).toEqual([skill])
    await user.type(editor, '!', { skipClick: true })
    expect(editor).toHaveTextContent('Before /Audit! after')
  })

  it('restores a legacy Skill and file selection together without dropping either', async () => {
    const parts: ConversationInputPart[] = [
      { kind: 'skill', skill_package_id: 'skill-1', package_hash: 'a'.repeat(64), display_name: 'Audit' },
      { kind: 'file_reference', project_folder_id: 'folder-1', workspace_location_id: 'location-1', relative_path: 'src/App.tsx', display_name: 'App.tsx', media_type: 'text/plain', byte_size: 20, sha256: 'e'.repeat(64) },
    ]
    render(<FileHarness initialText="Review this" initialParts={parts} />, { wrapper: MemoryRouter })
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toHaveTextContent('/Audit'))
    expect(document.querySelector('[data-file-reference]')).toHaveTextContent('src/App.tsx')
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent!)).toEqual(parts)
  })

  it.each(['/', '@'])('selects a pinned Skill through %s without changing Agent routing', async trigger => {
    const skill = { kind: 'skill' as const, skill_package_id: 'skill-1', package_hash: 'a'.repeat(64), display_name: 'Audit' }
    vi.mocked(capabilitiesFrameworkApi.availableSkills).mockResolvedValue([skill])
    const user = userEvent.setup({ delay: null })
    render(<FileHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.type(editor, '@Buil')
    await user.click(await screen.findByRole('option', { name: /@Builder/ }))
    await user.type(editor, `${trigger}Aud`, { skipClick: true })
    await user.click(await screen.findByRole('option', { name: /Audit/ }))
    // The menu asked for Skills enabled for the addressed Agent, as sending requires.
    expect(capabilitiesFrameworkApi.availableSkills).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipient_agent_ids: ['agent-1'] }), expect.anything())
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent!)).toEqual([skill])
    expect(JSON.parse(screen.getByTestId('room-value').textContent!)).toMatchObject({
      mentionIds: ['agent-1'],
      mentionRoute: { default_route: 'direct', direct_segments: [{ recipient_agent_ids: ['agent-1'], content: '@Builder /Audit' }] },
    })
    expect(editor).toHaveTextContent('@Builder /Audit')
    // Highlighted like a mention, and deleted as one token.
    expect(editor.querySelector('[data-skill-reference]')).toHaveTextContent('/Audit')
    await user.keyboard('{Backspace}{Backspace}')
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent!)).toEqual([])
    expect(JSON.parse(screen.getByTestId('room-value').textContent!)).toMatchObject({ text: '@Builder' })
  })

  it('leaves an unaddressed Skill menu to the manager default', async () => {
    const user = userEvent.setup({ delay: null })
    render(<FileHarness />, { wrapper: MemoryRouter })
    await user.type(await getEditor(), '/')
    await waitFor(() => expect(capabilitiesFrameworkApi.availableSkills).toHaveBeenCalled())
    expect(vi.mocked(capabilitiesFrameworkApi.availableSkills).mock.lastCall![0]).not.toHaveProperty('recipient_agent_ids')
  })

  it('points an empty Skill menu to the conversation Space library', async () => {
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter initialEntries={['/spaces/space-a/rooms/room-1']}>
      <ConversationScope spaceId="space-b"><FileHarness /></ConversationScope>
    </MemoryRouter>)
    await user.type(await getEditor(), '/')
    expect(await screen.findByRole('link', { name: 'Open Skills' })).toHaveAttribute('href', '/spaces/space-b/skills')
    expect(screen.queryByText('No matching agents or files.')).not.toBeInTheDocument()
  })

  it('uses source Space B for session file search and snapshot while URL stays in A', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(conversationInputApi.searchFiles).mockResolvedValue({ items: [{
      project_folder_id: 'folder-1', workspace_location_id: 'location-1', source: 'repo',
      relative_path: 'src/App.tsx', display_name: 'App.tsx', size_bytes: 20,
    }] } as Awaited<ReturnType<typeof conversationInputApi.searchFiles>>)
    render(<MemoryRouter initialEntries={['/spaces/space-a/rooms/room-1']}>
      <ConversationScope spaceId="space-b"><FileHarness sessionId="session-b" /></ConversationScope>
    </MemoryRouter>)
    const editor = await getEditor()
    await user.type(editor, '@App')
    await user.click(await screen.findByRole('option', { name: /App\.tsx/ }))
    await waitFor(() => expect(projectFoldersApi.file).toHaveBeenCalledWith(
      'project-1', 'folder-1', 'src/App.tsx', expect.objectContaining({ spaceId: 'space-b' }),
    ))
    expect(conversationInputApi.searchFiles).toHaveBeenCalledWith(
      'session-b', expect.any(String), expect.any(AbortSignal), expect.objectContaining({ spaceId: 'space-b', signal: expect.any(AbortSignal) }),
    )
    await waitFor(() => expect(JSON.parse(screen.getByTestId('room-input-parts').textContent!)).toHaveLength(1))
  })

  it('scopes tree and location discovery to B without a Session while URL is A', async () => {
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([{ id: 'location-1', status: 'active', execution_ready: true }] as never)
    const user = userEvent.setup({ delay: null })
    render(<MemoryRouter initialEntries={['/spaces/space-a/rooms/room-1']}>
      <ConversationScope spaceId="space-b"><FileHarness discoverLocation /></ConversationScope>
    </MemoryRouter>)
    await user.type(await getEditor(), '@App')
    await screen.findByRole('option', { name: /App\.tsx/ })
    expect(projectFoldersApi.tree).toHaveBeenCalledWith('project-1', 'folder-1', '.', 0, expect.objectContaining({ spaceId: 'space-b' }))
    expect(projectFoldersApi.locations).toHaveBeenCalledWith('project-1', 'folder-1', expect.objectContaining({ spaceId: 'space-b' }))
  })

  it('sends on plain Enter', async () => {
    render(<Harness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })

  it('does not send on Shift+Enter (inserts a hard break instead)', async () => {
    render(<Harness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
    expect(editor.querySelectorAll('br').length).toBeGreaterThan(0)
  })

  it('does not send while IME composition is in progress (isComposing or keyCode 229)', async () => {
    render(<Harness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, keyCode: 229, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
  })

  it('still sends on a normal Enter after a composition ends', async () => {
    render(<Harness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })

  it('hides the placeholder after a whitespace-only edit', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Harness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    await user.type(editor, ' ')
    await waitFor(() => expect(screen.queryByText('Message...')).not.toBeInTheDocument())
  })

  it('combines Agent and File results in the @ menu and references a File by keyboard', async () => {
    const user = userEvent.setup({ delay: null })
    render(<FileHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.type(editor, '@')
    await screen.findByRole('listbox', { name: 'Agents and Files' })
    expect(screen.getByRole('option', { name: /@Builder/ })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /App\.tsx/ })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'ArrowDown', bubbles: true, cancelable: true })
    fireEvent.keyDown(editor, { key: 'Enter', bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.queryByRole('option', { name: /App\.tsx/ })).not.toBeInTheDocument())
    // The body's digest, which the server admits, not the on-disk `sha256`.
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent ?? '[]')).toMatchObject([{
      kind: 'file_reference', relative_path: 'src/App.tsx', sha256: await sha256Utf8('export const App = 1'),
    }])
    expect(document.querySelector('[data-file-reference]')).toHaveTextContent('src/App.tsx')
  })

  it('finds a file beyond the first two hundred of a large Folder tree', async () => {
    const user = userEvent.setup({ delay: null })
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'repo', path: '.', type: 'dir', children: [
        ...Array.from({ length: 220 }, (_, index) => ({ name: `file-${index}.ts`, path: `src/file-${index}.ts`, type: 'file' as const, size: 1 })),
        { name: 'zeta.ts', path: 'src/zeta.ts', type: 'file', size: 1 },
      ],
    })
    render(<FileHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.type(editor, '@zeta')
    expect(await screen.findByRole('option', { name: /zeta\.ts/ })).toBeInTheDocument()
  })

  it('keeps the @ menu open when authorized file search finishes with no matches', async () => {
    const user = userEvent.setup({ delay: null })
    let resolveTree!: (tree: FileNode) => void
    vi.mocked(projectFoldersApi.tree).mockReturnValueOnce(new Promise<FileNode>(resolve => {
      resolveTree = resolve
    }))
    render(<EmptyResultsFileHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()

    await user.type(editor, '@')
    const listbox = await screen.findByRole('listbox', { name: 'Agents and Files' })

    resolveTree({ name: 'repo', path: '.', type: 'dir', children: [] })
    await waitFor(() => expect(screen.getByText('No matching agents or files.')).toBeInTheDocument())
    expect(listbox).toBeInTheDocument()
  })

  function currentRoute() {
    return JSON.parse(screen.getByTestId('room-route').textContent ?? '{}')
  }

  async function mention(editor: HTMLElement, user: ReturnType<typeof userEvent.setup>, before: string, query: string, name: RegExp) {
    await user.type(editor, `${before}@${query}`, { skipClick: true })
    fireEvent.click(await screen.findByRole('option', { name }))
  }

  it('shows no route line for a message that mentions nobody', async () => {
    const user = userEvent.setup({ delay: null })
    render(<RoutingHarness />, { wrapper: MemoryRouter })
    await user.type(await getEditor(), 'What changed today?')
    await waitFor(() => expect(JSON.parse(screen.getByTestId('room-routing').textContent ?? '{}')).toMatchObject({ text: 'What changed today?' }))
    expect(screen.queryByTestId('room-message-route')).not.toBeInTheDocument()
    expect(currentRoute()).toEqual({ routing_mode: 'direct', recipient_segments: [], coordination_target_agent_ids: [] })
  })

  it('sends a message that opens with a mention directly, mention kept, and offers the manager instead', async () => {
    const user = userEvent.setup({ delay: null })
    render(<RoutingHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.click(editor)
    await mention(editor, user, '', 'Buil', /@Builder/)
    await user.type(editor, 'fix the build', { skipClick: true })

    await waitFor(() => expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ Direct to Builder'))
    expect(currentRoute()).toEqual({
      routing_mode: 'direct',
      recipient_segments: [{ recipient_agent_ids: ['agent-1'], content: '@Builder fix the build' }],
      coordination_target_agent_ids: [],
    })

    await user.click(screen.getByRole('button', { name: 'Let the manager arrange it instead' }))
    expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ To the manager to arrange · with Builder')
    expect(currentRoute()).toEqual({ routing_mode: 'agent_coordination', recipient_segments: [], coordination_target_agent_ids: ['agent-1'] })
  })

  it('hands a mid-sentence mention to the manager with the Agent as target, and toggles both ways', async () => {
    const user = userEvent.setup({ delay: null })
    render(<RoutingHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.click(editor)
    await mention(editor, user, '你可以派 ', 'Buil', /@Builder/)
    await user.type(editor, '去查', { skipClick: true })

    await waitFor(() => expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ To the manager to arrange · with Builder'))
    expect(currentRoute()).toEqual({ routing_mode: 'agent_coordination', recipient_segments: [], coordination_target_agent_ids: ['agent-1'] })
    expect(JSON.parse(screen.getByTestId('room-routing').textContent ?? '{}').text).toBe('你可以派 @Builder 去查')

    await user.click(screen.getByRole('button', { name: 'Send directly to Builder instead' }))
    expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ Direct to Builder')
    expect(currentRoute()).toEqual({
      routing_mode: 'direct',
      recipient_segments: [{ recipient_agent_ids: ['agent-1'], content: '你可以派 @Builder 去查' }],
      coordination_target_agent_ids: [],
    })
    // Editing the words keeps the choice; it is about these mentions.
    await user.type(editor, '吧', { skipClick: true })
    await waitFor(() => expect(JSON.parse(screen.getByTestId('room-routing').textContent ?? '{}').text).toBe('你可以派 @Builder 去查吧'))
    expect(currentRoute().routing_mode).toBe('direct')

    await user.click(screen.getByRole('button', { name: 'Let the manager arrange it instead' }))
    expect(currentRoute().routing_mode).toBe('agent_coordination')
  })

  it('asks again when the mentions change after a choice', async () => {
    const user = userEvent.setup({ delay: null })
    render(<RoutingHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.click(editor)
    await mention(editor, user, 'ask ', 'Buil', /@Builder/)
    await user.click(await screen.findByRole('button', { name: 'Send directly to Builder instead' }))
    expect(currentRoute().routing_mode).toBe('direct')

    await mention(editor, user, 'and ', 'Crit', /@Critic/)
    await waitFor(() => expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ To the manager to arrange · with Builder, Critic'))
    expect(currentRoute()).toMatchObject({ routing_mode: 'agent_coordination', coordination_target_agent_ids: ['agent-1', 'agent-2'] })
  })

  it('segments a mention that opens each line, each part keeping its own address', async () => {
    const user = userEvent.setup({ delay: null })
    render(<RoutingHarness />, { wrapper: MemoryRouter })
    const editor = await getEditor()
    await user.click(editor)
    await mention(editor, user, '', 'Buil', /@Builder/)
    await user.type(editor, 'fix the build', { skipClick: true })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    await mention(editor, user, '', 'Crit', /@Critic/)
    await user.type(editor, 'review it', { skipClick: true })

    await waitFor(() => expect(currentRoute()).toEqual({
      routing_mode: 'direct',
      recipient_segments: [
        { recipient_agent_ids: ['agent-1'], content: '@Builder fix the build' },
        { recipient_agent_ids: ['agent-2'], content: '@Critic review it' },
      ],
      coordination_target_agent_ids: [],
    }))
    expect(screen.getByTestId('room-message-route')).toHaveTextContent('→ Direct to Builder, Critic')
  })

  it('puts a saved draft back with the route the person chose for it', async () => {
    render(<RoutingHarness restore={{ token: 1, text: 'please ask @Builder to fix it', routeChoice: 'direct' }} />, { wrapper: MemoryRouter })
    await waitFor(() => expect(currentRoute()).toEqual({
      routing_mode: 'direct',
      recipient_segments: [{ recipient_agent_ids: ['agent-1'], content: 'please ask @Builder to fix it' }],
      coordination_target_agent_ids: [],
    }))
  })

  it('puts a saved draft back with its Agent mentions still addressed', async () => {
    render(<RoutingHarness restore={{ token: 1, text: 'Context first @Builder fix the build\nthen @Critic review it' }} />, { wrapper: MemoryRouter })

    await waitFor(() => expect(JSON.parse(screen.getByTestId('room-routing').textContent ?? '{}')).toMatchObject({
      text: 'Context first @Builder fix the build\nthen @Critic review it',
      mentionIds: ['agent-1', 'agent-2'],
    }))
    const editor = document.querySelector('.ProseMirror') as HTMLElement
    expect(editor).toHaveTextContent('Context first @Builder fix the build')
    expect(editor.querySelectorAll('[data-agent-id]')).toHaveLength(2)
  })
})
