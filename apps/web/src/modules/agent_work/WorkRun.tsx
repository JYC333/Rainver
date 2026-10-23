import { useCallback, useEffect, useState } from 'react'
import { runsApi } from '../../api/client'
import type { Run, RunTurn } from '../../types/api'
import { ConversationTurn } from '../conversation/ConversationTurn'
import { ConversationRunControls } from '../conversation/ConversationRunControls'
import { ConversationLink, useConversationScope } from '../conversation/ConversationScope'
import { useAppTranslation } from '../../i18n'
import { formatDateTime } from '../../i18n/format'
import { failureKind } from './useAgentWorkList'
import { formatWorkDuration } from './formatWorkDuration'

/** A bounded Turn read, with the existing canonical controls. No pretend Run composer. */
export function WorkRun({ runId, revision, onDisplayed, onChanged }: {
  runId: string; revision: object; onDisplayed: (id: string, authorizationIds?: string[]) => void; onChanged: () => void
}) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [data, setData] = useState<{ run: Run; turn: RunTurn } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all([runsApi.get(runId, scope), runsApi.turn(runId, scope)]).then(([run, turn]) => {
      if (active && !scope.signal?.aborted) { setData({ run, turn }); setError(null) }
    }).catch(cause => { if (active && !scope.signal?.aborted) setError(failureKind(cause)) })
    return () => { active = false }
  }, [runId, revision, scope])
  useEffect(() => { if (data) onDisplayed(runId) }, [data, onDisplayed, runId])
  const authorizationDisplayed = useCallback((ids: string[]) => onDisplayed(runId, ids), [onDisplayed, runId])
  if (error) return <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">{t(`agent_work.${error}`)}</p>
  if (!data) return <p role="status" className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t('agent_work.loading')}</p>
  const duration = data.run.started_at ? (Date.parse(data.run.ended_at ?? data.run.updated_at) - Date.parse(data.run.started_at)) / 1000 : null
  return <section className="space-y-2 border-t border-border bg-muted/20 p-3">
    <p className="text-xs text-muted-foreground">{t('agent_work.run_target', { id: runId })} · {data.run.selected_runtime_key ?? t('agent_work.runtime_unknown')} · {formatDateTime(data.run.started_at)}{duration !== null && <> · {t('agent_work.duration', { value: formatWorkDuration(Math.max(0, duration)) })}</>}</p>
    <ConversationTurn turn={data.turn} runHref={`/runs/${runId}`} />
    <ConversationRunControls runId={runId} run={data.run} projectId={data.run.project_id} onChanged={onChanged} onAuthorizationDisplayed={authorizationDisplayed} />
    <ConversationLink className="text-xs font-medium text-accent-foreground underline-offset-2 hover:underline" to={`/runs/${runId}`}>{t('agent_work.open_run')}</ConversationLink>
  </section>
}
