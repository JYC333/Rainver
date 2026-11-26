import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { agentRolesApi, agentsApi, projectsApi, roomsApi } from '../../api/client'
import { refusalCode, refusalMetadata } from '../../api/transport'
import type { AgentOut, AgentRoleOut, ProjectRoomSummary } from '../../types/api'
import { useAppTranslation } from '../../i18n'
import { errMsg } from '../../lib/utils'
import { Button } from '../../components/ui/button'
import { Card, CardContent } from '../../components/ui/card'
import { Select } from '../../components/ui/select'
import { ConfirmDialog } from '../../components/ui/dialog'
import { openProjectChat } from '../projects/sidecar/projectChatOpen'
import { sidecarRoomName } from '../projects/sidecar/SidecarNavigator'

const CREATE = '__create__'
const SHARE_CONFIRMATION = 'private_agent_share_confirmation_required'
const PAGE = 100

/** The chosen Room's candidates from this Role, read whole (every page) before anything is offered. */
type Candidates = { roomId: string; status: 'loading' | 'ready' | 'failed'; agents: Array<{ id: string; name: string }> }
/** An add waiting for its owner's Room-only share: the server's exact people, by id and by name. */
type SharePending = { agentId: string; name: string; roomId: string; memberIds: string[]; names: string[]; changed: boolean }

async function roleCandidates(roomId: string, roleId: string): Promise<Candidates['agents']> {
  const agents: Candidates['agents'] = []
  for (let offset = 0; ;) {
    const page = await roomsApi.agentCandidates(roomId, { source_role_id: roleId, limit: PAGE, offset })
    agents.push(...page.agents.map(agent => ({ id: agent.agent_id, name: agent.name })))
    offset += page.agents.length
    if (!page.agents.length || offset >= page.total) return agents
  }
}

/** Every active Agent the viewer reads that was created from this Role, read to the last page. */
async function roleAgents(roleId: string): Promise<AgentOut[]> {
  const agents: AgentOut[] = []
  for (let offset = 0; ;) {
    const page = await agentsApi.list({ source_role_id: roleId, status: 'active', limit: String(PAGE), offset: String(offset) })
    agents.push(...page)
    offset += page.length
    if (page.length < PAGE) return agents
  }
}

/** The refusal's names for its member ids, in the server's order. */
function sharedPeople(error: unknown, memberIds: string[]): string[] {
  const members = refusalMetadata(error)?.members
  const names = new Map<string, string>()
  if (Array.isArray(members)) {
    for (const item of members) {
      const entry = item as { user_id?: unknown; display_name?: unknown } | null
      if (entry && typeof entry.user_id === 'string' && typeof entry.display_name === 'string') names.set(entry.user_id, entry.display_name)
    }
  }
  return memberIds.map(id => names.get(id) || id)
}

/**
 * One-time setup of a plugin's official assistant in a Project
 * (`.agent/plans/project-room-unification-plan.md` §3). The person picks one of
 * their Rooms in this Project and either an Agent from that Role the Room
 * would let them add (its own candidate list, asked for this Role and read to
 * the last page) or a new one created from the Role with this Project
 * prefilled. Nothing is offered, and Set up stays off, until that list for the
 * chosen Room has loaded; if it fails the person retries rather than creating
 * a second assistant. Setting up is the ordinary Room add, which also
 * completes the Project link. When the add needs its owner's Room-only share —
 * a private Agent, or one whose home is another Project — the server refuses
 * with the exact people to confirm; the dialog names them and the
 * confirmation sends that list back unchanged (as the Room roster does). If
 * the Room's people changed meanwhile the server answers with the new list and
 * the dialog says so. Whether it is already set up is decided first, from
 * every Agent of this Role the viewer reads (asked by Role, every page) and
 * the Project's Rooms; the card shows nothing until that is known, and a
 * Role list or Room that cannot be read offers a retry rather than the setup
 * form. A reload keeps the chosen Room only while it is still this Project's. On
 * success the chat panel opens on that Room. It never
 * creates a Room, and there is no separate chat entry: the conversation is the
 * Room's.
 */
