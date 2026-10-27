import { ArrowLeft } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useAppTranslation } from '../../i18n'
import { SpaceLink } from '../../core/spaceNav'
import { Button } from '../../components/ui/button'
import MonitoringPanel from './sourcesArea/MonitoringPanel'
import ProjectSourcesPage from './ProjectSourcesPage'
import ProjectDigestPage from './ProjectDigestPage'
import ReadingWorkspace from '../library/ReadingWorkspace'

/** Existing Sources deep links remain valid; reading is a consumer of the unified projection. */
export default function SourcesAreaPage() {
  const { projectId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { t } = useAppTranslation()
  const fromSettings = params.get('from') === 'settings'
  const requested = params.get('tab')
  const tab = requested === 'sources' ? 'settings' : requested === 'raw' ? 'candidates' : requested
  const change = (next: string | null) => {
    const updated = new URLSearchParams(params)
    if (next) updated.set('tab', next); else updated.delete('tab')
    if (next === 'materials') updated.set('view', 'all')
    setParams(updated, { replace: true })
  }
  // An old materials deep link resolves to the same complete authorized material query.
  if (tab === 'materials') return <div className="p-4 md:p-6"><ReadingWorkspace projectId={projectId} /></div>
  if (!tab || tab === 'updates') return <div className="p-4 md:p-6"><ReadingWorkspace projectId={projectId} /></div>
  return <div className="space-y-6 p-4 md:p-6">
    <Button size="sm" variant="outline" asChild><SpaceLink to={fromSettings ? `/projects/${projectId}?settings=project` : `/projects/${projectId}/sources`}><ArrowLeft className="size-4" aria-hidden="true" />{t(fromSettings ? 'reading.backSettings' : 'reading.backProject')}</SpaceLink></Button>
    {tab === 'digest' ? <ProjectDigestPage /> : <>
      <h1 className="text-xl font-semibold tracking-tight">{t('reading.sources')}</h1>
      <nav className="flex flex-wrap gap-2"><Button size="sm" variant={tab === 'settings' ? 'secondary' : 'ghost'} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => change('settings')}>{t('monitoring.followingSettings')}</Button><Button size="sm" variant={tab === 'candidates' ? 'secondary' : 'ghost'} aria-current={tab === 'candidates' ? 'page' : undefined} onClick={() => change('candidates')}>{t('monitoring.allCandidates')}</Button><Button variant="ghost" asChild><SpaceLink to={`/proposals?project_id=${projectId}`}>{t('reading.review')}</SpaceLink></Button></nav>
      {tab === 'candidates' ? <MonitoringPanel mode="candidates" /> : tab === 'review' ? <SpaceLink className="underline" to={`/proposals?project_id=${projectId}`}>{t('reading.review')}</SpaceLink> : <div className="space-y-5"><MonitoringPanel /><details className="rounded-lg border border-border bg-card"><summary className="cursor-pointer p-4 font-medium">{t('monitoring.manageLinkedSources')}</summary><ProjectSourcesPage view="manage" /></details></div>}
    </>}
  </div>
}
