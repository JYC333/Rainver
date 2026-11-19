import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_MANUAL_REVOCATION_URL, type GmailConnection, type GmailConnectionList } from '@rainver/protocol'
import { ApiRequestError } from '../../../api/client'
import { gmailApi } from '../../../api/gmail'
import { GmailConnectionsCard } from '../gmail/GmailConnectionsCard'

const space = vi.hoisted(() => ({ activeSpaceId: 'space-a', userId: 'user-a' }))
vi.mock('../../../contexts/SpaceContext', () => ({ useSpace: () => space }))
vi.mock('../../../api/gmail', async importOriginal => ({
  ...await importOriginal<typeof import('../../../api/gmail')>(),
  gmailApi: { connections: vi.fn(), digests: vi.fn(), setDigestStatus: vi.fn(), endDigest: vi.fn(), startOAuth: vi.fn(), disconnect: vi.fn(), forget: vi.fn(), setAgentRead: vi.fn(), revokeAgentReadGrant: vi.fn() },
}))

const now = '2026-11-16T09:00:00.000Z'
const connection = (id: string, status: GmailConnection['status'] = 'active'): GmailConnection => ({ id, mailbox_email: `${id}@example.test`, status, granted_scopes: [], last_error_class: null, connected_at: now, disconnected_at: status === 'disconnected' ? now : null, agent_read_enabled: false, agent_read_grants: [], updated_at: now })
function Location() { const l = useLocation(); return <output aria-label="location">{l.pathname + l.search}</output> }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function disconnect() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Disconnect' }))[0]!)
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
}
const view = (entry = '/spaces/space-a/sources/access') => <MemoryRouter initialEntries={[entry]}><GmailConnectionsCard /><Location /></MemoryRouter>

beforeEach(() => {
  vi.clearAllMocks()
  space.activeSpaceId = 'space-a'; space.userId = 'user-a'
  vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [] })
  vi.mocked(gmailApi.digests).mockResolvedValue([])
})

