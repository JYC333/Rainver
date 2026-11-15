import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomConversationQuota } from '../../types/api'
import { clearSessionResidue, sessionEpoch } from '../../lib/sessionResidue'
import { roomsApi } from '../../api/client'
import { ConversationQuotaLine } from './ConversationQuotaLine'
import { CONVERSATION_QUOTA_READ_INTERVAL_MS, useConversationQuota } from './useConversationQuota'
import { isSuppressed, quotaDismissalStorageKey, QUOTA_DISMISS_MS, readQuotaDismissals, writeQuotaDismissals, type QuotaDismissal } from './quotaDismissal'

vi.mock('../../api/client', () => ({ roomsApi: { conversationQuota: vi.fn() } }))

const T0 = Date.parse('2026-11-12T10:00:00.000Z')
const RESET = '2026-11-12T13:00:00.000Z'
const policy = { warn_pct: 70, reserve_pct: 90 }
const login = (utilization: number, over: Partial<RoomConversationQuota['logins'][number]> = {}) => ({
  account_label: 'Claude Code · Server',
  login_key: 'login-a',
  window: { kind: 'session' as const, utilization, resets_at: RESET },
  checked_at: new Date(T0 - 60_000).toISOString(),
  ...over,
})
const quotaWith = (logins: RoomConversationQuota['logins'], holds: RoomConversationQuota['holds'] = []): RoomConversationQuota =>
  ({ ...policy, logins, holds })
const alice = { userId: 'user-a', spaceId: 'space-1' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0)
  window.sessionStorage.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  vi.mocked(roomsApi.conversationQuota).mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('quota warning dismissal rules', () => {
  const dismissed: QuotaDismissal = { login_key: 'login-a', kind: 'session', resets_at: RESET, utilization: 75, severity: 1, dismissed_at: T0 }

  it('stays hidden through small movement for three hours, then lapses', () => {
    expect(isSuppressed(login(75), policy, dismissed, T0)).toBe(true)
    expect(isSuppressed(login(79.9), policy, dismissed, T0 + 60_000)).toBe(true)
    // Fluctuation downwards and the same window's reset reported a minute differently.
    expect(isSuppressed(login(72, { window: { kind: 'session', utilization: 72, resets_at: '2026-11-12T13:01:00.000Z' } }), policy, dismissed, T0)).toBe(true)
    expect(isSuppressed(login(75), policy, dismissed, T0 + QUOTA_DISMISS_MS - 1)).toBe(true)
    expect(isSuppressed(login(75), policy, dismissed, T0 + QUOTA_DISMISS_MS)).toBe(false)
  })

  it('shows again on a 5-point rise, a more severe line, or exhaustion', () => {
    expect(isSuppressed(login(80), policy, dismissed, T0)).toBe(false)
    const nearReserve = { ...dismissed, utilization: 87 }
    expect(isSuppressed(login(89), policy, nearReserve, T0)).toBe(true)
    expect(isSuppressed(login(90), policy, nearReserve, T0)).toBe(false)
    expect(isSuppressed(login(100), policy, { ...dismissed, utilization: 98, severity: 2 }, T0)).toBe(false)
  })

  it('does not carry over to a reset window, another window, or another account', () => {
    expect(isSuppressed(login(75), policy, dismissed, Date.parse(RESET))).toBe(false)
    expect(isSuppressed(login(75, { window: { kind: 'session', utilization: 75, resets_at: '2026-11-12T18:00:00.000Z' } }), policy, dismissed, T0)).toBe(false)
    expect(isSuppressed(login(75, { window: { kind: 'week', utilization: 75, resets_at: RESET } }), policy, dismissed, T0)).toBe(false)
    expect(isSuppressed(login(75, { login_key: 'login-b' }), policy, dismissed, T0)).toBe(false)
  })

  it('is stored per user and Space in this browser session and cleared at logout', () => {
    writeQuotaDismissals(alice, [dismissed], sessionEpoch(), T0)
    expect(readQuotaDismissals(alice, T0)['login-a']).toEqual(dismissed)
    expect(readQuotaDismissals({ userId: 'user-b', spaceId: 'space-1' }, T0)).toEqual({})
    expect(readQuotaDismissals({ userId: 'user-a', spaceId: 'space-2' }, T0)).toEqual({})
    expect(window.localStorage.getItem(quotaDismissalStorageKey(alice))).toBeNull()
    expect(readQuotaDismissals(alice, T0 + QUOTA_DISMISS_MS)).toEqual({})
    const epoch = sessionEpoch()
    clearSessionResidue()
    expect(readQuotaDismissals(alice, T0)).toEqual({})
    // A write from before the logout is not persisted afterwards.
    writeQuotaDismissals(alice, [dismissed], epoch, T0)
    expect(window.sessionStorage.getItem(quotaDismissalStorageKey(alice))).toBeNull()
  })
})

