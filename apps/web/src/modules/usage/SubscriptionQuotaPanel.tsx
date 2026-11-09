import { useEffect, useRef, useState } from 'react'
import type { SubscriptionQuotaPool } from '@rainver/protocol'
import { Loader2, RefreshCw } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { hostsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime, formatNumber } from '../../i18n/format'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { EmptyState } from '../../components/ui/empty-state'
import { SpaceLink } from '../../core/spaceNav'
import { errMsg } from '../../lib/utils'

export default function SubscriptionQuotaPanel() {
  const { t } = useAppTranslation()
  const { activeSpaceId } = useSpace()
  const [params] = useSearchParams()
  const scope = useRef(activeSpaceId)
  scope.current = activeSpaceId
  const generation = useRef(0)
  const refreshGeneration = useRef(0)
  const [state, setState] = useState<{ scope: string | null; items: SubscriptionQuotaPool[]; error: string | null; loading: boolean }>({ scope: activeSpaceId, items: [], error: null, loading: true })
  const [busy, setBusy] = useState<string | null>(null)
  async function load() {
    const mine = ++generation.current
    const space = activeSpaceId
    setState(previous => ({ ...previous, scope: space, items: previous.scope === space ? previous.items : [], error: null, loading: true }))
    try {
      const result = await hostsApi.subscriptionUsage()
      if (mine === generation.current && scope.current === space) setState({ scope: space, items: result.items, error: null, loading: false })
    } catch (error) {
      if (mine === generation.current && scope.current === space) setState({ scope: space, items: [], error: errMsg(error), loading: false })
    }
  }
  useEffect(() => {
    setBusy(null)
    void load()
    return () => { generation.current++; refreshGeneration.current++ }
  }, [activeSpaceId])
  const items = state.scope === activeSpaceId ? state.items : []
  const target = params.get('pool')
  const selected = items.find(item => item.id === target || item.connections.some(connection =>
    connection.host_id === params.get('host') && connection.runtime_key === params.get('runtime') && connection.installation === params.get('installation')))
  const selectedId = selected?.id
  useEffect(() => { if (selectedId) document.getElementById(`quota-${selectedId}`)?.scrollIntoView?.({ block: 'nearest' }) }, [selectedId])
  async function refresh(pool: SubscriptionQuotaPool) {
    const connection = pool.connections.find(item => item.online && item.can_refresh)
    if (!connection || busy) return
    const space = activeSpaceId
    const action = ++refreshGeneration.current
    setBusy(pool.id)
    try {
      await hostsApi.refreshUsage(connection.host_id, connection.runtime_key, connection.installation)
      if (scope.current === space && action === refreshGeneration.current) await load()
    } catch (error) {
      if (scope.current === space && action === refreshGeneration.current) setState(previous => ({ ...previous, items: [], error: errMsg(error) }))
    } finally { if (scope.current === space && action === refreshGeneration.current) setBusy(null) }
  }
  return <section className="space-y-4" aria-label={t('subscription_usage.title')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t('subscription_usage.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subscription_usage.description')}</p></div>
      <Button size="sm" variant="outline" disabled={state.loading} onClick={() => void load()}>{t('subscription_usage.reload')}</Button>
    </div>
    {state.error && <Card role="alert"><p className="text-sm text-destructive">{state.error}</p>
      <Button className="mt-2" size="sm" variant="outline" onClick={() => void load()}>{t('subscription_usage.retry')}</Button></Card>}
    {state.loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('subscription_usage.loading')}</p>}
    {!state.loading && !state.error && !items.length && <EmptyState title={t('subscription_usage.empty')} />}
    {target && !state.loading && items.length > 0 && !selected && <p role="status" className="text-sm text-muted-foreground">{t('subscription_usage.changed')}</p>}
    <div className="grid gap-4 lg:grid-cols-2">{items.map(pool => <Card key={pool.id} id={`quota-${pool.id}`} className={selectedId === pool.id ? 'ring-2 ring-primary' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-2"><CardTitle className="min-w-0 break-words text-sm normal-case tracking-normal [overflow-wrap:anywhere]">{pool.account_display ? [pool.account?.product === 'claude' ? 'Claude' : pool.account?.product === 'codex' ? 'Codex' : pool.account?.product === 'antigravity' ? 'Antigravity' : null, pool.account_display.email, pool.account_display.workspace_name].filter(Boolean).join(' · ') : pool.label}</CardTitle>
        <Button size="sm" variant="outline" disabled={busy !== null || !pool.connections.some(item => item.online && item.can_refresh)} onClick={() => void refresh(pool)}>
          {busy === pool.id ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{t('subscription_usage.refresh')}
        </Button></div>
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
