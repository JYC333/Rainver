import {TopicCollectionProgress,activeCollectionRun} from './TopicCollectionProgress'
import type {ProjectThemeAnalysisSelection} from '@rainver/protocol'
import {ThemeConsentFields} from '../../projects/reading/ThemeConsentFields'
import {ThemeAnalysis} from '../../projects/reading/ThemeAnalysis'
import {TopicAdjustmentDialog} from './TopicAdjustmentDialog'
import {TopicDirection} from './TopicDirection'
import {TopicExecutions} from './TopicExecutions'
import {TopicCheckButton} from './TopicCheckButton'
import {topicTitle} from './topicTitle'
import {ArrowLeft,Settings2} from 'lucide-react'
import {useCallback,useEffect,useRef,useState} from 'react'
import {useSearchParams} from 'react-router-dom'
import type {SourceGoalDetail} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {Button} from '../../../components/ui/button'
import {Card} from '../../../components/ui/card'
import {SpaceLink,type useSpaceNavigate} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {sourceGoalErrorKind} from '../sourceGoalErrors'
import {readingGoalsPath} from '../sourceGoalNavigation'
import {choiceFromBudget,followRequest,type FollowChoice} from './followOptions'
import {TopicChanges} from './TopicChanges'
import {TopicFollowFields} from './TopicFollowFields'
import {TopicManage} from './TopicManage'
import {TopicStatus,TopicSources} from './TopicStatus'

const ACTIVE_RUN=['queued','running','waiting_for_review','waiting_for_dependency','cancelling']
const WORKING_PHASES=['preparing','first_collection','checking']
/** Single-column management of one Following. Material reading stays in Reading;
 * adjustments share one dialog. All writes retain their original domain actions. */