export function PluginAgentSetup({ pluginId, projectId, canWrite }: { pluginId: string; projectId: string; canWrite: boolean | undefined }) {
  const { t } = useAppTranslation()
  const [role, setRole] = useState<AgentRoleOut | null>(null)
  const [rooms, setRooms] = useState<ProjectRoomSummary[]>([])
  const [fromRole, setFromRole] = useState<AgentOut[]>([])
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [reload, setReload] = useState(0)
  const [placed, setPlaced] = useState<{ roomId: string; agent: string } | null>(null)
  // Whether this Project's Rooms have been checked for the assistant: until then nothing is shown,
  // so a Project already set up never flashes the setup form while its Rooms are read. A Room that
  // could not be read leaves it unknown (`failed`), never "not set up": that would offer a second one.
  const [probe, setProbe] = useState<'loading' | 'ready' | 'failed'>('loading')
  // Only the latest check writes its outcome: an earlier one finishing late never overwrites it.
  const generation = useRef(0)
  const [roomId, setRoomId] = useState('')
  // The person's own pick; until they make one the Room's first reusable Agent is offered.
  const [picked, setPicked] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [sharePending, setSharePending] = useState<SharePending | null>(null)
  // The Agent "Create" already made: a retry after a failed add reuses it
  // rather than creating a second one, whatever the candidate list says.
  const created = useRef<{ id: string; name: string } | null>(null)

  const load = useCallback(async (prefer?: string) => {
    const run = ++generation.current
    const live = () => run === generation.current
    let own: AgentRoleOut | null
    try {
      // Asked with this Project: a plugin's Role exists only where it is bound and enabled.
      const roles = await agentRolesApi.list({ status: 'published', project_id: projectId })
      own = roles.find(item => item.source_plugin_id === pluginId) ?? null
    } catch {
      // Unknown, not "this plugin has no Role": offer a retry and keep the Role already shown.
      if (live()) setProbe('failed')
      return
    }
    if (!live()) return
    setRole(own)
    if (!own) return
    try {
      const [roomPage, fetched] = await Promise.all([projectsApi.rooms(projectId, { limit: 100 }), roleAgents(own.id)])
      if (!live()) return
      const agents = fetched.filter(agent => agent.source_role_id === own.id && agent.status === 'active')
      setRooms(roomPage.items)
      setFromRole(agents)
      // Keep the person's Room while it is still one of this Project's; otherwise offer the first.
      setRoomId(current => roomPage.items.some(item => item.room.id === current) ? current : roomPage.items[0]?.room.id || '')
      // Already set up: an Agent from this Role on one of the viewer's Rooms here,
      // the Room it was just set up in first. With no such Agent there is nothing to look for.
      const ordered = agents.length
        ? [...roomPage.items].sort((a, b) => Number(b.room.id === prefer) - Number(a.room.id === prefer))
        : []
      let found: { roomId: string; agent: string } | null = null
      for (const item of ordered) {
        const detail = await roomsApi.get(item.room.id)
        if (!live()) return
        const member = detail.agent_members.find(member => agents.some(agent => agent.id === member.agent_id))
        if (member) {
          found = { roomId: item.room.id, agent: agents.find(agent => agent.id === member.agent_id)?.name ?? own.name }
          break
        }
      }
      setPlaced(found)
      setProbe('ready')
    } catch {
      if (live()) setProbe('failed')
    }
  }, [pluginId, projectId])

  // A new Project or plugin is unknown until checked; a reload after setup keeps what is shown.
  const check = useCallback(() => { setProbe('loading'); void load() }, [load])
  useEffect(() => { check() }, [check])

  // Which of the Role's Agents the chosen Room would let this person add: the
  // Room's own candidate list for this Role, not a client-side guess at its rule.
  const roleId = role?.id
  useEffect(() => {
    if (!roomId || !roleId) { setCandidates(null); return }
    let current = true
    setCandidates({ roomId, status: 'loading', agents: [] })
    roleCandidates(roomId, roleId)
      .then(agents => { if (current) setCandidates({ roomId, status: 'ready', agents }) })
      .catch(() => { if (current) setCandidates({ roomId, status: 'failed', agents: [] }) })
    return () => { current = false }
  }, [roomId, roleId, fromRole, reload])

  const ready = candidates?.roomId === roomId && candidates.status === 'ready'
  const failed = candidates?.roomId === roomId && candidates.status === 'failed'
  const reusable = useMemo(() => (ready && candidates ? candidates.agents : []), [ready, candidates])
  const agentChoice = !ready ? null
    : picked === CREATE || (picked && reusable.some(agent => agent.id === picked)) ? picked
    : reusable[0]?.id ?? CREATE

  const roomName = useMemo(() => {
    const item = rooms.find(entry => entry.room.id === placed?.roomId)
    return item ? sidecarRoomName(item.room, null, t) : ''
  }, [rooms, placed, t])

  if (probe === 'loading') return null
  // The Role or the Rooms could not be read: whether it is set up is unknown, so neither the form nor nothing.
  if (probe === 'failed') {
    return (
      <Card data-testid="plugin-agent-setup">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3" role="alert">
          <p className="text-sm text-muted-foreground">{t('plugin_ui.agent_setup.probe_failed')}</p>
          <Button size="sm" variant="ghost" onClick={check}>{t('plugin_ui.retry')}</Button>
        </CardContent>
      </Card>
    )
  }
  if (!role) return null

  async function add(target: string, agentId: string, name: string, memberIds: string[] | null) {
    try {
      await roomsApi.addAgent(target, {
        agent_id: agentId,
        share_private_with_member_ids: memberIds ?? [],
        confirm_room_share: memberIds !== null,
        restore_workspace: false,
      })
    } catch (error) {
      if (refusalCode(error) !== SHARE_CONFIRMATION) throw error
      const raw = refusalMetadata(error)?.member_ids
      const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
      // A refusal of a confirmation already sent: the Room's people changed, even if their number did not.
      setSharePending({ agentId, name, roomId: target, memberIds: ids, names: sharedPeople(error, ids), changed: memberIds !== null })
      return
    }
    await finish(target)
  }

  async function setUp() {
    if (!role || !roomId || !agentChoice) return
    setBusy(true)
    try {
      let agentId = agentChoice
      let name = reusable.find(item => item.id === agentChoice)?.name ?? role.name
      if (agentChoice === CREATE) {
        if (!created.current) {
          const agent = await agentRolesApi.createAgent(role.id, { project_id: projectId })
          created.current = { id: agent.id, name: agent.name ?? role.name }
        }
        agentId = created.current.id
        name = created.current.name
      }
      await add(roomId, agentId, name, null)
    } catch (error) {
      toast.error(`${t('plugin_ui.agent_setup.failed')}: ${errMsg(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function finish(target: string) {
    created.current = null
    setEditing(false)
    await load(target)
    openProjectChat({ projectId, roomId: target })
  }

  async function confirmShare() {
    const pending = sharePending
    setSharePending(null)
    if (!pending) return
    setBusy(true)
    try {
      // The server's list, unchanged; if the Room changed meanwhile it answers with the new one.
      await add(pending.roomId, pending.agentId, pending.name, pending.memberIds)
    } catch (error) {
      toast.error(`${t('plugin_ui.agent_setup.failed')}: ${errMsg(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const shareDialog = (
    <ConfirmDialog
      open={Boolean(sharePending)}
      onOpenChange={open => { if (!open) setSharePending(null) }}
      title={t('plugin_ui.agent_setup.share_title', { name: sharePending?.name ?? '' })}
      description={[
        sharePending?.changed ? t('plugin_ui.agent_setup.share_changed') : '',
        t('plugin_ui.agent_setup.share_text', { name: sharePending?.name ?? '' }),
        sharePending?.names.length
          ? t('plugin_ui.agent_setup.share_people_named', { names: sharePending.names.join(', ') })
          : t('plugin_ui.agent_setup.share_only_you'),
      ].filter(Boolean).join(' ')}
      confirmLabel={t('plugin_ui.agent_setup.share_confirm')}
      variant="default"
      onConfirm={() => void confirmShare()}
    />
  )

  if (placed && !editing) {
    return (
      <Card data-testid="plugin-agent-setup">
        <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
          <p className="text-sm">{t('plugin_ui.agent_setup.done', { agent: placed.agent, room: roomName })}</p>
          {canWrite !== false && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('plugin_ui.agent_setup.change')}</Button>}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-testid="plugin-agent-setup">
      <CardContent className="space-y-3 py-3">
        <div>
          <p className="text-sm font-medium">{t('plugin_ui.agent_setup.title')}</p>
          <p className="text-xs text-muted-foreground">{t('plugin_ui.agent_setup.hint', { role: role.name })}</p>
        </div>
        {canWrite === false ? (
          <p className="text-xs text-muted-foreground">{t('plugin_ui.agent_setup.read_only')}</p>
        ) : rooms.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('plugin_ui.agent_setup.no_rooms')}</p>
        ) : (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <Select
                  ariaLabel={t('plugin_ui.agent_setup.room')}
                  value={roomId}
                  onChange={setRoomId}
                  options={rooms.map(item => ({ value: item.room.id, label: sidecarRoomName(item.room, null, t) }))}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Select
                  ariaLabel={t('plugin_ui.agent_setup.agent')}
                  value={agentChoice ?? ''}
                  onChange={setPicked}
                  disabled={!ready}
                  options={ready ? [
                    ...reusable.map(agent => ({ value: agent.id, label: t('plugin_ui.agent_setup.reuse', { name: agent.name }) })),
                    { value: CREATE, label: t('plugin_ui.agent_setup.create_new', { role: role.name }) },
                  ] : [{ value: '', label: t(failed ? 'plugin_ui.agent_setup.candidates_failed' : 'plugin_ui.agent_setup.candidates_loading') }]}
                />
              </div>
              <Button size="sm" disabled={busy || !roomId || !ready} onClick={() => void setUp()}>{t('plugin_ui.agent_setup.set_up')}</Button>
              {placed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('plugin_ui.agent_setup.cancel')}</Button>}
            </div>
            {failed && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="alert">
                <span>{t('plugin_ui.agent_setup.candidates_failed')}</span>
                <Button size="sm" variant="ghost" onClick={() => setReload(value => value + 1)}>{t('plugin_ui.retry')}</Button>
              </div>
            )}
          </>
        )}
        {shareDialog}
      </CardContent>
    </Card>
  )
}
