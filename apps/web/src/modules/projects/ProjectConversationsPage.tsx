import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { MessageSquare, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { projectsApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { ProjectConversation } from '../../types/api'
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
  const [canWrite, setCanWrite] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const showingRef = useRef(projectId)

  const load = useCallback(async () => {
    showingRef.current = projectId
    setLoading(true)
    setFailed(false)
    try {
      const page = await projectsApi.conversations(projectId, { limit: 100 })
      if (showingRef.current !== projectId) return
      setItems(page.items)
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
      ) : items.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description={canWrite
            ? 'Open the chat panel and say what this Project should do first — that starts its mainline conversation.'
            : 'Nobody has talked in this Project yet.'}
        />
      ) : (
        <div className="space-y-5">
          <Section title="Mainline" items={mainline} projectId={projectId} />
          {topics.length > 0 && <Section title="Topic Rooms" items={topics} projectId={projectId} />}
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
