import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GmailMonitor, GmailMonitorList } from '@rainver/protocol'
import { ApiRequestError } from '../../../api/client'
import { gmailApi, type GmailMonitorDraft } from '../../../api/gmail'
import { GmailMonitorsCard } from '../gmail/GmailMonitorsCard'

const space = vi.hoisted(() => ({ activeSpaceId: 'space-a', userId: 'user-a' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => space }))
vi.mock('../../../api/gmail', async importOriginal => ({
  ...await importOriginal<typeof import('../../../api/gmail')>(),
  gmailApi: { connections: vi.fn(), monitors: vi.fn(), monitorDrafts: vi.fn(), decideMonitorDraft: vi.fn(), setMonitorStatus: vi.fn(), deleteMonitor: vi.fn() },
}))

const now = '2026-11-16T09:00:00.000Z'
const criteria = { from_any: ['@uni.example'], subject_any: ['interview'], label_any: [] }
const monitor = (id: string, extra: Partial<GmailMonitor> = {}): GmailMonitor => ({ id, connection_id: 'c1', project_id: null, purpose: `Purpose ${id}`, criteria, status: 'active', active_since: now, match_count: 3, last_matched_at: now, created_at: now, updated_at: now, ...extra })
const list = (monitors: GmailMonitor[], extra: Partial<GmailMonitorList> = {}): GmailMonitorList => ({
  push_configured: true, monitors,
  sync: [{ connection_id: 'c1', state: 'ok', push: 'active', last_success_at: now, next_check_at: now, recovery_partial: false, last_error_code: null }],
  recent_matches: [{ monitor_id: 'm1', google_message_id: '18c0ffee', gmail_url: 'https://mail.google.com/mail/u/?authuser=me%40example.test#all/18c0ffee', matched_at: now }],
  ...extra,
})
const draft = (id: string): GmailMonitorDraft => ({ id, created_at: now, connection_id: 'c1', purpose: `Draft ${id}`, criteria })
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const view = () => <MemoryRouter><GmailMonitorsCard /></MemoryRouter>

beforeEach(() => {
  vi.clearAllMocks()
  space.activeSpaceId = 'space-a'; space.userId = 'user-a'
  vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ id: 'c1', mailbox_email: 'me@example.test', status: 'active', granted_scopes: [], last_error_class: null, connected_at: now, disconnected_at: null, agent_read_enabled: false, agent_read_grants: [], updated_at: now }] })
  vi.mocked(gmailApi.monitors).mockResolvedValue(list([]))
  vi.mocked(gmailApi.monitorDrafts).mockResolvedValue([])
})

describe('Gmail new-mail monitoring', () => {
  it('explains how monitors are drafted and shows no mail content, only criteria, status and Gmail links', async () => {
    vi.mocked(gmailApi.monitors).mockResolvedValue(list([monitor('m1', { project_id: 'p1' })]))
    render(view())
    expect(await screen.findByText('Purpose m1')).toBeInTheDocument()
    expect(screen.getByText(/Drafting a monitor never reads your mail/)).toBeInTheDocument()
    expect(screen.getByText('From: @uni.example')).toBeInTheDocument()
    expect(screen.getByText('Subject contains: interview')).toBeInTheDocument()
    expect(screen.getByText(/Instant updates on/)).toBeInTheDocument()
    expect(screen.getByText(/its members cannot see it/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in Gmail' })).toHaveAttribute('href', 'https://mail.google.com/mail/u/?authuser=me%40example.test#all/18c0ffee')
  })

  it('accepts a draft through the proposal decision once per intent, reusing the key after a lost reply', async () => {
    vi.mocked(gmailApi.monitorDrafts).mockResolvedValueOnce([draft('p1')]).mockResolvedValueOnce([draft('p1')]).mockResolvedValue([])
    vi.mocked(gmailApi.decideMonitorDraft).mockRejectedValueOnce(new ApiRequestError('x', 503, 'gmail_authority_busy')).mockResolvedValueOnce(undefined)
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText(/Rainver is busy/)).toBeInTheDocument()
    vi.mocked(gmailApi.monitors).mockResolvedValue(list([monitor('m1')]))
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(await screen.findByText('Purpose m1')).toBeInTheDocument()
    const calls = vi.mocked(gmailApi.decideMonitorDraft).mock.calls
    expect(calls.map(c => [c[0], c[1]])).toEqual([['p1', 'accept'], ['p1', 'accept']])
    expect(calls[0]![2]).toBe(calls[1]![2])
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('pauses, resumes and deletes only after confirmation, and reports a partial recovery honestly', async () => {
    vi.mocked(gmailApi.monitors).mockResolvedValue(list([monitor('m1')], { sync: [{ connection_id: 'c1', state: 'ok', push: 'not_configured', last_success_at: now, next_check_at: now, recovery_partial: true, last_error_code: null }] }))
    vi.mocked(gmailApi.setMonitorStatus).mockResolvedValue({ monitor_id: 'm1', space_id: 'space-a', status: 'paused' })
    vi.mocked(gmailApi.deleteMonitor).mockResolvedValue({ monitor_id: 'm1', space_id: 'space-a', deleted: true })
    render(view())
    expect(await screen.findByText(/could not all be checked/)).toBeInTheDocument()
    expect(screen.getByText(/^Checking on a schedule/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(gmailApi.setMonitorStatus).toHaveBeenCalledWith('m1', 'paused', expect.any(String), expect.objectContaining({ spaceId: 'space-a' })))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(gmailApi.deleteMonitor).not.toHaveBeenCalled()
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(gmailApi.deleteMonitor).toHaveBeenCalledWith('m1', expect.any(String), expect.objectContaining({ spaceId: 'space-a' })))
  })

  it('drops everything when the person or Space changes and ignores the old reply', async () => {
    vi.mocked(gmailApi.monitors).mockResolvedValueOnce(list([monitor('m1')]))
    const { rerender } = render(view())
    expect(await screen.findByText('Purpose m1')).toBeInTheDocument()
    const late = deferred<GmailMonitorList>()
    vi.mocked(gmailApi.monitors).mockReturnValueOnce(late.promise)
    space.userId = 'user-b'
    rerender(view())
    expect(screen.queryByText('Purpose m1')).not.toBeInTheDocument()
    space.userId = 'user-c'
    rerender(view())
    await act(async () => { late.resolve(list([monitor('m9')])) })
    expect(screen.queryByText('Purpose m9')).not.toBeInTheDocument()
  })

  it('clears shown monitors on a hidden 404', async () => {
    vi.mocked(gmailApi.monitors).mockResolvedValueOnce(list([monitor('m1')])).mockRejectedValue(new ApiRequestError('x', 404, 'operation_not_found'))
    vi.mocked(gmailApi.setMonitorStatus).mockRejectedValue(new ApiRequestError('x', 404, 'operation_not_found'))
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('This is no longer available to you.')).toBeInTheDocument()
    expect(screen.queryByText('Purpose m1')).not.toBeInTheDocument()
  })
})
