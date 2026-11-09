import { useEffect, useRef, useState } from 'react'
import { hostsApi } from '../../api/client'
import { ConversationLink, useConversationScope } from '../conversation/ConversationScope'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { formatDateTime, formatNumber } from '../../i18n/format'
import { errMsg } from '../../lib/utils'
import type { Run } from '../../types/api'
import { commandCenterRuntimePath } from '../command_center/hostLinks'
import { runtimeFailure } from './runtimeFailure'

/** Guidance only. Login and retries retain their existing permissioned owners. */
export function RuntimeFailureNotice({ run, flat = false }: { run: Run; flat?: boolean }) {
  const { t } = useAppTranslation()
  const scope = useConversationScope()
  const failure = runtimeFailure(run)
  const target = failure?.target
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ key: string; host?: string; at?: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    pending.current?.abort()
    pending.current = null
    setBusy(false); setReport(null); setError(null)
    return () => { pending.current?.abort(); pending.current = null }
  }, [run.id, run.space_id, target?.host_id, target?.runtime_key, target?.installation, target?.backend_mode, scope.signal])

  async function refresh() {
    if (!target || pending.current || scope.signal?.aborted || (scope.spaceId && scope.spaceId !== run.space_id)) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setReport(null); setError(null)
    try {
      // A fresh read of the Host's report, not a new CLI/login process.
      const result = await hostsApi.list({ spaceId: run.space_id, signal: controller.signal })
      if (controller.signal.aborted) return
      const host = result.items.find(item => item.id === target.host_id)
      const copy = host?.capabilities_json?.installations?.[target.runtime_key]?.find(item => item.id === target.installation)
      setReport({ key: !host ? 'unavailable' : host.status !== 'online' ? 'offline' : !copy ? 'copy_missing'
        : target.backend_mode === 'model_provider' ? 'provider_bound'
        : copy.logged_in === true ? 'reported_signed_in' : copy.logged_in === false ? 'reported_signed_out' : 'unconfirmed',
        host: host?.name, at: host?.last_heartbeat_at })
    } catch (caught) {
      if (!controller.signal.aborted) setError(errMsg(caught))
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }

  if (!failure || (scope.spaceId && scope.spaceId !== run.space_id)) return null
  return <section className={flat ? 'min-w-0 space-y-2 text-sm' : 'min-w-0 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm'} aria-label={t('runtime_failure_ui.guidance')} data-testid={`runtime-failure-${run.id}`}>
    <p className="font-medium">{t(`runtime_failure_ui.cause.${failure.cause}`)}</p>
    <p className="text-xs text-muted-foreground">{t(`runtime_failure_ui.advice.${failure.cause}`)}</p>
    {failure.evidence?.phase && <p className="text-xs text-muted-foreground">{t('runtime_failure_ui.failed_during', { phase: t(`runtime_failure_ui.phase.${failure.evidence.phase}`) })}</p>}
    {target && <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" variant="outline"><ConversationLink to={commandCenterRuntimePath(target)}>{t(failure.cause === 'auth' ? 'runtime_failure_ui.open_login' : 'runtime_failure_ui.open_host')}</ConversationLink></Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{t(busy ? 'runtime_failure_ui.refreshing' : 'runtime_failure_ui.refresh')}</Button>
    </div>}
    {report && <p role="status" className="text-xs text-muted-foreground">{t(`runtime_failure_ui.report.${report.key}`, { host: report.host })}{report.at ? ` · ${t('runtime_failure_ui.reported_at', { at: formatDateTime(report.at) })}` : ''}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {(run.error_message || failure.evidence) && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer hover:text-foreground">{t('runtime_failure_ui.details')}</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{run.error_message ?? failure.evidence?.message}</p>
      {failure.evidence?.phase_elapsed_ms !== undefined && <p>{t('runtime_failure_ui.phase_duration', { seconds: formatNumber(failure.evidence.phase_elapsed_ms / 1000, { maximumFractionDigits: 1 }) })}</p>}
    </details>}
  </section>
}
