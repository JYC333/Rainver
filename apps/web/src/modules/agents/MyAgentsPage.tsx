import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, ChevronDown, ChevronUp, LayoutTemplate, Loader2, Plus } from 'lucide-react'
import { pluginFrontendEntries, type MyAgent, type MyAgentLocation, type MyAgentsQuery } from '@rainver/protocol'
import { agentsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { useAppTranslation } from '../../i18n'
import { NavLinkOrInert } from '../../core/spaceNav'
import { spaceHref } from '../../core/spacePath'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import { bundledPlugin } from '../plugins/manifestCatalog'
import { sidecarRoomName } from '../projects/sidecar/SidecarNavigator'
import { usePeriodicRefresh } from '../../hooks/usePeriodicRefresh'
import { readMore, readRange } from './myAgentsPaging'

const PAGE = 50
/** A stop, a Room seat or a plugin change elsewhere shows up without leaving the page. */
const LIVE_REFRESH_MS = 30_000
type Manage = MyAgentsQuery['manage']
type Source = MyAgentsQuery['source']
type T = (key: string, options?: Record<string, unknown>) => string

const roomHref = (agent: MyAgent, projectId: string, roomId: string) =>
  `/spaces/${encodeURIComponent(agent.space_id)}/projects/${encodeURIComponent(projectId)}/rooms?room=${encodeURIComponent(roomId)}`

/** A plugin's own page in one Project: its first Project area entry, the page where its assistant is set up. */
function pluginPageHref(agent: MyAgent, projectId: string): string | null {
  const manifest = agent.plugin_id ? bundledPlugin(agent.plugin_id)?.manifest : undefined
  const entry = manifest ? pluginFrontendEntries(manifest).find(item => item.placements.includes('project.area')) : undefined
  if (!manifest || !entry) return null
  return `/spaces/${encodeURIComponent(agent.space_id)}/projects/${encodeURIComponent(projectId)}/plugins/${encodeURIComponent(manifest.id)}/${encodeURIComponent(entry.entry_id)}`
}

const usable = (location: MyAgentLocation) => location.plugin_state === null || location.plugin_state === 'ready'

/**
 * My Agents: every Agent the person can use, across all their Spaces
 * (`GET /me/agents`, agents guide "My Agents"). Each entry opens in its own
 * Space — its detail, its direct chat, its Rooms, its plugin's page — and only
 * where the server says the person may: a Room-only entry opens its Rooms,
 * nothing else. Editing and management live on the detail page and follow the
 * same `management` answer, explained here when the person does not manage it.
 */
export default function MyAgentsPage() {
  const { userId } = useSpace()
  return <MyAgentsContent key={userId} />
}

function MyAgentsContent() {
  const { t } = useAppTranslation()
  const { preferredSpaceId } = useSpace()
  const [manage, setManage] = useState<Manage>('all')
  const [source, setSource] = useState<Source>('all')
  const [items, setItems] = useState<MyAgent[]>([])
  const [total, setTotal] = useState(0)
  // The server position after the last entry read: where "Show more" continues. Every page shown
  // carried one revision, so the pages were cut from one list and this is `items.length`.
  const [cursor, setCursor] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [more, setMore] = useState(false)
  // A failed "Show more" keeps the loaded entries and says so beside the button.
  const [moreFailed, setMoreFailed] = useState(false)
  // Only the latest filter's answer is shown: an earlier one finishing late never replaces it.
  const generation = useRef(0)
  // Every change to the loaded list (a reload or another page) moves this on, so a quiet
  // refresh that started before it never writes over the list it no longer describes.
  const epoch = useRef(0)
  const paging = useRef(0)
  // Each quiet refresh takes the next number; only the latest one may write.
  const refreshSeq = useRef(0)

  // What is shown, as one list: its entries, the server position after them and the revision
  // every page of it carried. "Show more" continues it only while the server's list still has
  // that revision (`readMore`).
  const shown = useRef<{ items: MyAgent[]; cursor: number; revision: string | null }>({ items: [], cursor: 0, revision: null })
  const show = useCallback((next: { items: MyAgent[]; cursor: number; revision: string | null; total: number }) => {
    shown.current = { items: next.items, cursor: next.cursor, revision: next.revision }
    setItems(next.items)
    setCursor(next.cursor)
    setTotal(next.total)
  }, [])

  const load = useCallback(async (offset: number) => {
    const run = offset === 0 ? ++generation.current : generation.current
    const stale = () => run !== generation.current
    const read = (limit: number, at: number) => agentsApi.listMine({ manage, source, limit, offset: at })
    epoch.current += 1
    setMoreFailed(false)
    if (offset === 0) {
      paging.current = 0
      setState('loading')
    } else {
      paging.current += 1
      setMore(true)
    }
    try {
      if (offset === 0) {
        const page = await read(PAGE, 0)
        if (stale()) return
        show({ items: page.items, cursor: page.items.length, revision: page.revision, total: page.total })
        setState('ready')
      } else {
        const next = await readMore(read, shown.current, PAGE, stale)
        if (stale()) return
        // The list kept moving: keep what is shown and offer to try again.
        if (!next) { setMoreFailed(true); return }
        show(next)
      }
    } catch {
      if (stale()) return
      // A refusal or failure never keeps the previous answer on screen.
      if (offset === 0) { show({ items: [], cursor: 0, revision: null, total: 0 }); setState('failed') } else setMoreFailed(true)
    } finally {
      if (!stale()) {
        if (offset !== 0) paging.current -= 1
        epoch.current += 1
        setMore(false)
      }
    }
  }, [manage, source, show])

  useEffect(() => { void load(0) }, [load])

  // Quiet refresh of what is already shown (same filters, the whole loaded range, expanded Rooms
  // kept), read in server-sized pages that start over if the list moved between them
  // (`readRange`), so the range is never cut short and repeats or skips nothing. Only the latest
  // refresh writes: it is dropped when a newer refresh, a reload or another page started or
  // finished meanwhile. A failure keeps the current answer and the next tick tries again.
  const quietRefresh = useCallback(async () => {
    if (paging.current > 0) return
    const seq = ++refreshSeq.current
    const run = generation.current
    const at = epoch.current
    const stale = () => seq !== refreshSeq.current || run !== generation.current || at !== epoch.current
    try {
      const read = await readRange((limit, offset) => agentsApi.listMine({ manage, source, limit, offset }),
        Math.max(PAGE, shown.current.cursor), stale)
      if (!read || stale() || paging.current > 0) return
      show(read)
      setMoreFailed(false)
    } catch { /* keep the current answer */ }
  }, [manage, source, show])
  usePeriodicRefresh(quietRefresh, LIVE_REFRESH_MS, state === 'ready' && !more)

  const filtered = manage !== 'all' || source !== 'all'
  const groups: Array<{ spaceId: string; spaceName: string; agents: MyAgent[] }> = []
  for (const agent of items) {
    const last = groups[groups.length - 1]
    if (last?.spaceId === agent.space_id) last.agents.push(agent)
    else groups.push({ spaceId: agent.space_id, spaceName: agent.space_name, agents: [agent] })
  }

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-4xl" data-testid="my-agents-page">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-border">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Bot className="size-5" aria-hidden /></div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t('my_agents_ui.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('my_agents_ui.subtitle')}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {/* In a Space: inert until one is known (cold start, or a person with no active Space). */}
          <Button asChild size="sm" variant="outline">
            <NavLinkOrInert to={spaceHref(preferredSpaceId, '/agents/roles')}><LayoutTemplate className="size-3.5 mr-1" aria-hidden />{t('my_agents_ui.roles')}</NavLinkOrInert>
          </Button>
          <Button asChild size="sm">
            <NavLinkOrInert to={spaceHref(preferredSpaceId, '/agents/new')}><Plus className="size-3.5 mr-1" aria-hidden />{t('my_agents_ui.new_agent')}</NavLinkOrInert>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex min-w-[160px] flex-col gap-1">
          <Label className="mb-0">{t('my_agents_ui.filter_manage')}</Label>
          <Select ariaLabel={t('my_agents_ui.filter_manage')} value={manage} onChange={value => setManage(value as Manage)} options={[
            { value: 'all', label: t('my_agents_ui.manage_all') },
            { value: 'manageable', label: t('my_agents_ui.manage_manageable') },
          ]} />
        </div>
        <div className="flex min-w-[180px] flex-col gap-1">
          <Label className="mb-0">{t('my_agents_ui.filter_source')}</Label>
          <Select ariaLabel={t('my_agents_ui.filter_source')} value={source} onChange={value => setSource(value as Source)} options={[
            { value: 'all', label: t('my_agents_ui.source_all') },
            { value: 'mine', label: t('my_agents_ui.source_mine') },
            { value: 'shared', label: t('my_agents_ui.source_shared') },
            { value: 'room_only', label: t('my_agents_ui.source_room_only') },
            { value: 'plugin', label: t('my_agents_ui.source_plugin') },
          ]} />
        </div>
      </div>

      {state === 'loading' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden />{t('my_agents_ui.loading')}</p>
      ) : state === 'failed' && items.length === 0 ? (
        <Card className="flex flex-wrap items-center justify-between gap-2 p-4" role="alert">
          <p className="text-sm text-muted-foreground">{t('my_agents_ui.failed')}</p>
          <Button size="sm" variant="outline" onClick={() => void load(0)}>{t('my_agents_ui.retry')}</Button>
        </Card>
      ) : items.length === 0 ? (
        <Card><p className="p-4 text-sm text-muted-foreground">{t(filtered ? 'my_agents_ui.empty_filtered' : 'my_agents_ui.empty')}</p></Card>
      ) : (
        <div className="space-y-6">
          {groups.map(group => (
            <section key={group.spaceId} aria-label={group.spaceName} className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">{group.spaceName}</h2>
              {group.agents.map(agent => <AgentCard key={agent.agent_id} agent={agent} t={t} />)}
            </section>
          ))}
          {cursor < total && (
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="outline" disabled={more} onClick={() => void load(cursor)}>
                {more && <Loader2 className="size-3.5 mr-1 animate-spin" aria-hidden />}{t(moreFailed ? 'my_agents_ui.retry' : 'my_agents_ui.load_more')}
              </Button>
              {moreFailed && <p role="alert" className="text-sm text-destructive">{t('my_agents_ui.load_more_failed')}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AgentCard({ agent, t }: { agent: MyAgent; t: T }) {
  const [open, setOpen] = useState(false)
  const stopped = agent.status !== 'active'
  const reachable = agent.locations.filter(usable)
  const blocked = agent.locations.filter(location => !usable(location))
  const single = agent.usable_room_count === 1 ? reachable[0] : null
  const roomLabel = (location: MyAgentLocation, room: MyAgentLocation['rooms'][number]) =>
    t('my_agents_ui.room_in_project', { project: location.project_name, room: sidecarRoomName(room, location.project_name, t) })
  // The plugin's page: its home Project where the plugin is set up, else the first Project it works in.
  // A Room-only entry never shows a plugin source (the server sends none; this keeps the page to it).
  const pluginId = agent.access === 'room_only' ? null : agent.plugin_id
  const pluginProject = pluginId
    ? (agent.home_project?.plugin_state === 'ready' ? agent.home_project.project_id : reachable[0]?.project_id ?? null)
    : null
  const pluginHref = pluginProject ? pluginPageHref(agent, pluginProject) : null
  const managementNote = agent.management === 'manage' ? null : t(`my_agents_ui.manage_${agent.management}`)

  return (
    <Card className={`space-y-3 p-4 ${stopped ? 'opacity-80' : ''}`} data-testid="my-agent-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            <span className="min-w-0 break-words">{agent.name}</span>
            {stopped && <Badge variant="muted">{t('my_agents_ui.stopped')}</Badge>}
            {agent.access === 'shared' && <Badge variant="secondary">{t('my_agents_ui.access_shared')}</Badge>}
            {agent.access === 'room_only' && <Badge variant="outline">{t('my_agents_ui.access_room_only')}</Badge>}
            {pluginId && <Badge variant="outline">{t('my_agents_ui.plugin')}</Badge>}
          </p>
          {agent.description && <p className="line-clamp-2 text-sm text-muted-foreground">{agent.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {agent.can_open_detail && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/spaces/${encodeURIComponent(agent.space_id)}/agents/${encodeURIComponent(agent.agent_id)}`}>{t('my_agents_ui.open_detail')}</Link>
            </Button>
          )}
          {agent.can_direct_chat && (
            <Button asChild size="sm" variant="outline">
              <Link to={`/spaces/${encodeURIComponent(agent.space_id)}/agents/${encodeURIComponent(agent.agent_id)}/chat`}>{t('my_agents_ui.direct_chat')}</Link>
            </Button>
          )}
          {pluginHref && (
            <Button asChild size="sm" variant="ghost"><Link to={pluginHref}>{t('my_agents_ui.plugin_page')}</Link></Button>
          )}
        </div>
      </div>

      <div className="space-y-2 text-sm">
        {agent.usable_room_count === 0 ? (
          <p className="text-muted-foreground">{t('my_agents_ui.rooms_none')}</p>
        ) : single ? (
          <p>
            <Link className="underline-offset-4 hover:underline focus-visible:underline" to={roomHref(agent, single.project_id, single.rooms[0]!.room_id)}>
              {t('my_agents_ui.rooms_one', { room: roomLabel(single, single.rooms[0]!) })}
            </Link>
          </p>
        ) : (
          <>
            <Button size="sm" variant="ghost" className="-ml-2" aria-expanded={open} onClick={() => setOpen(value => !value)}>
              {open ? <ChevronUp className="size-3.5 mr-1" aria-hidden /> : <ChevronDown className="size-3.5 mr-1" aria-hidden />}
              {open ? t('my_agents_ui.rooms_hide') : t('my_agents_ui.rooms_many', { count: agent.usable_room_count })}
            </Button>
            {open && (
              <ul className="space-y-2">
                {reachable.map(location => (
                  <li key={location.project_id}>
                    <p className="text-xs text-muted-foreground">{location.project_name}</p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {location.rooms.map(room => (
                        <li key={room.room_id}>
                          <Button asChild size="sm" variant="outline">
                            <Link to={roomHref(agent, location.project_id, room.room_id)}>{sidecarRoomName(room, location.project_name, t)}</Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {blocked.map(location => (
          <p key={location.project_id} className="text-xs text-muted-foreground">
            {t(location.plugin_state === 'unbound' ? 'my_agents_ui.plugin_unbound' : 'my_agents_ui.plugin_disabled', { project: location.project_name })}
          </p>
        ))}
        {stopped && <p className="text-xs text-muted-foreground">{t('my_agents_ui.stopped_hint')}</p>}
        {managementNote && <p className="text-xs text-muted-foreground">{managementNote}</p>}
      </div>
    </Card>
  )
}
