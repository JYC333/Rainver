import {ArrowLeft} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {SourceGoalSafeTextSchema} from '@rainver/protocol'
import {sourceGoalsApi} from '../../../api/client'
import {AgentExecutionPicker,type AgentExecutionSelection} from '../../../components/agents/AgentExecutionPicker'
import {Button} from '../../../components/ui/button'
import {Card} from '../../../components/ui/card'
import {Textarea} from '../../../components/ui/textarea'
import {SpaceLink,type useSpaceNavigate} from '../../../core/spaceNav'
import {useAppTranslation} from '../../../i18n'
import {sourceGoalErrorKind} from '../sourceGoalErrors'
import {readingGoalPath,readingGoalsPath} from '../sourceGoalNavigation'
import {DEFAULT_FOLLOW,followLimits,followRequest,type FollowChoice} from './followOptions'
import {TopicFollowFields} from './TopicFollowFields'

/** What the owner confirmed, kept only to finish or recover that same
 * confirmation: never the topic text (it may be sensitive). */
type Confirmed={key:string;choice:FollowChoice;search_path:'agent'|'api';execution:AgentExecutionSelection;legacy_goal_id?:string}
/** One confirmation of topic, frequency and effort creates the topic and starts
 * following in one server transaction (`begin` with `follow`); preparation and
 * the first collection run in the background. The default Agent configuration
 * is the server's; an explicit Agent/Profile and its model/mode choices are
 * bound before the first planning Run. Typing or opening the page writes
 * nothing. A lost response is recovered by looking the creation up by its key;
 * if nothing was committed the form keeps the confirmed choices and the same
 * key, so a late commit and a resubmission cannot create two topics. */
