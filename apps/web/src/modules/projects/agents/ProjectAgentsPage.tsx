import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Bot, History, Loader2, MessageSquare, MoreHorizontal, Plus, RefreshCw, Settings2, UserMinus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, projectsApi } from '../../../api/client'
import { Badge } from '../../../components/ui/badge'
import { Button } from '../../../components/ui/button'
import { Card } from '../../../components/ui/card'
import { ConfirmDialog } from '../../../components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import { EmptyState } from '../../../components/ui/empty-state'
import { Input } from '../../../components/ui/input'
import { Skeleton } from '../../../components/ui/skeleton'
import { useSpace } from '../../../contexts/SpaceContext'
import { SpaceLink as Link, useSpaceNavigate } from '../../../core/spaceNav'
import { useAppTranslation } from '../../../i18n'
import { errMsg } from '../../../lib/utils'
import type { ProjectAgent, ProjectRoomSummary } from '../../../types/api'
import { displayRoomTitle } from '../../agent_groups/roomTitle'
import { CREATED_AGENT_PARAM, newAgentHref } from '../agentCreationReturn'
import { AddProjectAgentDialog } from './AddProjectAgentDialog'
import { JoinRoomDialog } from './JoinRoomDialog'
import { PAGE_SIZE, usePageGeneration } from './usePagedSearch'

/**
 * Which Agents this Project works with.
 *
 * A Project Agent is not a Room member. Adding one here lets it work in this
 * Project on its own — a direct conversation placed in the Project, which
 * reads Project context and no Room's history — and does not put it on any
 * Room roster. Joining a Room is a separate, explicit step per Room, and
 * leaving a Room keeps it here. The list is filtered by the viewer's own
 * access: a private Agent appears only to people it is shared with, and the
 * Rooms named on a card are only Rooms the viewer is in.
 */
