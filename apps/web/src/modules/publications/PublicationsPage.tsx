import { useCallback, useEffect, useState } from 'react'
import { Eye, Import, RotateCcw, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ContentPublication, PublicationResourceType } from '@rainver/protocol'
import { publicationsApi } from '../../api/client'
import { SpaceLink as Link } from '../../core/spaceNav'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { EmptyState } from '../../components/ui/empty-state'
import { Skeleton } from '../../components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'

type PublicationView = 'received' | 'published'

function resourceHref(resourceType: PublicationResourceType, resourceId: string): string {
  if (resourceType === 'artifact') return `/artifacts/${resourceId}`
  if (resourceType === 'memory') return `/memory/${resourceId}`
  if (resourceType === 'task') return `/tasks/${resourceId}`
  return `/knowledge/wiki/${resourceId}`
}

function fmt(value: string): string {
  return new Date(value).toLocaleString()
}

export default function PublicationsPage() {
  const { activeSpaceId, spaces } = useSpace()
  const [view, setView] = useState<PublicationView>('received')
  const [items, setItems] = useState<ContentPublication[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ContentPublication | null>(null)

  const load = useCallback(async () => {
    if (!activeSpaceId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await publicationsApi.list(view)
      setItems(response.items)
    } catch (error) {
      toast.error(errMsg(error))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, view])

  useEffect(() => { void load() }, [load])

  async function importPublication(publicationId: string) {
    setBusyId(publicationId)
    try {
      await publicationsApi.import(publicationId)
      toast.success('Snapshot imported')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyId(null)
    }
  }

  async function revokePublication(publicationId: string) {
    setBusyId(publicationId)
    try {
      await publicationsApi.revoke(publicationId)
      toast.success('Publication revoked')
      await load()
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Shared content</h1>
          <p className="mt-1 text-xs text-muted-foreground">{spaces.find(space => space.id === activeSpaceId)?.name ?? activeSpaceId}</p>
        </div>
        <Tabs value={view} onValueChange={value => setView(value as PublicationView)}>
          <TabsList>
            <TabsTrigger value="received">Received</TabsTrigger>
            <TabsTrigger value="published">Published</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          title={view === 'received' ? 'No shared snapshots' : 'No publications'}
          description={view === 'received' ? 'This space has no active targeted publications.' : 'You have not published content from this space.'}
        />
      )}

      {!loading && items.map(publication => {
        const imported = publication.import
        const targetNames = publication.target_space_ids.map(spaceId =>
          spaces.find(space => space.id === spaceId)?.name ?? spaceId)
        return (
          <Card key={publication.id} className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold break-words">{publication.title}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">{publication.source_resource_type}</Badge>
                  <Badge variant="outline">v{publication.version}</Badge>
                  <Badge variant={publication.status === 'active' ? 'success' : 'muted'}>{publication.status}</Badge>
                  <span className="text-xs text-muted-foreground">{fmt(publication.created_at)}</span>
                </div>
                {view === 'published' && (
                  <p className="mt-2 text-xs text-muted-foreground">Targets: {targetNames.join(', ')}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setPreview(publication)}>
                  <Eye className="size-3.5" /> Preview
                </Button>
                {view === 'received' && !imported && (
                  <Button size="sm" disabled={busyId === publication.id} onClick={() => importPublication(publication.id)}>
                    <Import className="size-3.5" />{busyId === publication.id ? 'Importing...' : 'Import'}
                  </Button>
                )}
                {view === 'received' && imported && (
                  <Button size="sm" variant="outline" asChild>
                    <Link to={resourceHref(imported.imported_resource_type, imported.imported_resource_id)}>Open copy</Link>
                  </Button>
                )}
                {view === 'published' && publication.status === 'active' && (
                  <Button size="sm" variant="destructive" disabled={busyId === publication.id} onClick={() => revokePublication(publication.id)}>
                    <RotateCcw className="size-3.5" />{busyId === publication.id ? 'Revoking...' : 'Revoke'}
                  </Button>
                )}
              </div>
            </div>
            {view === 'published' && (
              <Button size="sm" variant="ghost" asChild>
                <Link to={resourceHref(publication.source_resource_type, publication.source_resource_id)}>
                  <Share2 className="size-3.5" /> Open source
                </Link>
              </Button>
            )}
          </Card>
        )
      })}

      <Dialog open={preview !== null} onOpenChange={next => { if (!next) setPreview(null) }}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{preview?.title ?? 'Snapshot'}</DialogTitle>
          </DialogHeader>
          <pre className="overflow-auto rounded-md border border-border bg-muted/30 p-4 text-xs whitespace-pre-wrap break-words">
            {preview ? JSON.stringify(preview.snapshot.payload, null, 2) : ''}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}
