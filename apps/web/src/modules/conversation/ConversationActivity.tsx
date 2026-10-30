import { CirclePause, Loader2, Square } from 'lucide-react'
import type { Run, RunTurn } from '../../types/api'
import { useAppTranslation } from '../../i18n'
import { useConversationScope } from './ConversationScope'
import { RunQuotaRecoveryControls, runQuotaRecovery } from '../runs/RunQuotaRecoveryControls'

import { useRunActions } from '../runs/useRunActions'
import { Button } from '../../components/ui/button'

/** A compact, persistent companion to the chronological Room/Project transcript. */
export function ConversationActivity({ runs, turns, agentName, onChanged, allowCommands = true }: {
  runs: Run[]
  turns: Record<string, RunTurn>
  agentName: (runId: string) => string | undefined
  onChanged?: (run: Run) => void
  allowCommands?: boolean
}) {
  const { t, locale } = useAppTranslation()
  const scope = useConversationScope()
  if (!runs.length) return null
  return (
    <div role="status" aria-label={t('conversation_ui.surface.current_activity')}
      className="max-h-28 shrink-0 space-y-1 overflow-y-auto border-t border-border bg-card px-3 py-2 text-xs">
      {runs.map(run => {
        if (runQuotaRecovery(run)) return <div key={run.id} className="space-y-1">
          <div className="flex items-center gap-2"><span className="flex-1">{agentName(run.id) ?? t('conversation_ui.surface.agent')}</span>{allowCommands && (!scope.actionUserId || run.owner_user_id === scope.actionUserId || run.instructed_by_user_id === scope.actionUserId) && <ActivityStop run={run} onChanged={onChanged} />}</div>
          <RunQuotaRecoveryControls run={run} scope={scope}
            canControl={allowCommands && (!scope.actionUserId || run.owner_user_id === scope.actionUserId || run.instructed_by_user_id === scope.actionUserId)}
            onChanged={onChanged} />
        </div>
        const turn = turns[run.id]
        const blocked = turn?.state === 'blocked' || run.status === 'waiting_for_review'
        const idle = blocked || run.status === 'queued' || run.status === 'waiting_for_dependency'
        const label = run.status === 'cancelling' ? t('conversation_ui.run.stopping')
          : turn?.blocked_on === 'quota' ? t('conversation_ui.turn.blocked_quota')
          : run.status === 'queued' ? t('conversation_ui.surface.queued')
          : run.status === 'waiting_for_dependency' ? t('conversation_ui.surface.waiting_agents')
          : blocked ? t(turn?.blocked_on === 'authorization' ? 'conversation_ui.turn.blocked_authorization'
            : turn?.blocked_on === 'workspace' ? 'conversation_ui.turn.blocked_workspace' : 'conversation_ui.turn.blocked_decision')
          : t('conversation_ui.turn.working')
        return <div key={run.id} className="flex items-center gap-2">
          {idle ? <CirclePause className="size-3 shrink-0" /> : <Loader2 className="size-3 shrink-0 animate-spin" />}
          <span className="min-w-0 flex-1 break-words">{agentName(run.id) ?? t('conversation_ui.surface.agent')} · {label}
            {runs.filter(candidate => candidate.agent_id === run.agent_id).length > 1 && run.created_at && <time dateTime={run.created_at} className="ml-2 text-muted-foreground">{new Date(run.created_at).toLocaleString(locale)}</time>}
          </span>
          {allowCommands && (!scope.actionUserId || run.owner_user_id === scope.actionUserId || run.instructed_by_user_id === scope.actionUserId) && <ActivityStop run={run} onChanged={onChanged} />}
        </div>
      })}
    </div>
  )
}

/** Keep each command bound to its exact Run, including older held turns. */
function ActivityStop({ run, onChanged }: { run: Run; onChanged?: (run: Run) => void }) {
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const actions = useRunActions(run.id, scope, next => onChanged?.(next))
  return <div className="shrink-0">
    <Button type="button" size="sm" variant="outline" className="h-6 px-2" disabled={Boolean(actions.busy) || run.status === 'cancelling'} onClick={() => void actions.perform({ kind: 'stop' })}>
      <Square className="mr-1 size-3" />{t(run.status === 'cancelling' ? 'conversation_ui.run.stopping' : 'conversation_ui.run.stop')}
    </Button>
    {(actions.error || actions.refreshError) && <span role="alert" className="text-destructive">{actions.error || actions.refreshError}</span>}
  </div>
}
