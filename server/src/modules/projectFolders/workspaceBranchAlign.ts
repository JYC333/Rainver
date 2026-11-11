import {createHash,randomUUID} from 'node:crypto';
import {WorkspaceBranchAlignInputSchema,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Pool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {publicationConflict} from './workspacePublicationPlan.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {JobDeferredError,type JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {loadTaskLocation,locationWorkspace,taskLocationUsable} from '../hosts/taskBranchRequests.js';
import {sharedHostConnectionRegistry,type HostConnectionRegistry} from '../hosts/connectionRegistry.js';
import {workspaceHostFailureIsTemporary} from './workspacePolicy.js';

export const WORKSPACE_BRANCH_ALIGN_JOB='workspace_branch_align';
const conflict=publicationConflict;
interface Frozen {input:ReturnType<typeof WorkspaceBranchAlignInputSchema.parse>;location_id:string;host_id:string}

/**
 * Person-only alignment of one local branch to another (hosts.md, "Controlled
 * Git publication"). Admission is one Operation Core transaction that freezes
 * the request, the Folder's single active Location and its Host, and enqueues a
 * durable Job; the Host does the Git work under its own guards, journaled by
 * the intent id. One active alignment per Location and source branch. Agents
 * cannot call it; it never pushes or rewrites a remote.
 */
export function workspaceBranchAlignRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 async function subject(db:Queryable,raw:unknown,actor:Parameters<OperationRegistration['execute']>[2],lock=false){
  if(actor.run_id||actor.principal.kind!=='user'||!actor.on_behalf_of_user_id)throw hidden();
  const input=WorkspaceBranchAlignInputSchema.parse(raw),user=actor.on_behalf_of_user_id;
  await assertProjectWriterForMutation(db,actor.space_id,input.project_id,user);
  const rows=(await db.query<{id:string;execution_host_id:string;host_kind:string;owner_user_id:string|null}>(`SELECT l.id,l.execution_host_id,h.kind AS host_kind,h.owner_user_id
   FROM workspace_locations l JOIN project_folders f ON f.id=l.project_folder_id AND f.space_id=l.space_id JOIN hosts h ON h.id=l.execution_host_id
   WHERE l.space_id=$1 AND f.project_id=$2 AND f.id=$3 AND l.status='active' AND h.status<>'revoked'${lock?' FOR SHARE OF l,h':''}`,[actor.space_id,input.project_id,input.folder_id])).rows;
  const location=rows[0];
  if(!location||location.host_kind==='remote'&&location.owner_user_id!==user)throw hidden();
  if(rows.length>1)throw conflict('workspace_branch_align_location_ambiguous');
  return {input,user,location};
 }
 return {
  definition:definitions.get('workspace.branch.align')!,successStatus:202,
  async resolve(db,raw,actor){const {input}=await subject(db,raw,actor);return {authority:`project:${input.project_id}`,targets:{project_id:input.project_id,folder_id:input.folder_id},resourceType:'project',resourceId:input.project_id};},
  async authorize(db,raw,actor){await subject(db,raw,actor,true);},
  async authorizeResult(db,raw,actor){
   const id=(raw as {intent_id?:string}).intent_id;
   const row=(await db.query<{user_id:string;project_id:string}>("SELECT user_id,project_id FROM project_folder_io_intents WHERE id=$1 AND space_id=$2 AND kind='branch_align'",[id,actor.space_id])).rows[0];
   if(!row||row.user_id!==actor.on_behalf_of_user_id)throw hidden();
   await assertProjectWriterForMutation(db,actor.space_id,row.project_id,row.user_id);
  },
  policyContext(){return {trigger_origin:'manual',direct_user_write:true,file_operation:'write'};},
  async execute(db,raw,actor){
   const {input,user,location}=await subject(db,raw,actor,true);
   const scope=createHash('sha256').update(JSON.stringify(['branch_align',location.id,input.source_branch])).digest('hex');
   const active=(await db.query<{id:string;job_status:string|null}>("SELECT i.id,j.status AS job_status FROM project_folder_io_intents i LEFT JOIN jobs j ON j.id=i.job_id WHERE i.space_id=$1 AND i.project_id=$2 AND i.scope_key=$3 AND i.status IN ('pending','prepared','applied') FOR UPDATE OF i",[actor.space_id,input.project_id,scope])).rows[0];
   // A dead Job cannot finish its intent. The Host may already have acted on it,
   // so it needs attention (its recovery ref and journal stay), never success.
   if(active&&['failed','cancelled'].includes(active.job_status??''))await db.query("UPDATE project_folder_io_intents SET status='needs_attention',error_code='workspace_branch_align_job_ended',updated_at=now() WHERE id=$1",[active.id]);
   else if(active)throw conflict('workspace_branch_align_busy');
   const id=randomUUID(),frozen:Frozen={input,location_id:location.id,host_id:location.execution_host_id};
   await db.query("INSERT INTO project_folder_io_intents(id,space_id,project_id,user_id,folder_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'branch_align',$6,'pending',$7::jsonb,'{}'::jsonb,now(),now())",[id,actor.space_id,input.project_id,user,input.folder_id,scope,JSON.stringify(frozen)]);
   const job=await new PgJobQueueRepository(db).enqueue({job_type:WORKSPACE_BRANCH_ALIGN_JOB,space_id:actor.space_id,user_id:user,payload:{intent_id:id},max_attempts:8});
   await db.query('UPDATE project_folder_io_intents SET job_id=$2 WHERE id=$1',[id,job.id]);
   return {intent_id:id,status:'pending',job_id:job.id};
  },
 };
}

