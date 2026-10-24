import { useState } from 'react'
import { ConfirmDialog } from '../../components/ui/dialog'
import { Button } from '../../components/ui/button'
import { useAppTranslation } from '../../i18n'
import type { ConversationExecutionSummary } from '../../types/api'

type Runtime = ConversationExecutionSummary['runtimes'][number]
export function isPromptCacheExpired(runtime: Runtime): boolean {
  if (!runtime.last_run_ended_at || !runtime.prompt_cache_ttl_seconds) return false
  const ended = Date.parse(runtime.last_run_ended_at)
  return Number.isFinite(ended) && Date.now() - ended >= runtime.prompt_cache_ttl_seconds * 1000
}

export function ConversationCacheNotice({ runtimes, nameForAgent, disabled, onReset }: {
  runtimes: Runtime[]
  nameForAgent: (id: string) => string
  disabled: boolean
  onReset: (id: string) => Promise<void>
}) {
  const { t } = useAppTranslation()
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const expired = runtimes.filter(isPromptCacheExpired)
  if (!expired.length) return null
  async function reset() {
    if (!selected || busy) return
    const id = selected
    setSelected(null); setBusy(true); setError(false)
    try { await onReset(id) } catch { setError(true) } finally { setBusy(false) }
  }
  return <div className="space-y-2 rounded border border-warning/40 bg-warning/5 p-2.5 text-xs" role="status">
    {expired.map(runtime => <div key={runtime.agent_id} className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1">{t('conversation_ui.preflight.cache_expired_visible', { agent: nameForAgent(runtime.agent_id) })}</span>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setSelected(runtime.agent_id)}>{t('conversation_ui.preflight.fresh_session', { agent: nameForAgent(runtime.agent_id) })}</Button>
    </div>)}
    {error && <p role="alert" className="text-destructive">{t('conversation_ui.preflight.reset_failed')}</p>}
    <ConfirmDialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null) }}
      title={t('conversation_ui.preflight.fresh_session', { agent: selected ? nameForAgent(selected) : '' })}
      description={t('conversation_ui.preflight.fresh_session_description')}
      confirmLabel={t('conversation_ui.preflight.fresh_session_confirm')} onConfirm={() => void reset()} />
  </div>
}
