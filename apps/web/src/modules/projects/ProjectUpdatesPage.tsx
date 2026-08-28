import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Undo2 } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { ProjectWorkUpdate } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { EmptyState } from '../../components/ui/empty-state'
import { inProjectHref } from './taskHref'

/**
 * How the Project has been going, in the words of whoever did the work.
 *
 * A filter over the one event stream, not a second record — so an Agent's
 * account of a Task and the machine's account of the same Task cannot drift
 * apart. It is also the only place an Agent working outside a conversation can
 * be heard: it is not in a Room turn, so it has nowhere else to speak.
 */
export default function ProjectUpdatesPage() {
  const { projectId = '' } = useParams()
  const [items, setItems] = useState<ProjectWorkUpdate[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [undoing, setUndoing] = useState<string | null>(null)

  const undo = useCallback(async (eventId: string) => {
    setUndoing(eventId)
    try {
      await projectsApi.undoUpdate(projectId, eventId)
      // Reload rather than patch: the reversal is its own update, and the
      // reversed one now reads as undone.
      await load()
      toast.success('Undone')
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setUndoing(null)
    }
    // `load` is declared below; the dependency is intentionally the stable id.
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (nextCursor?: string) => {
    if (!nextCursor) {
      setFailed(false)
      // Held until the retry answers, so the surface does not flash the empty
      // state — the confident all-clear this error path exists to avoid.
      setLoading(true)
    } else {
      setLoadingMore(true)
    }
    try {
      const page = await projectsApi.updates(projectId, nextCursor ? { cursor: nextCursor } : {})
      setItems(current => (nextCursor ? [...current, ...page.items] : page.items))
      setCursor(page.next_cursor)
      setCanWrite(page.viewer_can_write)
    } catch (error) {
      // Only a failed first page leaves the state unknown. A failed "load
      // more" leaves what is already on screen true, so it stays.
      if (!nextCursor) setFailed(true)
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const post = useCallback(async () => {
    if (!draft.trim()) return
    setPosting(true)
    try {
      await projectsApi.postUpdate(projectId, { summary: draft.trim() })
      setDraft('')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setPosting(false)
    }
  }, [projectId, draft, load])

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Updates</h1>
        <p className="text-sm text-muted-foreground">
          What has been done and concluded, newest first.
        </p>
      </div>

      {/* Reading the account and adding to it are different permissions: a
          `viewer` gets the list without a composer that would only ever 403. */}
      {canWrite && (
      <Card className="space-y-2 p-4">
        <textarea
          className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent p-3 text-sm"
          placeholder="Where does this Project stand?"
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={posting || !draft.trim()} onClick={() => void post()}>
            {posting ? 'Posting…' : 'Post update'}
          </Button>
        </div>
      </Card>
      )}

      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : failed ? (
        <Card className="flex items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">Could not load this Project's updates.</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            Try again
          </Button>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing reported yet"
          description="Agents report here when they choose to, and every Task that closes shows up; you can post one too."
        />
      ) : (
        <div className="space-y-2">
          {items.map(update => (
            <Card key={update.id} className="space-y-1 p-4" data-testid={`update-${update.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {update.members ? (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-left text-sm hover:underline"
                      onClick={() => setExpanded(current => ({ ...current, [update.id]: !current[update.id] }))}
                    >
                      {expanded[update.id] ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      {update.summary}
                    </button>
                  ) : (
                    <p className="text-sm">{update.summary}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {update.outcome && update.outcome !== 'progress' && (
                    <Badge variant="outline" className="text-[11px]">{update.outcome}</Badge>
                  )}
                  <UndoControl update={update} busy={undoing} canWrite={canWrite} onUndo={undo} />
                </div>
              </div>
              <UpdateMeta projectId={projectId} update={update} />
              {update.members && expanded[update.id] && (
                <div className="mt-2 space-y-1 border-l border-border pl-3">
                  {update.members.map(member => (
                    <div key={member.id} className="flex items-start justify-between gap-2" data-testid={`update-${member.id}`}>
                      <p className="text-sm">{member.summary}</p>
                      <UndoControl update={member} busy={undoing} canWrite={canWrite} onUndo={undo} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
          {cursor && (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void load(cursor)}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A fold's member and a standalone update render identically. */
type UpdateRow = NonNullable<ProjectWorkUpdate['members']>[number]

/**
 * Who did it, what it was about, and when. The subject is whatever kind of
 * thing the update names — Tasks were the only kind until an Agent started
 * advancing Threads directly.
 */
function subjectHref(projectId: string, subject: NonNullable<UpdateRow['subject']>): string {
  switch (subject.type) {
    case 'task': return inProjectHref(projectId, `/tasks/${subject.id}`)
    // Memory is the Space's, not the Project's — the entry itself is where
    // its rationale and version chain are read.
    case 'memory_entry': return `/memory/${subject.id}`
    case 'inquiry_thread': return `/projects/${projectId}/inquiry?thread=${subject.id}`
    default: {
      // Exhaustive on purpose: a catch-all is what sent memory subjects to the
      // Inquiry Area with an id it had never heard of, and a fourth subject
      // type would do it again silently.
      const unreachable: never = subject.type
      return inProjectHref(projectId, `/updates#${String(unreachable)}`)
    }
  }
}

function UpdateMeta({ projectId, update }: { projectId: string; update: UpdateRow }) {
  return (
    <p className="text-xs text-muted-foreground">
      {update.actor.display_name ?? 'System'}
      {update.subject && (
        <>
          {' · '}
          {/* One link per subject type. Anything not named here would land
              on the wrong Area with an id that Area has never heard of. */}
          <Link to={subjectHref(projectId, update.subject)} className="hover:underline">
            {update.subject.title}
          </Link>
        </>
      )}
      {' · '}
      {new Date(update.occurred_at).toLocaleString()}
      {update.undone_by_event_id && ' · undone'}
    </p>
  )
}

/**
 * The counterpart of a direct write: an Agent advanced the Project without
 * asking, so this is where the person puts it back (ADR 0017 §4).
 */
function UndoControl({
  update, busy, canWrite, onUndo,
}: {
  update: Pick<UpdateRow, 'id' | 'undo'>
  busy: string | null
  canWrite: boolean
  onUndo: (eventId: string) => void | Promise<void>
}) {
  if (!update.undo) return null
  // Same rule as the composer above, with one exception: archiving a memory
  // is the owner's own decision, not a Project write, and the read model
  // already shows a viewer only their own memory rows.
  if (!canWrite && update.undo.action !== 'archive_memory') return null
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-[11px]"
      disabled={busy === update.id}
      onClick={() => void onUndo(update.id)}
    >
      <Undo2 className="mr-1 size-3" />
      Undo
    </Button>
  )
}
