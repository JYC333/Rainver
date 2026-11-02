import {scrollBehavior} from '../../../lib/motion'
import {useEffect,useState} from 'react'
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
import {BriefingView} from '../../library/briefing/BriefingView'
import {useReadingAction,useReadingResource} from './useReadingResource'
import {ReadingFeedback} from './ReadingFeedback'
import {topicTitle} from '../../sources/topics/topicTitle'
export function projectReaderHref(project:string,item:string,back:string,version?:string|null){return `/library/items/${encodeURIComponent(item)}?${new URLSearchParams({from:'project',projectId:project,returnTo:back,...(version?{version}:{})})}`}
export function ProjectComposition({space,project,goals}:{space:string;project:string;goals:SourceGoalDetail['goal'][]}){
 const {t}=useAppTranslation();const [params,setParams]=useSearchParams();const version=params.get('composition')??'';const [opened,setOpened]=useState<string|null>(null)
 const read=useReadingResource(`${space}:${project}:${version}`,signal=>projectReadingApi.composition(space,project,version||undefined,{signal}));const action=useReadingAction();const data=read.data,composition=data?.latest
 const capability=useReadingResource(`${space}:${project}:write`,signal=>projectsApi.get(project,{spaceId:space,signal}))
 const refresh=()=>{action.clearError();read.reload();capability.reload()}
 useEffect(()=>{if(action.denied){read.reload();capability.reload()}},[action.error])
 const back=`/projects/${project}/sources${params.size?`?${params}`:''}`
 const label=(id:string)=>{const goal=goals.find(g=>g.id===id);return goal?topicTitle(goal):t('projectReading.theme')}
 return <section className="min-w-0 space-y-5" aria-label={t('projectReading.overview')}>
  <div className="flex flex-wrap items-center gap-2"><Select ariaLabel={t('projectReading.history')} value={version} onChange={id=>{const next=new URLSearchParams(params);if(id)next.set('composition',id);else next.delete('composition');setParams(next);setOpened(null)}} options={[{value:'',label:t('projectReading.current')},...(data?.history??[]).map(h=>({value:h.id,label:`${t('projectReading.version',{version:h.revision})} · ${formatDateTime(h.created_at)}`}))]}/><Button variant="ghost" size="sm" onClick={refresh}>{t('reading.refresh')}</Button></div>
  <ReadingFeedback error={read.error} loading={read.loading} retry={refresh}/>{action.error!=null&&<div className="space-y-2"><p className="text-sm font-medium">{t('projectReading.retryFailed')}</p><ReadingFeedback error={action.error} retry={refresh}/></div>}
  {!read.loading&&!composition&&!read.error&&<Card className="space-y-3 p-5"><h2 className="font-semibold">{t(goals.length?'projectReading.noComposition':'projectReading.noFollowing')}</h2><p className="text-sm text-muted-foreground">{t('projectReading.noCompositionHint')}</p><Button variant="outline" asChild><SpaceLink to={`/projects/${project}/sources?tab=following`}>{t('projectReading.following')}</SpaceLink></Button><Button size="sm" variant="ghost" asChild><SpaceLink to={`/projects/${project}/sources?tab=digest`}>{t('projectReading.legacy')}</SpaceLink></Button></Card>}
  {composition&&<><p className="text-xs text-muted-foreground">{t('projectReading.version',{version:composition.revision})} · {formatDateTime(composition.created_at)}{version&&` · ${t('projectReading.historical')}`}</p>
   <Card className="space-y-3 p-4"><h2 className="font-semibold">{t('projectReading.quickRead')}</h2><ul className="space-y-3">{composition.sections.map(s=><li key={s.goal_id}><Button variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left text-foreground" onClick={()=>{setOpened(s.goal_id);setTimeout(()=>document.getElementById(`theme-${s.goal_id}`)?.scrollIntoView({block:'start',behavior:scrollBehavior()}),0)}}><span><strong className="block">{s.visibility==='visible'?label(s.goal_id):t('projectReading.withheld')}</strong><span>{s.visibility==='visible'?s.briefing?.topic?.quick_line:t('projectReading.withheld')}</span></span></Button></li>)}</ul>{!composition.sections.length&&<p>{t('projectReading.noComposition')}</p>}</Card>
   {composition.sections.map(s=><Card key={`${composition.id}:${s.goal_id}`} className="space-y-3 p-4" id={`theme-${s.goal_id}`}><details open={opened===s.goal_id} onToggle={e=>{if(e.currentTarget.open)setOpened(s.goal_id);else if(opened===s.goal_id)setOpened(null)}}><summary className="cursor-pointer space-y-2 text-sm"><span className="block font-semibold">{s.visibility==='visible'?label(s.goal_id):t('projectReading.withheld')}</span><time className="block text-xs text-muted-foreground">{formatDateTime(s.published_at)}</time><span className="block leading-relaxed">{s.visibility==='visible'?s.briefing?.topic?.summary:t('projectReading.withheld')}</span></summary>
    {s.visibility==='visible'&&s.briefing&&<div className="mt-4 space-y-4"><div className="space-y-1 text-sm"><p className="text-xs text-muted-foreground">{t('projectReading.frozenPurpose')}</p>{s.purpose_text&&<p className="whitespace-pre-wrap break-words">{s.purpose_text}</p>}</div><BriefingView briefing={s.briefing} evidenceHref={e=>spacePath(space,projectReaderHref(project,e.source_item_id,back,e.original_snapshot_id))}/><p className="text-sm text-muted-foreground">{s.briefing.topic?.stop_reason}</p></div>}
   </details></Card>)}
  </>}
  {!!data?.rounds.length&&<Card className="space-y-2 p-4"><h2 className="text-sm font-semibold">{t('projectReading.latestChecks')}</h2>{data.rounds.map(r=><p key={r.id} className="text-sm">{label(r.goal_id)} · {t(`projectReading.status.${r.status}`,{defaultValue:r.status})}{r.coverage.complete===false&&` · ${t('projectReading.partial')}`}{r.error_code&&` · ${t('projectReading.notUpdated')}`}</p>)}<p className="text-xs text-muted-foreground">{t('projectReading.preserveTimes')}</p>{!version&&!capability.loading&&!capability.error&&capability.data?.current_user_can_write===true&&<Button size="sm" variant="outline" disabled={action.busy} onClick={()=>void action.run(()=>projectReadingApi.retryComposition(space,project),refresh)}>{t('projectReading.retryComposition')}</Button>}</Card>}
 </section>
}
