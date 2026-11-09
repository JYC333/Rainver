import { useEffect, useRef, useState } from 'react'
import type { ApiPlanUsageProvider, ApiPlanUsageSnapshot } from '@rainver/protocol'
import { RefreshCw } from 'lucide-react'
import { providersApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { formatDateTime, formatNumber } from '../../i18n/format'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { SpaceLink } from '../../core/spaceNav'
import { runLimited } from './limited'

export default function ApiPlanUsagePanel({ refreshKey = 0, onBusyChange }: { refreshKey?: number; onBusyChange?: (busy: boolean) => void }) {
  const { activeSpaceId } = useSpace()
  const { t } = useAppTranslation()
  const generation = useRef(0)
  const currentScope = useRef(activeSpaceId)
  currentScope.current = activeSpaceId
  const [state, setState] = useState<{ scope: string | null; items: ApiPlanUsageProvider[]; loading: boolean; failed: boolean }>({ scope: activeSpaceId, items: [], loading: true, failed: false })
  const [snapshots, setSnapshots] = useState<Record<string, ApiPlanUsageSnapshot>>({})
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  /** Providers whose query of the current refresh has not settled; finished cards stop spinning. */
  const [unsettled, setUnsettled] = useState<ReadonlySet<string>>(new Set())
  const settle = (id: string) => setUnsettled(previous => { const next = new Set(previous); next.delete(id); return next })
  async function load() {
    const mine = ++generation.current, scope = activeSpaceId
    setState(previous => ({ ...previous, scope, loading: true, failed: false }))
    setErrors({}); setBusy(null); setUnsettled(new Set())
    try {
      const result = await providersApi.planUsageProviders()
      if (mine !== generation.current || currentScope.current !== scope) return
      setState({ scope, items: result.items, loading: false, failed: false })
      setSnapshots(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => result.items.some(item => item.provider_id === id))))
      setBusy('all'); setUnsettled(new Set(result.items.map(item => item.provider_id)))
      try {
        // Bounded fan-out: a slow vendor delays its own card, not every one behind it.
        await runLimited(result.items, 3, provider => query(provider.provider_id, mine, scope),
          () => mine !== generation.current || currentScope.current !== scope)
      } finally { if (mine === generation.current && currentScope.current === scope) { setBusy(null); setUnsettled(new Set()) } }
    } catch {
      if (mine === generation.current && currentScope.current === scope) {
        setSnapshots({}); setState({ scope, items: [], loading: false, failed: true })
      }
    }
  }
  useEffect(() => { setSnapshots({}) }, [activeSpaceId])
  useEffect(() => { void load(); return () => { generation.current++ } }, [activeSpaceId, refreshKey])
  useEffect(() => { onBusyChange?.(state.loading || busy !== null) }, [state.loading, busy, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  async function query(id: string, mine: number, scope: string | null) {
    setErrors(previous => ({ ...previous, [id]: false }))
    try {
      const snapshot = await providersApi.refreshPlanUsage(id)
      if (mine === generation.current && currentScope.current === scope) setSnapshots(previous => ({ ...previous, [id]: snapshot }))
    } catch {
      if (mine === generation.current && currentScope.current === scope) {
        // An authorization failure must clear the previous reading too.
        setSnapshots(previous => { const next = { ...previous }; delete next[id]; return next })
        setErrors(previous => ({ ...previous, [id]: true }))
      }
    } finally {
      if (mine === generation.current && currentScope.current === scope) settle(id)
    }
  }
  async function refresh(id: string) {
    if (busy || state.loading) return
    const mine = generation.current, scope = activeSpaceId
    setBusy(id); setUnsettled(new Set([id]))
    try { await query(id, mine, scope) }
    finally { if (mine === generation.current && currentScope.current === scope) setBusy(null) }
  }
  const items = state.scope === activeSpaceId ? state.items : []
  return <section className="space-y-4" aria-label={t('api_plan_usage.title')}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t('api_plan_usage.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('api_plan_usage.description')}</p></div>
      <Button size="sm" variant="outline" disabled={state.loading || busy !== null} onClick={() => void load()}>{t('api_plan_usage.reload')}</Button>
    </div>
    {state.loading && <p role="status" className="text-sm text-muted-foreground">{t('subscription_usage.loading')}</p>}
    {state.failed && <p role="alert" className="text-sm text-destructive">{t('api_plan_usage.load_failed')}</p>}
    {!state.loading && !state.failed && !items.length && <p className="text-sm text-muted-foreground">{t('api_plan_usage.empty')}</p>}
    <div className="grid gap-4 lg:grid-cols-2">{items.map(provider => {
      const snapshot = state.scope === activeSpaceId ? snapshots[provider.provider_id] : undefined
      return <Card key={provider.provider_id}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="min-w-0 break-words text-sm normal-case tracking-normal [overflow-wrap:anywhere]">{provider.name}</CardTitle>
          <Button size="sm" variant="outline" disabled={state.loading || busy !== null} onClick={() => void refresh(provider.provider_id)}><RefreshCw className={unsettled.has(provider.provider_id) ? 'size-3.5 animate-spin' : 'size-3.5'} />{t('subscription_usage.refresh')}</Button>
        </div>
        {provider.vendor !== 'minimax' && <p className="mt-2 text-xs text-muted-foreground">{t('api_plan_usage.unverified')}</p>}
        {errors[provider.provider_id] && <p role="alert" className="mt-3 text-sm text-destructive">{t('api_plan_usage.query_failed')}</p>}
        {!snapshot && !errors[provider.provider_id] && <p className="mt-3 text-sm text-muted-foreground">{t(unsettled.has(provider.provider_id) ? 'quota_refresh.refreshing' : 'api_plan_usage.not_queried')}</p>}
        {snapshot && <div className="my-4 space-y-4">{snapshot.windows.map(window => <div key={window.id} className="space-y-1.5">
          <div className="flex justify-between gap-3 text-sm"><span className="min-w-0 break-words">{window.label}</span><span className="shrink-0 tabular-nums">{t('subscription_usage.used', { percent: formatNumber(window.used_pct, { maximumFractionDigits: 1 }) })}</span></div>
          <div role="progressbar" aria-label={window.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.used_pct} className="h-2 overflow-hidden rounded-full bg-muted"><div className={`h-full ${window.used_pct >= 100 ? 'bg-destructive' : 'bg-primary'}`} style={{ width: `${window.used_pct}%` }} /></div>
          {window.resets_at && <p className="text-xs text-muted-foreground">{t('subscription_usage.resets', { time: formatDateTime(window.resets_at) })}</p>}
        </div>)}<p className="text-xs text-muted-foreground">{t('subscription_usage.checked', { time: formatDateTime(snapshot.checked_at) })}</p></div>}
      </Card>
    })}</div>
    <Button asChild size="sm" variant="ghost"><SpaceLink to="/providers">{t('api_plan_usage.manage')}</SpaceLink></Button>
  </section>
}
