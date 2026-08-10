import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useParams } from 'react-router-dom'
import { informationDigestsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { Card } from '../../components/ui/card'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { InformationDigest } from '../../types/api'
import { InformationDigestView } from '../library/InformationDigestView'

export default function ProjectDigestPage() {
  const { projectId = '' } = useParams()
  const { activeSpaceId } = useSpace()
  const [digest, setDigest] = useState<InformationDigest | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!activeSpaceId || !projectId) return
    setLoading(true)
    try {
      setDigest(await informationDigestsApi.project(activeSpaceId, projectId))
    } catch (error) {
      toast.error(errMsg(error))
    } finally {
      setLoading(false)
    }
  }, [activeSpaceId, projectId])

  useEffect(() => { void load() }, [load])

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Project digest</h1>
          <p className="text-sm text-muted-foreground">One shared daily view of newly admitted Project Corpus material. Reading state remains yours.</p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className="size-4" />Refresh</Button>
      </div>
      {loading && !digest ? <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-32" /></div> : null}
      {digest?.team_aggregates_available && digest.team_blind_spot_domains.length > 0 ? (
        <Card className="p-4 space-y-2">
          <h2 className="text-sm font-semibold">Team blind spots</h2>
          <p className="text-xs text-muted-foreground">Project Corpus domains no active member has read yet. Individual reading activity is never shown.</p>
          <div className="flex flex-wrap gap-2">
            {digest.team_blind_spot_domains.map(domain => <span key={domain} className="rounded border px-2 py-1 text-xs">{domain.replace(/_/g, ' ')}</span>)}
          </div>
        </Card>
      ) : null}
      {digest ? <InformationDigestView digest={digest} project /> : null}
    </div>
  )
}
