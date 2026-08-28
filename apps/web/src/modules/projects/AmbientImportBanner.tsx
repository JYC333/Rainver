import { useCallback, useEffect, useState } from 'react'
import { History, X } from 'lucide-react'
import { toast } from 'sonner'
import { ambientSessionsApi, projectFoldersApi } from '../../api/client'
import { errMsg } from '../../lib/utils'
import { SpaceLink as Link } from '../../core/spaceNav'
import type { AmbientSessionCount, WorkspaceLocation } from '../../types/api'
import { Card } from '../../components/ui/card'
import { Button } from '../../components/ui/button'

/**
 * The offer, made once.
 *
 * Binding a folder only counts what a machine holds; importing it is a
 * separate act, because a person's own terminal history becoming Project
 * content is a decision they should make deliberately and knowingly. The
 * banner is how that decision is put to them, and answering it either way —
 * by opening the settings or by dismissing — stops it being asked again.
 */
export function AmbientImportBanner({ projectId }: { projectId: string }) {
  const [offer, setOffer] = useState<{ location: WorkspaceLocation; counts: AmbientSessionCount[] } | null>(null)
  const [dismissing, setDismissing] = useState(false)

  const load = useCallback(async () => {
    try {
      const folders = await projectFoldersApi.list(projectId)
      for (const folder of folders.items) {
        const locations = await projectFoldersApi.locations(projectId, folder.id)
        for (const location of locations) {
          // Only a paired machine has ambient history: a server-host checkout
          // runs managed profiles, which have none.
          if (location.execution_host_kind !== 'remote') continue
          // Asking on behalf of someone who is not the host owner returns 403;
          // they are not the person this offer is for.
          const result = await ambientSessionsApi.offer(location.id).catch(() => null)
          if (!result || result.policy.offered_at) continue
          const counts = result.counts.filter(count => count.session_count > 0 && !count.error)
          if (counts.length === 0) continue
          setOffer({ location, counts })
          return
        }
      }
    } catch {
      // The banner is an offer, not a feature: a Project whose folders cannot
      // be listed simply does not show it.
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  if (!offer) return null

  const total = offer.counts.reduce((sum, count) => sum + count.session_count, 0)
  const runtimes = offer.counts.map(count => `${count.session_count} ${count.adapter_type}`).join(', ')

  async function dismiss() {
    if (!offer) return
    setDismissing(true)
    try {
      await ambientSessionsApi.dismiss(offer.location.id)
      setOffer(null)
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setDismissing(false)
    }
  }

  return (
    <Card className="flex flex-wrap items-start gap-3 border-dashed p-4" data-testid="ambient-import-banner">
      <History className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          Found {total} CLI session{total === 1 ? '' : 's'} for this folder on {offer.location.display_path ?? 'a paired machine'}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {runtimes}. Importing them makes what you already worked on available here — read-only, and you
          choose who can read it.
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" asChild>
          <Link to={`/projects/${projectId}/folders/${offer.location.project_folder_id}`}>Review and import</Link>
        </Button>
        <Button size="sm" variant="ghost" disabled={dismissing} onClick={() => void dismiss()} aria-label="Dismiss">
          <X className="size-4" />
        </Button>
      </div>
    </Card>
  )
}
