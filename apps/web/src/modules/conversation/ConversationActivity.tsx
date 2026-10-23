import { CirclePause, Loader2 } from 'lucide-react'
import type { Run, RunTurn } from '../../types/api'
import { useAppTranslation } from '../../i18n'
import { useConversationScope } from './ConversationScope'
import { RunQuotaRecoveryControls, runQuotaRecovery } from '../runs/RunQuotaRecoveryControls'

/** A compact, persistent companion to the chronological Room/Project transcript. */
export function ConversationActivity({ runs, turns, agentName, onChanged, allowCommands = true }: {
  runs: Run[]
  turns: Record<string, RunTurn>
  agentName: (runId: string) => string | undefined
  onChanged?: (run: Run) => void
  allowCommands?: boolean
}) {
  const { t } = useAppTranslation()
  const scope = useConversationScope()
  if (!runs.length) return null
  return (
    <div role="status" aria-label={t('conversation_ui.surface.current_activity')}
      className="max-h-28 shrink-0 space-y-1 overflow-y-auto border-t border-border bg-card px-3 py-2 text-xs">
      {runs.map(run => {
        if (runQuotaRecovery(run)) return <div key={run.id} className="space-y-1">
          <span>{agentName(run.id) ?? t('conversation_ui.surface.agent')}</span>
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
          <span>{agentName(run.id) ?? t('conversation_ui.surface.agent')} · {label}</span>
        </div>
      })}
    </div>
  )
}
