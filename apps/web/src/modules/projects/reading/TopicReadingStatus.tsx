import type {ProjectReadingResponse} from '@rainver/protocol'
import {useAppTranslation} from '../../../i18n'
import {SpaceLink} from '../../../core/spaceNav'
import {analysisFailureKey} from './analysisFailure'

type Round=ProjectReadingResponse['rounds'][number]
/** Report publication and the latest attempt are deliberately separate. */
export function TopicReadingStatus({round,hasReport,project,goal,reportPartial=false}:{round?:Round;reportPartial?:boolean;hasReport:boolean;project:string;goal:string}){
 const {t}=useAppTranslation()
 const needsHelp=round&&['blocked','awaiting_analysis'].includes(round.status)
 const active=round&&['collecting','generating'].includes(round.status)
 const partial=round?.coverage.complete===false||reportPartial
 if(!needsHelp&&!active&&!partial&&hasReport)return null
 return <div className="space-y-1 text-xs text-muted-foreground" data-topic-reading-status>
  {active&&<p role="status">{t(`projectReading.status.${round.status}`)}{hasReport&&` · ${t('projectReading.previousReport')}`}</p>}
  {needsHelp&&<><p>{t(round.status==='awaiting_analysis'?'projectReading.analysisAwaiting':analysisFailureKey(round.error_code))}</p>{hasReport&&<p>{t('projectReading.previousReport')}</p>}</>}
  {partial&&<p>{t('projectReading.partial')}</p>}
  {!hasReport&&!active&&!needsHelp&&<p>{t('projectReading.noTopicAnalysis')}</p>}
  {(needsHelp||!hasReport&&!active)&&<SpaceLink className="inline-block underline underline-offset-2" to={`/projects/${project}/sources/goals/${encodeURIComponent(goal)}#topic-analysis`}>{t('projectReading.resolveInTopic')}</SpaceLink>}
 </div>
}
