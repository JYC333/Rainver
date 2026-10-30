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
import {SourceGoalWorkbench} from '../SourceGoalWorkbench'
import {sourceGoalErrorKind} from '../sourceGoalErrors'
import {readingGoalsPath} from '../sourceGoalNavigation'
import {choiceFromBudget,followRequest,type FollowChoice} from './followOptions'
import {TopicChanges} from './TopicChanges'
import {TopicFollowFields} from './TopicFollowFields'
import {TopicManage} from './TopicManage'
import {TopicStatus} from './TopicStatus'
import {TopicUpdates} from './TopicUpdates'

const ACTIVE_RUN=['queued','running','waiting_for_review','waiting_for_dependency','cancelling']
const WORKING_PHASES=['preparing','first_collection','checking']
/** A followed topic: its update stream first, then status, changes and
 * management. Planning conversation, trial sample and Agent choice are
 * secondary (Advanced). Leaving or refreshing never stops following. */
export function TopicDetail({spaceId,userId,id,navigate}:{spaceId:string;userId:string|null;id:string;navigate:ReturnType<typeof useSpaceNavigate>}){
 const {t}=useAppTranslation()
 const [params,setParams]=useSearchParams()
 const selection=params.get('selection')==='all'?'all':'important'
 const [detail,setDetail]=useState<SourceGoalDetail|null>(null)
 const [error,setError]=useState<unknown>(null)
 const [busy,setBusy]=useState(false)
 const [updatesVersion,setUpdatesVersion]=useState(0)
 const lock=useRef(false);const lifetime=useRef<AbortController|null>(null);const followKey=useRef(crypto.randomUUID())
 const [choice,setChoice]=useState<FollowChoice|null>(null)
 const reload=useCallback(async()=>{try{setDetail(await sourceGoalsApi.read(id,{spaceId,signal:lifetime.current?.signal}))}catch(e){if(!lifetime.current?.signal.aborted)setDetail(null);throw e}},[id,spaceId])
 useEffect(()=>{const c=new AbortController();lifetime.current=c;void reload().catch(e=>{if(!c.signal.aborted)setError(e)});return()=>c.abort()},[reload])
 const goal=detail?.goal;const state=goal?.follow_state
 const working=!!detail&&(detail.agent_runs.some(r=>ACTIVE_RUN.includes(r.status)||(['succeeded','degraded'].includes(r.status)&&r.chat_completed===false))||detail.previews.some(p=>p.status==='running'&&Date.parse(p.expires_at)>Date.now())||(detail.native_runs??[]).some(r=>[...ACTIVE_RUN,'validating'].includes(r.phase??r.status))||WORKING_PHASES.includes(state?.phase??'')||(state?.collections?.queued??0)+(state?.collections?.running??0)>0)
 // Persisted server state is polled while background work is in flight.
 useEffect(()=>{if(!working)return;const timer=setInterval(()=>{void reload().then(()=>setUpdatesVersion(n=>n+1)).catch(e=>setError(e))},5000);return()=>clearInterval(timer)},[working,reload])
 async function act(action:()=>Promise<unknown>){if(lock.current)return;lock.current=true;setBusy(true);setError(null);try{await action();await reload();setUpdatesVersion(n=>n+1)}catch(e){if(e&&typeof e==='object'&&'status' in e&&[403,404].includes(Number(e.status)))setDetail(null);setError(e)}finally{lock.current=false;setBusy(false)}}
 const projectId=goal?.project_id??null
 const back=projectId?`/projects/${projectId}/sources`:'/library/reading'
 const canManage=!!goal&&goal.owner_user_id===userId&&detail?.can_manage!==false
 const manual=goal?.compatibility_json?.execution_mode==='manual'
 // Unfollowed topics and manual-save-only topics offer the one follow confirmation.
 const needsConfirm=!!goal&&canManage&&(state?.intent==='unconfirmed'||manual)
 const title=goal?topicTitle(goal):''
 const kind=error==null?null:sourceGoalErrorKind(error)
 return <div className="flex min-w-0 flex-col gap-5 p-4 md:p-6">
  <header className="space-y-3 border-b border-border pb-4">
   <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" asChild><SpaceLink to={back}><ArrowLeft className="size-4"/>{t('sourceGoals.back')}</SpaceLink></Button><Button variant="ghost" size="sm" asChild><SpaceLink to={readingGoalsPath(projectId)}>{t('sourceGoals.goals')}</SpaceLink></Button></div>
   {goal?<h1 title={title} className="line-clamp-2 break-words text-xl font-semibold tracking-tight">{title}</h1>:!error&&<p role="status">{t('sourceGoals.loading')}</p>}
  </header>
  {kind&&!['apiDecision','apiPathDecision'].includes(kind)&&<Card role="alert" className="space-y-2 p-4"><p>{t(`sourceGoals.${kind}`)}</p><div className="flex flex-wrap gap-2">{['errorHint','errorConflict','errorAccess','errorSetup'].includes(kind)&&<Button variant="outline" size="sm" onClick={()=>void act(reload)}>{t('sourceGoals.retry')}</Button>}{['errorCredentials','errorSetup','errorAccess'].includes(kind)&&<Button variant="outline" size="sm" asChild><SpaceLink to="/sources/access"><Settings2 className="size-4"/>{t('sourceGoals.credentials')}</SpaceLink></Button>}</div></Card>}
  {goal&&detail&&<>
   <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
    <div className="min-w-0 space-y-5">
     {needsConfirm&&<Card className="space-y-4 p-5"><div className="space-y-1"><h2 className="text-lg font-semibold">{t('topics.confirmTitle')}</h2><p className="text-sm text-muted-foreground">{t(manual?'topics.manualOnly':'topics.confirmHint')}</p></div><TopicFollowFields value={choice??choiceFromBudget(goal.budget_json)} onChange={setChoice} disabled={busy}/><Button disabled={busy} onClick={()=>void act(()=>sourceGoalsApi.follow(goal.id,followRequest(choice??choiceFromBudget(goal.budget_json),`follow:${followKey.current}`),{spaceId}))}>{t(busy?'topics.confirming':'topics.confirm')}</Button></Card>}
     {canManage&&state?.pending_adjustment&&goal.current_version_id&&<Card role="status" className="flex flex-wrap items-center justify-between gap-3 p-4"><p className="text-sm">{t('topics.pendingAdjustment')}</p><Button size="sm" disabled={busy} onClick={()=>void act(()=>sourceGoalsApi.follow(goal.id,{version_id:goal.current_version_id,idempotency_key:`follow:${goal.current_version_id}`},{spaceId}))}>{t('topics.applyAdjustment')}</Button></Card>}
     <TopicUpdates revision={updatesVersion} spaceId={spaceId} projectId={projectId} goalId={goal.id} state={state} selection={selection} onSelection={v=>{const next=new URLSearchParams(params);if(v==='all')next.set('selection','all');else next.delete('selection');setParams(next,{replace:true})}} canManage={canManage} onFeedback={()=>void reload().catch(e=>setError(e))}/>
    </div>
    <aside className="min-w-0 space-y-5 rounded-lg border border-border bg-card p-4">
     {state&&<TopicStatus state={state} bindings={detail.bindings} refreshing={busy} onRefresh={()=>void act(reload)} goalId={goal.id} spaceId={spaceId} act={act}/>}
     <TopicChanges changes={detail.changes??[]}/>
     <TopicManage goal={goal} spaceId={spaceId} canManage={canManage} busy={busy} act={act} onDeleted={()=>navigate(readingGoalsPath(projectId))}/>
    </aside>
   </div>
   <details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer font-medium">{t('topics.advancedDetail')}</summary><div className="mt-4"><SourceGoalWorkbench spaceId={spaceId} userId={userId} detail={detail} canManage={canManage} busy={busy} error={error} setError={setError} act={act} reload={reload}/></div></details>
  </>}
 </div>
}
