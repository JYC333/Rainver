import {useEffect,useMemo,useRef,useState} from 'react'
import {FileDiff} from 'lucide-react'
import type {WorkspaceChangeView} from '@rainver/protocol'
import {artifactsApi,runsApi,type RequestOptions} from '../../api/client'
import type {Artifact,Run} from '../../types/api'
import {Button} from '../../components/ui/button'
import {useAppTranslation} from '../../i18n'
import {ConversationLink as Link,useConversationScope} from './ConversationScope'
import {WorkspaceChangeList,type WorkspaceChangeEntryView} from '../runs/WorkspaceChangeList'
import {useRunWorkspaceChanges} from '../runs/useRunWorkspaceChanges'

const DIFF_ATTEMPTS=5,DIFF_DELAY_MS=700
type DiffState={state:'checking'|'no-change'|'ready'|'truncated'|'unavailable';artifact:Artifact|null}

/** The exact recorded diff of each Host Run. An unavailable upload is not proof of no changes. */
function useRunDiffs(runs:readonly Run[],scope:RequestOptions,refresh:number){
 const hostRuns=useMemo(()=>runs.filter(run=>run.host_task_thread_id||run.workspace_location_id),[runs])
 const key=hostRuns.map(run=>run.id).join(',')
 const [diffs,setDiffs]=useState<Record<string,DiffState>>({})
 useEffect(()=>{
  let cancelled=false
  const ids=key?key.split(','):[]
  setDiffs(Object.fromEntries(ids.map(id=>[id,{state:'checking',artifact:null}])))
  for(const id of ids)void (async()=>{
   for(let attempt=0;attempt<DIFF_ATTEMPTS&&!cancelled&&!scope.signal?.aborted;attempt+=1){
    try{
     const page=await runsApi.artifacts(id,{limit:'50'},scope)
     const summary=page.items.find(item=>item.artifact_type==='remote_diff')
     if(summary){
      const detail=await artifactsApi.get(summary.id,undefined,scope)
      if(cancelled||scope.signal?.aborted)return
      const changed=detail.has_inline_content||Boolean(detail.content)
      setDiffs(held=>({...held,[id]:{state:!changed?'no-change':detail.metadata_json?.truncated===true?'truncated':'ready',artifact:detail}}))
      return
     }
    }catch{/* A terminal Run may be readable before its Host artifact upload is. */}
    if(attempt<DIFF_ATTEMPTS-1)await new Promise(resolve=>window.setTimeout(resolve,DIFF_DELAY_MS))
   }
   if(!cancelled)setDiffs(held=>({...held,[id]:{state:'unavailable',artifact:null}}))
  })()
  return()=>{cancelled=true}
 },[key,refresh,scope])
 return diffs
}