export default function ProjectAgentsPage() {
  const { t } = useAppTranslation()
  const { projectId = '' } = useParams()
  const { userId } = useSpace()
  const navigate = useSpaceNavigate()
  const [search, setSearch] = useSearchParams()
  const createdAgentId = search.get(CREATED_AGENT_PARAM)
  const [items, setItems] = useState<ProjectAgent[]>([])
  const [total, setTotal] = useState(0)
  const [canWrite, setCanWrite] = useState(false)
  const [rooms, setRooms] = useState<ProjectRoomSummary[]>([])
  const [projectName, setProjectName] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [joining, setJoining] = useState<ProjectAgent | null>(null)
  const [removing, setRemoving] = useState<ProjectAgent | null>(null)
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null)
  // Every page — the first and each "load more" — belongs to one Project and one search.
  const pages = usePageGeneration(projectId)
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  const returnTo = `/projects/${projectId}/agents`
  const createHref = newAgentHref(projectId, returnTo)

  const load = useCallback(async (text: string) => {
    const current = pagesRef.current.begin()
    setLoading(true)
    setFailed(false)
    try {
      // The Rooms index first: it enrols the viewer in the mainline, so the
      // Rooms named on each card and offered by "Add to Room" are complete.
      const [roomPage, project] = await Promise.all([
        projectsApi.rooms(projectId, { limit: 200 }),
        projectsApi.get(projectId).catch(() => null),
      ])
      const page = await projectsApi.agents(projectId, { q: text.trim() || undefined, limit: PAGE_SIZE })
      if (!pagesRef.current.isCurrent(current)) return
      pagesRef.current.loadedFor(text)
      setRooms(roomPage.items)
      setProjectName(project?.name)
      setItems(page.items)
      setTotal(page.total)
      setCanWrite(page.viewer_can_write)
    } catch (error) {
      if (!pagesRef.current.isCurrent(current)) return
      setFailed(true)
      toast.error(errMsg(error))
    } finally {
      if (pagesRef.current.isCurrent(current)) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [projectId])

  // Another Project: nothing of the previous one stays on screen or in flight.
  useEffect(() => {
    pagesRef.current.reset()
    setItems([])
    setTotal(0)
    setRooms([])
    setCanWrite(false)
    setProjectName(undefined)
    setFailed(false)
    setLoading(true)
    setLoadingMore(false)
    setQuery('')
  }, [projectId])

  useEffect(() => {
    // A new search invalidates every page still in flight at once, not when the
    // debounced request leaves: a late answer for the old text is never shown.
    pagesRef.current.begin()
    setLoading(true)
    setLoadingMore(false)
    const timer = setTimeout(() => { void load(query) }, query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])

  // Returned here from "Create new Agent": take the id out of the URL once (a
  // reload must not offer it again), then name it and offer the add.
  const [pendingCreatedId, setPendingCreatedId] = useState<string | null>(null)
  useEffect(() => {
    if (!createdAgentId) return
    setPendingCreatedId(createdAgentId)
    setSearch(current => { const next = new URLSearchParams(current); next.delete(CREATED_AGENT_PARAM); return next }, { replace: true })
  }, [createdAgentId, setSearch])
  useEffect(() => {
    if (!pendingCreatedId) return
    let active = true
    agentsApi.get(pendingCreatedId)
      .then(agent => { if (active) setCreated({ id: agent.id, name: agent.name }) })
      .catch(() => { if (active) setCreated(null) })
    return () => { active = false }
  }, [pendingCreatedId])

  async function loadMore() {
    // Continues only the rows on screen, for the Project and search they were loaded for.
    const loadedQuery = pagesRef.current.loadedQuery()
    if (loading || loadingMore || loadedQuery === null || loadedQuery !== query) return
    const token = pagesRef.current.current()
    setLoadingMore(true)
    try {
      const page = await projectsApi.agents(projectId, { q: loadedQuery.trim() || undefined, limit: PAGE_SIZE, offset: items.length })
      if (!pagesRef.current.isCurrent(token)) return
      setItems(current => [...current, ...page.items.filter(item => !current.some(existing => existing.agent_id === item.agent_id))])
      setTotal(page.total)
    } catch (error) {
      if (pagesRef.current.isCurrent(token)) toast.error(errMsg(error))
    } finally {
      if (pagesRef.current.isCurrent(token)) setLoadingMore(false)
    }
  }

  async function addCreated() {
    if (!created) return
    try {
      await projectsApi.addAgent(projectId, created.id)
      toast.success(t('collab_ui.agents.added', { name: created.name }))
      setCreated(null)
      await load(query)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function remove(agent: ProjectAgent) {
    try {
      await projectsApi.removeAgent(projectId, agent.agent_id)
      toast.success(t('collab_ui.agents.removed', { name: agent.name }))
      await load(query)
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  const alreadyListed = useMemo(() => new Set(items.map(item => item.agent_id)), [items])

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Bot className="size-5" />{t('collab_ui.agents.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('collab_ui.agents.subtitle')}</p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" />{t('collab_ui.agents.add_existing')}</Button>
            <Button asChild size="sm" variant="outline">
              <Link to={createHref}>{t('collab_ui.agents.create_new')}</Link>
            </Button>
          </div>
        )}
      </header>

      {created && !alreadyListed.has(created.id) && canWrite && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/5 p-3">
          <p className="text-sm">{t('collab_ui.agents.created_prompt', { name: created.name })}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void addCreated()}>{t('collab_ui.agents.created_add')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>{t('collab_ui.common.dismiss')}</Button>
          </div>
        </Card>
      )}

      {!canWrite && !loading && !failed && items.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('collab_ui.agents.viewer_note')}</p>
      )}

      {(total > PAGE_SIZE || query) && (
        <Input
          className="max-w-sm"
          aria-label={t('collab_ui.agents.search')}
          placeholder={t('collab_ui.agents.search')}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      )}

      {loading && items.length === 0 ? (
        <div className="space-y-2"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
      ) : failed ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('collab_ui.agents.load_failed')}</p>
          <Button size="sm" variant="outline" onClick={() => void load(query)}><RefreshCw className="size-4" />{t('collab_ui.common.retry')}</Button>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            title={query.trim() ? t('collab_ui.add_agent.no_match', { q: query.trim() }) : t('collab_ui.agents.empty_title')}
            description={query.trim() ? undefined : t('collab_ui.agents.empty_text')}
            action={canWrite && !query.trim() ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" />{t('collab_ui.agents.add_existing')}</Button>
                <Button asChild size="sm" variant="outline"><Link to={createHref}>{t('collab_ui.agents.create_new')}</Link></Button>
              </div>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-2" aria-busy={loading}>
          {items.map(agent => (
            <Card key={agent.agent_id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between" data-testid={`project-agent-${agent.agent_id}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{agent.name}</span>
                  {agent.room_only && <Badge variant="outline">{t('collab_ui.roster.private_share')}</Badge>}
                  {agent.private && !agent.room_only && <Badge variant="outline" title={t('collab_ui.agents.private_hint')}>{t('collab_ui.common.private')}</Badge>}
                  {agent.status !== 'active' && <Badge variant="muted">{agent.status}</Badge>}
                </div>
                {agent.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{agent.description}</p>}
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <Users className="size-3.5 shrink-0" />
                  {agent.rooms.length > 0
                    ? t('collab_ui.agents.in_rooms', { rooms: agent.rooms.map(room => displayRoomTitle(room, projectName)).join(', ') })
                    : t('collab_ui.agents.no_rooms')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
                {agent.room_only ? <Button asChild size="sm" variant="outline">
                  <Link to={agent.rooms[0] ? `/projects/${projectId}/rooms?room=${agent.rooms[0].room_id}&view=members` : `/projects/${projectId}/rooms`}>
                    <Users className="size-3.5" />{t('collab_ui.agents.use_room')}
                  </Link>
                </Button> : <Button
                  size="sm"
                  variant="outline"
                  disabled={agent.status !== 'active'}
                  onClick={() => navigate(`/projects/${projectId}/agents/${agent.agent_id}/chat`)}
                >
                  <MessageSquare className="size-3.5" />{t('collab_ui.agents.use')}
                </Button>}
                {canWrite && (!agent.private || agent.viewer_is_owner) && (
                  <Button size="sm" variant="ghost" onClick={() => setJoining(agent)}>
                    <Users className="size-3.5" />{t('collab_ui.agents.add_to_room')}
                  </Button>
                )}
                {!agent.room_only && <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" aria-label={t('collab_ui.agents.actions_for', { name: agent.name })}><MoreHorizontal className="size-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(`/agents/${agent.agent_id}`)}><Settings2 className="size-4" />{t('collab_ui.agents.configure')}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => navigate(`/agents/${agent.agent_id}?tab=runs`)}><History className="size-4" />{t('collab_ui.agents.work_history')}</DropdownMenuItem>
                    {canWrite && (
                      <DropdownMenuItem onSelect={() => setRemoving(agent)}><UserMinus className="size-4" />{t('collab_ui.agents.remove')}</DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>}
              </div>
            </Card>
          ))}
          {items.length < total && (
            <Button size="sm" variant="ghost" className="w-full" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? <Loader2 className="size-3.5 animate-spin" /> : null}{t('collab_ui.common.load_more')}
            </Button>
          )}
        </div>
      )}

      <AddProjectAgentDialog
        open={adding}
        projectId={projectId}
        createHref={createHref}
        onClose={() => setAdding(false)}
        onAdded={() => load(query)}
      />
      <JoinRoomDialog
        agent={joining}
        rooms={rooms}
        projectName={projectName}
        userId={userId ?? null}
        onClose={() => setJoining(null)}
        onJoined={() => load(query)}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={next => { if (!next) setRemoving(null) }}
        title={t('collab_ui.agents.remove_title', { name: removing?.name ?? '' })}
        description={t('collab_ui.agents.remove_text')}
        confirmLabel={t('collab_ui.agents.remove')}
        onConfirm={() => { const target = removing; setRemoving(null); if (target) void remove(target) }}
      />
    </div>
  )
}
