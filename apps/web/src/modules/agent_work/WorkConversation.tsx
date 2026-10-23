import { useEffect, useState } from 'react'
import type { AgentWorkItem } from '@rainver/protocol'
import { agentsApi, roomsApi } from '../../api/client'
import type { AgentOut, ConversationExecutionSummary, RoomDetail } from '../../types/api'
import { useConversationScope, ConversationLink } from '../conversation/ConversationScope'
import { ConversationSurface } from '../conversation/ConversationSurface'
import { ConversationExecutionPreflight } from '../conversation/ConversationExecutionPreflight'
import { conversationInputSourcesFromExecutionSummary } from '../conversation/ConversationInputComposer'
import ChatPanel from '../agents/ChatPanel'
import { useAppTranslation } from '../../i18n'
import { failureKind } from './useAgentWorkList'

export function WorkConversation({ item, onMessagesDisplayed, onChanged, onReadError }: {
  item: AgentWorkItem; onMessagesDisplayed: (ids: string[]) => void; onChanged: () => void; onReadError: (error: unknown) => void
}) {
  const target = item.operations.find(operation => operation.kind === 'open_session')
  const targetKey = JSON.stringify(target)
  const scope = useConversationScope()
  const { t } = useAppTranslation()
  const [room, setRoom] = useState<RoomDetail | null>(null)
  const [agent, setAgent] = useState<AgentOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [summary, setSummary] = useState<ConversationExecutionSummary | null>(null)
  useEffect(() => {
    if (target?.kind !== 'open_session') return
    let active = true
    void (target.room_id ? roomsApi.get(target.room_id, scope).then(value => { if (active && !scope.signal?.aborted) { setRoom(value); setError(null) } })
      : agentsApi.get(target.agent_id, scope).then(value => { if (active && !scope.signal?.aborted) { setAgent(value); setError(null) } }))
      .catch(cause => { if (active && !scope.signal?.aborted) { setError(failureKind(cause)); onReadError(cause) } })
    return () => { active = false }
  }, [item, targetKey, scope, onReadError])
  if (target?.kind !== 'open_session') return null
  const href = target.room_id ? `/rooms/${encodeURIComponent(target.room_id)}?conversation=${encodeURIComponent(target.session_id)}`
    : `/agents/${encodeURIComponent(target.agent_id)}/chat?session=${encodeURIComponent(target.session_id)}`
  return <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
    <ConversationLink className="text-xs font-medium text-accent-foreground underline-offset-2 hover:underline" to={href}>{t('agent_work.open_conversation')}</ConversationLink>
    <p className="text-xs text-muted-foreground">{t('agent_work.reply_target', { name: room?.agent_members.find(member => member.role === 'manager')?.agent_name ?? agent?.name ?? target.agent_id })}</p>
    {error && !room && !agent ? null
      : room ? <>{!room.viewer_can_write && <p className="text-xs text-muted-foreground">{t('agent_work.no_conversation_authority')}</p>}<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"><ConversationSurface readOnly={!room.viewer_can_write} spaceId={item.space_id} roomId={target.room_id!} conversationId={target.session_id}
        detail={room} variant="panel" executionReady={ready} inputFileSources={conversationInputSourcesFromExecutionSummary(summary)}
        onMessagesDisplayed={onMessagesDisplayed} onReadError={onReadError} onSent={onChanged}
        executionPreflight={room.viewer_can_write && <ConversationExecutionPreflight spaceId={item.space_id} projectId={room.room.project_id} roomId={room.room.id}
          sessionId={target.session_id} detail={room} onReadyChange={setReady} onSummaryChange={setSummary} />} /></div></>
      : agent ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"><ChatPanel agent={agent} initialSessionId={target.session_id} projectId={item.project_id ?? undefined}
        onMessagesDisplayed={onMessagesDisplayed} onReadError={onReadError} onSessionChange={onChanged} /></div>
      : <p role="status" className="text-sm text-muted-foreground">{t('agent_work.loading')}</p>}
  </div>
}
