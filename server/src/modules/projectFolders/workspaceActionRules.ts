import {workspaceRecoveryBlocker} from './workspaceRecoveryDiagnostics.js';
import {assessWorkspaceDiscards,discardRecovery,type CleanupPublication,type DiscardAssessment} from './workspaceDiscard.js';
import {closedWorkspaceState,cleanupPublicationStatus} from './workspacePublicationState.js';
import {allPendingCheckpointsExhaustedSql} from './workspaceCheckpointState.js';
import type {OperationActor} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationError,OperationRefusal} from '../systemActions/operations/errors.js';
import {assertOperationGrant} from '../systemActions/operations/actor.js';
import {authorizedWorkspaceChange,refuseSharedDelegatedPublication} from './workspaceOperations.js';

/** Admission rules only. Input, live policy, revision, Host/Git proofs and
 * explicit human instructions are still checked by each executing operation. */
export function nativeAdmissionBlocker(state:string,pending:boolean){
 return !['open','ready','blocked','integrating'].includes(state)?'change_closed':pending?'request_pending':null;
}
export function retryAdmissionBlocker(state:string,status:string|null,workspaceState:string,checkpointBlocked:boolean){
 return ['blocked','retired'].includes(workspaceState)?'workspace_blocked':checkpointBlocked?'checkpoint_blocked'
  :state!=='blocked'||!status||!['conflict','verification_failed','failed'].includes(status)?'integration_not_retryable':null;
}
export function closeAdmissionBlocker(state:string,status:string|null,active:boolean,pending:boolean,exhausted:boolean,reclaim=false){
 return !['open','ready','blocked'].includes(state)&&!(reclaim&&closedWorkspaceState(state))?'change_closed'
  :status&&!['conflict','verification_failed','failed','superseded',...(reclaim&&closedWorkspaceState(state)?['merged','no_changes']:[])].includes(status)?'integration_active'
  :active?'run_active':pending&&!exhausted?'checkpoint_pending':null;
}
const recovery:Record<string,string>={
 ...discardRecovery,
 revision_moved:'Read workspace.change.get and use its current revision for the same authorized intent; do not replay a stale write.',
 change_closed:'Read workspace.change.get; this saved change does not accept this action in its current state.',
 request_pending:'Wait for the pending operation, then read workspace.change.get before deciding another action.',
 workspace_blocked:'Preserve the saved work and ask the workspace owner to inspect its blocked or retired state.',
 checkpoint_blocked:'Preserve the files; the workspace owner must inspect the blocked checkpoint before integration.',
 integration_not_retryable:'Read workspace.change.get; retry requires a failed integration on a blocked change.',
 integration_active:'Wait for the integration to settle, then read workspace.change.get.',
 run_active:'Wait for the Run to finish, or obtain explicit cancellation authorization and confirm it has stopped.',
 cleanup_not_retryable:'Read workspace.change.get; this generation has no blocked cleanup request to retry.',
 checkpoint_pending:'Wait for checkpoint recovery to settle; preserve the files.',
 action_not_authorized:'This visible change is outside this action\'s authority. Do not try another id or broaden workspace access.',
 coordinator_required:'Save with checkpoint; the coordinator handles publication and closure of this batch.',
 review_required:'Review the exact saved source and the person\'s applicable closure instruction before requesting abandonment.',
 native_agent_required:'This explicit completion action requires an active Agent on a native-integration Host.',
};
export function workspaceStateRefusal(blocker:string){
 return new OperationRefusal(409,'workspaces',recovery[blocker]??'Read workspace.change.get before deciding the next action.',{code:blocker,recovery_action:'workspace.change.get'});
}

/** Called only after the owning reader has established visibility. Authorization
 * uses the exact mutation modes (no retained-closure authority for completion).
 * A refusal never reports private authorizer details or grants write access. */
