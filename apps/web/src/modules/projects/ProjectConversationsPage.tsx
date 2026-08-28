import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { History, MessageSquare, Plus, RefreshCw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi, projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { ImportedSession, ProjectConversation } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'

/**
 * Every conversation in the Project, as one list.
 *
 * A Project is pushed forward through conversation, so the place to see all
 * of it is a first-level destination, beside Pulse, Board and Updates — not a
 * Room picker two clicks down. The mainline leads; topic Rooms follow by last
 * activity; each row opens that conversation in the full Room.
 */
export default function ProjectConversationsPage() {
  const { projectId = '' } = useParams()
  const [items, setItems] = useState<ProjectConversation[]>([])
  const [imported, setImported] = useState<ImportedSession[]>([])
  /** A failed read is said out loud; showing an empty section would claim there is no history. */
  const [importedFailed, setImportedFailed] = useState(false)
  const [pendingExtraction, setPendingExtraction] = useState<{ records: number; sessions: number } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const showingRef = useRef(projectId)

  const load = useCallback(async () => {
    showingRef.current = projectId
    setLoading(true)
    setFailed(false)
    try {
      // Two sources, each filtered by its own read gate on the server, merged
      // only for display: an imported session is not a Rainver conversation
      // and must never be mistaken for one, but a person looking for "what was
      // said about this Project" does not care who produced it.
      const [page, importedPage] = await Promise.all([
        projectsApi.conversations(projectId, { limit: 100 }),
        ambientSessionsApi.listForProject(projectId).then(
          result => ({ ok: true as const, result }),
          () => ({ ok: false as const, result: { sessions: [] as ImportedSession[] } }),
        ),
      ])
      if (showingRef.current !== projectId) return
      setItems(page.items)
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

  const mainline = items.filter(item => item.room_is_mainline)
  const topics = items.filter(item => !item.room_is_mainline)

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
          <Button size="sm" variant="outline" asChild>
            <Link to={`/projects/${projectId}/rooms`}>Rooms</Link>
          </Button>
          {canWrite && (
            <Button size="sm" asChild>
              <Link to={`/projects/${projectId}/rooms`}><Plus className="size-4" />New topic Room</Link>
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : failed ? (
        <Card className="flex items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">Could not load this Project's conversations.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="size-4" />Try again</Button>
        </Card>
      ) : items.length === 0 && imported.length === 0 ? (
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
          description={canWrite
            ? 'Open the chat panel and say what this Project should do first — that starts its mainline conversation.'
            : 'Nobody has talked in this Project yet.'}
        />
        )
      ) : (
        <div className="space-y-5">
          <Section title="Mainline" items={mainline} projectId={projectId} />
          {topics.length > 0 && <Section title="Topic Rooms" items={topics} projectId={projectId} />}
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

function Section({ title, items, projectId }: { title: string; items: ProjectConversation[]; projectId: string }) {
  if (items.length === 0) return null
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
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
                  {!item.room_is_mainline && <Badge variant="outline" className="text-[11px]">{item.room_title}</Badge>}
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
