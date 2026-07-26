import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SpaceLink as Link } from '../../core/spaceNav'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { artifactsApi } from '../../api/client'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { Artifact } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { PreviewBadge } from '../../components/PreviewBadge'
import { ScopeBadge } from '../../components/ScopeBadge'
import { ContentAccessControl } from '../../components/ContentAccessControl'

function fmt(dt: string | null | undefined) {
  return dt ? new Date(dt).toLocaleString() : '—'
}

export default function ArtifactDetailPage() {
  const { artifactId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const { activeSpaceId, activeSpaceName } = useSpace()
  const projectFolderId = searchParams.get('project_folder_id') ?? ''
  const [a, setA] = useState<Artifact | null>(null)
  const [loading, setLoading] = useState(true)
  const listHref = `/artifacts${projectFolderId ? `?project_folder_id=${encodeURIComponent(projectFolderId)}` : ''}`

  useEffect(() => {
    if (!artifactId) return
    if (!activeSpaceId) {
      setA(null)
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const r = await artifactsApi.get(artifactId, { project_folder_id: projectFolderId || undefined })
        if (!cancelled) setA(r)
      } catch (e) {
        if (!cancelled) {
          toast.error(errMsg(e))
          setA(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [artifactId, activeSpaceId, projectFolderId])

  async function exportArt() {
    if (!a) return
    try {
      await artifactsApi.export(a.id, { project_folder_id: projectFolderId || undefined })
      toast.success('Download started')
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <Button variant="ghost" size="sm" asChild>
        <Link to={listHref}><ArrowLeft className="size-4 mr-1" />Artifacts</Link>
      </Button>

      {loading && <Skeleton className="h-40 w-full" />}

      {!loading && !a && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {activeSpaceId ? 'Artifact not found.' : 'Select an operational space to inspect this artifact.'}
        </Card>
      )}

      {!loading && a && (
        <Card className="p-5 space-y-4">
          <div className="flex flex-wrap justify-between gap-3">
            <h1 className="text-lg font-semibold tracking-tight">{a.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <ContentAccessControl resourceType="artifact" resourceId={a.id} ownerUserId={a.owner_user_id ?? null} />
              <Button size="sm" variant="outline" disabled={!a.exportable} onClick={exportArt}>Export</Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Viewing: {activeSpaceName ?? activeSpaceId ?? 'No operational space selected'}</p>
          <div className="flex flex-wrap gap-1.5 items-center text-xs text-muted-foreground">
            <Badge variant="secondary">{a.artifact_type}</Badge>
            <ScopeBadge visibility={a.visibility} />
            {a.project_folder_id && <Badge variant="outline">folder</Badge>}
            {a.preview && <PreviewBadge />}
            <span>{fmt(a.created_at)}</span>
            {a.run_id && (
              <Link to={`/runs/${a.run_id}`} className="text-accent-foreground hover:underline ml-2">
                Open run
              </Link>
            )}
          </div>
          <div className="grid gap-3 rounded-md border border-border bg-muted/15 p-3 text-xs sm:grid-cols-2">
            <div><p className="text-muted-foreground">Artifact ID</p><p className="break-all font-mono">{a.id}</p></div>
            <div><p className="text-muted-foreground">Surface role</p><p>{a.surface_role.replace(/_/g, ' ')}</p></div>
            {a.project_id && <div><p className="text-muted-foreground">Project ID</p><p className="break-all font-mono">{a.project_id}</p></div>}
            {a.project_folder_id && <div><p className="text-muted-foreground">Project Folder ID</p><p className="break-all font-mono">{a.project_folder_id}</p></div>}
            <div><p className="text-muted-foreground">Updated</p><p>{fmt(a.updated_at)}</p></div>
            <div><p className="text-muted-foreground">Storage</p><p>{a.storage_ref ?? (a.has_inline_content ? 'Inline archive' : 'Unavailable')}</p></div>
          </div>
        </Card>
      )}
    </div>
  )
}
