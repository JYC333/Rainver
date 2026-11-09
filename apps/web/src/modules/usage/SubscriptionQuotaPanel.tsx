import { useEffect, useRef, useState } from 'react'
import type { SubscriptionQuotaPool } from '@rainver/protocol'
import { Loader2, RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ApiRequestError, hostsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime, formatNumber } from '../../i18n/format'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'
import { createLimiter, runLimited } from './limited'

type Connection = SubscriptionQuotaPool['connections'][number]

/** At most this many CLI probes at once; each probe can take up to 45 s on a slow host. */
const PROBE_CONCURRENCY = 3
/** A list read overtaken by a later one; its answer is not adopted. */
const SUPERSEDED = Symbol('superseded')

/**
 * A copy's stable identity. A pool's id is not: it follows the account, so a
 * logout or account switch the probe itself reports moves the copy to another
 * pool. Refresh state follows the copy, and a card shows its copies' state.
 */
function connectionKey(connection: Pick<Connection, 'host_id' | 'runtime_key' | 'installation'>): string {
  return JSON.stringify([connection.host_id, connection.runtime_key, connection.installation])
}
const keysOf = (pool: SubscriptionQuotaPool) => pool.connections.map(connectionKey)
const without = (record: Record<string, string>, keys: readonly string[]) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))

/** 401/403/404: access to the list or this copy is gone, so its readings must go too. */
function accessLost(error: unknown): boolean {
  return error instanceof ApiRequestError && [401, 403, 404].includes(error.status)
}

/**
 * The one connection a refresh asks. Automatic refresh skips copies known to
 * be logged out (asking them only launches a CLI to hear "log in"); a manual
 * refresh still asks one, so logging back in can be detected from here.
 */
function refreshTarget(pool: SubscriptionQuotaPool, manual: boolean): Connection | undefined {
  const usable = pool.connections.filter(item => item.online && item.can_refresh)
  return usable.find(item => item.error !== 'not_logged_in') ?? (manual ? usable[0] : undefined)
}