describe('ConversationQuotaLine', () => {
  const dismissButton = () => screen.queryByRole('button', { name: 'Hide usage warning' })

  it('hides an ordinary warning for three hours and shows it again when the time is up', async () => {
    const quota = quotaWith([login(75)])
    render(<ConversationQuotaLine quota={quota} dismissalScope={alice} />)
    expect(screen.getByTestId('conversation-quota-checked')).toHaveTextContent(/updated/)
    fireEvent.click(dismissButton()!)
    expect(screen.queryByTestId('conversation-quota-line')).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(QUOTA_DISMISS_MS - 60_000))
    expect(screen.queryByTestId('conversation-quota-line')).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000))
    expect(screen.getByTestId('conversation-quota-line')).toBeInTheDocument()
  })

  it('stays hidden across an ordinary refresh and a remount, and returns on a 5-point rise', () => {
    const { rerender, unmount } = render(<ConversationQuotaLine quota={quotaWith([login(75)])} dismissalScope={alice} />)
    fireEvent.click(dismissButton()!)
    rerender(<ConversationQuotaLine quota={quotaWith([login(77)])} dismissalScope={alice} />)
    expect(screen.queryByTestId('conversation-quota-line')).not.toBeInTheDocument()
    unmount()
    // Another conversation on the same login, same person: still put away.
    const other = render(<ConversationQuotaLine quota={quotaWith([login(77)])} dismissalScope={alice} />)
    expect(screen.queryByTestId('conversation-quota-line')).not.toBeInTheDocument()
    other.rerender(<ConversationQuotaLine quota={quotaWith([login(80)])} dismissalScope={alice} />)
    expect(screen.getByTestId('conversation-quota-line')).toBeInTheDocument()
  })

  it('never hides held turns, their continue anyway, or an exhausted window', () => {
    const hold = { account_label: 'Claude Code · Server', window: 'session' as const, resets_at: RESET, run_ids: ['run-1'], can_continue: true }
    const { rerender } = render(<ConversationQuotaLine quota={quotaWith([login(75)], [hold])} onContinueAnyway={vi.fn()} dismissalScope={alice} />)
    fireEvent.click(dismissButton()!)
    expect(screen.queryByTestId('conversation-quota-login')).not.toBeInTheDocument()
    expect(screen.getByText(/Agents are waiting for the window/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'continue anyway' })).toBeInTheDocument()
    rerender(<ConversationQuotaLine quota={quotaWith([login(100)])} dismissalScope={alice} />)
    expect(screen.getByTestId('conversation-quota-login')).toBeInTheDocument()
    expect(dismissButton()).not.toBeInTheDocument()
  })

  it('belongs to the person who dismissed it: another user, or a new account on the login, still sees it', () => {
    const { rerender } = render(<ConversationQuotaLine quota={quotaWith([login(75)])} dismissalScope={alice} />)
    fireEvent.click(dismissButton()!)
    rerender(<ConversationQuotaLine quota={quotaWith([login(75)])} dismissalScope={{ userId: 'user-b', spaceId: 'space-1' }} />)
    expect(screen.getByTestId('conversation-quota-line')).toBeInTheDocument()
    rerender(<ConversationQuotaLine quota={quotaWith([login(75, { login_key: 'login-b' })])} dismissalScope={alice} />)
    expect(screen.getByTestId('conversation-quota-line')).toBeInTheDocument()
  })

  it('says when a reading is stale, including once it ages on screen', async () => {
    render(<ConversationQuotaLine quota={quotaWith([login(75, { checked_at: new Date(T0 - 25 * 60_000).toISOString() })])} />)
    expect(screen.getByTestId('conversation-quota-checked')).toHaveTextContent(/updated/)
    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000))
    expect(screen.getByTestId('conversation-quota-checked')).toHaveTextContent(/may be out of date/)
  })
})

