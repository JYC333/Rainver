import {RefreshCw} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {SourceGoalSafeTextSchema,type SourceGoalDetail} from '@rainver/protocol'
import type {ChatActionPreview,RunTurn} from '../../types/api'
import {runsApi,sourceGoalsApi} from '../../api/client'
import {AgentExecutionPicker,type AgentExecutionSelection} from '../../components/agents/AgentExecutionPicker'
import {Button} from '../../components/ui/button'
import {SpaceLink} from '../../core/spaceNav'
import {useAppTranslation} from '../../i18n'
import {ActionPreviewCards} from '../conversation/ActionPreviewCard'
import {ConversationView} from '../conversation/ConversationView'
import {useConversationDraft} from '../conversation/useConversationDraft'
import {SourceGoalPreviewResult} from './SourceGoalPreviewResult'
import {sourceGoalErrorKind} from './sourceGoalErrors'

const ACTIVE_RUN=['queued','running','waiting_for_review','waiting_for_dependency','cancelling']
/** The topic's plan with its Agent: adjustment conversation, plan details, an
 * optional trial sample and optional manual save. None of it is required to
 * follow; collection progress lives in the topic status, not in this chat. */
export function SourceGoalWorkbench({spaceId,userId,detail,canManage,busy,error,setError,act,reload}:{spaceId:string;userId:string|null;detail:SourceGoalDetail;canManage:boolean;busy:boolean;error:unknown;setError:(e:unknown)=>void;act:(action:()=>Promise<unknown>)=>Promise<void>;reload:()=>Promise<void>}){
 const {t}=useAppTranslation();const text=(k:string)=>t(`sourceGoals.${k}`)
 const goal=detail.goal;const id=goal.id
 const requestKey=useRef<string>(crypto.randomUUID())
 const [turn,setTurn]=useState<RunTurn|null>(null)
 const [streamDisconnected,setStreamDisconnected]=useState(false)
 const [previewing,setPreviewing]=useState(false)
 const [searchPath,setSearchPath]=useState<'agent'|'api'>(()=>goal.compatibility_json?.search_path==='api'?'api':goal.compatibility_json?.search_path==='agent'?'agent':detail.versions[0]?.plan_json.sources.some(s=>s.implementation.kind==='agent_search')===false?'api':'agent')
 const [execution,setExecution]=useState<AgentExecutionSelection>({agent_id:'',runtime_profile_id:''})
 const [nativeAvailable,setNativeAvailable]=useState(false)
 const unbound=!goal.agent_id
 const chosenProfile=execution.runtime_profile_id||(typeof goal.runtime_profile_id==='string'?goal.runtime_profile_id:undefined)
 useEffect(()=>{setNativeAvailable(false);if(!chosenProfile)return;const c=new AbortController();void sourceGoalsApi.nativeAvailability(chosenProfile,{spaceId,signal:c.signal}).then(v=>{if(!c.signal.aborted)setNativeAvailable(v.supported)}).catch(()=>{});return()=>c.abort()},[chosenProfile,spaceId])
 const draft=useConversationDraft({isTextPersistable:value=>SourceGoalSafeTextSchema.safeParse(value).success,destination:`source-goal:${spaceId}:${id}:${goal.project_id??''}`,initialValue:()=>'',textOf:x=>x,withText:(_x:string,v:string)=>v,sessionId:goal.session_id})
 // Keep the canonical stream until chat_completed, not merely Run success.
 const active=detail.agent_runs.find(r=>ACTIVE_RUN.includes(r.status)||(['succeeded','degraded'].includes(r.status)&&r.chat_completed===false))
 useEffect(()=>{const pending=(detail.messages??[]).filter(m=>m.role==='user'&&!m.run_id&&m.metadata_json?.source_goal_message_key&&m.metadata_json.source_goal_dispatch_pending===true).slice(-1)[0];if(pending&&!draft.value){requestKey.current=String(pending.metadata_json!.source_goal_message_key);draft.setValue(pending.content)}},[detail.messages])
 useEffect(()=>{const last=(detail.messages??[]).filter(m=>m.role==='user').slice(-1)[0];if(last&&!last.run_id&&last.metadata_json?.source_goal_dispatch_failed)setError({code:last.metadata_json.source_goal_dispatch_error??'source_goal_dispatch_failed'})},[detail.messages])
 useEffect(()=>{if(!active)return;const c=new AbortController();setStreamDisconnected(false);void runsApi.streamTurn(active.id,{spaceId,signal:c.signal,onTurn:next=>{if(!c.signal.aborted)setTurn(next)}}).then(()=>reload()).catch(()=>{if(!c.signal.aborted){setStreamDisconnected(true);void reload().catch(e=>{if(!c.signal.aborted)setError(e)})}});return()=>c.abort()},[active?.id,spaceId,reload])
 async function send(){const value=draft.value.trim();if(!value||(unbound&&(!execution.agent_id||!execution.runtime_profile_id)))return;if(!SourceGoalSafeTextSchema.safeParse(value).success){setError({status:422,code:'source_goal_use_credential_channel'});return}if(searchPath==='agent'&&!nativeAvailable){setError({status:409,code:'source_goal_execution_setup_required'});return}
  await act(async()=>{await sourceGoalsApi.message(id,value,requestKey.current,{spaceId},{...(execution.agent_id&&execution.runtime_profile_id?execution:{}),search_path:searchPath});draft.setValue('');requestKey.current=crypto.randomUUID()})}
 const version=detail.versions.find(v=>v.id===goal.current_version_id);const versionPreviews=detail.previews.filter(p=>p.version_id===version?.id);const latestPreview=versionPreviews[0];const preview=latestPreview?.status==='ready'&&Date.parse(latestPreview.expires_at)>Date.now()?latestPreview:undefined;const previewExhausted=versionPreviews.length>=3
 const previewInFlight=detail.previews.some(p=>p.version_id===goal.current_version_id&&p.status==='running'&&Date.parse(p.expires_at)>Date.now())
 const progress=goal.execution?<div role="status" aria-live="polite" className="flex items-start gap-2 text-sm text-muted-foreground"><div className="space-y-1"><p>{goal.execution.phase==='working'&&goal.execution.last_action?text('executionAction.'+goal.execution.last_action):text('executionPhase.'+goal.execution.phase)}</p>{streamDisconnected&&active&&<p>{text('progressDisconnected')}</p>}{goal.execution.failure_reason&&<p>{text('executionFailure.'+goal.execution.failure_reason)}</p>}{goal.execution.block_reason&&<p>{text('executionBlock.'+goal.execution.block_reason)}</p>}</div><Button size="icon" variant="ghost" aria-label={text('refreshProgress')} title={text('refreshProgress')} onClick={()=>void act(reload)}><RefreshCw className="size-3.5"/></Button></div>:null
 const approvalCards=<ActionPreviewCards continueAfterDecision={false} previews={detail.action_previews??[]} viewerUserId={userId} onDecision={canManage?async()=>{await reload()}:undefined}/>
 const entries=(detail.messages??[]).filter(m=>m.role==='user'||m.role==='assistant').map(m=>({id:m.id,role:m.role as 'user'|'assistant',content:m.content,runId:m.run_id??undefined,turn:undefined as RunTurn|null|undefined,extra:<ActionPreviewCards continueAfterDecision={false} previews={detail.action_previews!==undefined&&m.run_id===detail.agent_runs[0]?.id?[]:Array.isArray(m.metadata_json?.action_previews)?m.metadata_json.action_previews as ChatActionPreview[]:[]} viewerUserId={userId} onDecision={canManage?async()=>{await reload()}:undefined}/>}))
 if(active&&!entries.some(e=>e.role==='assistant'&&e.runId===active.id))entries.push({id:`run:${active.id}`,role:'assistant',content:'',runId:active.id,extra:<>{progress}{approvalCards}</>,turn:turn?.run_id===active.id?turn:null})
 else if(progress||detail.action_previews?.length){const last=[...entries].reverse().find(e=>e.role==='assistant'&&e.runId===detail.agent_runs[0]?.id);if(last)last.extra=<>{progress}{approvalCards}</>;else entries.push({id:'planning-status',role:'assistant',content:'',runId:undefined,turn:undefined,extra:<>{progress}{approvalCards}</>})}
 if(error!=null&&['apiDecision','apiPathDecision'].includes(sourceGoalErrorKind(error)))entries.push({id:'api-question',role:'assistant',content:text(sourceGoalErrorKind(error)),runId:undefined,turn:undefined,extra:<></>})
 const composerBlocked=(unbound&&(!execution.agent_id||!execution.runtime_profile_id))||!canManage||busy||!!active||sourceGoalErrorKind(error)==='errorStopped'
 const nativeRun=detail.native_runs?.[0]
 return <div className="space-y-5">
  {canManage&&<div className="space-y-2" role="group" aria-label={text('searchPath')}><p className="text-sm font-medium">{text('searchPath')}</p><div className="flex flex-wrap gap-2">{(['agent','api'] as const).map(p=><Button key={p} size="sm" aria-pressed={searchPath===p} variant={searchPath===p?'default':'outline'} onClick={()=>{setSearchPath(p);requestKey.current=crypto.randomUUID()}}>{text(p==='agent'?'agentPath':'apiPath')}</Button>)}</div><p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{text(searchPath==='agent'?(nativeAvailable?'nativeSupported':'nativeSearchUsage'):'apiSearchUsage')}</p></div>}
  {unbound&&<AgentExecutionPicker spaceId={spaceId} userId={userId??''} value={execution} onChange={v=>{setExecution(v);requestKey.current=crypto.randomUUID()}} disabled={busy}/>}
  {typeof goal.agent_id==='string'&&typeof goal.runtime_profile_id==='string'&&<details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{text('executionSettings')}</summary><div className="mt-3"><AgentExecutionPicker className="rounded-none border-0 p-0" spaceId={spaceId} userId={userId??''} value={{...execution,agent_id:goal.agent_id,runtime_profile_id:goal.runtime_profile_id}} onChange={v=>{setExecution(v);requestKey.current=crypto.randomUUID()}} sessionId={goal.session_id} profileLocked disabled={!canManage||busy||!!active}/></div></details>}
  <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
   <section aria-label={text('conversation')} className="h-[60dvh] min-w-0"><ConversationView inputAttachmentsEnabled={false} entries={entries} sending={busy||!!active} loadingHistory={false} input={draft.value} onInputChange={value=>{if(value!==draft.value)requestKey.current=crypto.randomUUID();draft.setValue(value)}} onSend={()=>void send()} placeholder={text('placeholder')} emptyTitle={text('adjust')} emptyDescription={text('examples')} composerDisabled={composerBlocked} composerNote={text('noSecrets')+' '+t('sourceGoals.cycleAgreement',{count:goal.budget_json.agent_attempts??2})} projectId={goal.project_id}/></section>
   <div className="min-w-0 space-y-5">
    <section aria-labelledby="topic-plan" className="space-y-3"><h3 id="topic-plan" className="font-semibold">{text('plan')}</h3>
     <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">{text('collectionLimits')}</summary><p className="mt-2 leading-relaxed">{version?.plan_json.sources.some(s=>s.implementation.kind==='agent_search')?t('sourceGoals.nativeAgreement',{hours:Math.round((version.plan_json.interval_seconds??goal.budget_json.interval_seconds)/3600)}):<>{text('agreement')} {Math.round((version?.plan_json.interval_seconds??goal.budget_json.interval_seconds)/3600)} {text('hours')}; {goal.budget_json.requests_per_run} {text('requests')}</>}</p></details>
     {goal.compatibility_json?.scheduler_owner==='legacy'&&<p role="status" className="text-sm">{text('legacy')}</p>}
     <p className="whitespace-pre-wrap text-sm">{version?.plan_json.summary??text(active?'exploring':'noPlan')}</p>
     <details><summary className="cursor-pointer text-sm">{text('originalRequest')}</summary><p className="whitespace-pre-wrap text-sm text-muted-foreground">{String(goal.compatibility_json?.conversation_base_intent??goal.intent_json.intent)}</p></details>
     {detail.legacy&&<details><summary className="cursor-pointer text-sm">{detail.legacy.name} · {detail.legacy.channel_name}</summary><SpaceLink className="text-sm underline" to={`/sources/${detail.legacy.source_connection_id}`}>{text('sourceSettings')}</SpaceLink></details>}
     {version?.plan_json.sources.map(s=><details key={s.source_channel_id}><summary className="cursor-pointer text-sm">{s.reason}</summary><SpaceLink className="text-sm underline" to={`/sources/${s.source_connection_id}`}>{text('sourceSettings')}</SpaceLink></details>)}
     {version?.plan_json.filters&&<p className="text-sm">{text('includes')}: {version.plan_json.filters.includes.join(', ')||'—'}; {text('excludes')}: {[...version.plan_json.filters.excludes,...version.plan_json.filters.excluded_origins].join(', ')||'—'}</p>}
     {version?.plan_json.limitations.map((s,n)=><p key={n} className="text-sm text-muted-foreground">{s}</p>)}
    </section>
    {version&&<section aria-labelledby="topic-trial" className="space-y-3"><h3 id="topic-trial" className="font-semibold">{text('preview')}</h3><p className="text-xs text-muted-foreground">{text('previewNeeded')}</p>
     <SourceGoalPreviewResult preview={latestPreview} pending={previewing||previewInFlight} sources={version.plan_json.sources}/>
     <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={!canManage||busy||!!active||goal.status==='paused'&&goal.compatibility_json?.execution_mode!=='manual'||previewExhausted||previewInFlight} onClick={()=>{setPreviewing(true);void act(()=>sourceGoalsApi.action(id,'preview',{version_id:version.id},{spaceId})).finally(()=>setPreviewing(false))}}>{text(previewing||previewInFlight?'previewTrying':'try')}</Button>
      {version.plan_json.sources.every(s=>s.implementation.kind==='agent_search')&&goal.follow_state?.intent!=='following'&&<Button variant="outline" disabled={!canManage||busy||!!active||!preview} onClick={()=>void act(()=>sourceGoalsApi.action(id,'save',{version_id:version.id,preview_id:preview!.id,idempotency_key:`manual:${version.id}:${preview!.id}`},{spaceId}))}>{text('saveReading')}</Button>}
     </div>
     {versionPreviews.length>0&&<p className="text-xs text-muted-foreground">{t('sourceGoals.previewAttempts',{count:versionPreviews.length})}</p>}
     {previewExhausted&&<><p role="status" className="text-sm">{text('previewExhausted')}</p><Button variant="outline" disabled={!canManage||busy||!!active} onClick={()=>{requestKey.current=crypto.randomUUID();draft.setValue(text('previewAdjustPrompt'))}}>{text('previewAdjust')}</Button></>}
     <div className="flex flex-wrap gap-2">{['tooBroad','excludeSite','moreFocus'].map(k=><Button key={k} size="sm" variant="ghost" disabled={!canManage||busy||!!active} onClick={()=>{requestKey.current=crypto.randomUUID();draft.setValue(text(k+'Prompt'))}}>{text(k)}</Button>)}</div>
    </section>}
    {canManage&&nativeRun&&<SpaceLink className="text-sm underline" to={'/runs/'+nativeRun.id}>{t('topics.runDetails')}</SpaceLink>}
   </div>
  </div>
 </div>
}
