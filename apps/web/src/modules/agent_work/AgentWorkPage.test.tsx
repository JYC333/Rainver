import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttentionStreamFrame, AgentWorkItem } from '@rainver/protocol'
import { agentAttentionApi, agentsApi, authorizationRequestsApi, roomsApi, runsApi, sessionsApi, ApiRequestError } from '../../api/client'
import { useConversationScope } from '../conversation/ConversationScope'
import { deferred, page, run, turn, work, workRun } from './fixtures.test-support'
import AgentWorkPage from './AgentWorkPage'
import { AgentAttentionProvider } from './AgentAttentionProvider'
import i18n from '../../i18n'

vi.mock('../../api/client', async original => {
  const actual = await original<typeof import('../../api/client')>()
  return { ...actual, agentAttentionApi: { list: vi.fn(), item: vi.fn(), setReadState: vi.fn(), recordViews: vi.fn(), stream: vi.fn(), snapshot: vi.fn() },
    runsApi: { get: vi.fn(), turn: vi.fn(), authorizationRequests: vi.fn(), stop: vi.fn(), resume: vi.fn(), abandon: vi.fn() },
    authorizationRequestsApi: { approve: vi.fn(), reject: vi.fn() },
    roomsApi: { get: vi.fn() },
    agentsApi: { get: vi.fn(), conversationBackends: vi.fn() },
    sessionsApi: { messages: vi.fn() },
    runtimeContextApi: { retrievalSwitch: vi.fn(async () => ({ enabled: false })), setRetrievalSwitch: vi.fn() },
  }
})
vi.mock('../../contexts/SpaceContext', () => ({ useSpace: () => ({ userId: 'user', activeSpaceId: null, preferredSpaceId: 'space-a',
  spaces: [{ id: 'space-a', name: 'A', role: 'member' }, { id: 'space-b', name: 'B', role: 'owner' }] }) }))
// Exercise the workbench's display contract independently of Room's own covered sender.
vi.mock('../conversation/ConversationSurface', () => ({ ConversationSurface: (props: { spaceId: string; onMessagesDisplayed?: (ids: string[]) => void; onReadError?: (error: unknown) => void }) => {
  const scope = useConversationScope()
  const [shown, setShown] = useState(false)
  useEffect(() => { if (shown) props.onMessagesDisplayed?.(['message-b']) }, [shown, props.onMessagesDisplayed])
  return <div data-testid="surface" data-space={scope.spaceId} data-prop-space={props.spaceId}>
    <button onClick={() => setShown(true)}>Display reply</button>
    <button onClick={() => props.onReadError?.(new Error('read failed'))}>Fail reply</button>
    {shown && <p>Reply body</p>}<textarea aria-label="Reply editor" />
    {/* Keep these inside the page DOM but outside the detail DOM, so arrows
        exercise role/defaultPrevented guards rather than the detail exclusion. */}
    {createPortal(<>
      {['dialog', 'menu', 'listbox', 'option', 'menuitem'].map(role => <div key={role} role={role}>
        <button>Inline {role} action</button>
      </div>)}
      <button onKeyDown={event => event.preventDefault()}>Handled action</button>
    </>, document.querySelector('header')!)}
    {createPortal(<div role="menu"><button>Portal action</button></div>, document.body)}
    {createPortal(<button>Plain portal action</button>, document.body)}
  </div>
} }))
vi.mock('../conversation/ConversationExecutionPreflight', () => ({ ConversationExecutionPreflight: () => null }))