export function TopicDetail({spaceId,userId,id,navigate}:{spaceId:string;userId:string|null;id:string;navigate:ReturnType<typeof useSpaceNavigate>}){
 const {t}=useAppTranslation()
 const [params]=useSearchParams()
 const [adjustOpen,setAdjustOpen]=useState(false)
 const adjustTrigger=useRef<HTMLButtonElement>(null)
 const [detail,setDetail]=useState<SourceGoalDetail|null>(null)
 const [error,setError]=useState<unknown>(null)
 const [busy,setBusy]=useState(false)
 const lock=useRef(false);const lifetime=useRef<AbortController|null>(null);const followKey=useRef(crypto.randomUUID())
 const [analysis,setAnalysis]=useState<ProjectThemeAnalysisSelection|undefined>()
 const [choice,setChoice]=useState<FollowChoice|null>(null)
 const reload=useCallback(async()=>{try{setDetail(await sourceGoalsApi.read(id,{spaceId,signal:lifetime.current?.signal}))}catch(e){if(!lifetime.current?.signal.aborted)setDetail(null);throw e}},[id,spaceId])
 useEffect(()=>{const c=new AbortController();lifetime.current=c;void reload().catch(e=>{if(!c.signal.aborted)setError(e)});return()=>c.abort()},[reload])
 useEffect(()=>setAnalysis(undefined),[detail?.goal.current_version_id])
 const goal=detail?.goal;const state=goal?.follow_state
 const planning=!!detail&&detail.agent_runs.some(r=>ACTIVE_RUN.includes(r.status)||(['succeeded','degraded'].includes(r.status)&&r.chat_completed===false))
 const working=!!detail&&(planning||detail.previews.some(p=>p.status==='running')||(detail.native_runs??[]).some(r=>[...ACTIVE_RUN,'validating'].includes(r.phase??r.status))||WORKING_PHASES.includes(state?.phase??'')||(state?.collections?.queued??0)+(state?.collections?.running??0)>0)
 // Persisted server state is polled while background work is in flight.
 useEffect(()=>{if(!working)return;const timer=setInterval(()=>{void reload().catch(e=>setError(e))},5000);return()=>clearInterval(timer)},[working,reload])
 async function act(action:()=>Promise<unknown>){
  if(lock.current)return;lock.current=true;setBusy(true);setError(null)
  try{await action();await reload()}catch(e){
   // A refused operation does not prove the readable goal was revoked. Hide
   // cached content while checking; only a fresh authorized read restores it.
   if(e&&typeof e==='object'&&'status' in e&&[401,403,404,409].includes(Number(e.status))){setDetail(null);try{await reload()}catch{/* reload clears content on read failure */}}
   setError(e)
  }finally{lock.current=false;setBusy(false)}
 }
 const projectId=goal?.project_id??null
 const back=projectId?`/projects/${projectId}/sources`:'/library/reading'
 const canManage=!!goal&&goal.owner_user_id===userId&&detail?.can_manage!==false
 const manual=goal?.compatibility_json?.execution_mode==='manual'
 // Unfollowed topics and manual-save-only topics offer the one follow confirmation.
 const needsConfirm=!!goal&&canManage&&(state?.intent==='unconfirmed'||manual)
 const collection=detail&&canManage?activeCollectionRun(detail):undefined
 const title=goal?topicTitle(goal,t('topics.untitled')):''
 const kind=error==null?null:sourceGoalErrorKind(error)
 const confirmation=goal&&detail&&<>
     {canManage&&projectId&&userId&&goal.current_version_id&&(needsConfirm||!!state?.pending_adjustment)&&<ThemeConsentFields key={goal.current_version_id} space={spaceId} user={userId} value={analysis} onChange={setAnalysis} disabled={busy}/>}
     {needsConfirm&&<Card className="space-y-4 p-5"><div className="space-y-1"><h2 className="text-lg font-semibold">{t('topics.confirmTitle')}</h2><p className="text-sm text-muted-foreground">{t(manual?'topics.manualOnly':'topics.confirmHint')}</p></div><TopicFollowFields value={choice??choiceFromBudget(goal.budget_json)} onChange={setChoice} disabled={busy}/><Button disabled={busy||!!analysis?.enabled&&(!analysis.agent_id||!analysis.runtime_profile_id)} onClick={()=>void act(()=>sourceGoalsApi.follow(goal.id,{...followRequest(choice??choiceFromBudget(goal.budget_json),`follow:${followKey.current}`,analysis?goal.current_version_id:null),...(analysis?{theme_analysis:analysis}:{})},{spaceId}))}>{t(busy?'topics.confirming':'topics.confirm')}</Button></Card>}
     {canManage&&state?.pending_adjustment&&goal.current_version_id&&<Card role="status" className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0 space-y-2"><p className="text-sm">{t('topics.pendingAdjustment')}</p><details><summary className="cursor-pointer text-sm">{t('topics.reviewDraft')}</summary><div className="mt-3"><TopicDirection detail={detail} draft/></div></details></div><Button size="sm" disabled={busy||!!analysis?.enabled&&(!analysis.agent_id||!analysis.runtime_profile_id)} onClick={()=>void act(()=>sourceGoalsApi.follow(goal.id,{version_id:goal.current_version_id,idempotency_key:`follow:${goal.current_version_id}`, ...(analysis?{theme_analysis:analysis}:{})},{spaceId}))}>{t('topics.applyAdjustment')}</Button></Card>}
 </>
 return <div data-topic-management className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-5 p-4 md:p-6">
  <header className="space-y-3 border-b border-border pb-4">
   <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" asChild><SpaceLink to={back}><ArrowLeft className="size-4"/>{t('sourceGoals.back')}</SpaceLink></Button><Button variant="ghost" size="sm" asChild><SpaceLink to={readingGoalsPath(projectId)}>{t('sourceGoals.goals')}</SpaceLink></Button></div>
   {goal?<div className="flex flex-wrap items-center justify-between gap-3"><h1 title={title} className="min-w-0 line-clamp-2 break-words text-xl font-semibold tracking-tight">{title}</h1>{canManage&&<Button ref={adjustTrigger} size="sm" onClick={()=>setAdjustOpen(true)}>{t('topics.adjust')}</Button>}</div>:!error&&<p role="status">{t('sourceGoals.loading')}</p>}
  </header>
  {kind&&!['apiDecision','apiPathDecision'].includes(kind)&&<Card role="alert" className="space-y-2 p-4"><p>{t(`sourceGoals.${kind}`)}</p><div className="flex flex-wrap gap-2">{['errorHint','errorConflict','errorAccess','errorSetup'].includes(kind)&&<Button variant="outline" size="sm" onClick={()=>void act(reload)}>{t('sourceGoals.retry')}</Button>}{['errorCredentials','errorSetup'].includes(kind)&&<Button variant="outline" size="sm" asChild><SpaceLink to="/sources/access"><Settings2 className="size-4"/>{t('sourceGoals.credentials')}</SpaceLink></Button>}</div></Card>}
  {goal&&detail&&<>
   <Card className="mb-0 min-w-0 space-y-4 p-4">
    {state?<TopicStatus state={state} refreshing={busy} onRefresh={()=>void act(reload)} actions={canManage&&<TopicCheckButton compact key={`${spaceId}:${goal.id}:${goal.active_version_id}`} goal={goal} spaceId={spaceId} busy={busy} act={act}/>}/>:canManage&&<TopicCheckButton goal={goal} spaceId={spaceId} busy={busy} act={act}/>}
    {collection&&<TopicCollectionProgress key={`${spaceId}:${collection.id}`} run={collection} spaceId={spaceId} onReload={reload}/>}
   </Card>
   {!adjustOpen&&confirmation}
   <Card className="mb-0 min-w-0 p-4"><TopicDirection detail={detail}/></Card>
   {state&&<Card className="mb-0 min-w-0 p-4"><TopicSources state={state} bindings={detail.bindings} refreshing={busy} goalId={goal.id} spaceId={spaceId} act={act}/></Card>}
   <Card className="mb-0 min-w-0 p-4"><TopicExecutions detail={detail}/></Card>
   <Card className="mb-0 space-y-3 p-4"><h2 className="text-sm font-semibold">{t('topics.collected')}</h2><p className="text-sm text-muted-foreground">{t('topics.collectedHint')}</p><Button size="sm" variant="outline" asChild><SpaceLink to={projectId?`${back}?tab=materials&view=all&topic=${encodeURIComponent(goal.id)}`:`${back}?view=all&topic=${encodeURIComponent(goal.id)}&topic_selection=${params.get('selection')==='important'?'important':'all'}`}>{t('topics.viewArticles')}</SpaceLink></Button><details><summary className="cursor-pointer text-xs text-muted-foreground">{t('topics.changes')}</summary><div className="mt-3"><TopicChanges changes={detail.changes??[]}/></div></details></Card>
     {projectId&&userId&&<ThemeAnalysis space={spaceId} user={userId} goal={goal.id} version={goal.active_version_id} canManage={canManage}/>}
   <Card className="mb-0 p-4"><TopicManage goal={goal} spaceId={spaceId} canManage={canManage} busy={busy} act={act} onDeleted={()=>navigate(readingGoalsPath(projectId))}/></Card>
   {adjustOpen&&canManage&&<TopicAdjustmentDialog spaceId={spaceId} userId={userId} detail={detail} canManage={canManage} busy={busy} error={error} setError={setError} act={act} reload={reload} planning={planning} confirmation={confirmation} returnFocus={()=>adjustTrigger.current?.focus()} onClose={()=>setAdjustOpen(false)} onSaved={()=>{setAdjustOpen(false);void act(reload)}}/>}
  </>}
 </div>
}