export default function SubscriptionQuotaPanel({ refreshKey = 0, onBusyChange }: { refreshKey?: number; onBusyChange?: (busy: boolean) => void }) {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const [params] = useSearchParams()
  const scope = useRef(activeSpaceId)
  scope.current = activeSpaceId
  const generation = useRef(0)
  const listRead = useRef(0)
  /** Copies being refreshed in this cycle, by `connectionKey`. */
  const probing = useRef(new Set<string>())
  /** Automatic and manual probes share these slots. */
  const slots = useRef(createLimiter(PROBE_CONCURRENCY))
  const [state, setState] = useState<{ scope: string | null; items: SubscriptionQuotaPool[]; error: string | null; loading: boolean }>({ scope: activeSpaceId, items: [], error: null, loading: true })
  /** Per-copy refresh failures of the current cycle; the card stays with its last reading. */
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const setProbing = (id: string, on: boolean) => {
    if (on) probing.current.add(id); else probing.current.delete(id)
    setPending(new Set(probing.current))
  }

  /** The list read started last; a superseded read waits for it. */
  const latestList = useRef<Promise<SubscriptionQuotaPool[] | null | typeof SUPERSEDED>>(Promise.resolve(null))

  /**
   * Ends this cycle: queued probes do not start, the queue stops, and no card
   * stays busy. Used when the list itself is refused (401/403), so every
   * remaining probe would be refused too.
   */
  function endCycle() {
    generation.current++
    probing.current = new Set()
    setPending(new Set())
  }

  async function readListOnce(read: number, space: string | null, valid: () => boolean): Promise<SubscriptionQuotaPool[] | null | typeof SUPERSEDED> {
    try {
      const result = await hostsApi.subscriptionUsage()
      if (read !== listRead.current) return SUPERSEDED
      if (!valid()) return null
      setState({ scope: space, items: result.items, error: null, loading: false })
      const listed = new Set(result.items.flatMap(keysOf))
      setFailures(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => listed.has(key))))
      return result.items
    } catch (error) {
      if (read !== listRead.current) return SUPERSEDED
      if (!valid()) return null
      if (accessLost(error)) setFailures({})
      setState(previous => ({ scope: space, items: previous.scope === space && !accessLost(error) ? previous.items : [], error: errMsg(error), loading: false }))
      if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) endCycle()
      return null
    }
  }

  /**
   * Latest read wins. A transient failure keeps the authorized cards; lost
   * access clears them. A read overtaken by a later one resolves only when
   * the read that was actually adopted has, so a card waiting on it is not
   * released while its new reading is still on the way.
   */
  async function readList(space: string | null, valid: () => boolean): Promise<SubscriptionQuotaPool[] | null> {
    const read = ++listRead.current
    const own = readListOnce(read, space, valid)
    latestList.current = own
    let result = await own
    while (result === SUPERSEDED && valid()) result = await latestList.current
    return result === SUPERSEDED ? null : result
  }

  /**
   * Probes one pool through one connection, waiting for a free slot. Its
   * failure stays with that copy, wherever the re-read list puts it; the card
   * stays busy until that list is in.
   */
  async function probe(pool: SubscriptionQuotaPool, connection: Connection, space: string | null, valid: () => boolean) {
    const key = connectionKey(connection)
    setProbing(key, true)
    setFailures(previous => without(previous, keysOf(pool)))
    try {
      const asked = await slots.current(async () => {
        if (!valid()) return false
        try {
          const row = await hostsApi.refreshUsage(connection.host_id, connection.runtime_key, connection.installation)
          if (valid() && row.quota.error) setFailures(previous => ({ ...previous, [key]: row.quota.error! }))
        } catch (error) {
          if (!valid()) return false
          if (accessLost(error)) {
            // Do not keep showing an account this person may no longer read.
            setState(previous => ({ ...previous, items: previous.items.filter(item => !keysOf(item).includes(key)) }))
          } else setFailures(previous => ({ ...previous, [key]: errMsg(error) }))
        }
        return true
      })
      if (asked && valid()) await readList(space, valid)
    } finally {
      if (valid()) setProbing(key, false)
    }
  }

  /** Reads the list, then refreshes one connection per pool. Each start is a new cycle. */
  async function load() {
    const mine = ++generation.current
    const space = activeSpaceId
    const valid = () => mine === generation.current && scope.current === space
    probing.current = new Set()
    setPending(new Set())
    setFailures({})
    setState(previous => ({ ...previous, scope: space, items: previous.scope === space ? previous.items : [], error: null, loading: true }))
    const items = await readList(space, valid)
    if (!items) return
    await runLimited(items, PROBE_CONCURRENCY, async pool => {
      const connection = refreshTarget(pool, false)
      if (connection && !probing.current.has(connectionKey(connection))) await probe(pool, connection, space, valid)
    }, () => !valid())
  }
  useEffect(() => {
    void load()
    return () => { generation.current++ }
  }, [activeSpaceId, refreshKey])
  const busy = state.loading || pending.size > 0
  const poolPending = (pool: SubscriptionQuotaPool) => keysOf(pool).some(key => pending.has(key))
  const failureOf = (pool: SubscriptionQuotaPool) => keysOf(pool).map(key => failures[key]).find(Boolean)
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const items = state.scope === activeSpaceId ? state.items : []
  const target = params.get('pool')
  const selected = items.find(item => item.id === target || item.connections.some(connection =>
    connection.host_id === params.get('host') && connection.runtime_key === params.get('runtime') && connection.installation === params.get('installation')))
  const selectedId = selected?.id
  useEffect(() => { if (selectedId) document.getElementById(`quota-${selectedId}`)?.scrollIntoView?.({ block: 'nearest' }) }, [selectedId])
  function refresh(pool: SubscriptionQuotaPool) {
    const connection = refreshTarget(pool, true)
    if (!connection || state.loading || keysOf(pool).some(key => probing.current.has(key))) return
    const mine = generation.current, space = activeSpaceId
    void probe(pool, connection, space, () => mine === generation.current && scope.current === space)
  }
  return <section className="space-y-4" aria-label={t('subscription_usage.title')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t('subscription_usage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subscription_usage.description')}</p></div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{t('quota_refresh.cli')}</Button>
    </div>
    {state.error && <Card role="alert"><p className="text-sm text-destructive">{state.error}</p>
      <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{t('subscription_usage.retry')}</Button></Card>}
    {state.loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('subscription_usage.loading')}</p>}
    {!state.loading && !state.error && !items.length && <EmptyState title={t('subscription_usage.empty')} />}
    {target && !state.loading && items.length > 0 && !selected && <p role="status" className="text-sm text-muted-foreground">{t('subscription_usage.changed')}</p>}
    <div className="grid gap-4 lg:grid-cols-2">{items.map(pool => <Card key={pool.id} id={`quota-${pool.id}`} className={selectedId === pool.id ? 'ring-2 ring-primary' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-2"><CardTitle className="min-w-0 break-words text-sm normal-case tracking-normal [overflow-wrap:anywhere]">{pool.account_display ? [pool.account?.product === 'claude' ? 'Claude' : pool.account?.product === 'codex' ? 'Codex' : pool.account?.product === 'antigravity' ? 'Antigravity' : null, pool.account_display.email, pool.account_display.workspace_name].filter(Boolean).join(' · ') : pool.label}</CardTitle>
        <Button size="sm" variant="outline" disabled={state.loading || poolPending(pool) || !refreshTarget(pool, true)} onClick={() => refresh(pool)}>
          {poolPending(pool) ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t('subscription_usage.refresh')}
        </Button></div>
      {failureOf(pool) && <p role="alert" className="mt-2 break-words text-xs text-destructive">{t('subscription_usage.refresh_failed', { error: failureOf(pool) })}{pool.windows.length ? ` ${t('subscription_usage.showing_previous')}` : ''}</p>}
      {!pool.account && <p className="mt-2 text-xs text-muted-foreground">{t('subscription_usage.unidentified')}</p>}
      {pool.account?.identity_kind === 'email' && <p className="mt-2 text-xs text-muted-foreground">{t('subscription_usage.email_identity')}</p>}
      <div className="my-4 space-y-4">{pool.windows.length ? pool.windows.map(window => {
        const reset = window.resets?.replace(/^Resets\s+/i, '')
        const percent = window.used_pct === null ? null : formatNumber(window.used_pct, { maximumFractionDigits: window.used_pct < 1 ? 1 : 0 })
        return <div key={window.id} className="space-y-1.5">
          <div className="flex items-start justify-between gap-3 text-sm"><span className="min-w-0 break-words">{window.label === 'Session' ? t('subscription_usage.session') : window.label === 'Weekly' ? t('subscription_usage.week') : window.label}</span>
            <span className="shrink-0 tabular-nums">{percent === null ? t('subscription_usage.unavailable') : t('subscription_usage.used', { percent })}</span></div>
          {window.used_pct !== null && <div role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, window.used_pct)} className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${window.used_pct >= 100 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${Math.min(100, window.used_pct)}%` }} /></div>}
          {reset && <p className="break-words text-xs text-muted-foreground">{t('subscription_usage.resets', { time: Number.isFinite(Date.parse(reset)) ? formatDateTime(reset) : reset })}</p>}
          <p className="text-xs text-muted-foreground">{t('subscription_usage.checked', { time: formatDateTime(window.checked_at) })}</p>
        </div>
      }) : <p className="text-sm text-muted-foreground">{t('subscription_usage.no_measurement')}</p>}</div>
      <details><summary className="cursor-pointer text-sm">{t('subscription_usage.connections', { count: pool.connections.length })}</summary>
        <ul className="mt-3 space-y-3">{pool.connections.map(connection => <li key={`${connection.host_id}:${connection.runtime_key}:${connection.installation}`} className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-2"><Button asChild variant="ghost" size="sm" className="h-auto min-w-0 whitespace-normal px-0 text-left"><SpaceLink to={`/command-center?host=${encodeURIComponent(connection.host_id)}&runtime=${encodeURIComponent(connection.runtime_key)}&installation=${encodeURIComponent(connection.installation)}`}>
            {connection.host_name} · {connection.runtime_name} · {connection.installation}</SpaceLink></Button><Badge variant="outline">{t(connection.online ? 'subscription_usage.online' : 'subscription_usage.offline')}</Badge></div>
          {connection.error && <p className="break-words text-muted-foreground">{connection.error === 'not_logged_in' ? t('subscription_usage.not_logged_in') : connection.error}</p>}
          {connection.checked_at && <p className="text-muted-foreground">{t('subscription_usage.checked', { time: formatDateTime(connection.checked_at) })}</p>}
        </li>)}</ul>
      </details>
    </Card>)}</div>
  </section>
}
