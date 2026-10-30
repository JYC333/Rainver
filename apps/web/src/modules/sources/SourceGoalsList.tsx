import {topicTitle} from './topics/topicTitle'
import {ArrowLeft} from 'lucide-react'
import {SourceGoalDeleteButton} from './SourceGoalDeleteButton'
import {Badge} from '../../components/ui/badge'
import {useParams} from 'react-router-dom'
import {readingGoalPath} from './sourceGoalNavigation'
import {lifecycleAction} from './topics/followOptions'
import {useEffect,useState} from 'react'
import type {SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi,sourcesApi} from '../../api/client'
import {useSpace} from '../../contexts/SpaceContext'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {formatDateTime} from '../../i18n/format'
import {Button} from '../../components/ui/button'
import {Card} from '../../components/ui/card'
import {healthLabel,phaseLabel} from './topics/attention'
type Goal=SourceGoalDetail['goal']
/** Topics in this personal or Project scope with their server follow state;
 * pause/resume/delete use the canonical goal actions. */
export default function SourceGoalsList({projectId:providedProjectId}:{projectId?:string}){
 const {projectId:routeProjectId}=useParams();const projectId=providedProjectId??routeProjectId;
 const back=projectId?`/projects/${projectId}/sources`:'/library/reading';
 const {activeSpaceId,userId}=useSpace();const {t}=useAppTranslation();const [goals,setGoals]=useState<Goal[]|null>(null);const [error,setError]=useState<unknown>(null);const [busy,setBusy]=useState(false);const [attempt,setAttempt]=useState(0);
 useEffect(()=>{if(!activeSpaceId)return;const c=new AbortController();setError(null);void sourceGoalsApi.list({spaceId:activeSpaceId,signal:c.signal}).then(p=>{if(!c.signal.aborted)setGoals(p.goals.filter(g=>g.status!=='deleted'&&g.space_id===activeSpaceId&&(projectId?g.project_id===projectId:!g.project_id)))}).catch(e=>{if(!c.signal.aborted){setGoals(null);setError(e)}});return()=>c.abort()},[activeSpaceId,projectId,attempt]);
 async function run(action:()=>Promise<unknown>){if(busy)return;setBusy(true);setError(null);try{await action();setAttempt(n=>n+1)}catch(e){setError(e)}finally{setBusy(false)}}
 const legacy=()=>run(async()=>{const channels=await sourcesApi.channels({}, {spaceId:activeSpaceId!});for(const c of channels.filter(c=>c.source_owner_user_id===userId&&c.status!=='archived'&&(projectId?c.project_id===projectId:!c.project_id)))await sourceGoalsApi.legacy(c.id,{spaceId:activeSpaceId!})})
 return <div className="flex min-w-0 flex-col gap-4 p-4 md:p-6"><header className="space-y-3"><Button variant="ghost" size="sm" asChild><SpaceLink to={back}><ArrowLeft className="size-4"/>{t('sourceGoals.back')}</SpaceLink></Button><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t('sourceGoals.goals')}</h1><Button asChild><SpaceLink to={readingGoalPath(projectId,'new')}>{t('topics.createTitle')}</SpaceLink></Button></div></header>
  {error!=null&&<div role="alert" className="space-y-2"><p>{t('sourceGoals.errorHint')}</p><Button variant="outline" onClick={()=>setAttempt(n=>n+1)}>{t('sourceGoals.retry')}</Button></div>}
  {!goals&&!error&&<p role="status">{t('sourceGoals.loading')}</p>}
  <ul className="space-y-3">{goals?.map(g=><li key={g.id}><TopicRow goal={g} spaceId={activeSpaceId!} manageable={g.owner_user_id===userId} busy={busy} run={run} onDeleted={()=>setGoals(rows=>rows?.filter(row=>row.id!==g.id)??null)}/></li>)}</ul>
  {goals?.length===0&&<p className="text-sm text-muted-foreground">{t('sourceGoals.beforeSend')}</p>}
  <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={()=>void legacy()}>{t('sourceGoals.importExisting')}</Button></div></div>
}
function TopicRow({goal:g,spaceId,manageable,busy,run,onDeleted}:{goal:Goal;spaceId:string;manageable:boolean;busy:boolean;run:(a:()=>Promise<unknown>)=>Promise<void>;onDeleted:()=>void}){
 const {t}=useAppTranslation();const s=g.follow_state
 const manual=g.compatibility_json?.execution_mode==='manual';const legacyActive=g.compatibility_json?.scheduler_owner==='legacy'
 const lifecycle=manageable?lifecycleAction(g):null
 return <Card className="mb-0 flex flex-wrap items-start justify-between gap-3 p-4"><div className="min-w-0 flex-1 space-y-2">
  <SpaceLink className="line-clamp-2 break-words font-medium hover:text-primary" to={readingGoalPath(g.project_id,g.id)}>{topicTitle(g)}</SpaceLink>
  <div className="flex flex-wrap gap-2">{s&&<Badge variant={s.phase==='scheduled'?'success':s.phase==='blocked'?'destructive':s.phase==='stopped'||s.phase==='none'?'muted':'warning'}>{phaseLabel(s,t)}</Badge>}{s&&s.intent!=='paused'&&s.health!=='ok'&&s.health!=='unknown'&&<Badge variant={s.health==='failing'?'destructive':'warning'}>{healthLabel(s,t)}</Badge>}{manual&&<Badge variant="outline">{t('topics.manualOnly')}</Badge>}</div>
  {s&&<p className="text-xs text-muted-foreground">{t('topics.counts',{important:s.results.important_total,total:s.results.items_total,changes:s.results.changes_total})}{s.results.last_checked_at&&<> · {t('topics.lastChecked')}: {formatDateTime(s.results.last_checked_at)}</>}{s.intent==='following'&&s.results.next_check_at&&<> · {t('topics.nextCheck')}: {formatDateTime(s.results.next_check_at)}</>}</p>}
  {legacyActive&&<p className="text-sm text-muted-foreground">{t('sourceGoals.legacy')}</p>}
 </div><div className="flex flex-wrap gap-2">
  <Button size="sm" variant="outline" asChild><SpaceLink to={readingGoalPath(g.project_id,g.id)}>{t('topics.openTopic')}</SpaceLink></Button>
  {lifecycle&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(()=>sourceGoalsApi.action(g.id,lifecycle,{version_id:g.active_version_id},{spaceId}))}>{t(`sourceGoals.${lifecycle}`)}</Button>}
  {manageable&&<SourceGoalDeleteButton goalId={g.id} spaceId={spaceId} disabled={busy} onDeleted={onDeleted}/>}
 </div></Card>
}