export function TopicCreate({spaceId,userId,projectId,legacyChannel,navigate}:{spaceId:string;userId:string;projectId:string|null;legacyChannel:string|null;navigate:ReturnType<typeof useSpaceNavigate>}){
 const {t}=useAppTranslation()
 const storage=`source-topic-create:${spaceId}:${projectId??''}:${legacyChannel??''}`
 const stored=useRef<Confirmed|null>(readConfirmed(storage))
 const key=useRef<string>(stored.current?.key??crypto.randomUUID())
 const [text,setText]=useState('')
 const [choice,setChoice]=useState<FollowChoice>(stored.current?.choice??DEFAULT_FOLLOW)
 const [advanced,setAdvanced]=useState(!!stored.current?.execution.agent_id)
 const [searchPath,setSearchPath]=useState<'agent'|'api'>(stored.current?.search_path??'agent')
 const [execution,setExecution]=useState<AgentExecutionSelection>(stored.current?.execution??{agent_id:'',runtime_profile_id:''})
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState<unknown>(null)
 const [resolving,setResolving]=useState(!!legacyChannel||!!stored.current)
 const [recovered,setRecovered]=useState(false)
 const open=(goalSpace:string,goalId:string)=>{sessionStorage.removeItem(storage);navigate(`/spaces/${goalSpace}${readingGoalPath(projectId,goalId)}`,{replace:true})}
 // Finish a confirmation interrupted before its response arrived. Only what
 // the server shows was committed is continued; nothing new is authorized.
 const recover=async(pending:Confirmed,signal?:AbortSignal):Promise<boolean>=>{
  if(legacyChannel){
   const mapped=await sourceGoalsApi.findLegacy(legacyChannel,{spaceId,signal});if(!mapped.goal_id)return false
   const detail=await sourceGoalsApi.read(mapped.goal_id,{spaceId,signal})
   const sent=(detail.messages??[]).some(m=>m.role==='user'&&m.metadata_json?.source_goal_message_key===pending.key)
   if(!sent)return false
   await sourceGoalsApi.follow(mapped.goal_id,followRequest(pending.choice,`follow:${pending.key}`),{spaceId,signal});open(spaceId,mapped.goal_id);return true
  }
  const found=await sourceGoalsApi.findCreation(pending.key,projectId,{spaceId,signal});if(!found.goal_id)return false
  open(found.space_id??spaceId,found.goal_id);return true
 }
 useEffect(()=>{const c=new AbortController();const pending=stored.current
  void (async()=>{
   if(pending&&await recover(pending,c.signal))return
   if(c.signal.aborted)return
   if(pending)setRecovered(true)
   // A legacy Source that already has a topic opens it instead of creating another.
   else if(legacyChannel){const r=await sourceGoalsApi.findLegacy(legacyChannel,{spaceId,signal:c.signal});if(c.signal.aborted)return;if(r.goal_id){navigate(readingGoalPath(projectId,r.goal_id),{replace:true});return}}
   setResolving(false)
  })().catch(e=>{if(!c.signal.aborted){setError(e);setResolving(false)}})
  return()=>c.abort()},[])
 const chosen=execution.agent_id&&execution.runtime_profile_id?execution:null
 async function confirm(){
  const intent=text.trim();if(busy||resolving||intent.length<3)return
  if(!SourceGoalSafeTextSchema.safeParse(intent).success){setError({status:422,code:'source_goal_use_credential_channel'});return}
  const pending:Confirmed={...(stored.current??{}),key:key.current,choice,search_path:searchPath,execution:chosen??{agent_id:'',runtime_profile_id:''}}
  stored.current=pending;sessionStorage.setItem(storage,JSON.stringify(pending))
  setBusy(true);setError(null)
  const agent=chosen?{agent_id:chosen.agent_id,runtime_profile_id:chosen.runtime_profile_id,...(chosen.session_config?{session_config:chosen.session_config}:{})}:{}
  try{
   if(legacyChannel){
    const goalId=pending.legacy_goal_id??(await sourceGoalsApi.legacy(legacyChannel,{spaceId})).goal.id
    stored.current={...pending,legacy_goal_id:goalId};sessionStorage.setItem(storage,JSON.stringify(stored.current))
    // The described topic becomes the mapped goal's intent through its first message.
    await sourceGoalsApi.message(goalId,intent,pending.key,{spaceId},{search_path:searchPath,...agent})
    await sourceGoalsApi.follow(goalId,followRequest(choice,`follow:${pending.key}`),{spaceId})
    open(spaceId,goalId)
   }else{
    const goal=await sourceGoalsApi.begin({intent,project_id:projectId,idempotency_key:pending.key,search_path:searchPath,...agent,follow:followLimits(choice)},{spaceId})
    open(goal.space_id,goal.id)
   }
  }catch(e){
   // The request may have committed before its response was lost.
   if(!legacyChannel&&await recover(pending).catch(()=>false))return
   setError(e);if(sourceGoalErrorKind(e)==='errorSetup'||sourceGoalErrorKind(e).startsWith('native'))setAdvanced(true)
  }finally{setBusy(false)}
 }
 const kind=error==null?null:sourceGoalErrorKind(error)
 return <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 p-4 md:p-6">
  <header className="space-y-3"><Button variant="ghost" size="sm" asChild><SpaceLink to={readingGoalsPath(projectId)}><ArrowLeft className="size-4"/>{t('sourceGoals.goals')}</SpaceLink></Button><div className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">{t('topics.createTitle')}</h1><p className="text-sm text-muted-foreground">{t('topics.createHint')}</p></div></header>
  <Card className="space-y-5 p-5">
   <form className="space-y-5" onSubmit={e=>{e.preventDefault();void confirm()}}>
    <div className="space-y-1.5"><label htmlFor="topic-intent" className="text-sm font-medium">{t('topics.topic')}</label><Textarea id="topic-intent" rows={4} maxLength={8000} value={text} disabled={busy} onChange={e=>setText(e.target.value)} placeholder={t('topics.topicPlaceholder')}/><p className="text-xs text-muted-foreground">{t('sourceGoals.noSecrets')}</p></div>
    <TopicFollowFields value={choice} onChange={setChoice} disabled={busy}/>
    <details className="rounded-lg border border-border p-3" open={advanced} onToggle={e=>setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
     <summary className="cursor-pointer text-sm font-medium">{t('topics.advanced')}</summary>
     <div className="mt-3 space-y-3">
      <p className="text-xs text-muted-foreground">{t('topics.advancedHint')}</p>
      <div className="space-y-2" role="group" aria-label={t('sourceGoals.searchPath')}><p className="text-sm font-medium">{t('sourceGoals.searchPath')}</p><div className="flex flex-wrap gap-2">{(['agent','api'] as const).map(p=><Button key={p} type="button" size="sm" aria-pressed={searchPath===p} variant={searchPath===p?'default':'outline'} disabled={busy} onClick={()=>setSearchPath(p)}>{t(p==='agent'?'sourceGoals.agentPath':'sourceGoals.apiPath')}</Button>)}</div><p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{t(searchPath==='agent'?'sourceGoals.nativeSearchUsage':'sourceGoals.apiSearchUsage')}</p></div>
      <AgentExecutionPicker className="p-3" spaceId={spaceId} userId={userId} value={execution} onChange={setExecution} disabled={busy}/>
     </div>
    </details>
    {recovered&&!kind&&<p role="status" className="rounded-lg border border-border p-3 text-sm">{t('topics.recoverNotice')}</p>}
    {kind&&<div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-3 text-sm"><p>{t(`sourceGoals.${kind}`)}</p>{kind==='errorCredentials'&&<Button variant="outline" size="sm" asChild><SpaceLink to="/sources/access">{t('sourceGoals.credentials')}</SpaceLink></Button>}</div>}
    <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={busy||resolving||text.trim().length<3}>{t(busy?'topics.confirming':'topics.confirm')}</Button><p className="text-xs text-muted-foreground">{t('topics.confirmNote')}</p></div>
   </form>
  </Card>
 </div>
}
function readConfirmed(storage:string):Confirmed|null{
 try{const v=JSON.parse(sessionStorage.getItem(storage)??'null');return v&&typeof v.key==='string'&&v.choice?v:null}catch{return null}
}
