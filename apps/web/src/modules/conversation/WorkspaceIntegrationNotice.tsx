import {WorkspaceVerificationAction} from '../runs/WorkspaceVerificationAction'
import {useState} from 'react'
import {WorkspaceIntegrationNoticeSchema,type WorkspaceIntegrationNotice as Notice,type WorkspaceChangeView} from '@rainver/protocol'
import type {RoomMessage} from '../../types/api'
import {useRun} from '../../hooks/useRun'
import i18n,{useAppTranslation} from '../../i18n'
import {Button} from '../../components/ui/button'
import {ConversationLink,useConversationScope} from './ConversationScope'

export function isWorkspaceIntegrationNotice(message:RoomMessage){
 return message.role==='system'&&message.metadata_json?.room_display==='system_notice'&&message.metadata_json.execution_event==='workspace_integration'
}

function legacyDetails(change:WorkspaceChangeView,runId:string,repairStatus:string|undefined):Notice|null{
 const outcome=change.integration_status==='merged'?'integrated':change.integration_status;
 if(!['integrated','no_changes','conflict','verification_failed','failed'].includes(outcome??''))return null;
 const error=change.integration_detail?.error;
 const reason=typeof error==='string'&&i18n.exists(`workspace_ui.execution.reason.${error}`)?error:null;
 const verification=change.integration_detail?.verification as {level?:string;status?:string;checks?:Array<{status?:string}>}|undefined;
 const raw=verification?.checks??change.integration_detail?.checks,checks=Array.isArray(raw)?raw as Array<{status?:string}>:[];
 const parsed=WorkspaceIntegrationNoticeSchema.safeParse({schema_version:'workspace_integration_notice.v1',run_id:runId,
  integration_id:change.integration_id,attempt_id:change.attempt_id,change_set_id:change.change_set_id,target_ref:change.target_ref,
  outcome,reason,repair_status:!change.resolution_run_id?'not_needed':repairStatus==='succeeded'?'succeeded':repairStatus==='waiting_for_review'?'waiting_for_review':repairStatus&&['failed','cancelled','degraded','orphaned'].includes(repairStatus)?'failed':'unknown',
  verification_status:outcome==='integrated'||verification?.status==='passed'?'passed':reason==='verification_unconfigured'?'unconfigured':reason==='integration_verification_failed'?'failed':'not_run',
  ...(verification?.level==='basic'?{verification_level:'basic' as const}:{}),
  checks_passed:checks.filter(c=>c?.status==='passed').length,checks_failed:checks.filter(c=>c?.status==='failed'||c?.status==='error').length,
  candidate_ready:Boolean(change.candidate_commit),preserved:!['integrated','no_changes'].includes(outcome!),
 });
 return parsed.success?parsed.data:null;
}

/** One flat system-message body; old notices enrich only the same attempt
 * through authorized Run reads. No new polling or command channel. */
export function WorkspaceIntegrationNotice({message}:{message:RoomMessage}){
 const {t}=useAppTranslation(),scope=useConversationScope(),[reload,setReload]=useState(0);
 const metadata=message.metadata_json?.room_display==='system_notice'?message.metadata_json:null;
 const raw=metadata?.execution_details;
 const parsed=WorkspaceIntegrationNoticeSchema.safeParse(raw),stored=parsed.success?parsed.data:null;
 const originId=raw&&typeof raw.run_id==='string'?raw.run_id:null;
 const {run,error,loading}=useRun(stored?null:originId,reload,scope.spaceId);
 const sameRun=run&&run.id===originId&&(!scope.spaceId||run.space_id===scope.spaceId)?run:null;
 const change=sameRun?.workspace_changes?.find(c=>c.integration_id===raw?.integration_id&&typeof metadata?.execution_event_key==='string'
  &&metadata.execution_event_key.startsWith(`${c.integration_id}:${c.attempt_id}:`));
 const {run:repair}=useRun(change?.resolution_run_id??null,0,scope.spaceId);
 const details=stored??(change&&originId?legacyDetails(change,originId,repair&&repair.id===change.resolution_run_id?repair.status:undefined):null);
 const target=details?.target_ref.replace(/^refs\/heads\//,'')??'';
 const next=details?.verification_status==='unconfigured'?'configure':details?.verification_status==='failed'?'fix_checks'
  :details?.outcome==='repair_started'?'wait':details?.reason==='integration_requires_semantic_decision'?'resolve':'inspect';
 return <div className="min-w-0 space-y-2 text-sm text-foreground" data-testid={`integration-notice-${message.id}`}>
  <p className="font-medium">{t(`conversation_ui.integration.outcome_${details?.outcome??'unavailable'}`,{target})}</p>
  {details?<>
   {details.repair_status==='succeeded'&&<p>{t('conversation_ui.integration.repair_done')}</p>}
   {details.repair_status==='failed'&&<p>{t('conversation_ui.integration.repair_failed')}</p>}
   {details.candidate_ready&&details.outcome!=='integrated'&&<p>{t('conversation_ui.integration.candidate_ready')}</p>}
   {details.outcome!=='no_changes'&&<p>{t(`conversation_ui.integration.verification_${details.verification_status==='passed'&&details.verification_level==='basic'?'passed_basic':details.verification_status}`,{passed:details.checks_passed,failed:details.checks_failed})}</p>}
   {details.reason&&details.verification_status!=='unconfigured'&&<p>{t(`workspace_ui.execution.reason.${details.reason}`,{defaultValue:t('conversation_ui.integration.unknown_reason')})}</p>}
   {details.preserved&&details.outcome!=='repair_started'&&<p className="text-muted-foreground">{t('conversation_ui.integration.preserved')}</p>}
   {!['integrated','no_changes'].includes(details.outcome)&&<p>{t(`conversation_ui.integration.next_${next}`)}</p>}
  </>:<p>{t(`conversation_ui.integration.${loading?'loading':error?'read_failed':'historical'}`)}</p>}
  <div className="flex flex-wrap gap-2">
   {details?.integration_id&&(details.verification_status==='unconfigured'||['verification_failed','conflict'].includes(details.outcome))&&<WorkspaceVerificationAction integrationId={details.integration_id}/>}
   {(details?.run_id??originId)&&<Button asChild size="sm" variant="outline"><ConversationLink to={`/runs/${details?.run_id??originId}`}>{t('workspace_ui.execution.details')}</ConversationLink></Button>}
   {!stored&&<Button size="sm" variant="ghost" onClick={()=>setReload(n=>n+1)} disabled={loading}>{t('workspace_ui.execution.refresh')}</Button>}
  </div>
 </div>
}
