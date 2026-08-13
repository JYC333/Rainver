import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Bot, Loader2, MessageSquarePlus, Plus, RefreshCw, Send, Users } from 'lucide-react'
import { toast } from 'sonner'
import { agentsApi, projectFoldersApi, projectsApi, roomsApi, runsApi, spacesApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type {
  AgentOut,
  ConversationBackendCatalog,
  Project,
  ProjectFolder,
  Room,
  RoomConversation,
  RoomDetail,
  RoomMessage,
  Run,
  SpaceMember,
} from '../../types/api'
import { Badge, StatusBadge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, CardTitle } from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { Select } from '../../components/ui/select'
import {
  RoomMessageComposer,
  emptyRoomMessageComposerValue,
} from './RoomMessageComposer'
import { MarkdownMessage } from './MarkdownMessage'

type RoutingMode = 'direct' | 'agent_coordination'
type BackendSelection = {
  runtime_profile_id: string
  credential_profile_id: string | null
}
type RunProgress = {
  event_type: string
  status: string
  summary?: string | null
}
const MESSAGE_PAGE_SIZE = 50
const LIST_PAGE_SIZE = 100

export default function AgentGroupsPage() {
  const { activeSpaceId } = useSpace()
  const { projectId: projectRouteId } = useParams()
  const [search, setSearch] = useSearchParams()
  const roomId = search.get('room')
  const conversationId = search.get('conversation')
  const projectFilter = projectRouteId || search.get('project') || undefined
  const isProjectScoped = Boolean(projectRouteId)
  const [rooms, setRooms] = useState<Room[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([])
  const [agents, setAgents] = useState<AgentOut[]>([])
  const [spaceMembers, setSpaceMembers] = useState<SpaceMember[]>([])
  const [detail, setDetail] = useState<RoomDetail | null>(null)
  const [boundFolderName, setBoundFolderName] = useState<string | null>(null)
  const [conversations, setConversations] = useState<RoomConversation[]>([])
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [hasOlderMessages, setHasOlderMessages] = useState(false)
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const runsRef = useRef<Record<string, Run>>({})
  const [runProgress, setRunProgress] = useState<Record<string, RunProgress>>({})
  const [runDeltas, setRunDeltas] = useState<Record<string, string>>({})
  const streamControllers = useRef(new Map<string, AbortController>())
  const [backendCatalogs, setBackendCatalogs] = useState<Record<string, ConversationBackendCatalog>>({})
  const [backendSelections, setBackendSelections] = useState<Record<string, BackendSelection>>({})
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [sending, setSending] = useState(false)
  const [composer, setComposer] = useState(emptyRoomMessageComposerValue)
  const [resetToken, setResetToken] = useState(0)
  const [routingMode, setRoutingMode] = useState<RoutingMode>('direct')
  const [draft, setDraft] = useState({
    title: '',
    project_id: projectFilter ?? '',
    project_folder_id: '',
    manager_agent_id: '',
    agent_ids: [] as string[],
    user_ids: [] as string[],
  })

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  useEffect(() => {
    if (!draft.project_id) {
      setProjectFolders([])
      return
    }
    let cancelled = false
    projectFoldersApi.list(draft.project_id, { status: 'active', limit: '100' })
      .then(page => {
        if (cancelled) return
        const executable = page.items.filter(folder => folder.execution_enabled)
        setProjectFolders(executable)
        setDraft(current => {
          if (current.project_id !== draft.project_id) return current
          if (executable.some(folder => folder.id === current.project_folder_id)) return current
          return { ...current, project_folder_id: '' }
        })
      })
      .catch(error => {
        if (!cancelled) toast.error(errMsg(error))
      })
    return () => {
      cancelled = true
    }
  }, [draft.project_id])

  const loadCatalog = useCallback(async () => {
    if (!activeSpaceId) return
    const [allRooms, projectPage, agentList, members] = await Promise.all([
      loadAllPages((limit, offset) =>
        roomsApi.list({ project_id: projectFilter, limit, offset })),
      projectsApi.list({ status: 'active', limit: 100 }),
      agentsApi.list({ status: 'active' }),
      spacesApi.members(activeSpaceId),
    ])
    const selectableAgents = agentList.filter(agent => agent.agent_kind !== 'system_assistant')
    setRooms(allRooms)
    setProjects(projectPage.items)
    setAgents(selectableAgents)
    setSpaceMembers(members)
    setDraft(current => ({
      ...current,
      project_id:
        projectRouteId
        || current.project_id
        || projectFilter
        || projectPage.items[0]?.id
        || '',
      manager_agent_id: current.manager_agent_id || selectableAgents[0]?.id || '',
    }))
  }, [activeSpaceId, projectFilter, projectRouteId])

  const loadRoom = useCallback(async () => {
    if (!roomId) {
      setDetail(null)
      setConversations([])
      setBoundFolderName(null)
      return
    }
    const nextDetail = await roomsApi.get(roomId)
    const [allConversations, folderPage] = await Promise.all([
      loadAllPages((limit, offset) =>
        roomsApi.conversations(roomId, { limit, offset })),
      nextDetail.room.project_folder_id
        ? projectFoldersApi.list(nextDetail.room.project_id, {
            status: 'active',
            limit: String(LIST_PAGE_SIZE),
          })
        : Promise.resolve({ items: [] as ProjectFolder[] }),
    ])
    setDetail(nextDetail)
    setConversations(allConversations)
    setBoundFolderName(
      nextDetail.room.project_folder_id
        ? folderPage.items.find(folder =>
            folder.id === nextDetail.room.project_folder_id)?.name
          ?? 'Unavailable folder'
        : null,
    )
  }, [roomId])

  const loadMessages = useCallback(async () => {
    if (!roomId || !conversationId) {
      setMessages([])
      setRuns({})
      return
    }
    const page = await roomsApi.messages(roomId, conversationId, {
      limit: MESSAGE_PAGE_SIZE,
      offset: 0,
    })
    setMessages(current =>
      current.length > 0
      && current.every(message => message.session_id === conversationId)
        ? uniqueMessages([...current, ...page.items])
        : page.items)
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
    const runIds = uniqueIds(page.items.flatMap(message => metadataRunIds(message.metadata_json)))
    const idsToRefresh = runIds.filter(id =>
      !runsRef.current[id] || !isTerminalRunStatus(runsRef.current[id]!.status))
    const results = await Promise.all(idsToRefresh.map(async id => {
      try {
        return await runsApi.get(id)
      } catch {
        return null
      }
    }))
    setRuns(current => ({
      ...current,
      ...Object.fromEntries(results.filter((run): run is Run => Boolean(run)).map(run => [run.id, run])),
    }))
    const terminalIds = results.flatMap(run =>
      run && isTerminalRunStatus(run.status) ? [run.id] : [])
    if (terminalIds.length > 0) clearTransientRuns(terminalIds, setRunProgress, setRunDeltas)
  }, [conversationId, roomId])

  const loadOlderMessages = useCallback(async () => {
    if (!roomId || !conversationId || !hasOlderMessages) return
    const page = await roomsApi.messages(roomId, conversationId, {
      limit: MESSAGE_PAGE_SIZE,
      offset: messages.length,
    })
    setMessages(current => uniqueMessages([...page.items, ...current]))
    setHasOlderMessages(page.items.length === MESSAGE_PAGE_SIZE)
  }, [conversationId, hasOlderMessages, messages.length, roomId])

  const watchRuns = useCallback((runIds: string[]) => {
    for (const runId of uniqueIds(runIds)) {
      if (streamControllers.current.has(runId)) continue
      const controller = new AbortController()
      streamControllers.current.set(runId, controller)
      void runsApi.streamEvents(runId, {
        signal: controller.signal,
        onLifecycle: event => {
          setRunProgress(current => ({ ...current, [runId]: event }))
          if (event.event_type === 'run_finalized') {
            streamControllers.current.delete(runId)
            clearTransientRuns([runId], setRunProgress, setRunDeltas)
            void loadMessages()
          }
        },
        onTextDelta: delta => {
          setRunDeltas(current => ({
            ...current,
            [runId]: `${current[runId] ?? ''}${delta}`,
          }))
        },
      }).catch(error => {
        if (!controller.signal.aborted) toast.error(errMsg(error))
      }).finally(() => {
        if (streamControllers.current.get(runId) === controller) {
          streamControllers.current.delete(runId)
        }
      })
    }
  }, [loadMessages])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadCatalog(), loadRoom(), loadMessages()])
      .catch(error => toast.error(errMsg(error)))
      .finally(() => setLoading(false))
  }, [loadCatalog, loadMessages, loadRoom])

  useEffect(() => {
    if (!roomId || !conversationId) return
    const activeRunIds = Object.values(runs)
      .filter(run => !isTerminalRunStatus(run.status))
      .map(run => run.id)
    const timer = window.setInterval(() => {
      loadMessages().catch(() => undefined)
    }, activeRunIds.length > 0 ? 2500 : 5000)
    return () => window.clearInterval(timer)
  }, [conversationId, loadMessages, roomId, runs])

  useEffect(() => {
    const controllers = streamControllers.current
    return () => {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    }
  }, [conversationId])

  useEffect(() => {
    watchRuns(Object.values(runs)
      .filter(run => !isTerminalRunStatus(run.status))
      .map(run => run.id))
  }, [runs, watchRuns])

  useEffect(() => {
    if (!conversationId || !detail) {
      setBackendCatalogs({})
      setBackendSelections({})
      return
    }
    let cancelled = false
    Promise.all(detail.agent_members.map(async member => ({
      agentId: member.agent_id,
      catalog: await agentsApi.conversationBackends(member.agent_id, {
        sessionId: conversationId,
      }),
    }))).then(entries => {
      if (cancelled) return
      const catalogs = Object.fromEntries(entries.map(entry => [entry.agentId, entry.catalog]))
      setBackendCatalogs(catalogs)
      setBackendSelections(current => {
        const next: Record<string, BackendSelection> = {}
        for (const entry of entries) {
          const selection = current[entry.agentId] ?? selectedBackend(entry.catalog)
          if (selection) next[entry.agentId] = selection
        }
        return next
      })
    }).catch(error => {
      if (!cancelled) toast.error(errMsg(error))
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, detail])

  async function createRoom() {
    if (!draft.title.trim() || !draft.project_id || !draft.manager_agent_id) return
    setCreating(true)
    try {
      const created = await roomsApi.create({
        project_id: draft.project_id,
        project_folder_id: draft.project_folder_id || null,
        title: draft.title.trim(),
        manager_agent_id: draft.manager_agent_id,
        agent_ids: uniqueIds([draft.manager_agent_id, ...draft.agent_ids]),
        user_ids: uniqueIds(draft.user_ids),
      })
      await loadCatalog()
      setSearch({ room: created.room.id })
      setDraft(current => ({ ...current, title: '', agent_ids: [], user_ids: [] }))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setCreating(false)
    }
  }

  async function createConversation() {
    if (!roomId) return
    try {
      const conversation = await roomsApi.createConversation(roomId, { title: 'New conversation' })
      await loadRoom()
      setSearch({ room: roomId, conversation: conversation.id })
    } catch (error) {
      toast.error(errMsg(error))
    }
  }

  async function sendMessage() {
    if (!roomId || !conversationId || !composer.text.trim() || sending) return
    const segments = composer.routingSegments
      .map(segment => ({
        recipient_agent_ids: uniqueIds(segment.recipient_agent_ids),
        content: segment.content.trim(),
      }))
      .filter(segment => segment.recipient_agent_ids.length > 0 && segment.content)
    const managerAgentId = detail?.agent_members.find(member => member.role === 'manager')?.agent_id
    const recipientAgentIds = uniqueIds(
      routingMode === 'agent_coordination' || segments.length === 0
        ? managerAgentId ? [managerAgentId] : []
        : segments.flatMap(segment => segment.recipient_agent_ids),
    )
    setSending(true)
    try {
      const dispatched = await roomsApi.sendMessage(roomId, conversationId, {
        content: composer.text.trim(),
        routing_mode: routingMode,
        recipient_segments: routingMode === 'direct' && segments.length > 0 ? segments : null,
        backends: recipientAgentIds.flatMap(agent_id => {
          const selection = backendSelections[agent_id]
          return selection ? [{ agent_id, ...selection }] : []
        }),
      })
      watchRuns(dispatched.run_ids)
      setResetToken(value => value + 1)
      await Promise.all([loadRoom(), loadMessages()])
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setSending(false)
    }
  }

  const roomAgents = useMemo(() => {
    const ids = new Set(detail?.agent_members.map(member => member.agent_id) ?? [])
    return agents.filter(agent => ids.has(agent.id))
  }, [agents, detail])
  const currentConversation = conversations.find(item => item.id === conversationId) ?? null

  if (loading) {
    return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading Rooms…</div>
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Users className="size-5" />Rooms</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Project-bound conversations where every human speaks under their own identity and subscription.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => Promise.all([loadCatalog(), loadRoom(), loadMessages()])}>
          <RefreshCw className="size-3.5 mr-1" />Refresh
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <Card className="p-3 space-y-3">
            <CardTitle>New Room</CardTitle>
            <div className="space-y-1"><Label>Title</Label><Input value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></div>
            {!isProjectScoped && (
              <div className="space-y-1">
                <Label>Project</Label>
                <Select
                  value={draft.project_id}
                  onChange={project_id => setDraft({
                    ...draft,
                    project_id,
                    project_folder_id: '',
                  })}
                  options={[
                    { value: '', label: 'Choose Project' },
                    ...projects.map(project => ({ value: project.id, label: project.name })),
                  ]}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Project Folder</Label>
              <Select
                value={draft.project_folder_id}
                onChange={project_folder_id => setDraft({ ...draft, project_folder_id })}
                options={[
                  { value: '', label: 'No folder' },
                  ...projectFolders.map(folder => ({ value: folder.id, label: folder.name })),
                ]}
              />
            </div>
            <div className="space-y-1">
              <Label>Manager agent</Label>
              <Select
                value={draft.manager_agent_id}
                onChange={manager_agent_id => setDraft({ ...draft, manager_agent_id })}
                options={agents.map(agent => ({ value: agent.id, label: agent.name }))}
              />
            </div>
            <RosterChoices
              label="Other agents"
              values={agents.filter(agent => agent.id !== draft.manager_agent_id).map(agent => ({ id: agent.id, label: agent.name }))}
              selected={draft.agent_ids}
              onChange={agent_ids => setDraft({ ...draft, agent_ids })}
            />
            <RosterChoices
              label="People"
              values={spaceMembers.map(member => ({ id: member.user_id, label: member.display_name || member.email }))}
              selected={draft.user_ids}
              onChange={user_ids => setDraft({ ...draft, user_ids })}
            />
            <Button
              className="w-full"
              size="sm"
              disabled={creating || !draft.title.trim() || !draft.project_id || !draft.manager_agent_id}
              onClick={createRoom}
            >
              {creating ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : <Plus className="size-3.5 mr-1" />}Create Room
            </Button>
          </Card>
          <div className="space-y-2">
            {rooms.map(room => (
              <button
                key={room.id}
                className={`w-full text-left rounded-md border p-3 ${room.id === roomId ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40'}`}
                onClick={() => setSearch({ room: room.id })}
              >
                <div className="font-medium text-sm">{room.title}</div>
                {!isProjectScoped && (
                  <div className="text-xs text-muted-foreground mt-1">{projects.find(project => project.id === room.project_id)?.name ?? 'Project'}</div>
                )}
              </button>
            ))}
          </div>
        </aside>

        {!detail ? (
          <Card className="p-8 text-center text-muted-foreground">Choose or create a Room.</Card>
        ) : (
          <section className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
            <Card className="p-3 space-y-3">
              <div>
                <CardTitle>{detail.room.title}</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">{detail.user_members.length} people · {detail.agent_members.length} agents</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Folder: {boundFolderName ?? 'No project folder'}
                </p>
              </div>
              <Button size="sm" className="w-full" onClick={createConversation}><MessageSquarePlus className="size-3.5 mr-1" />New conversation</Button>
              <div className="space-y-1">
                {conversations.map(conversation => (
                  <button
                    key={conversation.id}
                    className={`w-full rounded px-2 py-2 text-left text-sm ${conversation.id === conversationId ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
                    onClick={() => setSearch({ room: detail.room.id, conversation: conversation.id })}
                  >
                    {conversation.title || 'Conversation'}
                  </button>
                ))}
              </div>
            </Card>

            <Card className="min-h-[620px] flex flex-col overflow-hidden">
              {!currentConversation ? (
                <div className="m-auto text-sm text-muted-foreground">Start or choose a conversation.</div>
              ) : (
                <>
                  <div className="border-b border-border px-4 py-3">
                    <CardTitle>{currentConversation.title || 'Conversation'}</CardTitle>
                  </div>
                  <div className="flex-1 overflow-auto p-4 space-y-4">
                    {hasOlderMessages && (
                      <div className="text-center">
                        <Button variant="outline" size="sm" onClick={() => void loadOlderMessages()}>
                          Load older
                        </Button>
                      </div>
                    )}
                    {messages.length === 0 && <p className="text-sm text-muted-foreground text-center py-12">No messages yet.</p>}
                    {messages.map(message => (
                      <RoomMessageView
                        key={message.id}
                        message={message}
                        agents={agents}
                        humans={spaceMembers}
                        runs={runs}
                        progress={runProgress}
                        deltas={runDeltas}
                      />
                    ))}
                  </div>
                  <div className="border-t border-border p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="routing">Routing</Label>
                      <Select
                        className="w-48"
                        ariaLabel="Routing"
                        value={routingMode}
                        onChange={value => setRoutingMode(value as RoutingMode)}
                        options={[
                          { value: 'direct', label: 'Direct mentions' },
                          { value: 'agent_coordination', label: 'Agent coordination' },
                        ]}
                      />
                      <Badge variant="secondary">own backend</Badge>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {roomAgents.map(agent => {
                        const catalog = backendCatalogs[agent.id]
                        const choices = backendChoices(catalog)
                        const selection = backendSelections[agent.id]
                        return (
                          <div key={agent.id} className="space-y-1">
                            <Label>{agent.name} backend</Label>
                            <Select
                              value={selection ? backendSelectionValue(selection) : ''}
                              onChange={value => setBackendSelections(current => ({
                                ...current,
                                [agent.id]: parseBackendSelection(value),
                              }))}
                              options={choices}
                              disabled={choices.length === 0}
                            />
                          </div>
                        )
                      })}
                    </div>
                    <RoomMessageComposer
                      value={composer}
                      onChange={setComposer}
                      agents={roomAgents}
                      members={detail.agent_members}
                      disabled={sending}
                      resetToken={resetToken}
                      onSubmit={sendMessage}
                    />
                    <div className="flex justify-end">
                      <Button disabled={sending || !composer.text.trim()} onClick={sendMessage}>
                        {sending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Send className="size-4 mr-1" />}Send
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </Card>
          </section>
        )}
      </div>
    </div>
  )
}

function RosterChoices({
  label,
  values,
  selected,
  onChange,
}: {
  label: string
  values: Array<{ id: string; label: string }>
  selected: string[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <div className="max-h-28 overflow-auto rounded border border-border p-2 space-y-1">
        {values.length === 0 && <div className="text-xs text-muted-foreground">None available</div>}
        {values.map(value => (
          <label key={value.id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={selected.includes(value.id)}
              onChange={event => onChange(event.target.checked
                ? uniqueIds([...selected, value.id])
                : selected.filter(id => id !== value.id))}
            />
            {value.label}
          </label>
        ))}
      </div>
    </div>
  )
}

function RoomMessageView({
  message,
  agents,
  humans,
  runs,
  progress,
  deltas,
}: {
  message: RoomMessage
  agents: AgentOut[]
  humans: SpaceMember[]
  runs: Record<string, Run>
  progress: Record<string, RunProgress>
  deltas: Record<string, string>
}) {
  const runIds = metadataRunIds(message.metadata_json)
  const label = message.role === 'user'
    ? humans.find(member => member.user_id === message.user_id)?.display_name
      ?? humans.find(member => member.user_id === message.user_id)?.email
      ?? 'Person'
    : agents.find(agent => agent.id === message.sender_agent_id)?.name ?? 'Agent'
  return (
    <div className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[82%] rounded-lg border px-3 py-2 ${message.role === 'user' ? 'bg-primary/5 border-primary/20' : 'bg-card border-border'}`}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          {message.role === 'assistant' && <Bot className="size-3.5" />}
          <span>{label}</span>
          <span>{new Date(message.created_at).toLocaleTimeString()}</span>
        </div>
        <MarkdownMessage content={message.content} />
        {runIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {runIds.map(runId => (
              <span key={runId} className="inline-flex flex-col items-start gap-1">
                <Link to={`/runs/${runId}`} className="inline-flex items-center gap-1 text-xs hover:underline">
                  <StatusBadge status={runs[runId]?.status ?? progress[runId]?.status ?? 'queued'} />
                  Run
                </Link>
                {progress[runId] && (
                  <span className="text-[11px] text-muted-foreground">
                    {progress[runId].summary || lifecycleLabel(progress[runId].event_type)}
                  </span>
                )}
                {deltas[runId] && (
                  <span className="max-w-md whitespace-pre-wrap text-xs text-muted-foreground">
                    {deltas[runId]}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function lifecycleLabel(eventType: string): string {
  return eventType.replace(/_/g, ' ')
}

function isTerminalRunStatus(status: string): boolean {
  return ['succeeded', 'failed', 'degraded', 'cancelled'].includes(status)
}

function clearTransientRuns(
  runIds: string[],
  setProgress: React.Dispatch<React.SetStateAction<Record<string, RunProgress>>>,
  setDeltas: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): void {
  const remove = <T,>(current: Record<string, T>): Record<string, T> => {
    const next = { ...current }
    for (const runId of runIds) delete next[runId]
    return next
  }
  setProgress(remove)
  setDeltas(remove)
}

function uniqueMessages(messages: RoomMessage[]): RoomMessage[] {
  const seen = new Set<string>()
  return messages.filter(message => {
    if (seen.has(message.id)) return false
    seen.add(message.id)
    return true
  })
}

function metadataRunIds(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.run_ids
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  const runId = metadata?.run_id
  return typeof runId === 'string' ? [runId] : []
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

async function loadAllPages<T>(
  fetchPage: (
    limit: number,
    offset: number,
  ) => Promise<{ items: T[] }>,
): Promise<T[]> {
  const items: T[] = []
  for (;;) {
    const page = await fetchPage(LIST_PAGE_SIZE, items.length)
    items.push(...page.items)
    if (page.items.length < LIST_PAGE_SIZE) return items
  }
}

function selectedBackend(catalog: ConversationBackendCatalog): BackendSelection | null {
  if (catalog.binding) {
    return {
      runtime_profile_id: catalog.binding.runtime_profile_id,
      credential_profile_id: catalog.binding.credential_profile_id ?? null,
    }
  }
  const option = catalog.options[0]
  if (!option) return null
  return {
    runtime_profile_id: option.runtime_profile_id,
    credential_profile_id: option.requires_cli_credential
      ? option.credential_profiles.find(profile => profile.is_default)?.id
        ?? option.credential_profiles[0]?.id
        ?? null
      : null,
  }
}

function backendChoices(catalog: ConversationBackendCatalog | undefined) {
  if (!catalog) return []
  return catalog.options.flatMap(option => {
    if (!option.requires_cli_credential) {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: null,
      }
      return [{
        value: backendSelectionValue(selection),
        label: option.model_name ? `${option.name} · ${option.model_name}` : option.name,
      }]
    }
    return option.credential_profiles.map(profile => {
      const selection = {
        runtime_profile_id: option.runtime_profile_id,
        credential_profile_id: profile.id,
      }
      return {
        value: backendSelectionValue(selection),
        label: `${option.name} · ${profile.name}`,
      }
    })
  })
}

function backendSelectionValue(selection: BackendSelection): string {
  return `${selection.runtime_profile_id}|${selection.credential_profile_id ?? ''}`
}

function parseBackendSelection(value: string): BackendSelection {
  const [runtime_profile_id = '', credential = ''] = value.split('|', 2)
  return {
    runtime_profile_id,
    credential_profile_id: credential || null,
  }
}