let streamSink: (frame: AgentAttentionStreamFrame) => void
function Probe() { const location = useLocation(); return <span data-testid="location">{location.pathname}</span> }
function renderPage() { return render(<MemoryRouter initialEntries={['/agent-work']} future={{ v7_relativeSplatPath: true, v7_startTransition: true }}><AgentAttentionProvider userId="user"><AgentWorkPage /><Probe /></AgentAttentionProvider></MemoryRouter>) }
/** Pick an option in the shared Select: open the labelled trigger, then click the option. */
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}
function row(title = 'Build the report') { return screen.getByRole('button', { name: new RegExp(title) }) }
async function openRun() {
  fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
  fireEvent.click(await screen.findByRole('button', { name: /Run run-b/ }))
}
function roomWork(): AgentWorkItem {
  return work({ identity: { kind: 'session', source_id: 'session-b' }, operations: [{ kind: 'open_session', space_id: 'space-b', session_id: 'session-b', room_id: 'room-b', agent_id: 'agent-b' }],
    read_states: [{ subject: { kind: 'message', schema_version: 1, message_id: 'message-b', revision: 'message-rev' }, unread: true, manual_unread: false, read_at: null, state_version: 2 }] })
}
beforeEach(() => {
  vi.clearAllMocks()
  void i18n.changeLanguage('en')
  let initialStream = true
  vi.mocked(agentAttentionApi.stream).mockImplementation(async (onFrame, options) => {
    streamSink = onFrame
    if (!initialStream) return new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
    initialStream = false
    const initial = await agentAttentionApi.list({ scope: 'mine', view: 'current', cursor: undefined }, options)
    if (!options?.signal?.aborted) onFrame({ type: 'attention.snapshot', seq: 1, version: 'initial', page: initial, unread_count: 0, notices: [] })
    await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
  })
  vi.mocked(agentAttentionApi.snapshot).mockRejectedValue(new Error('snapshot unavailable'))
  vi.mocked(agentAttentionApi.recordViews).mockResolvedValue({ read_count: 0, read_states: [] })
  vi.mocked(agentAttentionApi.list).mockResolvedValue(page())
  vi.mocked(agentAttentionApi.item).mockImplementation(async target => work({ identity: { kind: target.kind, source_id: target.source_id } }))
  vi.mocked(agentAttentionApi.setReadState).mockImplementation(async input => ({ subject: input.subject, state_version: input.state_version + 1, unread: input.action === 'unread', manual_unread: input.action === 'unread', read_at: input.action === 'read' ? '2026-10-21T00:00:00Z' : null }))
  vi.mocked(runsApi.get).mockResolvedValue(run())
  vi.mocked(runsApi.turn).mockResolvedValue(turn())
  vi.mocked(runsApi.authorizationRequests).mockResolvedValue([])
  vi.mocked(roomsApi.get).mockResolvedValue({ room: { id: 'room-b', project_id: 'project-b' }, agent_members: [], viewer_can_write: true } as never)
  vi.mocked(agentsApi.get).mockResolvedValue({ id: 'agent-b', space_id: 'space-b', name: 'Agent B' } as never)
  vi.mocked(agentsApi.conversationBackends).mockResolvedValue({ options: [], binding: null } as never)
  vi.mocked(sessionsApi.messages).mockResolvedValue([])
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => { vi.restoreAllMocks() })

describe('Agent Work page', () => {
  it('renders server groups, complete counts, reason and responsible actor; never auto-opens or reads', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([work({ group: 'needs_you', reasons: [{ kind: 'run_decision', run_id: 'run-b', responsible: { kind: 'user', id: 'user', display_name: 'Ada' } }] })], { counts: { needs_you: 103, recently_finished: 12, working: 8, waiting: 4, idle: 1 } }))
    renderPage()
    const group = await screen.findByRole('region', { name: 'Needs you' })
    expect(within(group).getByText('103')).toBeVisible()
    expect(within(group).getByText('Run decision required')).toBeVisible()
    expect(within(group).getByText(/Responsible: Ada/)).toBeVisible()
    expect(screen.getByRole('region', { name: 'Working' })).toHaveTextContent('8')
    expect(agentAttentionApi.item).not.toHaveBeenCalled()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('loads the server cursor and keeps complete totals', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work()], { next_cursor: 'server-cursor', counts: { needs_you: 0, recently_finished: 9, working: 0, waiting: 0, idle: 0 } }))
      .mockResolvedValueOnce(page([work({ title: 'Second item', work_key: 'opaque-2', identity: { kind: 'run', source_id: 'run-2' } })], { counts: { needs_you: 0, recently_finished: 9, working: 0, waiting: 0, idle: 0 } }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: /Second item/ })).toBeVisible()
    expect(row()).toBeVisible()
    expect(agentAttentionApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'server-cursor', scope: 'mine' }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(screen.getByRole('region', { name: 'Recently finished' })).toHaveTextContent('9')
  })
  it('refreshes the loaded window with fresh cursors and keeps rows, scroll and focus until it succeeds', async () => {
    const second = work({ title: 'Second item', work_key: 'second', identity: { kind: 'run', source_id: 'second-run' } })
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work()], { next_cursor: 'old-cursor' }))
      .mockResolvedValueOnce(page([second], { next_cursor: 'old-tail' }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    const secondRow = await screen.findByRole('button', { name: /Second item/ })
    secondRow.focus()
    const list = screen.getByRole('region', { name: 'Work list' })
    list.scrollTop = 240
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work()], { next_cursor: 'fresh-cursor' }))
      .mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(agentAttentionApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'fresh-cursor' }), expect.any(Object)))
    expect(secondRow).toBeVisible()
    expect(secondRow).toHaveFocus()
    await act(async () => pending.resolve(page([second], { next_cursor: 'fresh-tail' })))
    expect(row('Second item')).toBe(secondRow)
    expect(secondRow).toHaveFocus()
    expect(list.scrollTop).toBe(240)
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ title: 'Third item', work_key: 'third' })]))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('button', { name: /Third item/ })).toBeVisible()
    expect(agentAttentionApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'fresh-tail' }), expect.any(Object))
  })
  it('keeps the previous window when a later refresh page fails and resets the window on filter changes', async () => {
    const second = work({ title: 'Second item', work_key: 'second' })
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work()], { next_cursor: 'old-cursor' }))
      .mockResolvedValueOnce(page([second]))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await screen.findByRole('button', { name: /Second item/ })
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ title: 'Changed first' })], { next_cursor: 'fresh-cursor' }))
      .mockRejectedValueOnce(new TypeError('network'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/may be out of date/)
    expect(row()).toBeVisible()
    expect(row('Second item')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Changed first/ })).not.toBeInTheDocument()
    vi.mocked(agentAttentionApi.list).mockResolvedValueOnce(page([work({ title: 'Filtered work' })], { next_cursor: 'filtered-cursor' }))
    choose('Space', 'B')
    expect(await screen.findByRole('button', { name: /Filtered work/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Second item/ })).not.toBeInTheDocument()
    expect(agentAttentionApi.list).toHaveBeenCalledTimes(5)
  })
  it.each([
    ['en', 45, false, /45 sec/], ['en', 90, false, /1.5 min/], ['en', 7200, false, /2 hr/],
    ['en', 59.5, false, /1 min/], ['en', 3540, false, /59 min/], ['en', 3596, false, /59.9 min/],
    ['en', 3597, false, /1 hr/], ['en', 3599, false, /1 hr/], ['zh-CN', 3599, false, /1\s*小时/],
    ['zh-CN', 7200, false, /2\s*小时/], ['en', 7200, true, /Shown members: 2 hr elapsed/],
  ] as const)('shows readable %s durations (%s seconds, partial=%s)', async (locale, seconds, partial, expected) => {
    await i18n.changeLanguage(locale)
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([work({ visible_run_count: partial ? 2 : 1,
      runs: [workRun({ started_at: new Date(Date.parse('2026-10-20T12:00:00Z') - seconds * 1000).toISOString() })] })]))
    renderPage()
    expect(await screen.findByRole('button', { name: /Build the report/ })).toHaveTextContent(expected)
  })
  it('uses the readable duration in canonical Run details too', async () => {
    vi.mocked(runsApi.get).mockResolvedValue(run({ started_at: '2026-10-20T10:00:00Z' }))
    renderPage()
    await openRun()
    expect((await screen.findByRole('link', { name: 'Open full Run' })).closest('section')).toHaveTextContent('2 hr')
  })
  it('gives a conversation the detail pane without a duplicate Run list or execution IDs', async () => {
    const source = { ...roomWork(), visible_run_count: 120, runs_next_cursor: 'older-executions' }
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    expect(await screen.findByRole('textbox', { name: 'Reply editor' })).toBeVisible()
    expect(screen.queryByRole('region', { name: /Runs/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load more members/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Run run-b')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Display reply' }))
    expect(await screen.findByText('Reply body')).toBeVisible()
    expect(runsApi.get).not.toHaveBeenCalled()
    expect(runsApi.turn).not.toHaveBeenCalled()
  })

  it('preserves selection, existing content and input focus during an explicit refresh', async () => {
    const source = roomWork()
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    const editor = await screen.findByRole('textbox', { name: 'Reply editor' })
    editor.focus()
    fireEvent.change(editor, { target: { value: 'my unsent reply' } })
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(agentAttentionApi.list).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getByRole('heading', { name: 'Build the report' })).toBeVisible()
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('my unsent reply')
    await act(async () => pending.resolve(page([work({ title: 'New top', work_key: 'new' }), source])))
    expect(editor.isConnected).toBe(true)
    expect(editor).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Build the report' })).toBeVisible()
  })
  it.each(['offline event', 'network failure', 'read failure'] as const)('preserves the mounted detail, draft and focus through %s and online recovery', async failure => {
    const source = roomWork()
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    const editor = await screen.findByRole('textbox', { name: 'Reply editor' })
    fireEvent.click(screen.getByRole('button', { name: 'Display reply' }))
    expect(screen.getByText('Reply body')).toBeVisible()
    editor.focus()
    fireEvent.change(editor, { target: { value: 'unsaved draft at disconnect' } })
    const next = { ...source, read_states: [{ ...source.read_states[0]!, subject: { ...source.read_states[0]!.subject, revision: 'recovered-revision' }, state_version: 3 }] }
    vi.mocked(agentAttentionApi.item).mockResolvedValue(next)
    if (failure === 'offline event') fireEvent(window, new Event('offline'))
    else {
      vi.mocked(agentAttentionApi.list).mockRejectedValueOnce(failure === 'network failure' ? new TypeError('network') : new Error('read failed'))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    }
    expect(await screen.findByRole('alert')).toHaveTextContent(failure === 'read failure' ? /Could not read/ : /may be out of date/)
    expect(screen.getByRole('textbox', { name: 'Reply editor' })).toBe(editor)
    expect(editor).toHaveValue('unsaved draft at disconnect')
    expect(editor).toHaveFocus()
    expect(screen.getByText('Reply body')).toBeVisible()
    const readsBeforeOnline = vi.mocked(agentAttentionApi.list).mock.calls.length
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([next]))
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(agentAttentionApi.list).toHaveBeenCalledTimes(readsBeforeOnline + 1))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Reply editor' })).toBe(editor)
    expect(editor).toHaveValue('unsaved draft at disconnect')
    expect(editor).toHaveFocus()
    // Message views are the surface's own report; this page writes no message read.
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('requires an explicit reopen after a denied list read even when connectivity returns', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([roomWork()]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(roomWork())
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    expect(await screen.findByRole('textbox', { name: 'Reply editor' })).toBeVisible()
    vi.mocked(agentAttentionApi.list).mockRejectedValueOnce(new ApiRequestError('denied', 403))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.queryByTestId('surface')).not.toBeInTheDocument())
    const itemReads = vi.mocked(agentAttentionApi.item).mock.calls.length
    fireEvent(window, new Event('online'))
    expect(await screen.findByRole('button', { name: /Build the report/ })).toBeVisible()
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument()
    expect(agentAttentionApi.item).toHaveBeenCalledTimes(itemReads)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    fireEvent.click(row())
    expect(await screen.findByTestId('surface')).toBeVisible()
  })
  it.each([['denied', new ApiRequestError('denied', 403), /no longer accessible/], ['failed', new Error('failed'), /Could not read/], ['offline', new TypeError('network'), /Offline or connection/]] as const)('distinguishes %s from an empty result', async (_kind, cause, message) => {
    vi.mocked(agentAttentionApi.list).mockRejectedValue(cause)
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText('No work in this window.')).not.toBeInTheDocument()
  })
  it('returns to the same list, filters and scroll position after closing detail', async () => {
    renderPage()
    choose('Space', 'B')
    const first = await screen.findByRole('button', { name: /Build the report/ })
    const list = screen.getByRole('region', { name: 'Work list' })
    list.scrollTop = 240
    first.focus()
    fireEvent.click(first)
    fireEvent.click(await screen.findByRole('button', { name: 'Back to list' }))
    expect(screen.getByRole('region', { name: 'Work list' })).toBe(list)
    expect(list.scrollTop).toBe(240)
    expect(screen.getByRole('button', { name: 'Space' })).toHaveTextContent('B')
    expect(first).toHaveFocus()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('renders the empty state separately', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([]))
    renderPage()
    expect(await screen.findByText('No work in this window.')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('confirms only after a Turn body has successfully mounted, with exact revision and source Space', async () => {
    const pending = deferred<ReturnType<typeof turn>>()
    vi.mocked(runsApi.turn).mockReturnValueOnce(pending.promise)
    renderPage()
    await openRun()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    await act(async () => pending.resolve(turn()))
    expect(await screen.findByText('The report is ready.')).toBeVisible()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledWith({ identity: work().identity, space_id: 'space-b', subject: work().read_states[0]!.subject, state_version: 0, action: 'read' }, expect.objectContaining({ spaceId: 'space-b' })))
    expect(runsApi.turn).toHaveBeenCalledWith('run-b', expect.objectContaining({ spaceId: 'space-b' }))
  })
  it('does not acknowledge a failed Turn read', async () => {
    vi.mocked(runsApi.turn).mockRejectedValue(new Error('unavailable'))
    renderPage()
    await openRun()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read')
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('retries a failed expanded Turn on explicit detail refresh even when its work summary is unchanged', async () => {
    vi.mocked(runsApi.turn).mockRejectedValueOnce(new Error('unavailable'))
    renderPage()
    await openRun()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read')
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' })) })
    expect(runsApi.turn).toHaveBeenCalledTimes(2)
    expect(screen.getByText('The report is ready.')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1))
  })
  it('uses ConversationScope and explicit source for Room display; the page itself writes no message read', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([roomWork()]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(roomWork())
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    const surface = await screen.findByTestId('surface')
    expect(surface).toHaveAttribute('data-space', 'space-b')
    expect(surface).toHaveAttribute('data-prop-space', 'space-b')
    expect(roomsApi.get).toHaveBeenCalledWith('room-b', expect.objectContaining({ spaceId: 'space-b' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fail reply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Display reply' }))
    expect(await screen.findByText('Reply body')).toBeVisible()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: 'Open full conversation' })).toHaveAttribute('href', '/spaces/space-b/rooms/room-b?conversation=session-b')
    // A manual unread targets the messages this open displayed, with their exact revision.
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledWith(expect.objectContaining({ space_id: 'space-b', state_version: 2, action: 'unread', subject: roomWork().read_states[0]!.subject }), expect.objectContaining({ spaceId: 'space-b' })))
  })
  it('does not acknowledge a new result revision while the preserved Turn may still show its older body', async () => {
    const source = work()
    renderPage()
    await openRun()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1))
    const next = { ...source, read_states: [{ ...source.read_states[0]!, subject: { ...source.read_states[0]!.subject, revision: 'new-body' }, state_version: 1 }] }
    vi.mocked(agentAttentionApi.item).mockResolvedValue(next)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }))
    await waitFor(() => expect(agentAttentionApi.item).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('The report is ready.')).toBeVisible()
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    await openRun()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenLastCalledWith(expect.objectContaining({ subject: next.read_states[0]!.subject, state_version: 1 }), expect.any(Object)))
  })
  it.each([false, true])('uses a confirmed view-read version for explicit unread without following another source revision (changed=%s)', async changed => {
    const source = roomWork()
    const viewed = { ...source.read_states[0]!, unread: false, state_version: 3 }
    const latest = changed ? { ...viewed, subject: { ...viewed.subject, revision: 'new-message-body' } } : viewed
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(agentAttentionApi.setReadState).mockImplementation(async input => {
      if (input.state_version !== latest.state_version || input.subject.revision !== latest.subject.revision) throw new ApiRequestError('conflict', 409, undefined, { current: latest })
      return { ...latest, unread: true, manual_unread: true, state_version: 4 }
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Display reply' }))
    expect(await screen.findByText('Reply body')).toBeVisible()
    // The conversation's /views report has settled, and the aggregate refresh
    // now confirms its reading version for the source this open displayed.
    vi.mocked(agentAttentionApi.item).mockResolvedValue({ ...source, read_states: [latest] })
    await act(async () => streamSink({ type: 'attention.invalidation', seq: 2, version: 'view-confirmed', page: page([{ ...source, read_states: [latest] }]), unread_count: 0, notices: [] }))
    expect(agentAttentionApi.item).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledOnce())
    expect(agentAttentionApi.setReadState).toHaveBeenCalledWith(expect.objectContaining({ action: 'unread', subject: source.read_states[0]!.subject, state_version: changed ? 2 : 3 }), expect.any(Object))
    if (changed) expect(await screen.findByText(/Reading state changed elsewhere/)).toBeVisible()
    else await waitFor(() => expect(screen.queryByRole('heading', { name: 'Build the report' })).not.toBeInTheDocument())
  })
  it('keeps an unconfirmed view-read race as a conflict without automatically overwriting it', async () => {
    const source = roomWork()
    const viewed = { ...source.read_states[0]!, unread: false, state_version: 3 }
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(agentAttentionApi.setReadState).mockRejectedValue(new ApiRequestError('conflict', 409, undefined, { current: viewed }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Display reply' }))
    expect(await screen.findByText('Reply body')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    expect(await screen.findByText(/Reading state changed elsewhere/)).toBeVisible()
    expect(agentAttentionApi.setReadState).toHaveBeenCalledOnce()
    expect(agentAttentionApi.setReadState).toHaveBeenCalledWith(expect.objectContaining({ state_version: 2, action: 'unread' }), expect.any(Object))
    expect(screen.getByRole('heading', { name: 'Build the report' })).toBeVisible()
  })
  it.each(['success', 'new revision', 'other tab decision', 'view failure', 'account close'] as const)('orders an in-flight conversation view before manual unread: %s', async outcome => {
    const source = roomWork()
    source.operations = [{ kind: 'open_session', space_id: 'space-b', session_id: 'session-b', room_id: null, agent_id: 'agent-b' }]
    const reported = { ...source.read_states[0]!, unread: false, state_version: 3,
      subject: { ...source.read_states[0]!.subject, revision: outcome === 'new revision' ? 'new-body' : 'message-rev' } }
    const pending = deferred<Awaited<ReturnType<typeof agentAttentionApi.recordViews>>>()
    vi.mocked(agentAttentionApi.recordViews).mockReturnValue(pending.promise)
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(sessionsApi.messages).mockResolvedValue([{ id: 'message-b', session_id: 'session-b', role: 'assistant', content: 'A direct reply', metadata_json: {} }] as never)
    const current = outcome === 'other tab decision' ? { ...reported, state_version: 4 } : reported
    vi.mocked(agentAttentionApi.setReadState).mockImplementation(async input => {
      if (input.state_version !== current.state_version || input.subject.revision !== current.subject.revision) throw new ApiRequestError('conflict', 409, undefined, { current })
      return { ...current, state_version: current.state_version + 1, unread: true, manual_unread: true }
    })
    const view = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    expect(await screen.findByText('A direct reply')).toBeVisible()
    expect(screen.queryByRole('region', { name: /Runs/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Run run-b')).not.toBeInTheDocument()
    await waitFor(() => expect(agentAttentionApi.recordViews).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    if (outcome === 'account close') view.unmount()
    await act(async () => {
      if (outcome === 'view failure') pending.reject(new Error('View response lost'))
      else pending.resolve({ read_count: 1, read_states: [reported] })
    })
    if (outcome === 'account close') {
      expect(vi.mocked(agentAttentionApi.recordViews).mock.calls[0]![1]!.signal!.aborted).toBe(true)
      expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    } else if (outcome === 'view failure') {
      expect(await screen.findByText(/Could not read/)).toBeVisible()
      expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    } else {
      expect(agentAttentionApi.setReadState).toHaveBeenCalledOnce()
      expect(agentAttentionApi.setReadState).toHaveBeenCalledWith(expect.objectContaining({ action: 'unread', subject: source.read_states[0]!.subject,
        state_version: outcome === 'new revision' ? 2 : 3 }), expect.any(Object))
      if (outcome === 'success') expect(screen.queryByRole('heading', { name: 'Build the report' })).not.toBeInTheDocument()
      else expect(await screen.findByText(/Reading state changed elsewhere/)).toBeVisible()
    }
    expect(agentAttentionApi.recordViews).toHaveBeenCalledOnce()
  })
  it('marks manually unread after a pending read settles and confirms again only on an explicit reopen', async () => {
    const pending = deferred<Awaited<ReturnType<typeof agentAttentionApi.setReadState>>>()
    vi.mocked(agentAttentionApi.setReadState).mockReturnValueOnce(pending.promise)
    renderPage()
    choose('Window', 'History')
    choose('Group', 'Recently finished')
    await openRun()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve({ ...work().read_states[0]!, unread: false, state_version: 1 }))
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'unread', state_version: 1 }), expect.objectContaining({ spaceId: 'space-b' })))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Build the report' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Window' })).toHaveTextContent('Current')
    expect(screen.getByRole('button', { name: 'Group' })).toHaveTextContent('Recently finished')
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(2)
    vi.mocked(agentAttentionApi.item).mockResolvedValue(work({ read_states: [{ ...work().read_states[0]!, unread: true, manual_unread: true, state_version: 2 }] }))
    await openRun()
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(3))
    expect(agentAttentionApi.setReadState).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'read', state_version: 2,
      subject: work().read_states[0]!.subject }), expect.objectContaining({ spaceId: 'space-b' }))
  })
  it('retains a server state_version conflict, refreshes the item, and requires another explicit open', async () => {
    const current = { ...work().read_states[0]!, manual_unread: true, state_version: 7 }
    vi.mocked(agentAttentionApi.setReadState).mockRejectedValueOnce(new ApiRequestError('conflict', 409, undefined, { current }))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(work({ read_states: [current] }))
    renderPage()
    await openRun()
    expect(await screen.findByText(/Reading state changed elsewhere/)).toBeVisible()
    await waitFor(() => expect(agentAttentionApi.item).toHaveBeenCalledTimes(2))
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread and return' }))
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'unread', state_version: 7 }), expect.any(Object)))
  })
  it('filters remain user-level and discard late responses from an older filter', async () => {
    const old = deferred<ReturnType<typeof page>>()
    vi.mocked(agentAttentionApi.list).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([work({ title: 'Space B work' })]))
    renderPage()
    choose('Space', 'B')
    expect(await screen.findByRole('button', { name: /Space B work/ })).toBeVisible()
    await act(async () => old.resolve(page([work({ title: 'Stale work' })])))
    expect(screen.queryByRole('button', { name: /Stale work/ })).not.toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/agent-work')
    expect(agentAttentionApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ space_id: 'space-b' }), expect.any(Object))
  })
  it('moves focus with arrows, uses Enter to open, and leaves editor keys untouched', async () => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([roomWork(), work({ title: 'Second item', work_key: 'second' })]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(roomWork())
    renderPage()
    const first = await screen.findByRole('button', { name: /Build the report/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(row('Second item')).toHaveFocus()
    fireEvent.keyDown(row('Second item'), { key: 'ArrowUp' })
    expect(first).toHaveFocus()
    const user = userEvent.setup({ delay: null })
    await user.keyboard('{Enter}')
    const editor = await screen.findByRole('textbox', { name: 'Reply editor' })
    editor.focus()
    expect(fireEvent.keyDown(editor, { key: 'u' })).toBe(true)
    expect(fireEvent.keyDown(editor, { key: 'ArrowUp' })).toBe(true)
    expect(editor).toHaveFocus()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it.each(['Portal', 'Plain portal', 'Inline dialog', 'Inline menu', 'Inline listbox', 'Inline option', 'Inline menuitem', 'Handled'])('leaves %s keys to their own interaction', async location => {
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([roomWork()]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(roomWork())
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    const action = await screen.findByRole('button', { name: `${location} action` })
    const detail = screen.getByRole('complementary', { name: 'Work detail' })
    expect(detail.contains(action)).toBe(false)
    expect(screen.getByRole('heading', { name: 'Agent Work' }).closest('header')!.contains(action)).toBe(location.startsWith('Inline') || location === 'Handled')
    action.focus()
    for (const key of ['u', 'ArrowDown', 'Escape']) {
      fireEvent.keyDown(action, { key })
      expect(action).toHaveFocus()
      expect(screen.getByRole('heading', { name: 'Build the report' })).toBeVisible()
    }
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('hides commands for all_visible work without command standing and explains why', async () => {
    const source = work({ mine: false, runs: [workRun({ owner_user_id: 'other', instructed_by_user_id: 'other', status: 'waiting_for_review' })] })
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(runsApi.get).mockResolvedValue(run({ status: 'waiting_for_review', owner_user_id: 'other', instructed_by_user_id: 'other', error_json: { supervisor_review: true } }))
    vi.mocked(runsApi.turn).mockResolvedValue(turn({ state: 'blocked', blocked_on: 'run_decision' }))
    renderPage()
    choose('Show', 'All visible')
    await openRun()
    expect(await screen.findByText(/Only the Run owner/)).toBeVisible()
    for (const name of ['Stop', 'Resume', 'Approve authorization', 'Reject authorization', 'Abandon Run']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
  })
  it.each(['stop', 'resume', 'abandon'] as const)('uses shared canonical %s with source Space and rereads', async action => {
    vi.mocked(runsApi.get).mockResolvedValue(run({ status: action === 'stop' ? 'running' : 'waiting_for_review', error_json: { supervisor_review: true } }))
    renderPage()
    await openRun()
    const name = action === 'stop' ? 'Stop' : action === 'resume' ? 'Resume' : 'Abandon Run'
    fireEvent.click(await screen.findByRole('button', { name }))
    await waitFor(() => expect(runsApi[action]).toHaveBeenCalled())
    const args = vi.mocked(runsApi[action]).mock.calls[0]!
    expect(args[0]).toBe('run-b')
    expect(args[args.length - 1]).toEqual(expect.objectContaining({ spaceId: 'space-b', signal: expect.any(AbortSignal) }))
    await waitFor(() => expect(runsApi.get).toHaveBeenCalledWith('run-b', expect.objectContaining({ spaceId: 'space-b' })))
  })
  it.each(['approve', 'reject'] as const)('uses shared authorization %s without a second resume', async action => {
    vi.mocked(runsApi.get).mockResolvedValue(run({ status: 'waiting_for_review', error_json: { authorization_request_id: 'auth-b' } }))
    vi.mocked(runsApi.authorizationRequests).mockResolvedValue([{ id: 'auth-b', run_id: 'run-b', reason: 'Review the requested action', status: 'pending', instructed_by_user_id: 'user' }] as never)
    renderPage()
    await openRun()
    fireEvent.click(await screen.findByRole('button', { name: action === 'approve' ? 'Approve authorization' : 'Reject authorization' }))
    await waitFor(() => expect(authorizationRequestsApi[action]).toHaveBeenCalledExactlyOnceWith('auth-b', expect.objectContaining({ spaceId: 'space-b' })))
    expect(runsApi.resume).not.toHaveBeenCalled()
  })
  it('removes content and commands if acknowledging reveals revoked access', async () => {
    vi.mocked(agentAttentionApi.setReadState).mockRejectedValueOnce(new ApiRequestError('revoked', 404))
    renderPage()
    await openRun()
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible')
    expect(screen.queryByText('The report is ready.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark unread and return' })).not.toBeInTheDocument()
  })
  it('removes content and commands when refresh reports access loss', async () => {
    renderPage()
    await openRun()
    expect(await screen.findByText('The report is ready.')).toBeVisible()
    vi.mocked(agentAttentionApi.item).mockRejectedValueOnce(new ApiRequestError('removed', 404))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh detail' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer accessible')
    expect(screen.queryByText('The report is ready.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark unread and return' })).not.toBeInTheDocument()
  })
  it('loads child windows without acknowledging undisplayed children and stops at the final cursor', async () => {
    const second = workRun({ run_id: 'run-child', agent_id: 'agent-child' })
    const childRead = { ...work().read_states[0]!, subject: { ...work().read_states[0]!.subject, run_id: 'run-child' } } as AgentWorkItem['read_states'][number]
    vi.mocked(runsApi.turn).mockImplementation(async id => turn({ run_id: id }))
    vi.mocked(runsApi.get).mockImplementation(async id => run({ id }))
    const source = work({ visible_run_count: 2, runs_next_cursor: 'child-cursor' })
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockImplementation(async input => input.runs_cursor
      ? work({ runs: [second], read_states: [childRead], runs_next_cursor: null }) : source)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Load more members/ }))
    expect(await screen.findByRole('button', { name: /Run run-child/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Load more members/ })).not.toBeInTheDocument()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Run run-child/ }))
    await waitFor(() => expect(agentAttentionApi.setReadState).toHaveBeenCalledWith(expect.objectContaining({ subject: childRead.subject }), expect.objectContaining({ spaceId: 'space-b' })))
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
  })
  it('shows pending reasons and proposal links from every loaded child page', async () => {
    // The server cuts child pages at 100 read states: 120 Runs, each with a
    // result and a pending proposal, arrive as 50 + 50 + 20 Runs.
    const ids = Array.from({ length: 120 }, (_, index) => String(index).padStart(3, '0'))
    const childPage = (slice: string[], cursor: string | null, first = false) => work({
      ...(first ? {} : { title: 'child page' }),
      group: 'needs_you', visible_run_count: 120, runs_next_cursor: cursor,
      runs: slice.map(id => workRun({ run_id: `run-${id}` })),
      reasons: slice.map(id => ({ kind: 'proposal' as const, proposal_id: `proposal-${id}`, responsible: { kind: 'user' as const, id: 'user', display_name: 'Reader' } })),
      read_states: slice.flatMap(id => [
        { subject: { kind: 'run_result' as const, schema_version: 1 as const, run_id: `run-${id}`, attempt_id: `attempt-${id}`, revision: `rev-${id}` }, unread: true, manual_unread: false, read_at: null, state_version: 0 },
        { subject: { kind: 'proposal' as const, schema_version: 1 as const, proposal_id: `proposal-${id}`, revision: `rev-${id}` }, unread: true, manual_unread: false, read_at: null, state_version: 0 },
      ]),
    })
    const source = childPage(ids.slice(0, 50), 'page-2', true)
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockImplementation(async input => structuredClone(
      input.runs_cursor === 'page-2' ? childPage(ids.slice(50, 100), 'page-3')
        : input.runs_cursor === 'page-3' ? childPage(ids.slice(100), null) : source))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    expect(await screen.findAllByRole('link', { name: 'Review Proposal' })).toHaveLength(50)
    fireEvent.click(await screen.findByRole('button', { name: /Load more members/ }))
    expect(await screen.findByRole('button', { name: /Run run-099/ })).toBeVisible()
    fireEvent.click(await screen.findByRole('button', { name: /Load more members/ }))
    expect(await screen.findByRole('button', { name: /Run run-119/ })).toBeVisible()
    const links = screen.getAllByRole('link', { name: 'Review Proposal' })
    expect(links).toHaveLength(120)
    expect(links.some(link => link.getAttribute('href')?.endsWith('/proposals/proposal-119'))).toBe(true)
    // The list row keeps its first-page reasons; the detail shows all 120 loaded ones.
    expect(screen.getAllByText('Proposal needs review')).toHaveLength(50 + 120)
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('discards an older item response after another work is opened', async () => {
    const pending = deferred<AgentWorkItem>()
    const second = work({ title: 'Other work', work_key: 'second-key', identity: { kind: 'run', source_id: 'other-run' } })
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([work(), second]))
    vi.mocked(agentAttentionApi.item).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(second)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    fireEvent.click(screen.getByRole('button', { name: /Other work/ }))
    expect(await screen.findByRole('heading', { name: 'Other work' })).toBeVisible()
    await act(async () => pending.resolve(work()))
    expect(screen.queryByRole('heading', { name: 'Build the report' })).not.toBeInTheDocument()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('keeps the snapshot on network failure and labels it stale', async () => {
    renderPage()
    expect(await screen.findByRole('button', { name: /Build the report/ })).toBeVisible()
    vi.mocked(agentAttentionApi.list).mockRejectedValueOnce(new TypeError('offline'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('may be out of date')
    expect(row()).toBeVisible()
  })
  it('does not expose reply bodies or controls to a summary viewer', async () => {
    const source = work({ access_level: 'summary', read_states: [], reasons: [] })
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    renderPage()
    await openRun()
    expect(screen.getAllByText(/Summary access only/).length).toBeGreaterThan(0)
    expect(runsApi.turn).not.toHaveBeenCalled()
    expect(runsApi.get).not.toHaveBeenCalled()
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })
  it('withholds authorization decisions from a member even when they instructed the Run', async () => {
    const source = work({ space_id: 'space-a' })
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(runsApi.get).mockResolvedValue(run({ space_id: 'space-a', status: 'waiting_for_review', error_json: { authorization_request_id: 'auth-a' } }))
    vi.mocked(runsApi.authorizationRequests).mockResolvedValue([{ id: 'auth-a', run_id: 'run-b', reason: 'Needs owner', status: 'pending', instructed_by_user_id: 'user' }] as never)
    renderPage()
    await openRun()
    expect(await screen.findByText(/Only a Space owner/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Approve authorization' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject authorization' })).not.toBeInTheDocument()
  })
  it('loads direct chat in its source Space and preserves its live draft and focus offline', async () => {
    const source = roomWork()
    source.operations = [{ kind: 'open_session', space_id: 'space-b', session_id: 'session-b', room_id: null, agent_id: 'agent-b' }]
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockResolvedValue(source)
    vi.mocked(sessionsApi.messages).mockResolvedValue([{ id: 'message-b', session_id: 'session-b', role: 'assistant', content: 'A direct reply', metadata_json: {} }] as never)
    vi.mocked(agentsApi.conversationBackends).mockResolvedValue({ options: [{ runtime_profile_id: 'runtime-1', name: 'Managed', runtime_key: 'opencode', model_name: 'gpt-test' }], binding: null } as never)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Build the report/ }))
    expect(await screen.findByText('A direct reply')).toBeVisible()
    expect(sessionsApi.messages).toHaveBeenCalledWith('session-b', expect.objectContaining({ spaceId: 'space-b' }))
    expect(agentsApi.conversationBackends).toHaveBeenCalledWith('agent-b', expect.objectContaining({ spaceId: 'space-b' }))
    // The embedded direct chat reports its views like any other surface; the page writes no message read.
    await waitFor(() => expect(agentAttentionApi.recordViews).toHaveBeenCalledWith({ space_id: 'space-b', session_id: 'session-b', message_ids: ['message-b'] }, expect.objectContaining({ signal: expect.any(AbortSignal) })))
    expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
    const editor = screen.getByPlaceholderText('Ask your assistant… (Enter to send, Shift+Enter for newline)')
    await waitFor(() => expect(editor).toBeEnabled())
    editor.focus()
    fireEvent.change(editor, { target: { value: 'just typed before disconnect' } })
    fireEvent(window, new Event('offline'))
    expect(screen.getByRole('alert')).toHaveTextContent(/may be out of date/)
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('just typed before disconnect')
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByPlaceholderText('Ask your assistant… (Enter to send, Shift+Enter for newline)')).toBe(editor)
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue('just typed before disconnect')
    expect(sessionsApi.messages).toHaveBeenCalledTimes(1)
    expect(agentAttentionApi.recordViews).toHaveBeenCalledTimes(1)
  })
  it('preserves paged children and focused Run through unrelated invalidation, then refreshes changed work in place', async () => {
    const child=workRun({run_id:'run-child'})
    const childRead={...work().read_states[0]!,subject:{kind:'run_result' as const,schema_version:1 as const,run_id:'run-child',attempt_id:'child-attempt',revision:'child-v1'}}
    const source=work({visible_run_count:2,runs_next_cursor:'old-child'})
    const children=work({runs:[child],read_states:[childRead],runs_next_cursor:null})
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockImplementation(async input=>structuredClone(input.runs_cursor ? children : source))
    vi.mocked(runsApi.get).mockImplementation(async id=>run({id}))
    vi.mocked(runsApi.turn).mockImplementation(async id=>turn({run_id:id}))
    renderPage(); fireEvent.click(await screen.findByRole('button',{name:/Build the report/}))
    fireEvent.click(await screen.findByRole('button',{name:/Load more members/}))
    const focused=await screen.findByRole('button',{name:/Run run-child/})
    fireEvent.click(focused)
    await waitFor(()=>expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1))
    focused.focus()
    const reads=vi.mocked(runsApi.turn).mock.calls.length
    const itemReads=vi.mocked(agentAttentionApi.item).mock.calls.length
    await act(async()=>streamSink({type:'attention.invalidation',seq:2,version:'other-work-changed',page:null,unread_count:1,notices:[]}))
    await waitFor(()=>expect(agentAttentionApi.item).toHaveBeenCalledTimes(itemReads+2))
    expect(screen.getByRole('button',{name:/Run run-child/})).toBe(focused); expect(focused).toHaveFocus()
    expect(runsApi.turn).toHaveBeenCalledTimes(reads)
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
    const refreshed={...source,title:'Changed selected work',runs_next_cursor:'fresh-child'}
    const updatedChildren={...children,runs:[{...child,status:'failed' as const}],read_states:[{...childRead,subject:{...childRead.subject,revision:'child-v2'}}]}
    vi.mocked(agentAttentionApi.item).mockImplementation(async input=>structuredClone(input.runs_cursor ? updatedChildren : refreshed))
    vi.mocked(runsApi.turn).mockImplementation(async id=>turn({run_id:id,state:'failed'}))
    await act(async()=>streamSink({type:'attention.invalidation',seq:3,version:'selected-work-changed',page:null,unread_count:1,notices:[]}))
    expect(await screen.findByRole('heading',{name:'Changed selected work'})).toBeVisible()
    expect(agentAttentionApi.item).toHaveBeenLastCalledWith(expect.objectContaining({runs_cursor:'fresh-child'}),expect.any(Object))
    await waitFor(()=>expect(vi.mocked(runsApi.turn).mock.calls.length).toBeGreaterThan(reads))
    expect(focused).toBeVisible(); expect(focused).toHaveFocus()
    expect(agentAttentionApi.setReadState).toHaveBeenCalledTimes(1)
  })
  it('keeps a Room composer, draft and source read when another work invalidates', async () => {
    const source=roomWork()
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockImplementation(async()=>structuredClone(source))
    renderPage(); fireEvent.click(await screen.findByRole('button',{name:/Build the report/}))
    const editor=await screen.findByRole('textbox',{name:'Reply editor'})
    editor.focus(); fireEvent.change(editor,{target:{value:'still typing'}})
    const reads=vi.mocked(roomsApi.get).mock.calls.length
    await act(async()=>streamSink({type:'attention.invalidation',seq:2,version:'unrelated-room',page:null,unread_count:1,notices:[]}))
    expect(editor).toHaveFocus(); expect(editor).toHaveValue('still typing'); expect(editor.isConnected).toBe(true)
    expect(roomsApi.get).toHaveBeenCalledTimes(reads); expect(agentAttentionApi.setReadState).not.toHaveBeenCalled()
  })

  it('keeps load-more blocked while an aborted older child request finishes during refresh', async () => {
    const source=work({visible_run_count:2,runs_next_cursor:'old-child'})
    const old=deferred<AgentWorkItem>(), fresh=deferred<AgentWorkItem>();let first=true
    const child=work({runs:[workRun({run_id:'new-child'})],runs_next_cursor:null})
    vi.mocked(agentAttentionApi.list).mockResolvedValue(page([source]))
    vi.mocked(agentAttentionApi.item).mockImplementation(input=>{
      if(input.runs_cursor==='old-child') return old.promise
      if(input.runs_cursor==='fresh-child') return Promise.resolve(child)
      if(first) {first=false;return Promise.resolve(source)}
      return fresh.promise
    })
    renderPage();fireEvent.click(await screen.findByRole('button',{name:/Build the report/}))
    const more=await screen.findByRole('button',{name:/Load more members/})
    fireEvent.click(more)
    await act(async()=>streamSink({type:'attention.invalidation',seq:2,version:'new-members',page:null,unread_count:1,notices:[]}))
    await act(async()=>old.reject(new DOMException('Aborted','AbortError')))
    fireEvent.click(more)
    expect(agentAttentionApi.item).toHaveBeenCalledTimes(3)
    await act(async()=>fresh.resolve({...source,runs_next_cursor:'fresh-child'}))
    fireEvent.click(screen.getByRole('button',{name:/Load more members/}))
    expect(await screen.findByRole('button',{name:/Run new-child/})).toBeVisible()
    expect(agentAttentionApi.item).toHaveBeenLastCalledWith(expect.objectContaining({runs_cursor:'fresh-child'}),expect.any(Object))
  })

})
