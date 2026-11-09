import {workspaceRetentionRegistration} from './workspaceRetentionOperations.js';
import {nativeWorkspaceRegistration,workspaceChangeGetRegistration} from './workspaceNativeOperations.js';
import type {ServerConfig} from '../../config.js';
import {workspaceVerificationRegistrations} from './workspaceVerificationOperations.js';
import {workspaceCheckpointRunSettledSql} from './workspacePolicy.js';
import {bodyWithheld} from '../access/contentAccessTypes.js';
import {randomUUID} from 'node:crypto';
import {enqueueWorkspaceCleanup} from '../hosts/workspaceCleanup.js';
import type {ExecutionWorkspaceRow} from './executionWorkspaces.js';
import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import {WorkspaceChangeCompleteInputSchema,WorkspaceIntegrationRetryInputSchema,WorkspaceChangeAbandonInputSchema} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {assertProjectWriter,assertProjectWriterForMutation} from '../projects/access.js';
import {PgRunRepository} from '../runs/repository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,hidden} from '../systemActions/operations/errors.js';

export async function authorizedWorkspaceChange(db:Queryable,id:string,actor:OperationActor,lock=false,conversationRecovery=false,readOnly=false,retainedClosure=false,candidateRecovery?:'verification'){
 if(!actor.on_behalf_of_user_id)throw hidden();
 const row=(await db.query<{id:string;workspace_id:string;project_id:string;originating_run_id:string;revision:number;state:string;generation:number;execution_host_id:string;host_owner:string|null;host_kind:string;owner_kind:string;workspace_location_id:string}>(`SELECT c.*,w.project_id,w.execution_host_id,w.owner_kind,w.workspace_location_id,h.owner_user_id AS host_owner,h.kind AS host_kind FROM workspace_change_sets c JOIN execution_workspaces w ON w.id=c.workspace_id AND w.space_id=c.space_id JOIN hosts h ON h.id=w.execution_host_id WHERE c.id=$1 AND c.space_id=$2 `,[id,actor.space_id])).rows[0];
 if(!row||row.host_kind==='remote'&&row.host_owner!==actor.on_behalf_of_user_id)throw hidden();
 const origin=await new PgRunRepository(db).getVisibleRun(actor.space_id,actor.on_behalf_of_user_id,row.originating_run_id);
 if(!origin||bodyWithheld(origin.effective_access_level))throw hidden();
 if(actor.run_id){
  const own=(await db.query("SELECT 1 FROM execution_workspace_runs WHERE run_id=$1 AND workspace_id=$2 AND change_set_id=$3 AND space_id=$4 AND access_mode='write'",[actor.run_id,row.workspace_id,id,actor.space_id])).rowCount;
  const recovery=!own&&conversationRecovery&&(await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id AND r.space_id=b.space_id
   JOIN execution_workspaces w ON w.id=b.workspace_id AND w.space_id=b.space_id
   WHERE b.run_id=$1 AND (b.workspace_id=$2 OR ($7::boolean AND w.workspace_location_id=$8)) AND b.space_id=$3 AND b.access_mode='write' AND w.owner_kind='conversation'
    AND r.session_id=w.session_id AND r.session_id=$4 AND r.project_id=$5 AND r.instructed_by_user_id=$6`,[actor.run_id,row.workspace_id,actor.space_id,origin.session_id,row.project_id,actor.on_behalf_of_user_id,retainedClosure&&row.owner_kind==='conversation',row.workspace_location_id])).rowCount;
  const candidate=!own&&!recovery&&candidateRecovery==='verification'&&(await db.query(`SELECT 1 FROM task_merges m JOIN runs r ON r.id=$3 AND r.space_id=m.space_id
   WHERE m.change_set_id=$1 AND m.space_id=$2 AND (m.resolution_run_id=$3 OR (m.detail_json->>'reply_owner_run_id'=$3 AND m.detail_json->>'inline_phase_state'='running')) AND m.status='resolving'
    AND m.detail_json->>'repair_kind' IN ('verification_setup','verification')
    AND ((r.contract_snapshot_json->>'workspace_integration_id'=m.id AND r.contract_snapshot_json->>'workspace_integration_attempt_id'=m.attempt_id) OR (m.detail_json->>'reply_owner_run_id'=r.id AND m.detail_json->>'inline_phase_state'='running'))`,[id,actor.space_id,actor.run_id])).rowCount;
  if(!own&&!recovery&&!candidate)throw hidden();
 }
 if(readOnly)await assertProjectWriter(db,actor.space_id,row.project_id,actor.on_behalf_of_user_id);
 else await assertProjectWriterForMutation(db,actor.space_id,row.project_id,actor.on_behalf_of_user_id);
 if(lock){
  await db.query('SELECT id FROM execution_workspaces WHERE id=$1 AND space_id=$2 FOR UPDATE',[row.workspace_id,actor.space_id]);
  const current=(await db.query<{revision:number;state:string}>('SELECT revision,state FROM workspace_change_sets WHERE id=$1 AND space_id=$2 FOR UPDATE',[id,actor.space_id])).rows[0];
  if(!current)throw hidden();
  return {...row,...current};
 }
 return row;
}
export function workspaceOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config?:ServerConfig):OperationRegistration[]{
 const native=config?nativeWorkspaceRegistration(definitions,config):null;
 return [workspaceChangeGetRegistration(definitions),workspaceRetentionRegistration(definitions),...workspaceVerificationRegistrations(definitions),{
  definition:definitions.get('workspace.change.complete')!,
  ...(native?{afterCommit:native.afterCommit}:{}),
  async resolve(db,raw,actor){const input=WorkspaceChangeCompleteInputSchema.parse(raw),c=await authorizedWorkspaceChange(db,input.change_set_id,actor,false,true);return {authority:`workspace:${c.workspace_id}`,targets:{workspace_id:c.workspace_id,change_set_id:c.id},resourceType:'project',resourceId:c.project_id};},
  async authorize(db,raw,actor){await authorizedWorkspaceChange(db,WorkspaceChangeCompleteInputSchema.parse(raw).change_set_id,actor,true,true);},
  async authorizeResult(db,raw,actor){await authorizedWorkspaceChange(db,(raw as {change_set_id:string}).change_set_id,actor,false,true);},
  async execute(db,raw,actor,invocation){
   const input=WorkspaceChangeCompleteInputSchema.parse(raw),c=await authorizedWorkspaceChange(db,input.change_set_id,actor,true,true);
   if(actor.run_id&&native){
    const capability=(await db.query<{native:boolean|null}>("SELECT (capabilities_json->>'native_workspace_integration')::boolean AS native FROM hosts WHERE id=$1",[c.execution_host_id])).rows[0]?.native;
    if(input.action||capability)return native.execute(db,raw,actor,invocation);
   }
   if((await db.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state='blocked' LIMIT 1",[c.id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
   const owner=(await db.query<{state:string;recovery_state:string|null}>("SELECT w.state,c.verification_json->'checkpoint_recovery'->>'state' AS recovery_state FROM execution_workspaces w JOIN workspace_change_sets c ON c.workspace_id=w.id WHERE c.id=$1",[c.id])).rows[0];
   if(!owner||['blocked','retired'].includes(owner.state))throw new OperationBusinessError('operation_conflict',409,'workspaces');
   const blockedWithoutIntegration=c.state==='blocked'&&!(await db.query('SELECT 1 FROM task_merges WHERE change_set_id=$1',[c.id])).rowCount;
   if(c.revision!==input.expected_revision||c.state!=='open'&&!blockedWithoutIntegration&&!(input.commit&&c.state==='no_changes'))throw new OperationBusinessError('operation_conflict',409,'workspaces');
   if(input.commit){
    if((await db.query('SELECT 1 FROM execution_workspaces WHERE id=$1 AND parent_workspace_id IS NOT NULL',[c.workspace_id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
    if((await db.query('SELECT 1 FROM task_merges WHERE change_set_id=$1',[c.id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
    await db.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{submitted_commit}',$2::jsonb) WHERE id=$1",[c.id,JSON.stringify({source_commit:input.commit,user_id:actor.on_behalf_of_user_id,run_id:actor.run_id})]);
   }
   let recoveryOnly=false;
   if(owner.recovery_state==='exhausted'){
    const pending=(await db.query<{run_id:string;status:string;settled:boolean}>(`SELECT b.run_id,r.status,${workspaceCheckpointRunSettledSql('r')} AS settled FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.change_set_id=$1 AND b.checkpoint_state='pending' FOR SHARE OF r`,[c.id])).rows;
    const recoveryId=randomUUID();
    for(const binding of pending){
     if(!binding.settled)throw new OperationBusinessError('operation_conflict',409,'workspaces');
     if(binding.status==='waiting_for_dependency')recoveryOnly=true;
     const visible=await new PgRunRepository(db).getVisibleRun(actor.space_id,actor.on_behalf_of_user_id!,binding.run_id);
     if(!visible||bodyWithheld(visible.effective_access_level))throw hidden();
     await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_checkpoint',space_id:actor.space_id,user_id:actor.on_behalf_of_user_id,payload:{run_id:binding.run_id,workspace_id:c.workspace_id,checkpoint_recovery_id:recoveryId}});
    }
    await db.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{checkpoint_recovery}',(verification_json->'checkpoint_recovery')||$2::jsonb) WHERE id=$1",[c.id,JSON.stringify({state:'requested',request_id:recoveryId,checkpoint_only:recoveryOnly})]);
   }
   if(recoveryOnly){
    // A yielded manager still owns an unfinished turn. Recover its frozen
    // checkpoint without turning a repair request into publication intent.
    await db.query("UPDATE workspace_change_sets SET state='open',completion_basis=NULL,revision=revision+1,updated_at=now() WHERE id=$1",[c.id]);
    return {change_set_id:c.id,revision:c.revision+1,state:'open',integration_id:null};
   }
   await db.query(`UPDATE workspace_change_sets SET state='ready',revision=revision+1,summary=$2,completion_basis=$3,verification_json=(verification_json-'error')||$4::jsonb,updated_at=now() WHERE id=$1`,[c.id,input.summary,actor.run_id??`user:${actor.principal.id}`,JSON.stringify(actor.run_id?{reply_owner_run_id:actor.run_id}:{})]);
   await new PgJobQueueRepository(db).enqueue({job_type:'execution_workspace_complete',space_id:actor.space_id,user_id:actor.on_behalf_of_user_id,payload:{change_set_id:c.id}});
   return {change_set_id:c.id,revision:c.revision+1,state:'ready',integration_id:null};
  },
 },
 ...(['workspace.integration.retry','workspace.change.abandon'] as const).map(id=>{
  const retry=id==='workspace.integration.retry';
  async function subject(db:Queryable,raw:unknown,actor:OperationActor,lock=false){
   const input=retry?WorkspaceIntegrationRetryInputSchema.parse(raw):WorkspaceChangeAbandonInputSchema.parse(raw);
   const integration=retry?(await db.query<{change_set_id:string}>('SELECT change_set_id FROM task_merges WHERE id=$1 AND space_id=$2 AND workspace_id IS NOT NULL',[(input as {integration_id:string}).integration_id,actor.space_id])).rows[0]:null;
   const changeId=retry?integration?.change_set_id:(input as {change_set_id:string}).change_set_id;
   if(!changeId)throw hidden();
   return {c:await authorizedWorkspaceChange(db,changeId,actor,lock,true,false,!retry),input};
  }
  return {
   definition:definitions.get(id)!,
   ...(retry&&native?{afterCommit:native.afterCommit}:{}),
   async resolve(db,raw,actor){const {c}=await subject(db,raw,actor);return {authority:`workspace:${c.workspace_id}`,targets:{workspace_id:c.workspace_id,change_set_id:c.id},resourceType:'project',resourceId:c.project_id};},
   async authorize(db,raw,actor){await subject(db,raw,actor,true);},
   async authorizeResult(db,raw,actor){await authorizedWorkspaceChange(db,(raw as {change_set_id:string}).change_set_id,actor,false,true,false,!retry);},
   async execute(db,raw,actor){
    const {c,input}=await subject(db,raw,actor,true);
    const m=(await db.query<{id:string;revision:number;status:string;attempt_id:string;requested_by_user_id:string;detail_json:Record<string,unknown>}>('SELECT id,revision,status,attempt_id,requested_by_user_id,detail_json FROM task_merges WHERE change_set_id=$1 AND space_id=$2 FOR UPDATE',[c.id,actor.space_id])).rows[0];
    if(retry){
     if((await db.query("SELECT 1 FROM execution_workspaces WHERE id=$1 AND state IN ('blocked','retired')",[c.workspace_id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
     if((await db.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state='blocked' LIMIT 1",[c.id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
     if(!m||m.revision!==input.expected_revision||!['conflict','verification_failed','failed'].includes(m.status)||c.state!=='blocked')throw new OperationBusinessError('operation_conflict',409,'workspaces');
     const {resolution,repair_instruction,reconcile_only}=WorkspaceIntegrationRetryInputSchema.parse(input);
     if(resolution&&(actor.principal.kind!=='user'||actor.run_id||actor.on_behalf_of_user_id!==m.requested_by_user_id))throw hidden();
     if(repair_instruction&&(actor.principal.kind!=='agent'||!actor.run_id||actor.on_behalf_of_user_id!==m.requested_by_user_id))throw hidden();
     const capable=actor.run_id&&native&&(await db.query<{native:boolean|null}>("SELECT (capabilities_json->>'native_workspace_integration')::boolean AS native FROM hosts WHERE id=$1",[c.execution_host_id])).rows[0]?.native;
     if(capable&&!resolution){
      const summary=(await db.query<{summary:string|null}>('SELECT summary FROM workspace_change_sets WHERE id=$1',[c.id])).rows[0]?.summary??'Recover saved integration';
      return native!.retry(db,{change_set_id:c.id,expected_revision:c.revision,summary,action:reconcile_only?'reconcile':'prepare'},actor);
     }
     const paths=m.detail_json.conflicted_files;
     if((resolution||repair_instruction)&&(m.status!=='conflict'||!Array.isArray(paths)||paths.length===0||paths.length>500||!paths.every(p=>typeof p==='string')))throw new OperationBusinessError('operation_conflict',409,'workspaces');
     const detail=reconcile_only?{reconcile_only:true}:resolution?{human_resolution:{instruction:resolution,user_id:actor.on_behalf_of_user_id,paths}}
      :repair_instruction?{agent_repair:{instruction:repair_instruction,user_id:actor.on_behalf_of_user_id,run_id:actor.run_id,paths}}:{};
     await db.query(`UPDATE task_merges SET status='queued',revision=revision+1,attempt_id=$2,onto_commit=NULL,task_commit=NULL,resolution_run_id=NULL,detail_json=jsonb_build_object('previous_attempt',attempt_id,'previous_detail',detail_json)||$3::jsonb,updated_at=now() WHERE id=$1`,[m.id,randomUUID(),JSON.stringify({...detail,...(actor.run_id?{reply_owner_run_id:actor.run_id,verification_request:{run_id:actor.run_id,user_id:actor.on_behalf_of_user_id}}:{})})]);
     await db.query("UPDATE workspace_change_sets SET state='integrating',revision=revision+1,updated_at=now() WHERE id=$1",[c.id]);
     await new PgJobQueueRepository(db).enqueue({job_type:'task_merge',space_id:actor.space_id,user_id:actor.on_behalf_of_user_id,payload:{merge_id:m.id,workspace_id:c.workspace_id}});
     return {change_set_id:c.id,revision:c.revision+1,state:'integrating',integration_id:m.id};
    }
    if(c.revision!==input.expected_revision||!['open','ready','blocked'].includes(c.state)||m&&!['conflict','verification_failed','failed','superseded'].includes(m.status))throw new OperationBusinessError('operation_conflict',409,'workspaces');
    if((await db.query(`SELECT 1 FROM execution_workspace_runs b JOIN runs r ON r.id=b.run_id WHERE b.change_set_id=$1 AND r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency') LIMIT 1`,[c.id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
    const pendingCheckpoint=Boolean((await db.query("SELECT 1 FROM execution_workspace_runs WHERE change_set_id=$1 AND checkpoint_state NOT IN ('saved','blocked') LIMIT 1",[c.id])).rowCount);
    if(pendingCheckpoint&&!(await db.query("SELECT 1 FROM workspace_change_sets WHERE id=$1 AND verification_json->'checkpoint_recovery'->>'state'='exhausted'",[c.id])).rowCount)throw new OperationBusinessError('operation_conflict',409,'workspaces');
    await db.query(`UPDATE workspace_change_sets SET state='abandoned',revision=revision+1,verification_json=verification_json||$2::jsonb,updated_at=now() WHERE id=$1`,[c.id,JSON.stringify({abandon_reason:(input as {reason:string}).reason,blocked_bindings_retained:true,pending_checkpoint_retained:pendingCheckpoint})]);
    if(m)await db.query("UPDATE task_merges SET status='superseded',completed_at=now(),updated_at=now() WHERE id=$1",[m.id]);
    const w=(await db.query<ExecutionWorkspaceRow>('SELECT * FROM execution_workspaces WHERE id=$1',[c.workspace_id])).rows[0]!;
    // Permission/receipt violations cannot be cleared by relabelling a checkpoint.
    // Retire the old identity only after its last unfinished change is withdrawn;
    // a later conversation turn gets a fresh generation and keeps this evidence.
    if((w.state==='blocked'||pendingCheckpoint)&&!(await db.query("SELECT 1 FROM workspace_change_sets WHERE workspace_id=$1 AND state IN ('open','ready','integrating','blocked') LIMIT 1",[w.id])).rowCount)
     await db.query("UPDATE execution_workspaces SET state='retired',updated_at=now() WHERE id=$1",[w.id]);
    if(w.head_commit&&!pendingCheckpoint)await enqueueWorkspaceCleanup(db,w,{id:w.id,generation:w.generation},w.head_commit,true,actor.on_behalf_of_user_id!);
    return {change_set_id:c.id,revision:c.revision+1,state:'abandoned',integration_id:m?.id??null};
   },
  } satisfies OperationRegistration;
 })];}
