import {useEffect} from 'react'
import type {BriefingEvidence} from '@rainver/protocol'
import {useLocation} from 'react-router-dom'
import {ArrowLeft} from 'lucide-react'
import {projectReadingApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {SpaceLink} from '../../../core/spaceNav'
import {spacePath} from '../../../core/navigation'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {BriefingView} from '../../library/briefing/BriefingView'
import {BriefingText} from '../../library/briefing/BriefingCitations'
import {useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
import {projectReaderHref} from '../../library/readingLinks'

/** The selected composition pins the report, independently of live checks. */
export function TopicAnalysisReader({space,project,goal,version,title,overviewHref,returnTo,onDenied}:{space:string;project:string;goal:string;version:string;title:string;overviewHref:string;returnTo:string;onDenied:()=>void}){
 const {t}=useAppTranslation(),location=useLocation()
 const read=useReadingResource(`${space}:${project}:${version}`,signal=>projectReadingApi.composition(space,project,version,{signal}))
 const section=read.data?.latest?.sections.find(s=>s.goal_id===goal)
 const visible=section?.visibility==='visible'&&section.briefing?.visibility!=='withheld'
 const citations={evidence:new Map(section?.briefing?.evidence.map(e=>[e.key,e])),context:new Map(section?.briefing?.context.map(c=>[c.key,c])),evidenceHref:(e:BriefingEvidence)=>spacePath(space,projectReaderHref(project,e.source_item_id,returnTo,e.original_snapshot_id))}
 useEffect(()=>{if([401,403,404].includes((read.error as {status?:number})?.status??0))onDenied()},[read.error,onDenied])
 useEffect(()=>{if(read.data&&location.hash){document.getElementById(location.hash.slice(1))?.scrollIntoView?.({block:'start'})}},[read.data,location.hash])
 return <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6" data-topic-analysis-reader>
  <Button variant="ghost" size="sm" asChild><SpaceLink to={overviewHref} replace><ArrowLeft className="size-4"/>{t('projectReading.backToOverview')}</SpaceLink></Button>
  <header className="space-y-2 border-b border-border pb-4">
   <h2 tabIndex={-1} data-analysis-heading className="text-xl font-semibold outline-none">{visible?title:t('projectReading.fullAnalysis')}</h2>
   {visible&&<time dateTime={section.published_at} className="block text-xs text-muted-foreground">{t('projectReading.analysisPublished',{date:formatDateTime(section.published_at)})}</time>}
  </header>
  <ReadingFeedback error={read.error} loading={read.loading} retry={read.reload}/>
  {!read.loading&&!read.error&&!visible&&<p className="text-sm text-muted-foreground">{t('projectReading.withheld')}</p>}
  {visible&&section.briefing&&<>
   {section.briefing.topic?.summary&&<p className="text-sm leading-relaxed"><BriefingText text={section.briefing.topic.summary} {...citations}/></p>}
   <BriefingView briefing={section.briefing} evidenceHref={citations.evidenceHref} evidenceScopeTitle={title}/>
   <details className="border-t border-border pt-4 text-sm"><summary className="cursor-pointer text-muted-foreground">{t('projectReading.analysisContext')}</summary><div className="mt-3 space-y-2"><p>{t('projectReading.frozenPurpose')}</p>{section.purpose_text&&<p className="whitespace-pre-wrap break-words">{section.purpose_text}</p>}{section.briefing.topic?.stop_reason&&<p><BriefingText text={section.briefing.topic.stop_reason} {...citations}/></p>}</div></details>
  </>}
 </article>
}
