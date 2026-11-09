import {WorkspaceVerificationAction} from './WorkspaceVerificationAction'
import {WorkspaceRetentionStatus} from './WorkspaceRetentionStatus'
import {Fragment,useContext,useEffect,useRef,useState} from 'react'
import type {WorkspaceChangeView} from '@rainver/protocol'
import {callOperation} from '../../api/client'
import {Button} from '../../components/ui/button'
import {Badge} from '../../components/ui/badge'
import {Textarea} from '../../components/ui/textarea'
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '../../components/ui/dialog'
import {SpaceLink} from '../../core/spaceNav'
import {useConversationScope} from '../conversation/ConversationScope'
import {useAppTranslation} from '../../i18n'
import {errMsg} from '../../lib/utils'
import {ConversationRunControls,PresentedRunDecisions} from '../conversation/ConversationRunControls'

/** One batch and the Run it is read through: commands recheck that Run's authority. */
export type WorkspaceChangeEntryView={change:WorkspaceChangeView;runId:string;runSucceeded:boolean;agentLabel?:string}

export const TERMINAL_CHANGE_STATES=['integrated','no_changes','abandoned']

/** The visible state label of a batch, including where an integrated batch landed. */
export function workspaceChangeLabelKey(c:WorkspaceChangeView){
 if(c.state==='open'&&!c.source_commit)return 'workspace_ui.execution.unsaved'
 if(c.state==='integrating'&&c.integration_detail?.reconcile_only===true)return 'workspace_ui.execution.reconciling'
 if(c.state==='integrated'&&c.landing==='parent')return 'agent_workspaces_ui.landing.parent'
 if(c.state==='integrated'&&c.landing==='parent_unverified')return 'agent_workspaces_ui.landing.parent_unverified'
 return `workspace_ui.execution.state.${c.state}`
}

/**
 * Batch rows with their existing safe commands. Presentation only: every
 * command goes through Operation Core with the batch's current revision, and a
 * row never claims a merge the server has not recorded.
 */
