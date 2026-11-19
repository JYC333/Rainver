import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailConnection, GmailThreadReadOutput, GmailThreadSelection } from '@rainver/protocol'
import { ApiRequestError, projectsApi } from '../../../api/client'
import { gmailApi } from '../../../api/gmail'
import { ProjectGmailThreads } from '../sourcesArea/gmail/ProjectGmailThreads'

const space = vi.hoisted(() => ({ activeSpaceId: 'space-a', userId: 'user-a' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => space }))
vi.mock('../../../core/spaceNav', async () => ({ SpaceLink: (await import('react-router-dom')).Link }))
vi.mock('../../../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../../../api/client')>(), projectsApi: { get: vi.fn() } }))
vi.mock('../../../api/gmail', async importOriginal => {
  const real = await importOriginal<typeof import('../../../api/gmail')>()
  return { ...real, gmailApi: { connections: vi.fn(), selections: vi.fn(), removeSelection: vi.fn(), read: vi.fn() } }
})

const now = '2026-11-16T09:00:00.000Z'
const link = (id: string) => `https://mail.google.com/mail/u/?authuser=me@example.test#all/${id}`
const connection = (id: string, status: GmailConnection['status'] = 'active'): GmailConnection => ({ id, mailbox_email: `${id}@example.test`, status, granted_scopes: [], last_error_class: null, connected_at: now, disconnected_at: null, agent_read_enabled: false, agent_read_grants: [], updated_at: now })
const project = (id: string, extra: Record<string, unknown> = {}) => ({ id, space_id: space.activeSpaceId, name: id, status: 'active', current_user_can_write: true, ...extra })
const selection = (id: string, threadId: string, extra: Partial<GmailThreadSelection> = {}): GmailThreadSelection => ({ id, project_id: 'p1', connection_id: 'c1', google_thread_id: threadId, read_after: null, read_before: null, project_readable: true, gmail_url: link(threadId), created_at: now, updated_at: now, ...extra })
const message = (id: string, text: string) => ({ google_message_id: id, internal_date: now, subject: 'Budget', from: 'Alex', to: 'Me', cc: null, date_header: null, text, text_format: 'plain' as const, text_truncated: false, attachment_count: 0, omitted: null, gmail_url: link(id) })
const readPage = (texts: string[], next: string | null = null): GmailThreadReadOutput => ({ selection_id: 's1', project_id: 'p1', connection_id: 'c1', google_thread_id: 'aa', gmail_url: link('aa'), subject: 'Budget', messages_in_window: 25, messages: texts.map((t, i) => message(`m${i}${t.length}`, t)), next_cursor: next, truncated: false, truncation: [] })
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

const view = (projectId = 'p1') => <MemoryRouter><ProjectGmailThreads projectId={projectId} /></MemoryRouter>

beforeEach(() => {
  vi.clearAllMocks()
  space.activeSpaceId = 'space-a'; space.userId = 'user-a'
  vi.mocked(projectsApi.get).mockImplementation(async id => project(id) as never)
  vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1')] })
  vi.mocked(gmailApi.selections).mockResolvedValue([])
})

