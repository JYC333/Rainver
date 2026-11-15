import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, History, Loader2, Settings2 } from 'lucide-react'
import { agentsApi, ApiRequestError, projectsApi } from '../../../api/client'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { SpaceLink as Link } from '../../../core/spaceNav'
import { useAppTranslation } from '../../../i18n'
import { errMsg } from '../../../lib/utils'
import type { AgentOut } from '../../../types/api'
import ChatPanel from '../../agents/ChatPanel'

/**
 * One Project Agent, used on its own in this Project.
 *
 * The same direct conversation the Agent library offers, placed in this
 * Project: the turn carries Project context and nothing of any Room — no
 * roster, no transcript. The server starts a new one only for an Agent on the
 * Project's list, which is what this page is reached from.
 */
export default function ProjectAgentChatPage() {
  const { t } = useAppTranslation()
  const { projectId = '', agentId = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const sessionParam = search.get('session')
  const [agent, setAgent] = useState<AgentOut | null>(null)
  const [projectName, setProjectName] = useState('')
  const [onList, setOnList] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setFailure(null)
    Promise.all([
      agentsApi.get(agentId),
      projectsApi.get(projectId).catch(() => null),
      // One link, asked of the server directly: the answer does not depend on where the Agent sits in the list.
      // Only a 404 means "not on the list"; any other failure leaves the question open rather than warning.
      projectsApi.agent(projectId, agentId).then(
        () => true as boolean | null,
        error => (error instanceof ApiRequestError && error.status === 404 ? false : null),
      ),
    ])
      .then(([nextAgent, project, linked]) => {
        if (!active) return
        setAgent(nextAgent)
        setProjectName(project?.name ?? '')
        setOnList(linked)
      })
      .catch(error => { if (active) { setAgent(null); setFailure(errMsg(error)) } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agentId, projectId])

  const rememberSession = useCallback((sessionId: string) => {
    setSearch(previous => {
      const next = new URLSearchParams(previous)
      next.set('session', sessionId)
      return next
    }, { replace: true })
  }, [setSearch])

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('collab_ui.common.loading')}</div>
  }
  if (!agent) {
    return <div className="p-6 text-sm text-muted-foreground">{failure ?? t('collab_ui.chat.not_found')}</div>
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col p-4 md:p-6">
      <header className="shrink-0 space-y-2">
        <Link to={`/projects/${projectId}/agents`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ArrowLeft className="size-3.5" />{t('collab_ui.chat.back')}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              <span className="truncate">{agent.name}</span>
              <Badge variant="secondary">{t('collab_ui.chat.badge')}</Badge>
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">{t('collab_ui.chat.context', { project: projectName || projectId })}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button asChild size="sm" variant="outline">
              <Link to={`/agents/${agent.id}`}><Settings2 className="size-3.5" />{t('collab_ui.agents.configure')}</Link>
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to={`/agents/${agent.id}?tab=runs`}><History className="size-3.5" />{t('collab_ui.agents.work_history')}</Link>
            </Button>
          </div>
        </div>
      </header>
      {onList === false && !sessionParam && (
        <Card data-testid="not-in-project" className="mt-3 border-warning/40 bg-warning/5 p-3 text-sm">{t('collab_ui.chat.not_in_project')}</Card>
      )}
      <div className="mt-4 min-h-0 flex-1">
        <ChatPanel
          key={`${projectId}:${agent.id}`}
          agent={agent}
          projectId={projectId}
          initialSessionId={sessionParam}
          onSessionChange={rememberSession}
        />
      </div>
    </div>
  )
}
