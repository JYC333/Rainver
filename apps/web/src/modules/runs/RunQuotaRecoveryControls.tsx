import { QuotaRecoverySchema } from '@rainver/protocol'
import { useEffect, useState } from 'react'
import type { RequestOptions } from '../../api/client'
import type { Run } from '../../types/api'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import { useRunActions } from './useRunActions'

export function runQuotaRecovery(run: Run) {
  if (run.status !== 'queued') return null
  const marker = run.output_json?.waiting_for_quota
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
  const record = marker as Record<string, unknown>
  const parsed = QuotaRecoverySchema.safeParse(record.recovery)
  return parsed.success ? { ...parsed.data, resets_at: typeof record.resets_at === 'string' ? record.resets_at : null } : null
}

/** Same canonical commands in the transcript, bottom activity bar and Run detail. */
export function RunQuotaRecoveryControls({ run: supplied, scope, canControl, onChanged }: {
  run: Run; scope: RequestOptions; canControl: boolean; onChanged?: (run: Run) => void | Promise<void>
}) {
  const { t } = useAppTranslation()
  const [run, setRun] = useState(supplied)
  useEffect(() => setRun(supplied), [supplied])
  const actions = useRunActions(run.id, scope, async next => { setRun(next); await onChanged?.(next) })
  const recovery = runQuotaRecovery(run)
  if (!recovery) return null
  const reset = recovery.resets_at ? new Date(recovery.resets_at).toLocaleString() : null
  return <div className="flex flex-wrap items-center gap-2 text-xs" data-testid={`quota-recovery-${run.id}`}>
    <span>{t(recovery.auto_continue ? 'conversation_ui.run.quota_waiting' : 'conversation_ui.run.quota_paused')}
      {reset ? ` · ${t('conversation_ui.run.quota_check_after', { time: reset })}` : ` · ${t('conversation_ui.run.quota_unknown')}`}</span>
    {recovery.pause_reason && recovery.pause_reason !== 'user' && <span>{t(`conversation_ui.run.quota_reason_${recovery.pause_reason}`)}</span>}
    {canControl && <Button type="button" size="sm" variant="outline" className="h-7" disabled={Boolean(actions.busy)}
      onClick={() => void actions.perform({ kind: 'quota_recovery', autoContinue: !recovery.auto_continue })}>
      {t(recovery.auto_continue ? 'conversation_ui.run.quota_cancel' : 'conversation_ui.run.quota_enable')}
    </Button>}
    {actions.error && <span role="alert" className="text-destructive">{actions.error}</span>}
    {actions.refreshError && <span role="status" className="text-muted-foreground">{t('conversation_ui.run.refresh_failed', { message: actions.refreshError })}</span>}
  </div>
}