/** Rechecks the frozen authority, sends the journaled Host request and records its facts. */
export async function processBranchAlign(pool:Queryable,config:Pick<ServerConfig,'workspaceRoot'>,intentId:string,spaceId:string,hosts:HostConnectionRegistry=sharedHostConnectionRegistry){
 const intent=(await pool.query<{id:string;user_id:string;project_id:string;status:string;frozen_json:Frozen}>("SELECT id,user_id,project_id,status,frozen_json FROM project_folder_io_intents WHERE id=$1 AND space_id=$2 AND kind='branch_align'",[intentId,spaceId])).rows[0];
 if(!intent||intent.status!=='pending')return {processed:false};
 const finish=async(status:'succeeded'|'failed'|'needs_attention',error:string|null,result:unknown)=>{
  await pool.query("UPDATE project_folder_io_intents SET status=$3,error_code=$4,result_json=$5::jsonb,updated_at=now() WHERE id=$1 AND space_id=$2 AND status='pending'",[intentId,spaceId,status,error,result===null?null:JSON.stringify(result)]);
  return {processed:true,status};
 };
 const {input,location_id,host_id}=intent.frozen_json;
 try{await assertProjectWriterForMutation(pool,spaceId,intent.project_id,intent.user_id);}catch{return finish('failed','workspace_branch_align_authority_changed',null);}
 const location=await loadTaskLocation(pool,location_id,spaceId);
 const host=(await pool.query<{kind:string;owner_user_id:string|null}>("SELECT kind,owner_user_id FROM hosts WHERE id=$1 AND status<>'revoked'",[host_id])).rows[0];
 if(!taskLocationUsable(location)||location.execution_host_id!==host_id||!host||host.kind==='remote'&&host.owner_user_id!==intent.user_id)return finish('failed','workspace_branch_align_authority_changed',null);
 const workspace=locationWorkspace(location,config.workspaceRoot??'/');
 if(!workspace)return finish('failed','execution_workspace_location_outside_root',null);
 const reply=await hosts.requestTaskBranch(host_id,'git_branch_align',{workspace,operation_id:intentId,source_ref:`refs/heads/${input.source_branch}`,target_ref:`refs/heads/${input.target_branch}`,mode:input.mode,expected_source_commit:input.expected_source_commit,expected_target_commit:input.expected_target_commit});
 if(!reply.ok&&workspaceHostFailureIsTemporary(reply.error))throw new JobDeferredError(reply.error!,30_000);
 if(reply.ok)return finish('succeeded',null,{outcome:reply.outcome,previous_commit:reply.previous_commit,aligned_commit:reply.aligned_commit,backup_ref:reply.backup_ref,worktree_updated:reply.worktree_updated});
 // The branch moved and then had to be put back, or the Host could not bring
 // branch and checkout to one consistent state, or the Location now resolves
 // to another repository than the one this operation journaled (its effects,
 // if any, are there, isolated): a person decides. Every other refusal
 // changed nothing.
 return finish(['workspace_branch_align_worktree_update_failed','workspace_branch_align_recovery_required','workspace_branch_align_repository_changed'].includes(reply.error??'')?'needs_attention':'failed',reply.error,null);
}

export function registerWorkspaceBranchAlignJob(registry:JobHandlerRegistry,pool:Pool,config:Pick<ServerConfig,'workspaceRoot'>,hosts=sharedHostConnectionRegistry){
 registry.register(WORKSPACE_BRANCH_ALIGN_JOB,async job=>processBranchAlign(pool,config,String(job.payload.intent_id),job.space_id,hosts));
}
