import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useParams, useSearchParams } from 'react-router-dom'
import { informationDigestsApi } from '../../api/client'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { Card } from '../../components/ui/card'
import { useSpace } from '../../contexts/SpaceContext'
import { errMsg } from '../../lib/utils'
import type { InformationDigestLookup } from '../../types/api'
import { InformationDigestView } from '../library/InformationDigestView'
import { DigestDayNav, DigestMissing, DigestProvenance } from '../library/DigestDay'
import { useAppTranslation } from '../../i18n'
import { ProjectBriefingPanel } from './ProjectBriefingPanel'

export default function ProjectDigestPage() {
  const { projectId = '' } = useParams()
  const { activeSpaceId } = useSpace()
  return <ScopedProjectDigest key={`${activeSpaceId}:${projectId}`} />
}
function ScopedProjectDigest() {
  const [params, setParams] = useSearchParams()
  const { projectId = '' } = useParams()
  const { activeSpaceId } = useSpace()
  const { t } = useAppTranslation()
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : null
  const setDay = (value: string) => { const next = new URLSearchParams(params); next.set('date', value); setParams(next) }
  const [latestDay, setLatestDay] = useState<string | null>(null)
  const [lookup, setLookup] = useState<InformationDigestLookup | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const digest = lookup?.status === 'available' ? lookup.digest : null

  // Only the latest request lands, so fast prev/next cannot show a stale day.
  const loadRequest = useRef(0)
  const load = useCallback(async () => {
    if (!activeSpaceId || !projectId) return
    const request = ++loadRequest.current
    setLoading(true); setLookup(null); setError(null)
    try {
      const next = await informationDigestsApi.project(activeSpaceId, projectId, day ?? undefined)
      if (request !== loadRequest.current) return
      setLookup(next)
      if (day === null) setLatestDay(next.status === 'available' ? next.digest.digest_date : next.digest_date)
    } catch (error) {
      if (request === loadRequest.current) { setLookup(null); setError(error); toast.error(errMsg(error)) }
    } finally {
      if (request === loadRequest.current) setLoading(false)
    }
  }, [activeSpaceId, projectId, day])
  const shownDay = lookup ? (lookup.status === 'available' ? lookup.digest.digest_date : lookup.digest_date) : null

  useEffect(() => { void load(); return () => { loadRequest.current++ } }, [load])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reading.editions')}</h1>
          <p className="text-xs text-muted-foreground">{t('reading.historyHint')}</p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}><RefreshCw className="size-4" />{t('reading.refresh')}</Button>
      </div>
      {activeSpaceId && projectId ? <ProjectBriefingPanel key={`${activeSpaceId}:${projectId}`} spaceId={activeSpaceId} projectId={projectId} /> : null}
      {error != null && <div role="alert"><p>{errMsg(error)}</p><Button onClick={load}>{t('reading.retry')}</Button></div>}
      {loading && !lookup ? <div className="space-y-3"><Skeleton className="h-32" /><Skeleton className="h-32" /></div> : null}
      {lookup && shownDay ? (
        <DigestDayNav
          date={shownDay}
          timezone={lookup.status === 'available' ? lookup.digest.timezone : lookup.timezone}
          canGoForward={latestDay !== null && shownDay < latestDay}
          onSelect={setDay}
        />
      ) : null}
      {lookup?.status === 'missing' ? (
        <DigestMissing missing={lookup} onBackfill={async (date) => {
          if (!activeSpaceId) return
          const request = loadRequest.current
          try {
            const result = await informationDigestsApi.backfillProject(activeSpaceId, projectId, date)
            if (request !== loadRequest.current) return
            setLookup({ status: 'available', digest: result.digest })
            toast.success(result.created ? t('digest_reports.backfill_done') : t('digest_reports.backfill_existing'))
          } catch (error) {
            toast.error(errMsg(error))
          }
        }} />
      ) : null}
      {digest ? <DigestProvenance digest={digest} /> : null}
      {digest?.team_aggregates_available && digest.team_blind_spot_domains.length > 0 ? (
        <Card className="p-4 space-y-2">
          <h2 className="text-sm font-semibold">Team blind spots</h2>
          <p className="text-xs text-muted-foreground">Project Corpus domains no active member has read yet. Individual reading activity is never shown.</p>
          <div className="flex flex-wrap gap-2">
            {digest.team_blind_spot_domains.map(domain => <span key={domain} className="rounded-md border border-border px-2 py-1 text-xs">{domain.replace(/_/g, ' ')}</span>)}
          </div>
        </Card>
      ) : null}
      {digest ? <InformationDigestView digest={digest} project reading /> : null}
    </div>
  )
}
