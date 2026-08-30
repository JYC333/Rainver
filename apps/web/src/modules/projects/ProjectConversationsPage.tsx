import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LimitedRoomDialog } from '../agent_groups/LimitedRoomDialog'
import { useParams } from 'react-router-dom'
import { ChevronDown, History, MessageSquare, Plus, RefreshCw, Settings2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi, projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link, useSpaceNavigate } from '../../core/spaceNav'
import type { ImportedSession, ProjectConversation, ProjectEmptyRoom } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../components/ui/dropdown-menu'
import { audienceLabel } from '../agent_groups/audience'

/**
 * Every conversation in the Project, as one list.
 *
 * A Project is pushed forward through conversation, so the place to see all
 * of it is a first-level destination, beside Pulse, Board and Updates — not a
 * Room picker two clicks down.
 *
 * The Room layer is here but invisible until a visibility decision has to be
 * made ([ADR 0018](../../../../.agent/decisions/0018-room-as-visibility-boundary.md)
 * decision 2). The Project's own conversations lead with no heading and the
 * word "Room" never appears; a conversation that only some people can see
 * appears in a section titled by *who they are*, because that is what opening
 * a second Room means. A Project with only its mainline therefore looks like
 * a plain list of conversations, which is what most of them are.
 */
export default function ProjectConversationsPage() {
  const { projectId = '' } = useParams()
  const [items, setItems] = useState<ProjectConversation[]>([])
  const [emptyRooms, setEmptyRooms] = useState<ProjectEmptyRoom[]>([])
  const [imported, setImported] = useState<ImportedSession[]>([])
  /** A failed read is said out loud; showing an empty section would claim there is no history. */
  const [importedFailed, setImportedFailed] = useState(false)
  const [pendingExtraction, setPendingExtraction] = useState<{ records: number; sessions: number } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [mainlineRoomId, setMainlineRoomId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const showingRef = useRef(projectId)
  const navigate = useSpaceNavigate()

  const load = useCallback(async () => {
    showingRef.current = projectId
    setLoading(true)
    setFailed(false)
    try {
      // Two sources, each filtered by its own read gate on the server, merged
      // only for display: an imported session is not a Rainver conversation
      // and must never be mistaken for one, but a person looking for "what was
      // said about this Project" does not care who produced it.
      const [page, importedPage, mainline] = await Promise.all([
        projectsApi.conversations(projectId, { limit: 100 }),
        ambientSessionsApi.listForProject(projectId).then(
          result => ({ ok: true as const, result }),
          () => ({ ok: false as const, result: { sessions: [] as ImportedSession[] } }),
        ),
        // Every Project has one, and it is where "in this Project" lands. A
        // failure here only disables that entry; the list still renders.
        projectsApi.mainlineRoom(projectId).then(result => result.room.id, () => null),
      ])
      if (showingRef.current !== projectId) return
      setMainlineRoomId(mainline)
      setItems(page.items)
      setEmptyRooms(page.empty_rooms ?? [])
      setImported(importedPage.result.sessions)
      setImportedFailed(!importedPage.ok)
      // Only offered when there is something unread to offer: a button that
      // spends model budget should say how much work it would do.
      const pending = await ambientSessionsApi.pendingExtraction(projectId).catch(() => null)
      if (showingRef.current !== projectId) return
      setPendingExtraction(pending)
      setCanWrite(page.viewer_can_write)
    } catch (error) {
      if (showingRef.current !== projectId) return
      setFailed(true)
      toast.error(errMsg(error))
    } finally {
      if (showingRef.current === projectId) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  async function extract() {
    setExtracting(true)
    try {
      const outcome = await ambientSessionsApi.extract(projectId)
      if (outcome.records_covered === 0) toast.info('Nothing new to read')
      else if (!outcome.brief_proposal_id && !outcome.memory_packet_proposal_id) {
        // Said plainly rather than as a success: reporting decisions "waiting
        // for review" when no proposal was made sends the person looking for
        // something that does not exist.
        toast.info(`Read ${outcome.records_covered} record${outcome.records_covered === 1 ? '' : 's'} and found nothing to propose`)
      } else {
        // Proposals, not writes: what was found is put to a person, and the
        // Brief changes only when they publish it.
        const parts = [
          // A Brief proposal can be constraints only, so counting decisions
          // unconditionally would announce "0 decisions" for real work.
          outcome.brief_proposal_id
            ? (outcome.decisions > 0
              ? `${outcome.decisions} decision${outcome.decisions === 1 ? '' : 's'} for the Brief`
              : 'an update for the Brief')
            : null,
          outcome.memory_packet_proposal_id ? `${outcome.facts} thing${outcome.facts === 1 ? '' : 's'} learned` : null,
        ].filter(Boolean)
        toast.success(`Read ${outcome.records_covered} record${outcome.records_covered === 1 ? '' : 's'} — ${parts.join(' and ')}, waiting for review`)
      }
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setExtracting(false)
    }
  }

  // Grouped by audience, in the order the server returned: the Project's own
  // conversations first, then each limited group by last activity. The server
  // has already excluded groups the viewer is not in, so this renders whatever
  // it was given and never has to decide visibility itself.
  const groups = useMemo(() => {
    const byRoom = new Map<string, { room: ProjectConversation; items: ProjectConversation[] }>()
    for (const item of items) {
      const existing = byRoom.get(item.room_id)
      if (existing) existing.items.push(item)
      else byRoom.set(item.room_id, { room: item, items: [item] })
    }
    return [...byRoom.values()]
  }, [items])
  const shared = groups.filter(group => group.room.room_is_mainline)
  const limited = groups.filter(group => !group.room.room_is_mainline)

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
          <p className="text-sm text-muted-foreground">Everything said in this Project, newest first.</p>
        </div>
        <div className="flex gap-2">
          {pendingExtraction && pendingExtraction.records > 0 && (
            <Button size="sm" variant="outline" disabled={extracting} onClick={() => void extract()}>
              <Sparkles className="size-4" />
              Extract to Brief ({pendingExtraction.records} new record{pendingExtraction.records === 1 ? '' : 's'})
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />New conversation<ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            {/* Two entries, because there are exactly two answers to "who
                should see this": everyone in the Project, or a group you
                name. The boundary is chosen once, here, and never asked
                about again. */}
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!mainlineRoomId}
                // `new=1` or the Room page opens whichever conversation was
                // most recently active — which is the opposite of what this
                // entry offers.
                onSelect={() => { if (mainlineRoomId) navigate(`/projects/${projectId}/rooms?room=${mainlineRoomId}&new=1`) }}
              >
                In this Project
              </DropdownMenuItem>
              {/* Opening a Room asserts writer authority on the Project;
                  speaking in the one that already exists does not. */}
              {canWrite && (
                <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                  With a limited group…
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <LimitedRoomDialog
        open={pickerOpen}
        projectId={projectId}
        onClose={() => setPickerOpen(false)}
        onOpened={room => { setPickerOpen(false); navigate(`/projects/${projectId}/rooms?room=${room.id}&new=1`) }}
      />

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : failed ? (
        <Card className="flex items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">Could not load this Project's conversations.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Try again</Button>
        </Card>
      ) : items.length === 0 && imported.length === 0 && emptyRooms.filter(room => !room.room_is_mainline).length === 0 ? (
        importedFailed ? (
          // Saying "no conversations yet" when the imported half failed to
          // load is the silent-empty claim this notice exists to prevent.
          <Card className="flex items-center justify-between gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              No Rainver conversations yet, and imported CLI history could not be loaded.
            </p>
            <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Try again</Button>
          </Card>
        ) : (
        <EmptyState
          title="No conversations yet"
          description="Say what this Project should do first — the conversation starts when you do."
        />
        )
      ) : (
        <div className="space-y-5">
          {shared.map(group => (
            // No heading: these are the Project's conversations, and naming
            // the container would put a word in front of the only thing most
            // Projects have.
            <Section key={group.room.room_id} items={group.items} projectId={projectId} />
          ))}
          {limited.map(group => (
            <Section
              key={group.room.room_id}
              title={audienceLabel({
                otherMemberNames: group.room.room_other_member_names,
                agentCount: group.room.room_agent_count,
              })}
              rosterHref={`/projects/${projectId}/rooms?room=${group.room.room_id}`}
              items={group.items}
              projectId={projectId}
            />
          ))}
          {/* A limited group somebody opened and has not spoken in yet. It
              would otherwise be invisible on the only page that lists it, and
              a Room is reached through its conversations. */}
          {emptyRooms.filter(room => !room.room_is_mainline).map(room => (
            <section key={room.room_id} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-muted-foreground">
                  {audienceLabel({
                    otherMemberNames: room.room_other_member_names,
                    agentCount: room.room_agent_count,
                  })}
                </h2>
                <Button size="sm" variant="ghost" asChild>
                  <Link to={`/projects/${projectId}/rooms?room=${room.room_id}`} aria-label="Manage who can see this group">
                    <Settings2 className="size-4" />
                  </Link>
                </Button>
              </div>
              <Link to={`/projects/${projectId}/rooms?room=${room.room_id}&new=1`} className="block">
                <Card className="flex items-center gap-3 p-3 text-sm text-muted-foreground hover:bg-muted/40">
                  <MessageSquare className="size-4 shrink-0" />
                  Nothing said yet — start the conversation.
                </Card>
              </Link>
            </section>
          ))}
          {imported.length > 0 && <ImportedSection items={imported} projectId={projectId} />}
          {importedFailed && (
            <p className="text-xs text-muted-foreground">
              Imported CLI history could not be loaded, so it is not shown here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, rosterHref, items, projectId }: {
  title?: string
  rosterHref?: string
  items: ProjectConversation[]
  projectId: string
}) {
  if (items.length === 0) return null
  return (
    <section className="space-y-2">
      {title && (
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
          {rosterHref && (
            // Roster management is reached from the section it governs, which
            // is the only place the question "who is in this?" comes up.
            <Button size="sm" variant="ghost" asChild>
              <Link to={rosterHref} aria-label={`Manage who can see ${title}`}>
                <Settings2 className="size-4" />
              </Link>
            </Button>
          )}
        </div>
      )}
      <div className="space-y-2">
        {items.map(item => (
          <Link
            key={item.id}
            to={`/projects/${projectId}/rooms?room=${item.room_id}&conversation=${item.id}`}
            className="block"
            data-testid={`conversation-${item.id}`}
          >
            <Card className="flex items-start gap-3 p-3 hover:bg-muted/40">
              <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{item.title ?? 'Untitled conversation'}</span>
                </div>
                {item.last_message_preview ? (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    <span className="uppercase">{item.last_message_role === 'user' ? 'You' : 'Agent'}</span>
                    {' · '}{item.last_message_preview}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">Nothing said yet.</p>
                )}
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                <div>{new Date(item.last_message_at ?? item.created_at).toLocaleString()}</div>
                <div>{item.message_count} message{item.message_count === 1 ? '' : 's'}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}

/**
 * Sessions imported from a paired machine's own CLI.
 *
 * Marked read-only in the row itself rather than only on the page it opens:
 * the whole risk of showing these beside real conversations is someone
 * expecting to be able to reply.
 */
function ImportedSection({ items, projectId }: { items: ImportedSession[]; projectId: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Imported CLI history</h2>
      <div className="space-y-2">
        {items.map(session => (
          <Link
            key={session.id}
            to={`/projects/${projectId}/imported-sessions/${session.id}`}
            className="block"
            data-testid={`imported-session-${session.id}`}
          >
            <Card className="flex items-start gap-3 p-3 hover:bg-muted/40">
              <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{session.title ?? 'Imported session'}</span>
                  <Badge variant="outline" className="text-[11px]">Read-only</Badge>
                  {session.source_state === 'gone' && (
                    <Badge variant="outline" className="text-[11px]">No longer on host</Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  Imported from {session.adapter_type}
                  {session.cwd && ` · ${session.cwd}`}
                </p>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                {session.last_record_at && <div>{new Date(session.last_record_at).toLocaleString()}</div>}
                <div>{session.record_count} record{session.record_count === 1 ? '' : 's'}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}