describe('Personal Gmail connections', () => {
  it('turns Agent reading on and off only by the owner’s click, off by default, and explains its limits', async () => {
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1'), connection('c2', 'reauth_required')] })
    vi.mocked(gmailApi.setAgentRead).mockResolvedValue({ connection_id: 'c1', space_id: 'space-a', agent_read_enabled: true })
    render(view())
    const section = await screen.findByLabelText('Agent access')
    expect(within(section).getByText('Off')).toBeInTheDocument()
    expect(within(section).getByText(/at most five at a time/)).toBeInTheDocument()
    expect(within(section).getByText(/once per Project, on the card in the conversation where you ask/)).toBeInTheDocument()
    // Only an active connection offers it.
    expect(screen.getAllByLabelText('Agent access')).toHaveLength(1)
    expect(gmailApi.setAgentRead).not.toHaveBeenCalled()
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ ...connection('c1'), agent_read_enabled: true }] })
    fireEvent.click(within(section).getByRole('button', { name: 'Allow Agent reading' }))
    await waitFor(() => expect(gmailApi.setAgentRead).toHaveBeenCalledWith('c1', true, expect.any(String), expect.objectContaining({ spaceId: 'space-a' })))
    const on = await screen.findByLabelText('Agent access')
    expect(await within(on).findByText('On')).toBeInTheDocument()
    vi.mocked(gmailApi.setAgentRead).mockResolvedValue({ connection_id: 'c1', space_id: 'space-a', agent_read_enabled: false })
    fireEvent.click(within(on).getByRole('button', { name: 'Turn off Agent reading' }))
    await waitFor(() => expect(gmailApi.setAgentRead).toHaveBeenLastCalledWith('c1', false, expect.any(String), expect.anything()))
  })


  it('lists each Project the owner allowed and revokes one only after confirmation', async () => {
    const grant = { grant_id: 'g1', project_id: 'p1', project_name: 'Thesis', purpose: 'on_demand_read' as const, created_at: now, last_used_at: now }
    const unused = { ...grant, grant_id: 'g2', project_id: 'p2', project_name: null, last_used_at: null }
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ ...connection('c1'), agent_read_enabled: true, agent_read_grants: [grant, unused] }] })
    vi.mocked(gmailApi.revokeAgentReadGrant).mockResolvedValue({} as never)
    render(view())
    const list = await screen.findByRole('list', { name: 'Projects you allowed' })
    expect(within(list).getByText('Thesis')).toBeInTheDocument()
    expect(within(list).getByText('A Project you no longer work in')).toBeInTheDocument()
    expect(within(list).getByText(/not used yet/)).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'Revoke Agent reading in Thesis' }))
    expect(gmailApi.revokeAgentReadGrant).not.toHaveBeenCalled()
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ ...connection('c1'), agent_read_enabled: true, agent_read_grants: [unused] }] })
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(gmailApi.revokeAgentReadGrant).toHaveBeenCalledWith('g1', expect.any(String), expect.objectContaining({ spaceId: 'space-a' })))
    await waitFor(() => expect(screen.queryByText('Thesis')).not.toBeInTheDocument())
  })

  it('shows a digest paused for re-confirmation without resume or retime, and links a Room digest to its Room conversation', async () => {
    const digest = { id: 'd1', connection_id: 'c1', project_id: 'p1', project_name: 'Thesis', session_id: 's1', room_id: 'r1', agent_id: 'a1', kind: 'daily' as const,
      local_time: '08:00', time_zone: 'Europe/London', status: 'paused' as const, covered_until: now, next_run_at: null, retry_at: null, last_delivered_at: now,
      failure_count: 0, last_error_code: 'gmail_digest_reconfirm_required', last_delivery: null, created_at: now }
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ ...connection('c1'), agent_read_enabled: true }] })
    vi.mocked(gmailApi.digests).mockResolvedValue([digest])
    render(view())
    expect(await screen.findByText(/Paused until you confirm it again/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change summary time' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Revoke digest access' })).toBeInTheDocument()
    expect(screen.queryByText('The digest has a delivery or authorization issue.')).not.toBeInTheDocument()
    const room = screen.getByRole('link', { name: 'Open Room conversation' })
    expect(room.getAttribute('href')).toMatch(/\/projects\/p1\/rooms\?room=r1&conversation=s1$/)
    expect(screen.queryByRole('link', { name: 'Open private conversation' })).not.toBeInTheDocument()
  })

  it('names a private digest’s link as the private conversation and a Room digest’s as its Room conversation', async () => {
    const digest = (id: string, roomId: string | null) => ({ id, connection_id: 'c1', project_id: 'p1', project_name: 'Thesis', session_id: `s-${id}`, room_id: roomId, agent_id: 'a1',
      kind: 'daily' as const, local_time: '08:00', time_zone: 'Europe/London', status: 'active' as const, covered_until: now, next_run_at: now, retry_at: null,
      last_delivered_at: null, failure_count: 0, last_error_code: null, last_delivery: null, created_at: now })
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [{ ...connection('c1'), agent_read_enabled: true }] })
    vi.mocked(gmailApi.digests).mockResolvedValue([digest('d1', null), digest('d2', 'r2')])
    render(view())
    const own = await screen.findByRole('link', { name: 'Open private conversation' })
    expect(own.getAttribute('href')).toMatch(/\/projects\/p1\/agents\/a1\/chat\?session=s-d1$/)
    const room = screen.getByRole('link', { name: 'Open Room conversation' })
    expect(room.getAttribute('href')).toMatch(/\/projects\/p1\/rooms\?room=r2&conversation=s-d2$/)
  })

  it('explains a server without Gmail configuration and asks for no secret', async () => {
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: false, connections: [] })
    const { container } = render(view())
    expect(await screen.findByText(/Gmail is not set up on this server yet/)).toBeInTheDocument()
    expect(container.querySelector('input')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).not.toBeInTheDocument()
  })

  it('opens Google only through the person’s own click on the returned consent link', async () => {
    vi.mocked(gmailApi.startOAuth).mockResolvedValue({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })
    const before = window.location.href
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }))
    const consent = await screen.findByRole('link', { name: 'Continue to Google' })
    expect(consent).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/v2/auth?state=s')
    expect(window.location.href).toBe(before)
    expect(gmailApi.startOAuth).toHaveBeenCalledWith({}, expect.objectContaining({ spaceId: 'space-a' }))
  })

  it('reconnects an expired grant by naming the person’s own connection', async () => {
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1', 'reauth_required')] })
    vi.mocked(gmailApi.startOAuth).mockResolvedValue({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=r' })
    render(view())
    expect(await screen.findByText('Needs reconnecting')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await screen.findByRole('link', { name: 'Continue to Google' })
    expect(gmailApi.startOAuth).toHaveBeenCalledWith({ reconnect_connection_id: 'c1' }, expect.anything())
  })

  it('disconnects locally, links Google’s page for manual revocation and retries with the same key', async () => {
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1')] })
    vi.mocked(gmailApi.disconnect).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ connection_id: 'c1', space_id: 'space-a', status: 'disconnected', generation: 3, remote_revocation: 'not_requested', manual_revocation_url: GMAIL_MANUAL_REVOCATION_URL })
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/does not contact Google/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByText(/Could not reach Rainver/)).toBeInTheDocument()
    vi.mocked(gmailApi.connections).mockResolvedValue({ configured: true, connections: [connection('c1', 'disconnected')] })
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    const revoke = await screen.findByRole('link', { name: /Google Account third-party access/ })
    expect(revoke).toHaveAttribute('href', GMAIL_MANUAL_REVOCATION_URL)
    const [first, second] = vi.mocked(gmailApi.disconnect).mock.calls
    expect(second![1]).toBe(first![1])
    expect(screen.getByRole('button', { name: 'Remove from list' })).toBeEnabled()
  })

  it('shows a known callback result once, removes it from the URL and ignores unknown values', async () => {
    render(view('/spaces/space-a/sources/access?gmail=gmail_scope_excess&keep=1'))
    expect(await screen.findByText(/more access than read-only/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('location')).toHaveTextContent('/spaces/space-a/sources/access?keep=1'))
  })

  it('drops the list when the Space changes and ignores the previous Space’s late reply', async () => {
    let resolveOld!: (value: GmailConnectionList) => void
    vi.mocked(gmailApi.connections).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce({ configured: true, connections: [connection('c-b')] })
    const { rerender } = render(view())
    space.activeSpaceId = 'space-b'
    rerender(view())
    expect(await screen.findByText('c-b@example.test')).toBeInTheDocument()
    await act(async () => { resolveOld({ configured: true, connections: [connection('c-a')] }) })
    expect(screen.queryByText('c-a@example.test')).not.toBeInTheDocument()
  })

  it('keeps the refresh after a disconnect when an earlier, slower list read arrives later', async () => {
    const slow = deferred<GmailConnectionList>()
    vi.mocked(gmailApi.connections).mockResolvedValueOnce({ configured: true, connections: [connection('c1')] })
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce({ configured: true, connections: [connection('c1', 'disconnected')] })
    vi.mocked(gmailApi.disconnect).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ connection_id: 'c1', space_id: 'space-a', status: 'disconnected', generation: 3, remote_revocation: 'not_requested', manual_revocation_url: GMAIL_MANUAL_REVOCATION_URL })
    render(view())
    await disconnect()
    expect(await screen.findByText(/Could not reach Rainver/)).toBeInTheDocument()
    expect(gmailApi.connections).toHaveBeenCalledTimes(2)
    await disconnect()
    expect(await screen.findByText('Disconnected')).toBeInTheDocument()
    expect(vi.mocked(gmailApi.connections).mock.calls[1]![0].signal!.aborted).toBe(true)
    await act(async () => { slow.resolve({ configured: true, connections: [connection('c1')] }) })
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
  })

  it.each([
    ['401', () => new ApiRequestError('x', 401, 'unauthorized'), /Your session ended/],
    ['403', () => new ApiRequestError('x', 403, 'forbidden'), /no longer available to you/],
    ['404', () => new ApiRequestError('x', 404, 'gmail_not_found'), /no longer available to you/],
    ['reauth', () => new ApiRequestError('x', 409, 'gmail_reauth_required'), /Google no longer accepts this connection/],
  ] as const)('a %s refusal of disconnect clears the list and consent link, and an older read cannot restore them', async (_name, refusal, message) => {
    const slow = deferred<GmailConnectionList>()
    vi.mocked(gmailApi.connections).mockResolvedValueOnce({ configured: true, connections: [connection('c1'), connection('c2', 'reauth_required')] })
      .mockReturnValueOnce(slow.promise)
    vi.mocked(gmailApi.startOAuth).mockResolvedValue({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })
    vi.mocked(gmailApi.forget).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(gmailApi.disconnect).mockRejectedValueOnce(refusal())
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }))
    await screen.findByRole('link', { name: 'Continue to Google' })
    // An ordinary failure leaves a list re-read in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Remove from list' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from list' }))
    await waitFor(() => expect(gmailApi.connections).toHaveBeenCalledTimes(2))
    await disconnect()
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByText('c1@example.test')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue to Google' })).not.toBeInTheDocument()
    await act(async () => { slow.resolve({ configured: true, connections: [connection('c1')] }) })
    expect(screen.queryByText('c1@example.test')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue to Google' })).not.toBeInTheDocument()
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it.each(['start', 'forget'] as const)('a refused %s clears the list and consent link too', async kind => {
    vi.mocked(gmailApi.connections).mockResolvedValueOnce({ configured: true, connections: [connection('c2', 'reauth_required')] })
    vi.mocked(gmailApi.startOAuth).mockResolvedValueOnce({ authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })
    if (kind === 'start') vi.mocked(gmailApi.startOAuth).mockRejectedValueOnce(new ApiRequestError('x', 403, 'forbidden'))
    else vi.mocked(gmailApi.forget).mockRejectedValueOnce(new ApiRequestError('x', 403, 'forbidden'))
    render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }))
    await screen.findByRole('link', { name: 'Continue to Google' })
    if (kind === 'start') fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Remove from list' }))
      fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from list' }))
    }
    expect(await screen.findByText(/no longer available to you/)).toBeInTheDocument()
    expect(screen.queryByText('c2@example.test')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue to Google' })).not.toBeInTheDocument()
  })

  it.each([
    'https://evil.example/o/oauth2/v2/auth?state=s',
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth?state=s',
    'http://accounts.google.com/o/oauth2/v2/auth?state=s',
    'https://user:pass@accounts.google.com/o/oauth2/v2/auth?state=s',
    'https://accounts.google.com@evil.example/o/oauth2/v2/auth',
    'https://accounts.google.com:8443/o/oauth2/v2/auth?state=s',
    'https://accounts.google.com:443/o/oauth2/v2/auth?state=s',
    'https://accounts.google.com:0443/o/oauth2/v2/auth?state=s',
    'https://accounts.google.com/o/oauth2/v2/auth/../../../evil',
    'https://accounts.google.com/signin?continue=https://evil.example',
    'javascript:alert(1)',
  ])('renders no consent link for %s and says why', async url => {
    vi.mocked(gmailApi.startOAuth).mockResolvedValue({ authorize_url: url })
    const { container } = render(view())
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gmail' }))
    expect(await screen.findByText(/did not return Google’s sign-in page/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue to Google' })).not.toBeInTheDocument()
    expect(container.querySelector('a[href*="evil"], a[href^="http:"], a[href^="javascript:"]')).toBeNull()
  })
})
