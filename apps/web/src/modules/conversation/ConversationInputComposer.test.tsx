import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type { ConversationInputMediaOut, RuntimePromptCapabilities } from '@rainver/protocol'
import { ConversationComposer } from './ConversationComposer'
import { ConversationInputPartsView } from './ConversationInputComposer'
import { conversationInputApi, projectFoldersApi } from '../../api/client'
import type { ConversationInputPart } from '@rainver/protocol'

vi.mock('../../api/client', () => ({
  conversationInputApi: {
    uploadImage: vi.fn(),
    deletePendingImage: vi.fn().mockResolvedValue(null),
    imageBlob: vi.fn(),
    searchFiles: vi.fn(),
  },
  projectFoldersApi: {
    tree: vi.fn(),
    locations: vi.fn(),
    file: vi.fn(),
  },
}))

function Harness({ projectId, projectFolderId, sessionId, inputCapabilities }: { projectId?: string; projectFolderId?: string; sessionId?: string; inputCapabilities?: RuntimePromptCapabilities }) {
  const [parts, setParts] = React.useState<ConversationInputPart[]>([])
  const [sent, setSent] = React.useState(0)
  return (
    <>
      <ConversationComposer
        editor={<textarea aria-label="Message" />}
        sending={false}
        sendDisabled={false}
        onSend={() => setSent(value => value + 1)}
        inputParts={parts}
        onInputPartsChange={setParts}
        projectId={projectId}
        projectFolderId={projectFolderId}
        sessionId={sessionId}
        inputCapabilities={inputCapabilities}
      />
      <output data-testid="parts">{JSON.stringify(parts)}</output>
      <output data-testid="sent">{sent}</output>
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(conversationInputApi.uploadImage).mockImplementation(async (file, onProgress) => {
    onProgress?.(100)
    return {
      media_id: 'media-1', filename: file.name, media_type: file.type as 'image/png',
      byte_size: file.size, sha256: 'a'.repeat(64), expires_at: new Date().toISOString(),
    } satisfies ConversationInputMediaOut
  })
  if (!URL.createObjectURL) Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test' })
  if (!URL.revokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined })
})

function imageFile(name = 'diagram.png') {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
}