describe('Project private Gmail (legacy selections)', () => {
  it('offers no manual search or selection, only the owner\'s earlier selections and the way to monitoring', async () => {
    vi.mocked(gmailApi.selections).mockResolvedValue([selection('s1', 'aa')])
    render(view())
    expect(await screen.findByRole('button', { name: 'Read' })).toBeEnabled()
    expect(screen.getByText('Earlier selected threads')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open Gmail monitoring' })).toHaveAttribute('href', '/sources/access')
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument()
  })

  it('drops selections at once and ignores the old reply when the Project, person or Space changes', async () => {
    vi.mocked(gmailApi.selections).mockResolvedValueOnce([selection('s1', 'aa')])
    const { rerender } = render(view('p1'))
    expect(await screen.findByRole('button', { name: 'Read' })).toBeInTheDocument()
    const late = deferred<GmailThreadSelection[]>()
    vi.mocked(gmailApi.selections).mockReturnValueOnce(late.promise)
    rerender(view('p2'))
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument()
    await waitFor(() => expect(projectsApi.get).toHaveBeenLastCalledWith('p2', expect.objectContaining({ spaceId: 'space-a' })))
    await waitFor(() => expect(gmailApi.selections).toHaveBeenCalledTimes(2))
    space.userId = 'user-b'
    rerender(view('p2'))
    expect(vi.mocked(gmailApi.selections).mock.calls[1]![1].signal!.aborted).toBe(true)
    await act(async () => { late.resolve([selection('s9', 'ff')]) })
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument()
    space.activeSpaceId = 'space-b'
    rerender(view('p2'))
    await waitFor(() => expect(gmailApi.connections).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 'space-b' })))
  })

  it('reads pages by cursor, refreshes manually and drops the body when the selection is removed', async () => {
    vi.mocked(gmailApi.selections).mockResolvedValue([selection('s1', 'aa')])
    vi.mocked(gmailApi.read).mockResolvedValueOnce(readPage(['Newest body text'], 'read.2')).mockResolvedValueOnce(readPage(['Older body text']))
      .mockResolvedValueOnce(readPage(['Newest body text refreshed'], 'read.2'))
    vi.mocked(gmailApi.removeSelection).mockResolvedValue({ selection_id: 's1', space_id: 'space-a', removed: true })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Read' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Newest body text')).toBeInTheDocument()
    expect(within(dialog).getByText('Page 1 · 25 messages in the window')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Older messages' }))
    expect(await within(dialog).findByText('Older body text')).toBeInTheDocument()
    expect(vi.mocked(gmailApi.read).mock.calls[1]![1]).toBe('read.2')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }))
    expect(await within(dialog).findByText('Newest body text refreshed')).toBeInTheDocument()
    expect(vi.mocked(gmailApi.read).mock.calls[2]![1]).toBeNull()
    vi.mocked(gmailApi.selections).mockResolvedValue([])
    fireEvent.click(screen.getByRole('button', { name: 'Remove', hidden: true }))
    await waitFor(() => expect(screen.queryByText('Newest body text refreshed')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('clears an open thread on a hidden 404 and keeps the body for a retryable limit', async () => {
    vi.mocked(gmailApi.selections).mockResolvedValue([selection('s1', 'aa')])
    vi.mocked(gmailApi.read).mockResolvedValueOnce(readPage(['Body before limit'], 'read.2')).mockRejectedValueOnce(new ApiRequestError('x', 429, 'gmail_rate_limited'))
      .mockRejectedValueOnce(new ApiRequestError('x', 404, 'gmail_not_found'))
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Read' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Body before limit')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Older messages' }))
    expect(await within(dialog).findByText(/Gmail limit reached/)).toBeInTheDocument()
    expect(within(dialog).getByText('Body before limit')).toBeInTheDocument()
    vi.mocked(gmailApi.selections).mockResolvedValue([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Older messages' }))
    await waitFor(() => expect(screen.queryByText('Body before limit')).not.toBeInTheDocument())
    expect(await screen.findByText('No earlier selected threads for this Project.')).toBeInTheDocument()
  })

  it('shows the reconnect path for an expired grant and offers no search', async () => {
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1', 'reauth_required')] })
    render(view())
    expect(await screen.findByText(/Google no longer accepts this connection/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Manage Gmail connections' })).toHaveAttribute('href', '/sources/access')
    expect(screen.queryByLabelText('Search your mail')).not.toBeInTheDocument()
  })

  it('clears everything when Project access is lost', async () => {
    vi.mocked(projectsApi.get).mockRejectedValue(new ApiRequestError('x', 404, 'not_found'))
    render(view())
    expect(await screen.findByText('This is no longer available to you.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Search your mail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('removes once per intent, reusing the idempotency key after a failed reply, and keeps the newest list', async () => {
    vi.mocked(gmailApi.selections).mockResolvedValueOnce([selection('s1', 'aa')]).mockResolvedValueOnce([selection('s1', 'aa')]).mockResolvedValueOnce([])
    vi.mocked(gmailApi.removeSelection).mockRejectedValueOnce(new ApiRequestError('x', 503, 'gmail_authority_busy')).mockResolvedValueOnce({ selection_id: 's1', space_id: 'space-a', removed: true })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText(/Rainver is busy/)).toBeInTheDocument()
    await waitFor(() => expect(gmailApi.selections).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('No earlier selected threads for this Project.')).toBeInTheDocument()
    const keys = vi.mocked(gmailApi.removeSelection).mock.calls.map(c => c[1])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })
})