export function WorkspaceChangeList({entries,onChanged,showRunLink=false}:{entries:WorkspaceChangeEntryView[];onChanged:()=>void;showRunLink?:boolean}){
 const {t}=useAppTranslation(),scope=useConversationScope()
 const presentedDecisions=useContext(PresentedRunDecisions)
 const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
 const [dialog,setDialog]=useState<{entry:WorkspaceChangeEntryView;action:'complete'|'abandon'|'resolve'}|null>(null),[text,setText]=useState('')
 const [reconcileNotice,setReconcileNotice]=useState<string|null>(null)
 const reconciliation=useRef<{id:string;revision:number}|null>(null)
 const command=useRef<{fingerprint:string;key:string}|null>(null)
 const generation=useRef(0)
 useEffect(()=>()=>{generation.current+=1},[])
 useEffect(()=>{
  const checking=reconciliation.current
  if(!checking)return
  const checked=entries.find(e=>e.change.change_set_id===checking.id)?.change
  if(!checked||Number(checked.integration_revision??0)<=checking.revision||['ready','integrating'].includes(checked.state))return
  setReconcileNotice(t(['integrated','no_changes'].includes(checked.state)?'workspace_ui.execution.reconcile_done':'workspace_ui.execution.reconcile_unmatched'))
  reconciliation.current=null
 },[entries,t])
 async function execute(entry:WorkspaceChangeEntryView,action:'complete'|'abandon'|'retry'|'resolve'|'reconcile',value=''){
  const change=entry.change,current=generation.current;setBusy(true);setError(null)
  try{
   const fingerprint=JSON.stringify([entry.runId,change.change_set_id,change.revision,change.integration_revision,action,value]);
   if(command.current?.fingerprint!==fingerprint)command.current={fingerprint,key:crypto.randomUUID()};
   const key=command.current.key;
   const outcome=(action==='retry'||action==='resolve'||action==='reconcile')&&change.integration_id
    ?await callOperation('workspace.integration.retry',{integration_id:change.integration_id,expected_revision:change.integration_revision!,...(action==='resolve'?{resolution:value}:action==='reconcile'?{reconcile_only:true}:{})},key,scope)
    :action==='abandon'?await callOperation('workspace.change.abandon',{change_set_id:change.change_set_id,expected_revision:change.revision,reason:value},key,scope)
    :await callOperation('workspace.change.complete',{change_set_id:change.change_set_id,expected_revision:change.revision,summary:value},key,scope)
   if(generation.current!==current||scope.signal?.aborted)return
   if('error' in outcome)throw new Error(outcome.error.message)
   if(outcome.status==='pending_approval'){setError(t('workspace_ui.execution.approval_pending'));return;}
   if(action==='reconcile'){reconciliation.current={id:change.change_set_id,revision:change.integration_revision??0};setReconcileNotice(t('workspace_ui.execution.reconcile_checking'))}
   command.current=null;setDialog(null);onChanged()
  }catch(e){if(generation.current===current&&!scope.signal?.aborted)setError(errMsg(e))}
  finally{if(generation.current===current&&!scope.signal?.aborted)setBusy(false)}
 }
 const changes=entries.map(e=>e.change)
 return <div className="min-w-0 space-y-3">
  {reconcileNotice&&<p role="status" className="break-words text-xs text-muted-foreground">{reconcileNotice}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
  {new Set(changes.map(c=>c.workspace_location_id)).size>1&&<p className="text-xs text-muted-foreground">{t('workspace_ui.execution.multi_repository')}</p>}
  {entries.map((entry,index)=>{
   const c=entry.change
   // Retention belongs to the workspace generation: show it once, on its newest batch.
   const firstOfWorkspace=changes.findIndex(other=>other.workspace_id===c.workspace_id&&other.generation===c.generation)===index
   const checkpointBlocked=c.integration_detail?.checkpoint_blocked===true||c.workspace_state==='blocked'
   const conflictPaths=c.integration_detail?.conflicted_files
   const canResolve=c.integration_status==='conflict'&&Array.isArray(conflictPaths)&&conflictPaths.length>0&&conflictPaths.every(path=>typeof path==='string')
   const saved=c.source_commit!==null,terminal=TERMINAL_CHANGE_STATES.includes(c.state)
   const message=checkpointBlocked?'workspace_checkpoint_blocked':typeof c.integration_detail?.error==='string'?c.integration_detail.error:c.integration_status==='waiting_local_changes'?'integration_waiting_local_changes':null
   const target=c.target_ref&&!c.parent_workspace_id?c.target_ref.replace(/^refs\/heads\//,''):null
   const freeBytes=typeof c.inventory?.free_bytes==='number'?c.inventory.free_bytes:null
   const technical=Boolean(c.base_commit||c.target_ref||freeBytes!==null||(firstOfWorkspace&&c.retention&&(c.retention.retained_refs>0||c.retention.unclaimed_refs>0)))
   return <Fragment key={c.change_set_id}><div className="min-w-0 space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0" data-testid={`workspace-change-${c.change_set_id}`}>
    <div className="flex flex-wrap items-center gap-2">
     {entry.agentLabel&&<span className="text-xs font-medium text-muted-foreground">{entry.agentLabel}</span>}
     <Badge variant={c.state==='blocked'?'warning':'default'}>{t(workspaceChangeLabelKey(c))}</Badge>
     {!saved&&!checkpointBlocked&&!terminal&&<span className="text-xs text-muted-foreground">{t('workspace_ui.execution.checkpoint_pending')}</span>}
     {target&&<span className="min-w-0 break-all text-xs text-muted-foreground">{t('workspace_ui.execution.target',{target})}</span>}
    </div>
    {c.summary&&<p className="break-words text-sm">{c.summary}</p>}
    {typeof c.integration_detail?.continuation_from_workspace_id==='string'&&<p role="status" className="text-xs text-muted-foreground">{t('workspace_ui.execution.continued')}</p>}
    {message&&<p role="status" className="break-words text-xs text-muted-foreground">{t('workspace_ui.execution.blocked_detail',{reason:t(`workspace_ui.execution.reason.${message}`,{defaultValue:message})})}</p>}
    {c.integration_status==='conflict'&&Array.isArray(c.integration_detail?.conflicted_files)&&<ul className="break-words pl-4 text-xs text-muted-foreground">{c.integration_detail.conflicted_files.filter((path):path is string=>typeof path==='string').slice(0,50).map(path=><li key={path}>{path}</li>)}</ul>}
    {(terminal||c.cleanup_state==='blocked')&&!(firstOfWorkspace&&c.retention?.state==='reclaimed')&&<p className="text-xs text-muted-foreground">{t(c.integration_detail?.pending_checkpoint_retained===true?'workspace_ui.execution.retained_pending_checkpoint':`workspace_ui.execution.cleanup.${c.cleanup_state}`)}</p>}
    {(Number(c.inventory?.quarantined_whole??0)>0||Number(c.inventory?.retained_quarantine??0)>0)&&<p className="text-xs text-muted-foreground">{t('workspace_ui.execution.retained_evidence',{whole:Number(c.inventory?.quarantined_whole??0),captured:Number(c.inventory?.retained_quarantine??0)})}</p>}
    {c.cleanup_errors.map((e,i)=><p key={i} className="break-words text-xs text-muted-foreground">{e}</p>)}
    {firstOfWorkspace&&<WorkspaceRetentionStatus change={c} onChanged={onChanged} showRefCounts={false}/>}
    {technical&&<details className="text-xs text-muted-foreground">
     <summary className="cursor-pointer">{t('agent_workspaces_ui.technical')}</summary>
     <div className="mt-1 space-y-1 break-all font-mono">
      {c.base_commit&&<p>{t(c.baseline_mode==='snapshot'?'workspace_ui.execution.snapshot_base':'workspace_ui.execution.committed_base',{commit:c.base_commit.slice(0,8)})}</p>}
      {c.target_ref&&<p>{t('workspace_ui.execution.target',{target:c.target_ref})}</p>}
      {freeBytes!==null&&<p>{t('workspace_ui.execution.disk_available',{gb:(freeBytes/1024**3).toFixed(1)})}</p>}
      {firstOfWorkspace&&c.retention&&c.retention.retained_refs>0&&<p>{t('workspace_ui.execution.retention.refs',{count:c.retention.retained_refs})}</p>}
      {firstOfWorkspace&&c.retention&&c.retention.unclaimed_refs>0&&<p>{t('workspace_ui.execution.retention.unclaimed',{count:c.retention.unclaimed_refs})}</p>}
     </div>
    </details>}
    <div className="flex flex-wrap gap-2 empty:hidden">
     {c.can_manage&&c.state==='blocked'&&c.integration_id&&!checkpointBlocked&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void execute(entry,'reconcile')}>{t('workspace_ui.execution.reconcile')}</Button>}
     {c.can_manage&&c.native_integration&&!checkpointBlocked&&['open','blocked'].includes(c.state)&&<WorkspaceVerificationAction changeSetId={c.change_set_id} onRetried={onChanged}/>}
     {c.can_manage&&!c.native_integration&&saved&&(c.state==='open'||c.state==='blocked'&&!c.integration_id)&&entry.runSucceeded&&<Button size="sm" variant="outline" disabled={busy||checkpointBlocked} onClick={()=>{setText(c.summary??t('workspace_ui.execution.default_summary'));setDialog({entry,action:'complete'})}}>{t('workspace_ui.execution.complete')}</Button>}
     {c.can_manage&&!c.native_integration&&c.integration_id&&(c.integration_detail?.error==='verification_unconfigured'||['verification_failed','conflict'].includes(c.integration_status??''))&&<WorkspaceVerificationAction integrationId={c.integration_id} onRetried={onChanged}/>}
     {c.can_manage&&!c.native_integration&&c.state==='blocked'&&c.integration_id&&(c.integration_detail?.error==='verification_unconfigured'||c.integration_status==='verification_failed'?null:canResolve?<Button size="sm" variant="outline" disabled={busy||checkpointBlocked} onClick={()=>{setText('');setDialog({entry,action:'resolve'})}}>{t('workspace_ui.execution.resolve')}</Button>:<Button size="sm" variant="outline" disabled={busy||checkpointBlocked} onClick={()=>void execute(entry,'retry')}>{t('workspace_ui.execution.retry')}</Button>)}
     {c.can_manage&&['open','ready','blocked'].includes(c.state)&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{setText('');setDialog({entry,action:'abandon'})}}>{t('workspace_ui.execution.abandon')}</Button>}
     {showRunLink&&entries.findIndex(other=>other.runId===entry.runId)===index&&<Button size="sm" variant="ghost" asChild><SpaceLink to={`/runs/${entry.runId}`}>{t('workspace_ui.execution.details')}</SpaceLink></Button>}
    </div>
   </div>{c.resolution_run_id&&!presentedDecisions.has(c.resolution_run_id)&&c.integration_status==='resolving'&&<div className="min-w-0 space-y-2 border-t border-border pt-3"><p className="text-sm font-medium">{t('workspace_ui.execution.repair_task')}</p><ConversationRunControls runId={c.resolution_run_id} reviewOnly onChanged={onChanged} /></div>}</Fragment>
  })}
  <Dialog open={dialog!==null} onOpenChange={open=>{if(!open&&!busy)setDialog(null)}}><DialogContent className="w-[calc(100%_-_2rem)] max-h-[90dvh] overflow-y-auto">
   <DialogHeader><DialogTitle>{t(dialog?.action==='resolve'?'workspace_ui.execution.resolve':dialog?.action==='abandon'?'workspace_ui.execution.abandon':'workspace_ui.execution.complete')}</DialogTitle><DialogDescription>{t(dialog?.action==='resolve'?'workspace_ui.execution.resolve_description':dialog?.action==='abandon'?'workspace_ui.execution.abandon_description':'workspace_ui.execution.complete_description')}</DialogDescription></DialogHeader>
   {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
   {dialog?.action==='resolve'&&Array.isArray(dialog.entry.change.integration_detail?.conflicted_files)&&<ul className="max-h-32 overflow-y-auto break-words pl-4 text-xs text-muted-foreground">{dialog.entry.change.integration_detail.conflicted_files.filter((path):path is string=>typeof path==='string').map(path=><li key={path}>{path}</li>)}</ul>}
   <Textarea aria-label={t(dialog?.action==='resolve'?'workspace_ui.execution.resolution':'workspace_ui.execution.summary')} value={text} onChange={e=>setText(e.target.value)} maxLength={dialog?.action==='complete'?16000:4000}/>
   <DialogFooter className="flex-wrap"><Button variant="ghost" disabled={busy} onClick={()=>setDialog(null)}>{t('workspace_ui.execution.cancel')}</Button><Button disabled={busy||!text.trim()} onClick={()=>dialog&&void execute(dialog.entry,dialog.action,text.trim())}>{t('workspace_ui.execution.confirm')}</Button></DialogFooter>
  </DialogContent></Dialog>
 </div>
}
