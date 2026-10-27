import { lazy, Suspense } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SpaceLink } from '../../core/spaceNav'
import { useAppTranslation } from '../../i18n'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'

const DeepResearchAreaPage = lazy(() => import('./DeepResearchAreaPage'))
const deepTabs = new Set(['standing', 'focus', 'reading', 'checklist', 'reports', 'runs'])

/** A visit alone neither initializes Research nor loads its state machine. */
export default function ResearchAreaPage() {
  const { projectId = '' } = useParams()
  const [params] = useSearchParams()
  const { t } = useAppTranslation()
  // Existing Inquiry setup and attention/history deep links remain executable.
  if (deepTabs.has(params.get('tab') ?? '') || params.get('research') === 'new') {
    return <Suspense fallback={<div className="p-6">{t('monitoring.researchLoading')}</div>}><DeepResearchAreaPage /></Suspense>
  }
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <header className="space-y-2"><h1 className="text-2xl font-semibold">{t('monitoring.researchNav')}</h1><p className="text-sm text-muted-foreground">{t('monitoring.questionResearchIntro')}</p></header>
      <Card className="space-y-4 p-6 md:p-8">
        <h2 className="text-xl font-semibold">{t('monitoring.questionResearchTitle')}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('monitoring.questionResearchDescription')}</p>
        <Button asChild><SpaceLink to={`/projects/${projectId}/inquiry`}>{t('monitoring.chooseQuestion')}</SpaceLink></Button>
      </Card>
      <div className="flex flex-wrap gap-3">
        <Button asChild variant="outline"><SpaceLink to={`/projects/${projectId}/research?tab=focus`}>{t('monitoring.openResearchWorkspace')}</SpaceLink></Button>
        <Button asChild variant="ghost"><SpaceLink to={`/projects/${projectId}/research?tab=reports`}>{t('monitoring.pastReports')}</SpaceLink></Button>
        <Button asChild variant="ghost"><SpaceLink to={`/projects/${projectId}/research?tab=runs`}>{t('monitoring.pastRuns')}</SpaceLink></Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('monitoring.routineReadingHint')} <SpaceLink className="text-primary hover:underline" to={`/projects/${projectId}/sources`}>{t('monitoring.openUpdates')}</SpaceLink></p>
    </div>
  )
}
