import {useEffect,useRef,useState} from 'react'
import {queryOperation,roomsApi,agentsApi} from '../../api/client'
import {Button} from '../../components/ui/button'
import {useConversationScope} from '../conversation/ConversationScope'
import {useAppTranslation} from '../../i18n'
import {errMsg} from '../../lib/utils'

/** Explicitly ask the original Agent in its visible conversation. The ordinary
 * conversation Run owns repair, verification, publication and its final reply. */
export function WorkspaceVerificationAction({integrationId,changeSetId,onRetried}:{integrationId?:string;changeSetId?:string;onRetried?:()=>void}){
 const {t}=useAppTranslation(),scope=useConversationScope(),[busy,setBusy]=useState(false),[sent,setSent]=useState<'queued'|'working'|'done'|null>(null),[error,setError]=useState<string|null>(null)
 const generation=useRef(0),command=useRef<{conversation:string;room:string|null;agent:string;message:string;key:string}|null>(null)
 useEffect(()=>{++generation.current;setBusy(false);setSent(null);setError(null);command.current=null;return()=>{++generation.current}},[integrationId,changeSetId,scope])
 async function retry(){
  const current=generation.current,valid=()=>current===generation.current&&!scope.signal?.aborted
  setBusy(true);setError(null)
  try{
   if(!command.current){
    const read=changeSetId?await queryOperation('workspace.change.get',{change_set_id:changeSetId},scope):await queryOperation('workspace.integration.verification.get',{integration_id:integrationId!},scope)
    if(!valid())return
    if('error' in read)throw new Error(read.error.message)
    if(read.status!=='succeeded')throw new Error(t('workspace_ui.execution.approval_pending'))
    if(!read.data.can_retry){
     if(['queued','rebasing','resolving','verifying','waiting_local_changes'].includes(read.data.integration_status??'')){setSent('working');return}
     if(['merged','no_changes'].includes(read.data.integration_status??'')){setSent('done');return}
     throw new Error(t('workspace_ui.execution.agent_verify_unavailable'))
    }
    if(!read.data.conversation_id||!read.data.agent_id)throw new Error(t('workspace_ui.execution.agent_verify_unavailable'))
    command.current={conversation:read.data.conversation_id,room:read.data.room_id??null,agent:read.data.agent_id,key:crypto.randomUUID(),message:t('workspace_ui.execution.agent_verify_request',{folder:read.data.folder_name,commit:read.data.source_commit?.slice(0,8)??''})}
   }
   const pending=command.current,options={...scope,idempotencyKey:pending.key}
   const accepted=()=>{if(valid()){command.current=null;setSent('queued');onRetried?.()}}
   if(pending.room){await roomsApi.sendMessage(pending.room,pending.conversation,{content:pending.message,routing_mode:'direct',recipient_segments:[{recipient_agent_ids:[pending.agent],content:pending.message}],queue:true,backends:[]},options);accepted()}
   else await agentsApi.chat(pending.agent,{message:pending.message,session_id:pending.conversation},{...options,onAccepted:accepted})
  }catch(e){if(valid())setError(errMsg(e))}
  finally{if(valid())setBusy(false)}
 }
 return <div className="min-w-0 space-y-2">
  <Button size="sm" variant="outline" disabled={busy||sent!==null} onClick={()=>void retry()}>{t(`workspace_ui.execution.${busy?'agent_verify_busy':'agent_verify'}`)}</Button>
  {sent&&<p role="status" className="text-xs text-muted-foreground">{t(`workspace_ui.execution.agent_verify_${sent}`)}</p>}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </div>
}