describe('shared conversation input composer', () => {
  it('uploads a pasted image, renders its thumbnail, and permits image-only send', async () => {
    render(<Harness />)
    const editor = screen.getByLabelText('Message')
    fireEvent.paste(editor, { clipboardData: { files: [imageFile()], types: ['Files'], getData: () => '' } })

    expect(conversationInputApi.uploadImage).toHaveBeenCalled()
    await waitFor(() => expect(JSON.parse(screen.getByTestId('parts').textContent ?? '[]')).toMatchObject([{ kind: 'image', media_id: 'media-1' }]))
    expect(screen.getByAltText('diagram.png')).toBeInTheDocument()
    expect(JSON.parse(screen.getByTestId('parts').textContent ?? '[]')).toMatchObject([{ kind: 'image', media_id: 'media-1' }])
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByTestId('sent')).toHaveTextContent('1')
  })

  it('accepts a dropped image and keeps send disabled while upload is unresolved', async () => {
    let finish!: (value: ConversationInputMediaOut) => void
    vi.mocked(conversationInputApi.uploadImage).mockImplementation((file, onProgress) => {
      onProgress?.(42)
      return new Promise(resolve => { finish = resolve as (value: ConversationInputMediaOut) => void })
    })
    render(<Harness />)
    const editor = screen.getByLabelText('Message')
    fireEvent.drop(editor, { dataTransfer: { files: [imageFile('drop.webp')] } })
    expect(await screen.findByRole('progressbar', { name: 'Uploading drop.webp' })).toHaveAttribute('value', '42')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    finish({ media_id: 'media-2', filename: 'drop.webp', media_type: 'image/webp', byte_size: 4, sha256: 'b'.repeat(64), expires_at: new Date().toISOString() })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled())
  })

  it('cancels an unresolved upload so a late response cannot reinsert it', async () => {
    let finish!: (value: ConversationInputMediaOut) => void
    vi.mocked(conversationInputApi.uploadImage).mockImplementation((file, onProgress) => {
      onProgress?.(42)
      return new Promise(resolve => { finish = resolve as (value: ConversationInputMediaOut) => void })
    })
    render(<Harness />)
    fireEvent.drop(screen.getByLabelText('Message'), { dataTransfer: { files: [imageFile('cancel.png')] } })
    const remove = await screen.findByRole('button', { name: 'Remove cancel.png' })
    fireEvent.click(remove)
    finish({ media_id: 'media-cancelled', filename: 'cancel.png', media_type: 'image/png', byte_size: 4, sha256: 'b'.repeat(64), expires_at: new Date().toISOString() })
    await waitFor(() => expect(conversationInputApi.deletePendingImage).toHaveBeenCalledWith('media-cancelled'))
    expect(JSON.parse(screen.getByTestId('parts').textContent ?? '[]')).toEqual([])
    expect(screen.getByTestId('sent')).toHaveTextContent('0')
  })

  it('blocks Enter while an image upload is unresolved', async () => {
    vi.mocked(conversationInputApi.uploadImage).mockImplementation(() => new Promise(() => undefined))
    render(<Harness />)
    const editor = screen.getByLabelText('Message')
    fireEvent.drop(editor, { dataTransfer: { files: [imageFile('enter.png')] } })
    await screen.findByRole('progressbar', { name: 'Uploading enter.png' })
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false } })
    expect(screen.getByTestId('sent')).toHaveTextContent('0')
  })

  it('removes a completed image and deletes its pending media record', async () => {
    render(<Harness />)
    fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files: [imageFile()], types: ['Files'], getData: () => '' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove diagram.png' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Remove diagram.png' }))
    await waitFor(() => expect(JSON.parse(screen.getByTestId('parts').textContent ?? '[]')).toEqual([]))
    expect(conversationInputApi.deletePendingImage).toHaveBeenCalledWith('media-1')
  })

  it('explains an image capability mismatch and blocks send without dropping the image', async () => {
    render(<Harness inputCapabilities={{ image: false, embedded_context: null, resource_link: null }} />)
    fireEvent.paste(screen.getByLabelText('Message'), { clipboardData: { files: [imageFile()], types: ['Files'], getData: () => '' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not supported/))
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(JSON.parse(screen.getByTestId('parts').textContent ?? '[]')).toHaveLength(1)
  })

  it('searches the authorized Project Folder and creates a bounded file reference', async () => {
    vi.mocked(projectFoldersApi.tree).mockResolvedValue({
      name: 'source', path: '.', type: 'dir', children: [{
        name: 'src', path: 'src', type: 'dir', children: [{ name: 'App.tsx', path: 'src/App.tsx', type: 'file', size: 12 }],
      }],
    })
    vi.mocked(projectFoldersApi.locations).mockResolvedValue([{ id: 'location-1', project_folder_id: 'folder-1', execution_host_id: 'host-1', execution_host_kind: 'server', display_path: null, status: 'active', execution_ready: true } as never])
    vi.mocked(projectFoldersApi.file).mockResolvedValue({ path: 'src/App.tsx', content: 'export const App = 1', size: 20, line_count: 1, sha256: 'c'.repeat(64) })

    render(<Harness projectId="project-1" projectFolderId="folder-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reference file' }))
    const search = await screen.findByRole('textbox', { name: 'Search files' })
    fireEvent.change(search, { target: { value: 'App' } })
    fireEvent.click(await screen.findByRole('option', { name: /App\.tsx/ }))

    await waitFor(() => expect(screen.getByText('src/App.tsx')).toBeInTheDocument())
    const parts = JSON.parse(screen.getByTestId('parts').textContent ?? '[]')
    expect(parts).toMatchObject([{ kind: 'file_reference', relative_path: 'src/App.tsx', workspace_location_id: 'location-1' }])
    expect(screen.getByLabelText('Message').parentElement).toContainElement(screen.getByLabelText('Referenced files'))
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled()
  })

  it('uses the initialized session file-search boundary instead of a generic tree search', async () => {
    vi.mocked(conversationInputApi.searchFiles).mockResolvedValue({
      items: [{
        project_folder_id: 'folder-1', workspace_location_id: 'location-1', source: 'Primary · repo',
        relative_path: 'src/App.tsx', display_name: 'App.tsx', kind: 'file', size_bytes: 20,
      }],
      truncated: false,
    })
    vi.mocked(projectFoldersApi.file).mockResolvedValue({ path: 'src/App.tsx', content: 'export const App = 1', size: 20, line_count: 1, sha256: 'c'.repeat(64) })

    render(<Harness projectId="project-1" projectFolderId="folder-1" sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reference file' }))
    expect(await screen.findByRole('option', { name: /App\.tsx/ })).toBeInTheDocument()
    expect(conversationInputApi.searchFiles).toHaveBeenCalledWith('session-1', '', expect.any(AbortSignal))
    expect(projectFoldersApi.tree).not.toHaveBeenCalled()
  })

  it('restores historical images through the authenticated media endpoint', async () => {
    vi.mocked(conversationInputApi.imageBlob).mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    render(<ConversationInputPartsView parts={[{
      kind: 'image', media_id: 'media-history', filename: 'history.png', media_type: 'image/png', byte_size: 5, sha256: 'f'.repeat(64),
    }]} />)
    await waitFor(() => expect(screen.getByAltText('history.png')).toBeInTheDocument())
    expect(screen.getByAltText('history.png')).toHaveClass('h-24', 'w-full', 'object-contain')
    expect(conversationInputApi.imageBlob).toHaveBeenCalledWith('media-history')
  })

  it('shows an accessible fallback when a historical image cannot be loaded', async () => {
    vi.mocked(conversationInputApi.imageBlob).mockRejectedValue(new Error('gone'))
    render(<ConversationInputPartsView parts={[{
      kind: 'image', media_id: 'media-gone', filename: 'gone.png', media_type: 'image/png', byte_size: 5, sha256: 'f'.repeat(64),
    }]} />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'gone.png unavailable' })).toHaveTextContent('Image unavailable'))
  })
})
