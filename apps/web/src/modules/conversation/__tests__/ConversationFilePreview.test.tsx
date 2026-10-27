import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ConversationFilePreview } from '../ConversationFilePreview'
import { ConversationScope } from '../ConversationScope'
import { MessageResponse } from '../../../components/ai-elements/message'
import { runsApi } from '../../../api/client'

vi.mock('../../../api/client', () => ({ runsApi: { filePreview: vi.fn() } }))
function Location() { return <output data-testid="location">{useLocation().pathname + useLocation().search}</output> }
function show(body: string, run = 'run-1') {
  return render(<MemoryRouter initialEntries={['/spaces/active/home']}><Location /><ConversationScope spaceId="source"><ConversationFilePreview runId={run}><MessageResponse>{body}</MessageResponse></ConversationFilePreview></ConversationScope></MemoryRouter>)
}
beforeEach(() => { vi.mocked(runsApi.filePreview).mockReset(); URL.createObjectURL = vi.fn(() => 'blob:preview'); URL.revokeObjectURL = vi.fn() })

describe('conversation file preview', () => {
  it.each(['AGENTS.md', './AGENTS.md', '.agent/INDEX.md', 'src/app.ts:12', '../outside.md'])('preserves the relative file reference %s for server validation', async path => {
    vi.mocked(runsApi.filePreview).mockResolvedValue({ kind: 'workspace', project_id: 'project-1', folder_id: 'folder-2', path: 'AGENTS.md' })
    show(`[File](${path})`)
    expect(screen.queryByText(/\[blocked\]/)).toBeNull()
    fireEvent.click(await screen.findByRole('link', { name: 'File' }))
    await waitFor(() => expect(runsApi.filePreview).toHaveBeenCalledWith('run-1', path, expect.objectContaining({ spaceId: 'source' })))
  })
  it('opens a relative image only on click and preserves its original path', async () => {
    vi.mocked(runsApi.filePreview).mockRejectedValue(new Error('404'))
    show('![Local image](images/preview.png)')
    expect(screen.queryByRole('img')).toBeNull()
    expect(runsApi.filePreview).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Local image' }))
    await waitFor(() => expect(runsApi.filePreview).toHaveBeenCalledWith('run-1', 'images/preview.png', expect.objectContaining({ spaceId: 'source' })))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
  })
  it('opens the linked file in source-Space Files & Code without navigating to the host path', async () => {
    let resolve!: (value: { kind: 'workspace'; project_id: string; folder_id: string; path: string; line: number }) => void
    vi.mocked(runsApi.filePreview).mockReturnValueOnce(new Promise(r => { resolve = r }))
    show('[Report](/home/person/repo/.agent/report.md:12)')
    fireEvent.click(await screen.findByRole('link', { name: 'Report' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { resolve({ kind: 'workspace', project_id: 'project-1', folder_id: 'folder-2', path: '.agent/report.md', line: 12 }) })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/spaces/source/projects/project-1/files?folder=folder-2&path=.agent%2Freport.md&line=12'))
    expect(runsApi.filePreview).toHaveBeenCalledWith('run-1', '/home/person/repo/.agent/report.md:12', expect.objectContaining({ spaceId: 'source' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows a raster image in a closable dialog and releases its object URL', async () => {
    vi.mocked(runsApi.filePreview).mockResolvedValue({ kind: 'image', name: 'preview.png', mime_type: 'image/png', content_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=' })
    show('![Preview](/__run_output__/preview.png)')
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('img', { name: 'preview.png' })).toHaveAttribute('src', 'blob:preview')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    expect(screen.getByTestId('location')).toHaveTextContent('/spaces/active/home')
  })
  it('keeps unavailable previews on the current page and lets the person retry', async () => {
    vi.mocked(runsApi.filePreview).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ kind: 'text', name: 'note.md', content: '<script>safe text</script>' })
    show('[Preview](/tmp/gone.png)')
    fireEvent.click(await screen.findByRole('link', { name: 'Preview' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('location')).toHaveTextContent('/spaces/active/home')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('<script>safe text</script>')).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
  })
  it('does not navigate a local link without a source Run', async () => {
    render(<MemoryRouter><MessageResponse>{'[Report](/tmp/no-run.md)'}</MessageResponse></MemoryRouter>)
    fireEvent.click(await screen.findByRole('link', { name: 'Report' }))
    expect(screen.getByRole('status')).toHaveTextContent('unavailable')
    expect(runsApi.filePreview).not.toHaveBeenCalled()
  })
  it('discards an older response after a newer preview is opened', async () => {
    let resolve!: (value: { kind: 'text'; name: string; content: string }) => void
    vi.mocked(runsApi.filePreview).mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce({ kind: 'text', name: 'new.txt', content: 'new preview' })
    show('[Old](/__run_output__/old.txt) [New](/__run_output__/new.txt)')
    fireEvent.click(await screen.findByRole('link', { name: 'Old' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'New' }))
    expect(await screen.findByText('new preview')).toBeInTheDocument()
    resolve({ kind: 'text', name: 'old.txt', content: 'stale preview' })
    await waitFor(() => expect(screen.queryByText('stale preview')).toBeNull())
  })
})