export async function workspaceActionApplicability(db:Queryable,id:string,actor:OperationActor,assessment?:{publication:CleanupPublication;discard:DiscardAssessment},recoveryBlockers=new Map<string,Promise<string|null>>()){
 const f=(await db.query<{state:string;generation:number;current_generation:number;workspace_id:string;workspace_state:string;native:boolean;pending:boolean;status:string|null;active:boolean;checkpoint_pending:boolean;checkpoint_blocked:boolean;exhausted:boolean;saved:boolean}>(`SELECT c.state,c.generation,w.generation AS current_generation,c.workspace_id,w.state AS workspace_state,
  COALESCE((h.capabilities_json->>'native_workspace_integration')::boolean,false) AS native,
  COALESCE(c.verification_json->'native_progress'->>'status','')='pending' AS pending,m.status,
  EXISTS(SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id WHERE b.change_set_id=c.id AND r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency')) AS active,
  EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state NOT IN ('saved','blocked')) AS checkpoint_pending,
  EXISTS(SELECT 1 FROM execution_workspace_runs b WHERE b.change_set_id=c.id AND b.checkpoint_state='blocked') AS checkpoint_blocked,
  ${allPendingCheckpointsExhaustedSql('c')} AS exhausted,
  c.source_commit IS NOT NULL AND c.source_commit IS DISTINCT FROM c.base_commit AS saved
  FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id JOIN hosts h ON h.id=w.execution_host_id
  LEFT JOIN task_merges m ON m.change_set_id=c.id AND m.space_id=c.space_id WHERE c.id=$1 AND c.space_id=$2`,[id,actor.space_id])).rows[0]!;
 const publication=assessment?.publication??await cleanupPublicationStatus(db,id);
 const actions=[];
 const authority=new Map<string,Promise<{blocker:string|null;access?:string}>>();
 for(const action of ['checkpoint','prepare','publish','reconcile','retry','abandon','recover','cleanup_retry'] as const){
  const retention=action==='recover'||action==='cleanup_retry';
  const operation=retention?'workspace.retention.update':action==='retry'?'workspace.integration.retry':action==='abandon'?'workspace.change.abandon':'workspace.change.complete';
  // Do not advertise tools absent from this Run's grant snapshot.
  try{await assertOperationGrant(db,actor,operation);}catch(error){if(error instanceof OperationError&&[403,404].includes(error.httpStatus))continue;throw error;}
  const mode=action==='checkpoint'?'checkpoint':retention?'recover':action==='abandon'?'abandon':'publish';
  if(!authority.has(mode))authority.set(mode,(async()=>{
   try{
    const c=await authorizedWorkspaceChange(db,id,actor,false,true,true,action==='abandon'||retention);
    if(!retention)await refuseSharedDelegatedPublication(db,actor,c,action==='checkpoint'?'checkpoint':undefined);
    return {blocker:null,access:c.access};
   }catch(error){
    if(error instanceof OperationError){
     if(error.httpStatus===404)return {blocker:'action_not_authorized'};
     if(error.httpStatus===409)return {blocker:'coordinator_required'};
     throw error;
    }
    if([403,404,409].includes((error as {statusCode?:number}).statusCode??0))return {blocker:'action_not_authorized'};
    throw error;
   }
  })());
  const admitted=await authority.get(mode)!;
  let blocker=admitted.blocker;
  const reclaimOnly=action==='abandon'&&closedWorkspaceState(f.state);
  const recoveryKey=action==='cleanup_retry'?`${f.workspace_id}:retry`:f.workspace_id;
  if(retention&&!blocker&&f.generation===f.current_generation&&!recoveryBlockers.has(recoveryKey))
   recoveryBlockers.set(recoveryKey,workspaceRecoveryBlocker(db,f.workspace_id,action==='cleanup_retry'?'retry':'recover'));
  blocker??=retention?(f.generation!==f.current_generation?'workspace_discard_source_moved':await recoveryBlockers.get(recoveryKey)!):action==='abandon'?closeAdmissionBlocker(f.state,publication.status,f.active,f.checkpoint_pending,f.exhausted,reclaimOnly)
   :action==='retry'?retryAdmissionBlocker(f.state,f.status,f.workspace_state,f.checkpoint_blocked)
   :!actor.run_id||!f.native?'native_agent_required':nativeAdmissionBlocker(f.state,f.pending);
  if(!blocker&&reclaimOnly)blocker=(assessment?.discard??(await assessWorkspaceDiscards(db,[id],new Map([[id,publication]]))).get(id))!.blocker;
  // A saved open batch requires review; this projection cannot infer consent.
  if(!blocker&&action==='abandon'&&actor.run_id&&(admitted.access==='project_cleanup'||reclaimOnly||f.state==='open'&&f.saved))blocker='review_required';
  actions.push({operation,...(action==='retry'||action==='abandon'?{}:{action:action==='cleanup_retry'?'retry' as const:action}),available:blocker===null,blocker,
   guidance:blocker?recovery[blocker]:'Read the current revision before execution; input, policy and Host checks still apply.',
   requirements:action==='publish'?['verification_on_saved_commit']:action==='abandon'?['applicable_user_closure_instruction',...(reclaimOnly?['reclaim_and_exact_source_review']:admitted.access==='project_cleanup'?['exact_source_review']:[])]:[]});
 }
 return actions;
}
