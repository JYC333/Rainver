import {useEffect} from 'react'
import {useSearchParams} from 'react-router-dom'
import type {SourceGoalDetail} from '@rainver/protocol'
import {projectReadingApi,projectsApi} from '../../../api/client'
import {useAppTranslation} from '../../../i18n'
import {formatDateTime} from '../../../i18n/format'
import {Card} from '../../../components/ui/card'
import {Button} from '../../../components/ui/button'
import {Select} from '../../../components/ui/select'
import {SpaceLink} from '../../../core/spaceNav'
import {spacePath} from '../../../core/navigation'
import {useReadingAction,useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
import {topicTitle} from '../../sources/topics/topicTitle'
import {TopicAnalysisPreview} from './TopicAnalysisPreview'
import {TopicReadingStatus} from './TopicReadingStatus'
import {TopicAnalysisReader} from './TopicAnalysisReader'
import {useAnalysisFocus} from './useAnalysisFocus'
import {EditionDateNav} from './EditionDateNav'
import {ReadingHistory} from './ReadingHistory'
import {TopicAnalysisArchive} from './TopicAnalysisArchive'
import {projectReaderHref} from '../../library/readingLinks'
export function ProjectComposition({space,project,goals}:{space:string;project:string;goals:SourceGoalDetail['goal'][]}){
 const {t}=useAppTranslation(),[params,setParams]=useSearchParams()
 const date=params.get('date')??undefined,archive=params.get('archive'),archivedBriefing=params.get('briefing')??undefined
 const version=params.get('composition')??'',selected=params.get('analysis'),reportVersion=params.get('analysisVersion')
 const focus=useAnalysisFocus(selected)
 const read=useReadingResource(`${space}:${project}:${version}:${date??'today'}`,signal=>projectReadingApi.composition(space,project,version||undefined,{signal,date}),{pollWhile:data=>!version&&!archive&&(data.rounds.some(r=>['collecting','generating'].includes(r.status))||['queued','running'].includes(data.composition_status??''))})
 const action=useReadingAction(),data=read.data,composition=data?.latest
 const capability=useReadingResource(`${space}:${project}:write`,signal=>projectsApi.get(project,{spaceId:space,signal}))
 const refresh=()=>{action.clearError();read.reload();capability.reload()}
 useEffect(()=>{if(action.denied){read.reload();capability.reload()}},[action.error])
 const compositionFailed=data?.composition_status==='failed'&&!data.rounds.some(r=>['collecting','generating','blocked','awaiting_analysis'].includes(r.status))
 const overviewParams=new URLSearchParams(params);overviewParams.delete('analysis');overviewParams.delete('analysisVersion')
 const overviewHref=`/projects/${project}/sources${overviewParams.size?`?${overviewParams}`:''}`
 const reportHref=(goal:string)=>{const next=new URLSearchParams(overviewParams);next.set('analysis',goal);next.set('analysisVersion',composition!.id);return `/projects/${project}/sources?${next}`}
 const label=(id:string)=>{const goal=goals.find(g=>g.id===id);return goal?topicTitle(goal,t('topics.untitled')):t('projectReading.theme')}
 const archiveMode=archive==='theme'
 const historical=!!version||!!archiveMode||!!date&&date!==data?.today
 const changeDate=(day:string)=>{const next=new URLSearchParams({tab:'overview',date:day});setParams(next)}
 const sections=composition?.sections??[]
 // Historical content never borrows today's rounds or today's unanalysed topics.
 const ids=!data||archiveMode?[]:historical?[...new Set([...sections.map(s=>s.goal_id),...data.rounds.map(r=>r.goal_id)])]:[...new Set([...sections.map(s=>s.goal_id),...(data?.rounds.filter(r=>goals.some(g=>g.id===r.goal_id)).map(r=>r.goal_id)??[]),...goals.filter(g=>g.status==='running').map(g=>g.id)])]
 return <section ref={focus.root} className="min-w-0" aria-label={t('projectReading.overview')}>
  <div hidden={!!selected} className="space-y-5" data-reading-overview onClickCapture={event=>{
   const link=event.target instanceof Element?event.target.closest('a'):null
   if(link&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&new URL(link.href).searchParams.has('analysis'))focus.remember(link)
  }}>
   <div className="flex flex-wrap items-center justify-between gap-2">
    <EditionDateNav date={date??data?.date??''} today={data?.today} timezone={data?.timezone} onChange={changeDate}/>
    <div className="flex flex-wrap items-center gap-2">
     {!archiveMode&&composition&&<Select size="sm" ariaLabel={t('projectReading.history')} value={version||composition.id} onChange={id=>{const next=new URLSearchParams(overviewParams);next.set('date',data!.date);if(id===data!.history[0]?.id)next.delete('composition');else next.set('composition',id);setParams(next)}} options={(data?.history??[]).map((h,index)=>({value:h.id,label:[t('projectReading.version',{version:h.day_revision}),index===0?t('projectReading.current'):null,formatDateTime(h.created_at)].filter(Boolean).join(' · ')}))}/>}
     <ReadingHistory space={space} project={project}/><Button variant="ghost" size="sm" onClick={refresh}>{t('reading.refresh')}</Button>
    </div>
   </div>
   <ReadingFeedback error={read.error} loading={read.loading} retry={refresh}/>
   {action.error!=null&&<div className="space-y-2"><p className="text-sm font-medium">{t('projectReading.retryFailed')}</p><ReadingFeedback error={action.error} retry={refresh}/></div>}
   {!archiveMode&&composition&&historical&&<p className="text-xs text-muted-foreground">{t('projectReading.historical')} · {formatDateTime(composition.created_at)}</p>}
   {!historical&&data?.composition_status&&['queued','running','failed'].includes(data.composition_status)&&<div className="space-y-2 text-xs text-muted-foreground">
    <p role="status">{t(`projectReading.compositionStatus.${data.composition_status}`)}</p>
    {compositionFailed&&!capability.loading&&!capability.error&&capability.data?.current_user_can_write===true&&<Button size="sm" variant="outline" disabled={action.busy} onClick={()=>void action.run(()=>projectReadingApi.retryComposition(space,project),refresh)}>{t(action.busy?'projectReading.retryingComposition':'projectReading.retryComposition')}</Button>}
   </div>}
   {!archiveMode&&!read.loading&&!read.error&&!composition&&!ids.length&&<Card className="space-y-3 p-5"><h2 className="font-semibold">{t(historical?'projectReading.missingEdition':goals.length?'projectReading.noComposition':'projectReading.noFollowing')}</h2><p className="text-sm text-muted-foreground">{t('projectReading.noCompositionHint')}</p><Button variant="outline" asChild><SpaceLink to={`/projects/${project}/sources?tab=following`}>{t('projectReading.following')}</SpaceLink></Button></Card>}
   {archiveMode&&archivedBriefing&&<TopicAnalysisArchive space={space} project={project} id={archivedBriefing}/>}
   {!archiveMode&&!read.loading&&!read.error&&composition&&data?.rounds.length===0&&<p className="text-xs text-muted-foreground">{t('projectReading.noChecksToday')}</p>}
   {ids.length>3&&<nav aria-label={t('projectReading.topicNavigation')} className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-xs">{ids.map(id=>{const s=sections.find(s=>s.goal_id===id);return <a key={id} href={`#theme-${id}`} className="max-w-full break-words underline underline-offset-2">{s?.visibility==='withheld'?t('projectReading.withheld'):label(id)}</a>})}</nav>}
   <div className="divide-y divide-border">{ids.map(id=>{
    const s=sections.find(s=>s.goal_id===id),briefing=s?.visibility==='visible'&&s.briefing?.visibility!=='withheld'?s.briefing:null
    const round=data?.rounds.find(r=>r.goal_id===id)
    return <article key={id} id={`theme-${id}`} data-topic-overview tabIndex={-1} className="min-w-0 space-y-4 py-6 first:pt-0">
     <header className="space-y-1"><h2 className="break-words text-base font-semibold">{s?.visibility==='withheld'?t('projectReading.withheld'):label(id)}</h2>{s&&<time dateTime={s.published_at} className="block text-xs text-muted-foreground">{t('projectReading.analysisPublished',{date:formatDateTime(s.published_at)})}</time>}</header>
     {s?.visibility==='withheld'?<p className="text-sm text-muted-foreground">{t('projectReading.withheld')}</p>:<>
      {briefing&&<TopicAnalysisPreview briefing={briefing} reportHref={spacePath(space,reportHref(id))} evidenceHref={e=>spacePath(space,projectReaderHref(project,e.source_item_id,overviewHref,e.original_snapshot_id))}/>}
      <TopicReadingStatus reportPartial={briefing?!briefing.coverage.complete:false} round={round} hasReport={!!briefing} project={project} goal={id}/>
      <div className="flex flex-wrap gap-2">{briefing&&<Button size="sm" variant="outline" asChild><SpaceLink to={reportHref(id)}>{t('projectReading.readFullAnalysis')}</SpaceLink></Button>}<Button size="sm" variant="ghost" asChild><SpaceLink to={`/projects/${project}/sources?${new URLSearchParams({tab:'materials',view:'all',topic:id})}`}>{t('projectReading.topicMaterials')}</SpaceLink></Button></div>
     </>}
    </article>
   })}</div>
  </div>
  {selected&&<TopicAnalysisReader key={`${selected}:${reportVersion}`} space={space} project={project} goal={selected} version={reportVersion??version} onDenied={read.reload} title={label(selected)} overviewHref={overviewHref} returnTo={`/projects/${project}/sources?${params}`}/>}
 </section>
}