type Tone='attention'|'progress'|'neutral'
/** One status phrase per batch, ordered by how much it needs a person. */
function changeStatus(c:WorkspaceChangeView,runActive:boolean):{key:string;rank:number;tone:Tone;target?:string}|null{
 // Live batch and Run facts before the recorded retention reading (see workspaceChangeLabelKey).
 if(c.state==='blocked'||c.cleanup_state==='blocked'||c.retention?.state==='blocked')return {key:'attention',rank:0,tone:'attention'}
 if(['ready','integrating'].includes(c.state))return {key:'integrating',rank:1,tone:'progress'}
 if(c.retention?.state==='missing'&&c.state==='open'&&!runActive)return {key:'missing',rank:0,tone:'attention'}
 if(c.state==='open'&&!c.source_commit)return {key:'unsaved',rank:2,tone:'progress'}
 // Nothing saved beyond its base: no private result that could contradict the target.
 if(c.state==='open'&&c.source_commit===c.base_commit)return null
 if(c.state==='open')return {key:'saved',rank:3,tone:'neutral'}
 if(c.state==='abandoned')return {key:c.retention?.reason==='discarded'?'discarded':'kept',rank:4,tone:'neutral'}
 if(c.state==='integrated'&&c.landing==='parent_unverified')return {key:'adoption_unverified',rank:5,tone:'neutral'}
 if(c.state==='integrated'&&c.landing==='parent')return {key:'adopted',rank:7,tone:'neutral'}
 if(c.state==='integrated')return {key:'merged',rank:6,tone:'neutral',target:c.target_ref?.replace(/^refs\/heads\//,'')}
 return null
}

/**
 * One default-collapsed line for a turn's workspace work: every Run of one
 * request and its explicit delegations, each batch once. Approvals, stop,
 * resume, retry and quota controls stay with their Runs. A read-only turn
 * shows nothing; a failed read says so instead of implying no changes.
 */
export function TurnWorkspaceSummary({runs,projectId,exclude,agentName,onPresented}:{runs:readonly Run[];projectId?:string|null;exclude?:ReadonlySet<string>;agentName?:(run:Run)=>string|undefined;
 /** The batches this summary is displaying right now; empty while it cannot show them. */
 onPresented?:(changeSetIds:readonly string[])=>void}){
 const {t}=useAppTranslation(),scope=useConversationScope()
 const [diffRefresh,setDiffRefresh]=useState(0)
 const workspace=useRunWorkspaceChanges(runs,scope)
 const diffs=useRunDiffs(runs,scope,diffRefresh)
 const byId=useMemo(()=>new Map(runs.map(run=>[run.id,run])),[runs])
 const multipleAgents=new Set(runs.map(run=>run.agent_id)).size>1
 const entries:WorkspaceChangeEntryView[]=workspace.entries
  .filter(e=>!exclude?.has(e.change.change_set_id)&&!(e.change.state==='no_changes'&&e.change.cleanup_state!=='blocked'))
  .map(e=>({...e,agentLabel:multipleAgents?agentName?.(byId.get(e.runId)!):undefined}))
 const diffList=runs.flatMap(run=>diffs[run.id]?{run,...diffs[run.id]!}:[])
 const recorded=diffList.filter(d=>d.state==='ready'||d.state==='truncated')
 const unavailable=diffList.filter(d=>d.state==='unavailable')
 const checking=diffList.some(d=>d.state==='checking')||workspace.enabled&&!workspace.loaded
 // Claim a batch only once it is on screen here, so the conversation's pending
 // line keeps it while this summary checks, fails to read it or is gone.
 const shownKey=checking?'':entries.map(e=>e.change.change_set_id).join(',')
 const report=useRef(onPresented);report.current=onPresented
 useEffect(()=>{report.current?.(shownKey?shownKey.split(','):[])},[shownKey])
 useEffect(()=>()=>report.current?.([]),[])
 if(checking||entries.length===0&&recorded.length===0&&unavailable.length===0&&!workspace.error)return null

 const statuses=entries.map(e=>changeStatus(e.change,Boolean(e.runActive))).filter((s):s is NonNullable<typeof s>=>s!==null).sort((a,b)=>a.rank-b.rank)
 const phrases=[...new Map(statuses.map(s=>[s.key,s])).values()].slice(0,2)
  .map(s=>t(`agent_workspaces_ui.turn_summary.status.${s.key==='merged'&&!s.target?'merged_plain':s.key}`,{target:s.target??''}))
 if(workspace.error)phrases.unshift(t('agent_workspaces_ui.turn_summary.status.read_failed'))
 if(!phrases.length)phrases.push(t(unavailable.length&&!recorded.length?'agent_workspaces_ui.turn_summary.status.diff_unavailable':'agent_workspaces_ui.turn_summary.status.recorded'))
 const tone:Tone=workspace.error||statuses[0]?.tone==='attention'?'attention':statuses[0]?.tone??'neutral'
 return <details className="w-full min-w-0 max-w-full rounded-md border border-border bg-muted/20 px-2.5 py-1.5 text-xs" data-testid="turn-workspace-summary">
  <summary className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-1.5 [&::-webkit-details-marker]:hidden">
   <FileDiff className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true"/>
   <span className="font-medium">{t('agent_workspaces_ui.turn_summary.title')}</span>
   <span className={`min-w-0 break-words ${tone==='attention'?'font-medium text-warning':'text-muted-foreground'}`} role={tone==='attention'?'status':undefined}>· {phrases.join(' · ')}</span>
   {entries.length>1&&<span className="text-muted-foreground">· {t('agent_workspaces_ui.turn_summary.batches',{count:entries.length})}</span>}
  </summary>
  <div className="mt-2 space-y-3 border-t border-border pt-2">
   {workspace.error&&<div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">{t('agent_workspaces_ui.turn_summary.read_failed_detail')}<Button size="sm" variant="outline" onClick={workspace.reload}>{t('workspace_ui.execution.refresh')}</Button></div>}
   {entries.length>0&&<WorkspaceChangeList entries={entries} onChanged={workspace.reload} showRunLink/>}
   {diffList.filter(d=>d.state!=='checking'&&d.state!=='no-change').map(d=><div key={d.run.id} className="min-w-0 space-y-1" data-testid={`changes-${d.run.id}`}>
    <p className="text-muted-foreground">{multipleAgents&&agentName?.(d.run)?`${agentName(d.run)} · `:''}{d.state==='unavailable'?t(d.run.status==='failed'?'conversation_ui.changes.unavailable_failed':'conversation_ui.changes.unavailable'):d.state==='truncated'?t('conversation_ui.changes.truncated'):t('conversation_ui.changes.recorded')}</p>
    {d.artifact?.content&&<details><summary className="cursor-pointer text-muted-foreground">{t('conversation_ui.changes.preview')}</summary><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 text-[10px]">{d.artifact.content}</pre></details>}
    <div className="flex flex-wrap gap-2">
     {d.artifact&&<Button size="sm" variant="ghost" asChild><Link to={`/artifacts/${d.artifact.id}`}>{t('conversation_ui.changes.open_exact')}</Link></Button>}
     {d.state==='unavailable'&&<Button size="sm" variant="ghost" onClick={()=>setDiffRefresh(n=>n+1)}>{t('conversation_ui.changes.check_again')}</Button>}
    </div>
   </div>)}
   {projectId&&<div className="flex flex-wrap gap-2">
    <Button size="sm" variant="ghost" asChild><Link to={`/projects/${projectId}/files`}>{t(runs.some(run=>run.contract_snapshot_json?.execution_workspace_version===1)?'workspace_ui.execution.source_files':'conversation_ui.changes.files')}</Link></Button>
    {workspace.enabled&&<Button size="sm" variant="ghost" asChild><Link to={`/projects/${projectId}/files/workspaces`}>{t('agent_workspaces_ui.open_overview')}</Link></Button>}
   </div>}
  </div>
 </details>
}
