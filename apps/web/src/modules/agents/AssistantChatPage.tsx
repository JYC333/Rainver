import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { Loader2, Settings2, MessageSquareText } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi } from '../../api/client'
import type { AgentOut } from '../../types/api'
import { Button } from '../../components/ui/button'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { errMsg } from '../../lib/utils'
import ChatPanel from './ChatPanel'

/**
 * Dedicated, full-height chat surface for an agent (typically the space's Personal
 * Assistant). Chat is a primary daily activity, so it is its own page — intentionally
 * separate from the agent's configuration, which lives on AgentDetailPage. A draft
 * carried from Home (?draft=) is captured once and auto-sent on arrival.
 *
 * ChatPanel loads the signed-in user's eligible managed and CLI conversation
 * backends. A user × session binding is restored when the page opens an
 * existing thread.
 */
export default function AssistantChatPage() {
  const { agentId } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  // Captured once so the Chat auto-sends it; the URL param is then cleared so a
  // refresh won't resend the same message.
  const [initialDraft] = useState(() => searchParams.get('draft'))
  const sessionParam = searchParams.get('session')
  const [agent, setAgent] = useState<AgentOut | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!agentId) return
    setLoading(true)
    agentsApi.get(agentId)
      .then(setAgent)
      .catch(err => toast.error(errMsg(err)))
      .finally(() => setLoading(false))
  }, [agentId])

  // Clear the carried ?draft= once (already captured into initialDraft above).
  useEffect(() => {
    if (searchParams.get('draft')) {
      setSearchParams(p => { p.delete('draft'); return p }, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rememberSession = useCallback((sessionId: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('draft')
      next.set('session', sessionId)
      return next
    }, { replace: true })
  }, [setSearchParams])

  if (loading) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  if (!agent) return <div className="p-6 text-muted-foreground">Agent not found.</div>

  const isAssistant = agent.agent_kind === 'system_assistant'
  return (
    <div className="flex flex-col h-full w-full max-w-3xl mx-auto p-4 md:p-6">
      <header className="flex items-start justify-between gap-4 shrink-0">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold flex items-center gap-2 truncate">
            {agent.name} <StatusBadge status={agent.status} />
            {isAssistant && <Badge variant="secondary">System-managed</Badge>}
          </h1>
          {agent.description && <p className="text-sm text-muted-foreground truncate">{agent.description}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button asChild size="sm" variant="outline">
            <Link to={`/agents/${agent.id}`}><Settings2 className="size-3.5 mr-1" />Settings</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/sessions"><MessageSquareText className="size-3.5 mr-1" />History</Link>
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 mt-4">
        <ChatPanel
          agent={agent}
          initialDraft={initialDraft}
          initialSessionId={sessionParam}
          onSessionChange={rememberSession}
        />
      </div>
    </div>
  )
}
