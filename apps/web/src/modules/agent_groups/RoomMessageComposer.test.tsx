import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomMessageComposer, emptyRoomMessageComposerValue } from './RoomMessageComposer'
import { projectFoldersApi } from '../../api/client'
import type { ConversationInputPart } from '@rainver/protocol'
import type { FileNode } from '../../types/api'

vi.mock('../../api/client', () => ({
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

function FileHarness() {
  const [value, setValue] = useState(emptyRoomMessageComposerValue())
  const [parts, setParts] = useState<ConversationInputPart[]>([])
  return <>
    <RoomMessageComposer
      value={value}
      onChange={setValue}
      agents={[{ id: 'agent-1', name: 'Builder', status: 'active' }]}
      members={[{ agent_id: 'agent-1', status: 'active' }]}
      disabled={false}
      resetToken={0}
      onSubmit={() => undefined}
      projectId="project-1"
      projectFolderId="folder-1"
      fileSources={[{ projectFolderId: 'folder-1', workspaceLocationId: 'location-1', label: 'Primary · repo' }]}
      inputParts={parts}
      onInputPartsChange={setParts}
    />
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

async function getEditor() {
  await screen.findByText('Message...', {}, { timeout: 5000 })
  return document.querySelector('.ProseMirror') as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(projectFoldersApi.tree).mockResolvedValue({
    name: 'repo', path: '.', type: 'dir', children: [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file', size: 20 }],
  })
  vi.mocked(projectFoldersApi.file).mockResolvedValue({
    path: 'src/App.tsx', content: 'export const App = 1', size: 20, line_count: 1, sha256: 'e'.repeat(64),
  })
})

describe('RoomMessageComposer keyboard behavior', () => {
  it('sends on plain Enter', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })

  it('does not send on Shift+Enter (inserts a hard break instead)', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
    expect(editor.querySelectorAll('br').length).toBeGreaterThan(0)
  })

  it('does not send while IME composition is in progress (isComposing or keyCode 229)', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, keyCode: 229, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')
  })

  it('still sends on a normal Enter after a composition ends', async () => {
    render(<Harness />)
    const editor = await getEditor()

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, isComposing: true, bubbles: true, cancelable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(screen.getByTestId('submit-calls').textContent).toBe('0')

    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.getByTestId('submit-calls').textContent).toBe('1'))
  })

  it('hides the placeholder after a whitespace-only edit', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Harness />)
    const editor = await getEditor()

    await user.type(editor, ' ')
    await waitFor(() => expect(screen.queryByText('Message...')).not.toBeInTheDocument())
  })

  it('combines Agent and File results in the @ menu and references a File by keyboard', async () => {
    const user = userEvent.setup({ delay: null })
    render(<FileHarness />)
    const editor = await getEditor()
    await user.type(editor, '@')
    await screen.findByRole('listbox', { name: 'Agents and Files' })
    expect(screen.getByRole('option', { name: /@Builder/ })).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: /App\.tsx/ })).toBeInTheDocument()
    fireEvent.keyDown(editor, { key: 'ArrowDown', bubbles: true, cancelable: true })
    fireEvent.keyDown(editor, { key: 'Enter', bubbles: true, cancelable: true })
    await waitFor(() => expect(screen.queryByRole('option', { name: /App\.tsx/ })).not.toBeInTheDocument())
    expect(JSON.parse(screen.getByTestId('room-input-parts').textContent ?? '[]')).toMatchObject([{ kind: 'file_reference', relative_path: 'src/App.tsx' }])
    expect(document.querySelector('[data-file-reference]')).toHaveTextContent('src/App.tsx')
  })

  it('keeps the @ menu open when authorized file search finishes with no matches', async () => {
    const user = userEvent.setup({ delay: null })
    let resolveTree!: (tree: FileNode) => void
    vi.mocked(projectFoldersApi.tree).mockReturnValueOnce(new Promise<FileNode>(resolve => {
      resolveTree = resolve
    }))
    render(<EmptyResultsFileHarness />)
    const editor = await getEditor()

    await user.type(editor, '@')
    const listbox = await screen.findByRole('listbox', { name: 'Agents and Files' })

    resolveTree({ name: 'repo', path: '.', type: 'dir', children: [] })
    await waitFor(() => expect(screen.getByText('No matching agents or files.')).toBeInTheDocument())
    expect(listbox).toBeInTheDocument()
  })
})