let lastAdopt: ((next: RoomConversationQuota) => void) | null = null
const defaultScope = {}
function Probe({ room = 'room-1', conversation = 'conv-1', signal = 0, user = 'user-a', space = 'space-1', scope = defaultScope, onQuota }: {
  room?: string; conversation?: string; signal?: number; user?: string; space?: string; scope?: { signal?: AbortSignal }
  onQuota: (quota: RoomConversationQuota | null) => void
}) {
  const { quota, adopt } = useConversationQuota(room, conversation, scope, { userId: user, spaceId: space }, [signal])
  lastAdopt = adopt
  onQuota(quota)
  return null
}
const deferredReads = () => {
  const resolvers: Array<(value: RoomConversationQuota) => void> = []
  vi.mocked(roomsApi.conversationQuota).mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
  return resolvers
}
const keyed = (key: string) => expect.objectContaining({ logins: [expect.objectContaining({ login_key: key })] })

describe('useConversationQuota', () => {
  it('reads the cache on change signals and every five minutes only while visible', async () => {
    vi.mocked(roomsApi.conversationQuota).mockResolvedValue(quotaWith([login(75)]))
    const seen = vi.fn()
    const { rerender } = render(<Probe onQuota={seen} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(roomsApi.conversationQuota).toHaveBeenCalledTimes(1)
    rerender(<Probe signal={1} onQuota={seen} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(roomsApi.conversationQuota).toHaveBeenCalledTimes(2)
    await act(() => vi.advanceTimersByTimeAsync(CONVERSATION_QUOTA_READ_INTERVAL_MS))
    expect(roomsApi.conversationQuota).toHaveBeenCalledTimes(3)

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    rerender(<Probe signal={2} onQuota={seen} />)
    await act(() => vi.advanceTimersByTimeAsync(4 * CONVERSATION_QUOTA_READ_INTERVAL_MS))
    expect(roomsApi.conversationQuota).toHaveBeenCalledTimes(3)

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(roomsApi.conversationQuota).toHaveBeenCalledTimes(4)
  })

  it('lets a continue-anyway answer supersede a read in flight, but not land on another conversation', async () => {
    const resolvers: Array<(value: RoomConversationQuota) => void> = []
    vi.mocked(roomsApi.conversationQuota).mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const seen = vi.fn()
    const { rerender } = render(<Probe onQuota={seen} />)
    await act(async () => { lastAdopt!(quotaWith([], [])) })
    await act(async () => { resolvers[0]!(quotaWith([login(95)])) })
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ logins: [] }))
    const oldAdopt = lastAdopt!
    rerender(<Probe conversation="conv-2" onQuota={seen} />)
    await act(async () => { oldAdopt(quotaWith([login(99)])) })
    expect(seen).toHaveBeenLastCalledWith(null)
    await act(async () => { resolvers[1]!(quotaWith([login(72, { login_key: 'login-c' })])) })
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ logins: [expect.objectContaining({ login_key: 'login-c' })] }))
  })

  it('keeps the latest answer and drops one for a conversation no longer shown', async () => {
    const resolvers: Array<(value: RoomConversationQuota) => void> = []
    vi.mocked(roomsApi.conversationQuota).mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
    const seen = vi.fn()
    const { rerender } = render(<Probe onQuota={seen} />)
    rerender(<Probe signal={1} onQuota={seen} />)
    expect(resolvers).toHaveLength(2)
    await act(async () => { resolvers[1]!(quotaWith([login(80)])) })
    await act(async () => { resolvers[0]!(quotaWith([login(71)])) })
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ logins: [expect.objectContaining({ window: expect.objectContaining({ utilization: 80 }) })] }))

    // A read for conv-1 still in flight when the person moves to conv-2.
    rerender(<Probe signal={2} onQuota={seen} />)
    rerender(<Probe conversation="conv-2" signal={2} onQuota={seen} />)
    expect(resolvers).toHaveLength(4)
    expect(seen).toHaveBeenLastCalledWith(null)
    await act(async () => { resolvers[3]!(quotaWith([login(72, { login_key: 'login-c' })])) })
    await act(async () => { resolvers[2]!(quotaWith([login(99)])) })
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ logins: [expect.objectContaining({ login_key: 'login-c' })] }))
  })

  it('drops an old continue-anyway answer and an old read after leaving and coming back (A -> B -> A)', async () => {
    const resolvers = deferredReads()
    const seen = vi.fn()
    const { rerender } = render(<Probe onQuota={seen} />)
    const adoptA1 = lastAdopt!
    rerender(<Probe conversation="conv-2" onQuota={seen} />)
    rerender(<Probe onQuota={seen} />)
    expect(resolvers).toHaveLength(3)
    await act(async () => { resolvers[2]!(quotaWith([login(72, { login_key: 'login-new' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-new'))
    // The first visit's action and read finish late: same conversation, but not this visit.
    await act(async () => { adoptA1(quotaWith([login(99, { login_key: 'login-old' })])) })
    await act(async () => { resolvers[0]!(quotaWith([login(98, { login_key: 'login-old' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-new'))
    expect(seen).not.toHaveBeenCalledWith(keyed('login-old'))
  })

  it('forgets the line at once when the viewer or Space changes on the same conversation', async () => {
    const resolvers = deferredReads()
    const seen = vi.fn()
    const { rerender } = render(<Probe onQuota={seen} />)
    await act(async () => { resolvers[0]!(quotaWith([login(80, { login_key: 'login-alice' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-alice'))
    const adoptAlice = lastAdopt!
    seen.mockClear()
    rerender(<Probe user="user-b" onQuota={seen} />)
    // The very first render for the new viewer is already empty.
    expect(seen.mock.calls[0]![0]).toBeNull()
    expect(resolvers).toHaveLength(2)
    await act(async () => { adoptAlice(quotaWith([login(99, { login_key: 'login-alice' })])) })
    expect(seen).toHaveBeenLastCalledWith(null)
    await act(async () => { resolvers[1]!(quotaWith([login(75, { login_key: 'login-bob' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-bob'))

    seen.mockClear()
    rerender(<Probe user="user-b" space="space-2" onQuota={seen} />)
    expect(seen.mock.calls[0]![0]).toBeNull()
    await act(async () => { resolvers[1]!(quotaWith([login(75, { login_key: 'login-bob' })])) })
    expect(seen).toHaveBeenLastCalledWith(null)
  })

  it('forgets the line when the panel request lifetime is replaced', async () => {
    const resolvers = deferredReads()
    const seen = vi.fn()
    const first = { signal: new AbortController().signal }
    const { rerender } = render(<Probe scope={first} onQuota={seen} />)
    await act(async () => { resolvers[0]!(quotaWith([login(80, { login_key: 'login-first' })])) })
    const adoptFirst = lastAdopt!
    seen.mockClear()
    rerender(<Probe scope={{ signal: new AbortController().signal }} onQuota={seen} />)
    expect(seen.mock.calls[0]![0]).toBeNull()
    await act(async () => { adoptFirst(quotaWith([login(99, { login_key: 'login-first' })])) })
    expect(seen).toHaveBeenLastCalledWith(null)
  })

  it('lands nothing from before a logout, read or action', async () => {
    const resolvers = deferredReads()
    const seen = vi.fn()
    render(<Probe onQuota={seen} />)
    await act(async () => { resolvers[0]!(quotaWith([login(80, { login_key: 'login-before' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-before'))
    const adoptBefore = lastAdopt!
    // A read in flight at logout.
    await act(() => vi.advanceTimersByTimeAsync(CONVERSATION_QUOTA_READ_INTERVAL_MS))
    const inFlight = resolvers.length - 1
    await act(async () => { clearSessionResidue() })
    expect(seen).toHaveBeenLastCalledWith(null)
    await act(async () => { resolvers[inFlight]!(quotaWith([login(90, { login_key: 'login-before' })])) })
    await act(async () => { adoptBefore(quotaWith([login(99, { login_key: 'login-before' })])) })
    expect(seen).toHaveBeenLastCalledWith(null)
    // The next session's own read is shown.
    const after = resolvers.length - 1
    expect(after).toBeGreaterThan(inFlight)
    await act(async () => { resolvers[after]!(quotaWith([login(71, { login_key: 'login-after' })])) })
    expect(seen).toHaveBeenLastCalledWith(keyed('login-after'))
  })

  it('writes nothing back after unmount', async () => {
    const resolvers = deferredReads()
    const seen = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = render(<Probe onQuota={seen} />)
    const adoptGone = lastAdopt!
    unmount()
    seen.mockClear()
    await act(async () => { resolvers[0]!(quotaWith([login(80)])); adoptGone(quotaWith([login(99)])) })
    expect(seen).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
