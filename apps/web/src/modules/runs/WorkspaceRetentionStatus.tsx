import {useRef,useState} from 'react'
import type {WorkspaceChangeView} from '@rainver/protocol'
import {callOperation} from '../../api/client'
import {Button} from '../../components/ui/button'
import {useConversationScope} from '../conversation/ConversationScope'
import {useAppTranslation} from '../../i18n'
import {formatDateTime} from '../../i18n/format'
import {errMsg} from '../../lib/utils'

type Action='reclaim_now'|'hold'|'release_hold'|'retry'|'acknowledge_missing'
const NO_EXPIRY=new Set(['retained','missing'])

/** One workspace generation's retention: state, reason, time and safe controls. */
/** Ref counts are technical recovery facts; list surfaces show them in their own technical details. */
export function WorkspaceRetentionStatus({change,onChanged,showRefCounts=true}:{change:WorkspaceChangeView;onChanged:()=>void;showRefCounts?:boolean}){
 const {t}=useAppTranslation(),scope=useConversationScope()
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[confirming,setConfirming]=useState(false)
 const command=useRef<{fingerprint:string;key:string}|null>(null)
 const r=change.retention
 if(!r)return null
 const time=formatDateTime(r.state==='reclaimed'?r.reclaimed_at:r.state==='held'?r.hold_until:r.reclaim_after,{fallback:''})
 const reason=t(`workspace_ui.execution.retention.reason.${r.reason}`,{defaultValue:r.reason})
 const blocked=change.cleanup_state==='blocked'
 const actions:Action[]=change.can_manage?[
  ...(['grace','held','reclaimable'].includes(r.state)?['reclaim_now' as const]:[]),
  ...(['grace','reclaimable','active'].includes(r.state)?['hold' as const]:[]),
  ...(r.state==='held'?['release_hold' as const]:[]),
  ...(blocked?['retry' as const]:[]),
  ...(r.state==='missing'&&r.reason==='branch_missing'?['acknowledge_missing' as const]:[]),
 ]:[]
 async function run(action:Action){
  setBusy(true);setError(null)
  try{
   const fingerprint=JSON.stringify([change.workspace_id,action,r?.assessed_at])
   if(command.current?.fingerprint!==fingerprint)command.current={fingerprint,key:crypto.randomUUID()}
   const outcome=await callOperation('workspace.retention.update',{change_set_id:change.change_set_id,action,...(action==='hold'?{hold_days:7}:{})},command.current.key,scope)
   if(scope.signal?.aborted)return
   if('error' in outcome)throw new Error(outcome.error.message)
   command.current=null;setConfirming(false);onChanged()
  }catch(e){if(!scope.signal?.aborted)setError(errMsg(e))}
  finally{if(!scope.signal?.aborted)setBusy(false)}
 }
 return <div className="min-w-0 space-y-1" data-testid={`workspace-retention-${change.workspace_id}`}>
  <p role="status" className="break-words text-xs text-muted-foreground">
   {t(r.state==='reclaimed'&&r.reason==='discarded'?'workspace_ui.execution.retention.state.discarded':r.state==='missing'&&r.reason==='missing_acknowledged'?'workspace_ui.execution.missing_closed':`workspace_ui.execution.retention.state.${r.state}`,{time})}
   {!['reclaimed','reclaiming'].includes(r.state)&&<> · {t('workspace_ui.execution.retention.because',{reason})}</>}
  </p>
  {NO_EXPIRY.has(r.state)&&<p className="text-xs text-muted-foreground">{t('workspace_ui.execution.retention.no_expiry')}</p>}
  {showRefCounts&&r.retained_refs>0&&<p className="text-xs text-muted-foreground">{t('workspace_ui.execution.retention.refs',{count:r.retained_refs})}</p>}
  {showRefCounts&&r.unclaimed_refs>0&&<p className="text-xs text-muted-foreground">{t('workspace_ui.execution.retention.unclaimed',{count:r.unclaimed_refs})}</p>}
  {error&&<p role="alert" className="break-words text-xs text-destructive">{error}</p>}
  {confirming&&<p role="status" className="break-words text-xs text-muted-foreground">{t('workspace_ui.execution.retention.acknowledge_missing_description')}</p>}
  {actions.length>0&&<div className="flex flex-wrap gap-2">{confirming
   ?<><Button size="sm" variant="outline" disabled={busy} onClick={()=>void run('acknowledge_missing')}>{t('workspace_ui.execution.retention.acknowledge_missing_confirm')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirming(false)}>{t('workspace_ui.execution.cancel')}</Button></>
   :actions.map(action=><Button key={action} size="sm" variant={action==='reclaim_now'||action==='acknowledge_missing'?'outline':'ghost'} disabled={busy} onClick={()=>action==='acknowledge_missing'?setConfirming(true):void run(action)}>{t(`workspace_ui.execution.retention.${action}`)}</Button>)}</div>}
 </div>
}
