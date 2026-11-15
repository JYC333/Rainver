import {createWorkspaceSlotWorker} from "./support/workspaceSlotWorker.js";
import {workspaceOperationRegistrations} from '../src/modules/projectFolders/workspaceOperations.js';
import {SYSTEM_ACTION_REGISTRY} from '@rainver/protocol';
import {workspaceActionApplicability} from '../src/modules/projectFolders/workspaceActionRules.js';
import type {OperationActor} from '@rainver/protocol';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedRun,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {ensureExecutionWorkspace,ensurePrimaryExecutionWorkspace} from '../src/modules/projectFolders/executionWorkspaces.js';
import {sharedDelegatedBinding,sharedDelegatedRun} from '../src/modules/projectFolders/delegatedWorkspacePlacement.js';
import {frozenReview,recordReviewObservation,recordReviewRefusal} from '../src/modules/projectFolders/delegatedWorkspaceReview.js';
import {reviewBasisLine} from '../src/modules/agentGroups/lifecycleProjector.js';

/**
 * Delegated workspace placement on real PostgreSQL (ADR 0029): a serial writer
 * continues in its coordinator's conversation workspace and batch, parallel
 * writers and anything not provably idle keep independent forks, and a
 * read-only child reviews the coordinator's saved checkpoint without a new
 * workspace, batch or checkpoint only on a Host that can enforce it.
 */
const SPACE='a3a3a3a3-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='b3b3b3b3-bbbb-4bbb-8bbb-bbbbbbbbbbbb',PROJECT='c3c3c3c3-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER='e3e3e3e3-eeee-4eee-8eee-eeeeeeeeeeee',LOCATION='13131313-1111-4111-8111-111111111111',MACHINE='23232323-2222-4222-8222-222222222222';
const HOST='34343434-3333-4333-8333-333333333333',AGENT='56565656-5555-4555-8555-555555555555',VERSION='67676767-6666-4666-8666-666666666666';
const CONVERSATION='89898989-8888-4888-8888-888888888888',OTHER='89898989-9999-4888-8888-888888888888';
const A='a'.repeat(40),B='b'.repeat(40);
const db=useTestDatabase(import.meta.filename);
let roomId='',groupId='',collaborationTask:string|null=null;

async function capabilities(value:Record<string,unknown>){await db.pool.query('UPDATE hosts SET capabilities_json=$2::jsonb WHERE id=$1',[HOST,JSON.stringify(value)]);}
beforeEach(async()=>{
 if(!db.available)return;
 collaborationTask=null;
 await resetTables(db.pool,['execution_workspace_reviews','host_threads','sessions','workspace_locations','project_folders','tasks','agents','agent_versions','rooms','projects','hosts','machines','space_memberships','users','spaces'],{cascade:true});
 const {now}=await seedSpaceOwnerProject(db.pool,{space:SPACE,owner:OWNER,project:PROJECT,now:new Date().toISOString()});
 roomId=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND is_mainline=true LIMIT 1',[SPACE])).rows[0]!.id;
 for(const s of [CONVERSATION,OTHER])await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5)`,[s,SPACE,PROJECT,roomId,now]);
 await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repo','code','active',false,false,$4,$4)`,[FOLDER,SPACE,PROJECT,now]);
 await db.pool.query(`INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'M','desktop',$3,$3)`,[MACHINE,OWNER,now]);
 await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,created_at,updated_at) VALUES($1,$2,$3,'H','remote','linux_native','online','{}'::jsonb,$4,$4)`,[HOST,OWNER,MACHINE,now]);
 await capabilities({execution_workspaces:{version:2,reclaim:5}});
 await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/workspace/repo',true,'active',$5,$5)`,[LOCATION,SPACE,FOLDER,HOST,now]);
 await seedAgentWithVersion(db.pool,{agent:AGENT,version:VERSION,space:SPACE,owner:OWNER,now});
 const message=randomUUID();groupId=randomUUID();
 await db.pool.query("INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Implement then review',0,'/',now())",[message,SPACE,CONVERSATION,OWNER]);
 await db.pool.query('UPDATE sessions SET head_message_id=$2 WHERE id=$1',[CONVERSATION,message]);
 await db.pool.query("INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Work','Work','active',now(),now())",[groupId,SPACE,OWNER,roomId,CONVERSATION,message,PROJECT]);
});

async function run(status:string,access:'read'|'write'='write',session=CONVERSATION){
 const id=randomUUID();
 await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
 await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,status=$6,contract_snapshot_json=$7::jsonb WHERE id=$1`,
  [id,PROJECT,session,LOCATION,OWNER,status,JSON.stringify({execution_workspace_version:1,workspace_access:access})]);
 return id;
}
const load=async(id:string)=>(await new PgRunRepository(db.pool).getRun(SPACE,id))!;
/** The coordinator's turn: it worked in its conversation workspace, saved B and finished. */
async function coordinator(){
 const parent=await run('running');
 const bound=await ensureExecutionWorkspace(db.pool,await load(parent),HOST,LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET state='ready',base_commit=$2,head_commit=$3,target_ref='refs/heads/main',head_sequence=2 WHERE id=$1",[bound.workspace.id,A,B]);
 await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state='saved',launch_sequence=2 WHERE run_id=$1",[parent,A,B]);
 await db.pool.query("UPDATE workspace_change_sets SET base_commit=$2,source_commit=$3 WHERE id=$1",[bound.changeSetId,A,B]);
 await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[parent]);
 return {parent,workspace:bound.workspace.id,changeSet:bound.changeSetId};
}
async function child(parent:string,access:'read'|'write'='write',status='queued'){
 const id=await run(status,access),delegation=randomUUID();
 await db.pool.query("INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,requesting_agent_id,target_agent_id,status,instruction,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,'queued','Work',now(),now())",[delegation,SPACE,groupId,parent,id,AGENT]);
 if(collaborationTask)await db.pool.query("UPDATE run_delegations SET budget_json=jsonb_build_object('collaboration_task_id',$2::text) WHERE id=$1",[delegation,collaborationTask]);
 await db.pool.query("UPDATE runs SET parent_run_id=$2,root_run_id=$2,run_group_id=$3,delegation_id=$4 WHERE id=$1",[id,parent,groupId,delegation]);
 return id;
}


const slotWorker=(runId:string)=>createWorkspaceSlotWorker(db,runId,{SPACE,OWNER,PROJECT,FOLDER,HOST,LOCATION,AGENT,CONVERSATION,roomId});

describe('delegated workspace placement',()=>{
 for(const action of ['reclaim_now','discard','shorter_hold'] as const)it(`wakes exact pending and claimed slot waits after ${action} despite clock skew`,async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  const first=await child(c.parent),bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[first]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[first,B]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated',base_commit=$2,source_commit=$2 WHERE id=$1",[bound.changeSetId,B]);
  await db.pool.query("UPDATE execution_workspaces SET base_commit=$2,head_commit=$2,state='ready',retention_json=jsonb_build_object('hold_until',now()+interval '5 days','slot_use_id',$3::text) WHERE id=$1",[bound.workspace.id,B,'use-current']);
  const next=await child(c.parent);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('child_release_hold');
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const queue=new PgJobQueueRepository(db.pool);
  const jobs=[];
  for(let i=0;i<2;i++)jobs.push((await queue.enqueue({job_type:'agent_run',space_id:SPACE,user_id:OWNER,payload:{run_id:next},scheduled_at:new Date(Date.now()+5*86400000)})).id);
  // App claim is an hour ahead of DB time. Timestamp ordering alone loses wake.
  await db.pool.query("UPDATE jobs SET status='running',claimed_by='skew-worker',claimed_at=now()+interval '1 hour',attempts=1 WHERE id=$1",[jobs[1]]);
  const unrelated=await child(c.parent),oldUse=await child(c.parent);
  const wait=(await load(next)).output_json;
  await db.pool.query("UPDATE runs SET output_json=$2::jsonb WHERE id=ANY($1::varchar[])",[[unrelated,oldUse],JSON.stringify(wait)]);
  await db.pool.query("UPDATE runs SET output_json=jsonb_set(output_json,'{waiting_for_workspace_release,workspace_ids}',$2::jsonb) WHERE id=$1",[unrelated,JSON.stringify([c.workspace])]);
  await db.pool.query("UPDATE runs SET output_json=jsonb_set(output_json,'{waiting_for_workspace_release,identity}',to_jsonb($2::text)) WHERE id=$1",[oldUse,bound.workspace.id+':use-old']);
  const unrelatedJob=await queue.enqueue({job_type:'agent_run',space_id:SPACE,user_id:OWNER,payload:{run_id:unrelated},scheduled_at:new Date(Date.now()+5*86400000)});
  const oldJob=await queue.enqueue({job_type:'agent_run',space_id:SPACE,user_id:OWNER,payload:{run_id:oldUse},scheduled_at:new Date(Date.now()+5*86400000)});
  const {workspaceRetentionRegistration}=await import('../src/modules/projectFolders/workspaceRetentionOperations.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {withQueryableTransaction}=await import('../src/modules/routeUtils/common.js');
  const actor=sessionActor({spaceId:SPACE,userId:OWNER});
  if(action==='discard'){
   const operation=workspaceOperationRegistrations(new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d]))).find(r=>r.definition.id==='workspace.change.abandon')!;
   await db.pool.query("UPDATE workspace_change_sets SET state='abandoned' WHERE id=$1",[bound.changeSetId]);
   await withQueryableTransaction(db.pool,tx=>operation.execute(tx,{change_set_id:bound.changeSetId,expected_revision:1,reason:'Discard obsolete saved files',reclaim:true,review:{source_commit:B,user_request_quote:'Discard obsolete saved files',findings:'Reviewed exact saved tip'}},actor,{} as any));
  }else{
   const operation=workspaceRetentionRegistration(new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d])));
   await withQueryableTransaction(db.pool,tx=>operation.execute(tx,{change_set_id:bound.changeSetId,action:action==='shorter_hold'?'hold':action,...(action==='shorter_hold'?{hold_days:1}:{})},actor,{} as any));
  }
  expect(await queue.deferJob(jobs[1],'stale five day hold','skew-worker',new Date(Date.now()+5*86400000))).toBe(true);
  for(const job of jobs)expect((await db.pool.query('SELECT scheduled_at<=now() AS due,attempts FROM jobs WHERE id=$1',[job])).rows[0]).toEqual({due:true,attempts:0});
  for(const job of [unrelatedJob.id,oldJob.id])expect((await db.pool.query('SELECT scheduled_at>now()+interval \'4 days\' AS untouched FROM jobs WHERE id=$1',[job])).rows[0].untouched).toBe(true);
  expect(Date.parse(((await load(next)).output_json as any).waiting_for_workspace_release.since)).toBeLessThan(Date.now()+1000);
  if(action==='shorter_hold')await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('child_release_hold');
 });

 it('keeps one noncollaborative slot for a one-member or null-room scope',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  await db.pool.query("INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,roomId,AGENT]);
  const first=await child(c.parent);
  const slot=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  expect(slot.workspace.owner_kind).toBe('delegation');
  // Null-room historical groups remain valid; no equality-to-NULL join refusal.
  const nullGroup=randomUUID(),next=await child(c.parent);
  await db.pool.query(`INSERT INTO agent_run_groups SELECT (jsonb_populate_record(NULL::agent_run_groups,to_jsonb(g)||jsonb_build_object('id',$2::text,'room_id',NULL,'session_id',NULL,'trigger_message_id',NULL,'project_id',NULL))).* FROM agent_run_groups g WHERE id=$1`,[groupId,nullGroup]);
  await db.pool.query('UPDATE run_delegations SET group_id=$2 WHERE child_run_id=$1',[next,nullGroup]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
 });

 it('reports another Task blocked resource at the shared bound instead of waiting forever or allocating more slots',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  const taskA=randomUUID(),taskB=randomUUID();
  for(const [id,title] of [[taskA,'Blocked Task'],[taskB,'Independent Task']])await db.pool.query("INSERT INTO tasks(id,space_id,project_id,title,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'inbox',$5,now(),now())",[id,SPACE,PROJECT,title,OWNER]);
  const first=await child(c.parent),slot=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  await db.pool.query("UPDATE run_delegations SET budget_json=jsonb_build_object('collaboration_task_id',$2::text) WHERE child_run_id=$1",[first,taskA]);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[first]);
  await db.pool.query("UPDATE execution_workspaces SET state='blocked' WHERE id=$1",[slot.workspace.id]);
  const otherGroup=randomUUID();
  await db.pool.query(`INSERT INTO agent_run_groups SELECT (jsonb_populate_record(NULL::agent_run_groups,to_jsonb(g)||jsonb_build_object('id',$2::text))).* FROM agent_run_groups g WHERE id=$1`,[groupId,otherGroup]);
  const next=await child(c.parent);
  await db.pool.query("UPDATE run_delegations SET group_id=$2,budget_json=jsonb_build_object('collaboration_task_id',$3::text) WHERE child_run_id=$1",[next,otherGroup,taskB]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('capacity_occupied_by_blocked_workspace:'+slot.workspace.id);
  const h=await slotWorker(next);
  try{
   expect(await h.worker.processOne()).toMatchObject({status:'completed'});
   expect((await load(next)).error_message).toContain('capacity_occupied_by_blocked_workspace:'+slot.workspace.id);
   expect(h.host.promptsFor(next)).toHaveLength(0);
  }finally{h.host.disconnect();}
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(2);
  expect((await db.pool.query('SELECT state FROM execution_workspaces WHERE id=$1',[slot.workspace.id])).rows[0].state).toBe('blocked');
 });

 it('preserves unrelated reconciliation evidence and first checkpoint failure time until saved',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const {lockUnchangedIdleWorkspace}=await import('../src/modules/hosts/workspaceReconcileFence.js');
  const {refreshCleanupSummary}=await import('../src/modules/hosts/workspaceCleanup.js');
  const {workspaceChangesForRun}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const row=async()=>(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[c.workspace])).rows[0];
  const old='2026-01-01T00:00:00Z';
  await db.pool.query("UPDATE execution_workspaces SET inventory_json=jsonb_build_object('reconciliation_error','host_inspection_failed','reconciliation_failed_at',$2::text) WHERE id=$1",[c.workspace,old]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[c.parent]);
  expect(await lockUnchangedIdleWorkspace(db.pool,await row())).toBe(false);
  const first=(await row()).inventory_json.checkpoint_reconciliation_failed_at;
  expect(first).toBeTruthy();
  expect(await lockUnchangedIdleWorkspace(db.pool,await row())).toBe(false);
  expect((await row()).inventory_json).toMatchObject({reconciliation_error:'host_inspection_failed',reconciliation_failed_at:old,checkpoint_reconciliation_failed_at:first});
  await refreshCleanupSummary(db.pool,c.workspace);
  expect((await workspaceChangesForRun(db.pool,{id:c.parent,space_id:SPACE},OWNER))[0].cleanup_errors).toContain('workspace_checkpoint_blocked');
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[c.parent]);
  expect(await lockUnchangedIdleWorkspace(db.pool,await row())).toBe(true);
  expect((await row()).inventory_json).toEqual({reconciliation_error:'host_inspection_failed',reconciliation_failed_at:old});
 });

 for(const kind of ['capacity','pending','hold'] as const)it(`real agent_run worker defers ${kind} before running and launches once on reentry`,async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  const occupied=await child(c.parent),next=await child(c.parent);
  const slot=await ensurePrimaryExecutionWorkspace(db.pool,await load(occupied),HOST,LOCATION);
  async function settle(clean=false){
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[occupied]);
   await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[occupied,B]);
   await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[slot.changeSetId]);
   if(clean)await db.pool.query(`UPDATE execution_workspaces SET state='ready',retention_json=jsonb_build_object('state','reclaimed'),cleanup_state='cleaned',cleanup_json='{}',inventory_json='{"worktree":false,"registration":false,"branch":false}' WHERE id=$1`,[slot.workspace.id]);
  }
  if(kind!=='capacity')await settle();
  if(kind==='hold')await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_build_object('hold_until',now()+interval '3 days') WHERE id=$1",[slot.workspace.id]);
  const h=await slotWorker(next);
  try{
   expect(await h.worker.processOne(),JSON.stringify(await load(next))).toMatchObject({status:'deferred'});
   expect((await load(next)).status).toBe('queued');
   expect((await db.pool.query('SELECT * FROM run_attempts WHERE run_id=$1',[next])).rows).toEqual([]);
   expect((await db.pool.query('SELECT * FROM run_execution_locks WHERE run_id=$1',[next])).rows).toEqual([]);
   expect((await db.pool.query('SELECT status FROM run_delegations WHERE child_run_id=$1',[next])).rows[0].status).toBe('queued');
   expect((await db.pool.query('SELECT attempts,status FROM jobs WHERE id=$1',[h.job.id])).rows[0]).toMatchObject({attempts:0,status:'pending'});
   expect(h.host.promptsFor(next)).toHaveLength(0);
   // Repeat the actual worker entry, rather than helper-only admission.
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[h.job.id]);
   expect(await h.worker.processOne(),JSON.stringify(await load(next))).toMatchObject({status:'deferred'});
   await settle(true);
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[h.job.id]);
   const result=await h.worker.processOne();
   expect(result).toMatchObject({status:'completed'});
   expect((await load(next)).status,JSON.stringify(await load(next))).toBe('succeeded');
   expect(h.host.promptsFor(next)).toHaveLength(1);
   expect((await db.pool.query('SELECT status,attempt_number FROM run_attempts WHERE run_id=$1',[next])).rows).toEqual([{status:'succeeded',attempt_number:1}]);
   expect((await db.pool.query('SELECT * FROM run_execution_locks WHERE run_id=$1',[next])).rowCount).toBe(0);
   expect((await db.pool.query("SELECT 1 FROM run_events WHERE run_id=$1 AND error_code='orphaned'",[next])).rowCount).toBe(0);
  }finally{h.host.disconnect();}
 });

 it('settles cancellation that races locked queued workspace admission',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION);
  const next=await child(c.parent),h=await slotWorker(next);
  const request=h.registry.requestTaskBranch.bind(h.registry);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  h.registry.requestTaskBranch=async(...args)=>{if(args[1]==='workspace_scope'){entered();await gate;}return request(...args);};
  try{
   const working=h.worker.processOne();
   await started;
   await h.orchestration.cancelRun({run_id:next,space_id:SPACE,requested_by_user_id:OWNER,reason:'Cancel during admission'});
   release();
   expect(await working).toMatchObject({status:'completed'});
   expect((await load(next)).status).toBe('cancelled');
   expect(h.host.promptsFor(next)).toHaveLength(0);
   expect((await db.pool.query('SELECT * FROM run_attempts WHERE run_id=$1',[next])).rowCount).toBe(0);
   expect((await db.pool.query('SELECT * FROM run_execution_locks WHERE run_id=$1',[next])).rowCount).toBe(0);
  }finally{release();h.host.disconnect();}
 });

 it('rechecks live Agent authorization when a workspace waiter reenters',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION);
  const next=await child(c.parent),h=await slotWorker(next);
  try{
   expect(await h.worker.processOne()).toMatchObject({status:'deferred'});
   await db.pool.query("UPDATE room_agent_members SET status='removed' WHERE room_id=$1 AND agent_id=$2",[roomId,AGENT]);
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[h.job.id]);
   await h.worker.processOne();
   expect((await load(next)).error_json).toMatchObject({error_code:'run_execution_authorization_revoked'});
   expect(h.host.promptsFor(next)).toHaveLength(0);
   expect((await db.pool.query("SELECT * FROM run_attempts WHERE run_id=$1 AND (launch_id IS NOT NULL OR status IN ('running','cancelling'))",[next])).rowCount).toBe(0);
   expect((await db.pool.query('SELECT * FROM run_execution_locks WHERE run_id=$1',[next])).rowCount).toBe(0);
  }finally{h.host.disconnect();}
 });

 it('cancels a queued slot waiter without a launch, attempt or leaked execution lock',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION);
  const next=await child(c.parent),h=await slotWorker(next);
  try{
   expect(await h.worker.processOne(),JSON.stringify(await load(next))).toMatchObject({status:'deferred'});
   await h.orchestration.cancelRun({run_id:next,space_id:SPACE,requested_by_user_id:OWNER,reason:'Cancel slot wait'});
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 second' WHERE id=$1",[h.job.id]);
   await h.worker.processOne();
   expect((await load(next)).status).toBe('cancelled');
   expect(h.host.promptsFor(next)).toHaveLength(0);
   expect((await db.pool.query('SELECT * FROM run_attempts WHERE run_id=$1',[next])).rowCount).toBe(0);
   expect((await db.pool.query('SELECT * FROM run_execution_locks WHERE run_id=$1',[next])).rowCount).toBe(0);
  }finally{h.host.disconnect();}
 });

 it('continues a serial writer in the coordinator workspace and batch, and keeps publication with the coordinator',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const first=await child(c.parent);
  const bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  expect(bound).toMatchObject({workspace:{id:c.workspace},changeSetId:c.changeSet,sharedWithCoordinator:true});
  expect(bound.ref.sync_to_target).toBeUndefined();
  expect((await db.pool.query("SELECT count(*)::int AS n FROM execution_workspaces WHERE space_id=$1",[SPACE])).rows[0].n).toBe(1);
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[first])).rowCount).toBe(1);
  expect(await sharedDelegatedBinding(db.pool,first,SPACE,c.workspace)).toBe(true);
  expect(await sharedDelegatedRun(db.pool,first,SPACE)).toBe(true);
  expect(await sharedDelegatedRun(db.pool,c.parent,SPACE)).toBe(false);
  await db.pool.query("UPDATE hosts SET capabilities_json=capabilities_json||'{\"native_workspace_integration\":true}'::jsonb WHERE id=$1",[HOST]);
  await db.pool.query('UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1',[first,JSON.stringify({tool_grants:['workspace.change.complete','workspace.integration.retry','workspace.change.abandon'].map(action_id=>({action_id}))})]);
  const actor={space_id:SPACE,principal:{kind:'agent',id:AGENT},agent_id:AGENT,on_behalf_of_user_id:OWNER,run_id:first} as OperationActor;
  const hints=await workspaceActionApplicability(db.pool,c.changeSet,actor);
  expect(hints.find(h=>h.action==='checkpoint')).toMatchObject({available:true,blocker:null});
  for(const hint of hints.filter(h=>h.action!=='checkpoint'))expect(hint).toMatchObject({available:false,blocker:'coordinator_required'});
  const complete=workspaceOperationRegistrations(new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d]))).find(r=>r.definition.id==='workspace.change.complete')!;
  const input={change_set_id:c.changeSet,expected_revision:1,summary:'Publish',action:'publish'};
  await expect(complete.authorize(db.pool,input,actor,await complete.resolve(db.pool,input,actor))).rejects.toMatchObject({httpStatus:409});
  // A retry of the same child keeps its frozen binding.
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace},sharedWithCoordinator:true});
  // While it is unfinished, the next delegated writer is not serial: it forks.
  const second=await child(c.parent);
  const forked=await ensurePrimaryExecutionWorkspace(db.pool,await load(second),HOST,LOCATION);
  expect(forked.workspace).toMatchObject({owner_kind:'delegation',parent_workspace_id:c.workspace});
  expect(forked.sharedWithCoordinator).toBeUndefined();
 });

 it('reuses a confirmed released slot across rounds, freezes old launch identity and queues at capacity',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator(),blocker=await child(c.parent),first=await child(c.parent);
  const initial=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  expect(initial.workspace.parent_workspace_id).toBe(c.workspace);
  const next=await child(c.parent);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  const oldRef=initial.ref;
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[first]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[first,B]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[initial.changeSetId]);
  // A database retention label alone cannot permit slot reuse.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json='{"state":"reclaimed"}' WHERE id=$1`,[initial.workspace.id]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('child_release_pending');
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_state='cleaned',cleanup_json='{}',inventory_json='{"worktree":false,"registration":false,"branch":false}',materialization_epoch=3 WHERE id=$1`,[initial.workspace.id]);
  await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('hold_until',(now()+interval '1 day')::text) WHERE id=$1",[initial.workspace.id]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('child_release_hold');
  await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json-'hold_until',state='blocked' WHERE id=$1",[initial.workspace.id]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('child_release_blocked');
  await db.pool.query("UPDATE execution_workspaces SET state='ready' WHERE id=$1",[initial.workspace.id]);
  const reused=await ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION);
  expect(reused.workspace.id).toBe(initial.workspace.id);
  expect(reused.changeSetId).not.toBe(initial.changeSetId);
  expect(reused.ref).toMatchObject({base_commit:B,materialization_epoch:4});
  expect((await db.pool.query('SELECT launch_reference_json FROM execution_workspace_runs WHERE run_id=$1',[first])).rows[0].launch_reference_json).toEqual(oldRef);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(2);
  // Different Task/Group scope does not inherit the old slot or its assets.
  const otherGroup=randomUUID();
  await db.pool.query(`INSERT INTO agent_run_groups SELECT (jsonb_populate_record(NULL::agent_run_groups,to_jsonb(g)||jsonb_build_object('id',$2::text))).* FROM agent_run_groups g WHERE id=$1`,[groupId,otherGroup]);
  const other=await child(c.parent);
  await db.pool.query('UPDATE run_delegations SET group_id=$2 WHERE child_run_id=$1',[other,otherGroup]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(other),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  expect(blocker).toBeTruthy();
 });

 it('starts a durable release clock after capacity waiting, pauses for holds and wakes the original Job',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  const first=await child(c.parent),next=await child(c.parent);
  const bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  await db.pool.query("UPDATE runs SET created_at=now()-interval '2 hours' WHERE id=$1",[next]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  expect(((await load(next)).output_json as any)?.waiting_for_workspace_release).toBeUndefined();
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[first]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[first]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[bound.changeSetId]);
  const pending=async()=>ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION);
  await expect(pending()).rejects.toThrow('child_release_pending');
  const wait=async()=>(await load(next)).output_json as any;
  const since=(await wait()).waiting_for_workspace_release.since;
  await db.pool.query("UPDATE runs SET updated_at=now()+interval '1 day' WHERE id=$1",[next]);
  await expect(pending()).rejects.toThrow('child_release_pending');
  expect((await wait()).waiting_for_workspace_release.since).toBe(since);
  await db.pool.query(`UPDATE runs SET output_json=jsonb_set(output_json,'{waiting_for_workspace_release,since}',to_jsonb((now()-interval '31 minutes')::text)) WHERE id=$1`,[next]);
  await expect(pending()).rejects.toThrow('child_release_timeout');
  // A legal hold is neither a safety failure nor an expired release clock.
  await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_build_object('hold_until',now()+interval '2 days') WHERE id=$1",[bound.workspace.id]);
  await expect(pending()).rejects.toThrow('child_release_hold');
  const heldSince=(await wait()).waiting_for_workspace_release.since;
  await expect(pending()).rejects.toThrow('child_release_hold');
  expect((await wait()).waiting_for_workspace_release.since).toBe(heldSince);
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const queue=new PgJobQueueRepository(db.pool);
  const claimed=(await queue.enqueue({space_id:SPACE,user_id:OWNER,job_type:'agent_run',payload:{run_id:next}})).id;
  await db.pool.query("UPDATE jobs SET status='running',claimed_by='hold-race',claimed_at=now()-interval '1 minute',attempts=1 WHERE id=$1",[claimed]);
  const job=(await queue.enqueue({space_id:SPACE,user_id:OWNER,job_type:'agent_run',payload:{run_id:next},scheduled_at:new Date(Date.now()+2*86400000)})).id;
  const {workspaceRetentionRegistration}=await import('../src/modules/projectFolders/workspaceRetentionOperations.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {withQueryableTransaction}=await import('../src/modules/routeUtils/common.js');
  const operation=workspaceRetentionRegistration(new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d])));
  await withQueryableTransaction(db.pool,tx=>operation.execute(tx,{change_set_id:bound.changeSetId,action:'release_hold'},sessionActor({spaceId:SPACE,userId:OWNER}),{} as any));
  expect((await db.pool.query('SELECT scheduled_at<=now() AS due,attempts FROM jobs WHERE id=$1',[job])).rows[0]).toMatchObject({due:true,attempts:0});
  // A claimed handler may return the hold's old two-day defer after release.
  expect(await queue.deferJob(claimed,'workspace_placement_blocked:child_release_hold','hold-race',new Date(Date.now()+2*86400000))).toBe(true);
  expect((await db.pool.query('SELECT scheduled_at<=now() AS due,status,attempts FROM jobs WHERE id=$1',[claimed])).rows[0]).toMatchObject({due:true,status:'pending',attempts:0});
  await expect(pending()).rejects.toThrow('child_release_pending');
  expect(Date.parse((await wait()).waiting_for_workspace_release.since)).toBeLessThan(Date.now()+1000);
  await db.pool.query(`UPDATE execution_workspaces SET state='ready',cleanup_state='cleaned',cleanup_json='{}',retention_json='{"state":"reclaimed"}',inventory_json='{"worktree":false,"registration":false,"branch":false}' WHERE id=$1`,[bound.workspace.id]);
  expect((await pending()).workspace.id).toBe(bound.workspace.id);
  expect((await wait()).waiting_for_workspace_release).toBeUndefined();
 });

 it('settles awaiting and blocked old-use lifecycles from physical proof before reuse without completing the new use',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();await child(c.parent);
  const first=await child(c.parent),bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[first]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[first]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated',base_commit=$2,source_commit=$2 WHERE id=$1",[bound.changeSetId,B]);
  const use=randomUUID();
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2,state='ready',retention_json=jsonb_build_object('slot_use_id',$3::text,'state','reclaimed'),cleanup_state='cleaned',cleanup_json='{}',inventory_json='{\"worktree\":false,\"registration\":false,\"branch\":false}' WHERE id=$1",[bound.workspace.id,B,use]);
  for(const phase of ['awaiting_release','blocked']){
   const id=randomUUID(),changeId=phase==='awaiting_release'?bound.changeSetId:randomUUID();
   if(changeId!==bound.changeSetId)await db.pool.query(`INSERT INTO workspace_change_sets SELECT (jsonb_populate_record(NULL::workspace_change_sets,to_jsonb(c)||jsonb_build_object('id',$2::text,'sequence',c.sequence+1))).* FROM workspace_change_sets c WHERE id=$1`,[bound.changeSetId,changeId]);
   await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,merged_commit,detail_json,created_at,updated_at,completed_at)
    VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$7,'refs/heads/main','merged',$8,$7,$9::jsonb,now(),now(),now())`,[id,SPACE,bound.workspace.id,changeId,LOCATION,randomUUID(),B,OWNER,JSON.stringify({lifecycle:{operation_id:id,slot_use_id:use,phase,workspace_id:bound.workspace.id,generation:1,base_commit:B,source_commit:B,target_ref:'refs/heads/main',landed_commit:B,publication_status:'merged',cleanup_key:'source-g1'}})]);
  }
  const reused=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION);
  const {readVisibleWorkspaceChanges}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const old=(await readVisibleWorkspaceChanges(db.pool,SPACE,OWNER,{where:"w.id=$2 AND c.state='integrated'",params:[bound.workspace.id]})).entries.map(e=>e.change);
  expect(old).toHaveLength(2);for(const row of old)expect(row.integration_detail?.lifecycle).toMatchObject({phase:'complete',slot_use_id:use});
  const newUse=reused.workspace.retention_json!.slot_use_id;
  expect(newUse).not.toBe(use);
  await db.pool.query(`INSERT INTO task_merges SELECT (jsonb_populate_record(NULL::task_merges,to_jsonb(m)||jsonb_build_object('id',$1::text,'attempt_id',$2::text,'change_set_id',$3::text,'detail_json',jsonb_build_object('lifecycle',(detail_json->'lifecycle')||jsonb_build_object('operation_id',$1::text,'slot_use_id',$4::text,'phase','awaiting_release'))))).* FROM task_merges m ORDER BY id LIMIT 1`,[randomUUID(),randomUUID(),reused.changeSetId,newUse]);
  const {refreshWorkspaceLifecycle}=await import('../src/modules/hosts/workspaceLifecycle.js');
  await refreshWorkspaceLifecycle(db.pool,bound.workspace.id);
  const phases=(await db.pool.query("SELECT detail_json->'lifecycle' AS lifecycle FROM task_merges ORDER BY id")).rows;
  expect(phases.find(r=>r.lifecycle.slot_use_id===use)!.lifecycle.phase).toBe('complete');
  expect(phases.find(r=>r.lifecycle.slot_use_id===newUse)!.lifecycle.phase).not.toBe('complete');
 });

 it('shows permanent checkpoint attention without retiring new live bindings and clears only on saved evidence',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const {lockUnchangedIdleWorkspace}=await import('../src/modules/hosts/workspaceReconcileFence.js');
  const {withQueryableTransaction}=await import('../src/modules/routeUtils/common.js');
  const {workspaceChangesForRun}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const row=async()=>(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[c.workspace])).rows[0];
  const check=async(w?:Awaited<ReturnType<typeof row>>)=>{const current=w??await row();return withQueryableTransaction(db.pool,tx=>lockUnchangedIdleWorkspace(tx,current));};
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[c.parent]);
  expect(await check()).toBe(false);expect((await row()).inventory_json.reconciliation_error).toBeUndefined();
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[c.parent]);
  expect(await check()).toBe(false);
  expect((await workspaceChangesForRun(db.pool,{id:c.parent,space_id:SPACE},OWNER))[0]).toMatchObject({cleanup_state:'blocked',cleanup_errors:['workspace_checkpoint_blocked']});
  const {refreshCleanupSummary}=await import('../src/modules/hosts/workspaceCleanup.js');
  await refreshCleanupSummary(db.pool,c.workspace);
  expect((await row()).cleanup_state).toBe('blocked');
  const {workspaceRetentionRegistration}=await import('../src/modules/projectFolders/workspaceRetentionOperations.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const operation=workspaceRetentionRegistration(new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d])));
  await withQueryableTransaction(db.pool,tx=>operation.execute(tx,{change_set_id:c.changeSet,action:'retry'},sessionActor({spaceId:SPACE,userId:OWNER}),{} as any));
  expect((await row()).inventory_json.reconciliation_error).toBe('workspace_checkpoint_blocked');
  expect((await row()).cleanup_state).toBe('blocked');
  const stale=await row();
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[c.parent]);
  expect(await check()).toBe(true);expect((await row()).inventory_json.reconciliation_error).toBeUndefined();
  await db.pool.query("UPDATE execution_workspaces SET materialization_epoch=materialization_epoch+1,revision=revision+1 WHERE id=$1",[c.workspace]);
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.parent]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[c.parent]);
  expect(await check(stale)).toBe(false);expect(await check()).toBe(false);
  expect(await row()).toMatchObject({state:'ready',inventory_json:{}});
 });

 it('bounds admission by the changing Room roster rather than a fixed four or delegation history',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator(),roster:string[]=[];
  for(let i=0;i<5;i++){
   const agent=i===0?AGENT:randomUUID();roster.push(agent);
   if(i)await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space:SPACE,owner:OWNER,now:new Date().toISOString()});
   await db.pool.query("INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,roomId,agent]);
  }
  await child(c.parent); // Coordinator's outstanding sibling keeps writers isolated.
  for(let i=0;i<4;i++)expect((await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION)).workspace.owner_kind).toBe('delegation');
  const waiting=await child(c.parent);
  for(let retry=0;retry<3;retry++)await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(waiting),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  await db.pool.query("UPDATE room_agent_members SET status='removed' WHERE agent_id=ANY($1::varchar[])",[roster.slice(2)]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(waiting),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(5);
  expect((await db.pool.query('SELECT 1 FROM execution_workspace_runs WHERE run_id=$1',[waiting])).rowCount).toBe(0);
 });

 it('counts the coordinator within the declared collaboration bound even in a larger Room',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator(),participants=[randomUUID(),randomUUID()];
  for(const agent of [AGENT,...participants,randomUUID()]){
   if(agent!==AGENT)await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space:SPACE,owner:OWNER,now:new Date().toISOString()});
   await db.pool.query("INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,roomId,agent]);
  }
  const task=randomUUID();
  await db.pool.query("UPDATE agent_run_groups SET budget_json=jsonb_build_object('collaboration',jsonb_build_object('task_id',$2::text,'coordinator_agent_id',$3::text,'participant_agent_ids',$4::jsonb,'max_delegations',12)) WHERE id=$1",[groupId,task,AGENT,JSON.stringify(participants)]);
  await child(c.parent);
  const scoped=async()=>{const id=await child(c.parent);await db.pool.query("UPDATE run_delegations SET budget_json=jsonb_build_object('collaboration_task_id',$2::text) WHERE child_run_id=$1",[id,task]);return load(id);};
  for(let i=0;i<2;i++)await ensurePrimaryExecutionWorkspace(db.pool,await scoped(),HOST,LOCATION);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await scoped(),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(3);
 });

 it('converges real parallel Host trees across five merge/cancel/failure rounds and reuses the same bounded slots',async ctx=>{
  if(!db.available)return ctx.skip();
  const {mkdtemp,mkdir,writeFile,rm,access}=await import('node:fs/promises');
  const {join}=await import('node:path'),{tmpdir}=await import('node:os'),{execFileSync,spawn}=await import('node:child_process');
  const {saveConfig}=await import('../../packages/host-daemon/src/config.js');
  const {acquireLocationLeases,releaseLocationLeases}=await import('../../packages/host-daemon/src/locationLease.js');
  const {workspaceWorktreeKey}=await import('../../packages/host-daemon/src/worktreeIdentity.js');
  const {taskLeaseKey,checkLocationRepository}=await import('../../packages/host-daemon/src/taskWorktree.js');
  const {prepareExecutionWorkspace,executeWorkspaceCommand}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const {recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {checkpointWorkspaceRun}=await import('../src/modules/hosts/workspaceCheckpoints.js');
  const {sharedHostConnectionRegistry:hosts}=await import('../src/modules/hosts/connectionRegistry.js');
  const original={request:hosts.requestTaskBranch,online:hosts.isOnline};
  const liveLaunches=new Map<string,{lease:string;process:ReturnType<typeof spawn>}>();
  const {resolveWorkspaceScope}=await import('../../packages/host-daemon/src/workspaceScope.js');
  const {executeWorkspaceIntegration}=await import('../../packages/host-daemon/src/workspaceIntegration.js');
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {canonicalRunOutput}=await import('../src/modules/runs/orchestrationResults.js');
  const {enqueueWorkspaceIntegration,advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
  const {JobWorker}=await import('../src/modules/jobs/worker.js');
  const {executeRemoteHostCliAdapter,NO_PROVIDER_BINDINGS}=await import('../src/modules/runs/remoteHostCliAdapter.js');
  const {processNativeWorkspaceRequest}=await import('../src/modules/hosts/workspaceNativeIntegration.js');
  const {registerExecutionWorkspaceJobs}=await import('../src/modules/hosts/executionWorkspaceJobs.js');
  const {executionWorkspacePath}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const {runActor,sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {loadConfig}=await import('../src/config.js');
  const {enqueueWorkspaceCleanup,advanceWorkspaceCleanup}=await import('../src/modules/hosts/workspaceCleanup.js');
  const root=await mkdtemp(join(tmpdir(),'parallel-slots-pg-')),repo=join(root,'repo'),previous=process.env.RAINVER_HOST_CONFIG_DIR;
  await mkdir(repo);process.env.RAINVER_HOST_CONFIG_DIR=join(root,'config');
  const git=(args:string[],cwd=repo)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  try{
   git(['init','-q','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.com']);
   await writeFile(join(repo,'base.txt'),'base');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']);
   await saveConfig({server_url:'http://127.0.0.1:9',host_id:HOST,trust:'trusted',token:'fixture',workspaces:{[LOCATION]:repo}});
   await capabilities({native_workspace_integration:true,native_workspace_rebase:true,execution_workspaces:{version:2,reclaim:6,shared_review:1,preserve_source:1,lifecycle:1},workspace_read_only:{supported:true}});
   const extras=[randomUUID(),randomUUID()];for(const extra of extras)await seedAgentWithVersion(db.pool,{agent:extra,version:randomUUID(),space:SPACE,owner:OWNER,now:new Date().toISOString()});
   for(const agent of [AGENT,...extras])await db.pool.query("INSERT INTO room_agent_members(id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),SPACE,roomId,agent]);
   const c=await coordinator();collaborationTask=randomUUID();
   await db.pool.query("UPDATE agent_run_groups SET budget_json=jsonb_build_object('collaboration',jsonb_build_object('task_id',$2::text,'coordinator_agent_id',$3::text,'participant_agent_ids',$4::jsonb,'max_delegations',12)) WHERE id=$1",[groupId,collaborationTask,AGENT,JSON.stringify(extras)]);
   await db.pool.query("UPDATE runs SET status='running',run_group_id=$2 WHERE id=$1",[c.parent,groupId]);
   await db.pool.query('UPDATE execution_workspaces SET base_commit=$2,head_commit=$2,head_sequence=0 WHERE id=$1',[c.workspace,base]);
   await db.pool.query('UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$2 WHERE run_id=$1',[c.parent,base]);
   await db.pool.query('UPDATE workspace_change_sets SET base_commit=$2,source_commit=$2 WHERE id=$1',[c.changeSet,base]);
   const check=await checkLocationRepository(repo);if(check.kind!=='repository')throw new Error('fixture');
   const main=await prepareExecutionWorkspace(check.repo,LOCATION,{id:c.workspace,generation:1,base_commit:base,target_ref:'refs/heads/main'},c.parent);
   hosts.isOnline=()=>true;
   let dropPublish=true,dropCleanup=true;const lateCleanups:any[]=[];
   hosts.requestTaskBranch=async(_h,type,frame):Promise<any>=>{
    if(type==='workspace_scope')return resolveWorkspaceScope({type,request_id:randomUUID(),...frame} as any,{[LOCATION]:repo},null);
    const reply=type==='workspace_integration'?await executeWorkspaceIntegration(repo,{type,request_id:randomUUID(),...frame} as any):await executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),...frame} as any);
    if((frame as any).action==='native_publish'&&reply.ok&&dropPublish){dropPublish=false;return {...reply,ok:false,error:'host_disconnected'};}
    if((frame as any).action==='cleanup'&&!(frame as any).workspace.execution_workspace.integration_id&&reply.ok){
     lateCleanups.push(frame);
     if(dropCleanup){dropCleanup=false;return {...reply,ok:false,error:'host_disconnected'};}
    }
    return reply;
   };
   const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),engine=await operationRuntime(config);
   let waitingId:string|undefined,waitingJob:string|undefined,worker:InstanceType<typeof JobWorker>|undefined;let launches=0;
   const queue=new PgJobQueueRepository(db.pool);
   const slots=new Set<string>(),recoveries:string[]=[];let peak=0;
   for(let round=0;round<5;round++){
    await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.parent]);
    const mainLease=taskLeaseKey(LOCATION,workspaceWorktreeKey({id:c.workspace,generation:1}));
    await acquireLocationLeases([mainLease],{runId:c.parent,launchId:c.parent},()=>{throw new Error('unexpected coordinator lease wait');});
    const mainProcess=spawn(process.execPath,['-e','process.stdout.write("ready");process.stdin.resume()'],{cwd:main.root,env:{PATH:process.env.PATH??''},stdio:['pipe','pipe','ignore']});
    liveLaunches.set(c.parent,{lease:mainLease,process:mainProcess});
    await new Promise<void>((resolve,reject)=>{mainProcess.stdout!.once('data',()=>resolve());mainProcess.once('error',reject);});

    const blocker=await child(c.parent),ids=[await child(c.parent),await child(c.parent)];
    let resumeInspection:(()=>void)|undefined,inspectionScan:Promise<unknown>|undefined,raceThread:string|undefined;
    const requestBeforeRace=hosts.requestTaskBranch;
    if(round===1){
     const target=[...slots].at(-1)!;
     const {PgHostThreadRepository}=await import('../src/modules/hosts/threadRepository.js');
     raceThread=(await new PgHostThreadRepository(db.pool).create({executionHostId:HOST,workspaceLocationId:LOCATION,runtimeKey:'opencode',createdByUserId:OWNER})).id;
     await db.pool.query('UPDATE host_threads SET execution_workspace_json=$2::jsonb WHERE id=$1',[raceThread,JSON.stringify({id:target,generation:1})]);
     let entered!:()=>void;const inspected=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resumeInspection=resolve;});
     hosts.requestTaskBranch=async(h,type,f):Promise<any>=>{
      const reply=await requestBeforeRace(h,type,f);
      if(type==='execution_workspace_command'&&(f as any).action==='inspect'&&(f as any).workspace.execution_workspace.id===target){entered();await gate;}
      return reply;
     };
     inspectionScan=reconcileExecutionWorkspaces(db.pool,'/',{hosts});
     await inspected;
    }
    const bounds=await Promise.all(ids.map(async id=>ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION)));
    const paths:string[]=[],leases:string[]=[];
    for(let i=0;i<bounds.length;i++){
     const bound=bounds[i]!,id=ids[i]!;slots.add(bound.workspace.id);
     const prepared=await prepareExecutionWorkspace(check.repo,LOCATION,bound.ref,id);paths.push(prepared.root);
     await recordWorkspaceLaunch(db.pool,await load(id),{id:bound.workspace.id,generation:1,start_commit:prepared.startCommit,target_ref:prepared.targetRef,launch_sequence:prepared.launchSequence});
     await db.pool.query("UPDATE runs SET status='running',started_at=now() WHERE id=$1",[id]);
     const lease=taskLeaseKey(LOCATION,workspaceWorktreeKey(bound.ref));leases.push(lease);
     await acquireLocationLeases([lease],{runId:id,launchId:id},()=>{throw new Error('unexpected fixture lease wait');});
     const processHandle=spawn(process.execPath,['-e','process.stdout.write("ready");process.stdin.resume()'],{cwd:prepared.root,env:{PATH:process.env.PATH??''},stdio:['pipe','pipe','ignore']});
     liveLaunches.set(id,{lease,process:processHandle});
     await new Promise<void>((resolve,reject)=>{processHandle.stdout!.once('data',()=>resolve());processHandle.once('error',reject);});
     if(round<3)await writeFile(join(prepared.root,`round-${round}-${i}.txt`),`round ${round} child ${i}`);
    }
    if(round===4){
     for(const old of lateCleanups.slice(0,2)){
      const answer=await executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),...old} as any);
      expect(answer.ok).toBe(false);
     }
     for(const path of paths)await access(path);
    }
    if(inspectionScan){
     resumeInspection!();await inspectionScan;hosts.requestTaskBranch=requestBeforeRace;
     expect((await db.pool.query('SELECT status FROM host_threads WHERE id=$1',[raceThread])).rows[0].status).toBe('active');
     for(const bound of bounds){
      const current=(await db.pool.query('SELECT state,inventory_json FROM execution_workspaces WHERE id=$1',[bound.workspace.id])).rows[0];
      expect(current.state).toBe('ready');expect(current.inventory_json.worktree).toBe(true);
     }
    }
    const over=await Promise.all(Array.from({length:6},()=>child(c.parent)));
    for(const id of over)await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
    await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=ANY($1::varchar[])",[over]);
    peak=Math.max(peak,git(['worktree','list','--porcelain']).match(/^worktree /gm)!.length-1);
    const coordinatorExited=new Promise<void>(resolve=>mainProcess.once('exit',()=>resolve()));mainProcess.stdin!.end();await coordinatorExited;
    liveLaunches.delete(c.parent);releaseLocationLeases([mainLease],c.parent);
    await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[c.parent]);
    for(let i=0;i<bounds.length;i++){
     const bound=bounds[i]!,id=ids[i]!;
     if(round===0&&i===1){
      const processHandle=liveLaunches.get(id)?.process;
     if(processHandle){const exited=new Promise<void>(resolve=>processHandle.once('exit',()=>resolve()));processHandle.stdin!.end();await exited;liveLaunches.delete(id);}
     releaseLocationLeases([leases[i]!],id);
      await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now(),output_json=$2::jsonb WHERE id=$1",[id,JSON.stringify(canonicalRunOutput({success:true,outputText:'',outputJson:{execution_workspace_location:{kind:'location',workspace_location_id:LOCATION,execution_workspace:bound.ref},execution_workspace_access:[]}}))]);
      await checkpointWorkspaceRun(db.pool,id,SPACE,hosts);
      const current=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[bound.changeSetId])).rows[0];
      const receipt=await engine.execute('workspace.change.complete',{change_set_id:bound.changeSetId,expected_revision:current.revision,summary:'Controlled real Host publication'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
      expect(receipt.http_status,JSON.stringify(receipt.body)).toBe(200);
      const merge=await enqueueWorkspaceIntegration(db.pool,bound.changeSetId!,SPACE,OWNER);expect(merge).toBeTruthy();
      expect(await advanceWorkspaceIntegration(db.pool,config,merge!,SPACE,{hosts,verify:async input=>{
       if(input.target.workspace?.kind!=='location'||!input.target.workspace.execution_workspace)throw new Error('candidate workspace required');
       const candidate=await executionWorkspacePath(repo,LOCATION,input.target.workspace.execution_workspace);
       git(['diff','--check'],candidate);return {status:'passed',checks:[{key:'git_diff',verifier_type:'test',status:'passed',summary:'Real candidate Git check'}]};
      }})).toEqual({status:'integrated'});
      const legacyHead=git(['rev-parse','HEAD'],main.root);
      const {registerTaskMergeHandler}=await import('../src/modules/hosts/taskMerges.js');
      const legacyRegistry=new JobHandlerRegistry();registerTaskMergeHandler(legacyRegistry,config,{hosts});
      const legacyWorker=new JobWorker(new PgJobQueueRepository(db.pool),legacyRegistry,'legacy-round-0',['task_merge']);
      expect(await legacyWorker.processOne()).toMatchObject({status:'completed'});
      expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='task_merge' AND status IN ('pending','claimed','running') AND payload_json->>'merge_id'=$1",[merge])).rowCount).toBe(0);
      expect(git(['rev-parse','HEAD'],main.root)).toBe(legacyHead);
      const landed=git(['rev-parse','HEAD'],main.root);
      await db.pool.query('UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1',[c.parent,landed]);
      await reconcileExecutionWorkspaces(db.pool,'/',{hosts});
     }else if(round!==1){
      await db.pool.query('UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1',[id,JSON.stringify({tool_grants:['workspace.change.complete','workspace.change.get'].map(action_id=>({action_id}))})]);
      if(round<3){git(['add','.'],paths[i]!);git(['commit','-qm','Child contribution'],paths[i]!);}
      const actor=await runActor(db.pool,await load(id));
      const read=async()=>{const r=await engine.execute('workspace.change.get',{change_set_id:bound.changeSetId},actor,randomUUID(),undefined);expect(r.http_status,JSON.stringify(r.body)).toBe(200);return (r.body as any).data;};
      let current=await read();
      git(['diff','--check'],paths[i]!);
      for(const action of ['prepare','publish']){
       const r=await engine.execute('workspace.change.complete',{change_set_id:bound.changeSetId,expected_revision:current.revision,summary:'Real Host Git lifecycle',action,...(action==='publish'?{verification:{commit:current.progress.commit,checks:[{command:'git diff --check',summary:'Checked real temporary source'}],note:'Same fixture runtime'}}:{})},actor,randomUUID(),randomUUID());
       expect(r.http_status,JSON.stringify(r.body)).toBe(200);current=await read();
       if(current.progress.status==='pending'){
        const landedBeforeReplay=git(['rev-parse','HEAD'],main.root);
        await processNativeWorkspaceRequest(db.pool,config,bound.changeSetId!,SPACE,current.progress.request_id,hosts);
        expect(git(['rev-parse','HEAD'],main.root)).toBe(landedBeforeReplay);current=await read();
       }
       if(current.progress.status==='no_changes')break;
       expect(current.progress.status,JSON.stringify(current)).toBe(action==='prepare'?'prepared':'merged');
      }
      expect(current.lifecycle).toMatchObject({phase:'awaiting_release'});
      const landed=git(['rev-parse','HEAD'],main.root);
      await db.pool.query('UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1',[c.parent,landed]);
     }
      // afterCommit may already have delivered the intent, but only the real
      // worker consumes its durable Job. Replaying delivery must not move HEAD.
      const deliveredHead=git(['rev-parse','HEAD'],main.root);
      const nativeRegistry=new JobHandlerRegistry();registerExecutionWorkspaceJobs(nativeRegistry,config,hosts);
      const nativeWorker=new JobWorker(new PgJobQueueRepository(db.pool),nativeRegistry,`native-round-${round}-${i}`,['execution_workspace_native_integrate']);
      const activeNative=async()=>Number((await db.pool.query("SELECT count(*) FROM jobs WHERE job_type='execution_workspace_native_integrate' AND status IN ('pending','claimed','running') AND payload_json->>'change_set_id'=$1",[bound.changeSetId])).rows[0].count);
      for(let delivery=0;await activeNative()>0&&delivery<20;delivery++)expect(await nativeWorker.processOne()).toMatchObject({status:'completed'});
      expect(await activeNative()).toBe(0);
      expect(git(['rev-parse','HEAD'],main.root)).toBe(deliveredHead);
     const processHandle=liveLaunches.get(id)?.process;
     if(processHandle){const exited=new Promise<void>(resolve=>processHandle.once('exit',()=>resolve()));processHandle.stdin!.end();await exited;liveLaunches.delete(id);}
     releaseLocationLeases([leases[i]!],id);
     await db.pool.query("UPDATE runs SET status=$2,ended_at=now() WHERE id=$1",[id,round===1?i===0?'cancelled':'failed':'succeeded']);
     await checkpointWorkspaceRun(db.pool,id,SPACE,hosts);
     const tip=git(['rev-parse',`rainver/workspace-${bound.workspace.id}-g1`]);
     const w=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[bound.workspace.id])).rows[0];
     if(round===1){
      // Cancellation/failure preserves the checkpoint, but its open batch must
      // first be withdrawn through the person's existing closure operation.
      const revision=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[bound.changeSetId])).rows[0].revision;
      const withdrawn=await engine.execute('workspace.change.abandon',{change_set_id:bound.changeSetId,expected_revision:revision,reason:'Keep cancelled/failed fixture work without merging'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
      expect(withdrawn.http_status,JSON.stringify(withdrawn.body)).toBe(200);
      expect((await db.pool.query('SELECT source_commit,state FROM workspace_change_sets WHERE id=$1',[bound.changeSetId])).rows[0]).toMatchObject({source_commit:tip,state:'abandoned'});
      await enqueueWorkspaceCleanup(db.pool,w,{id:w.id,generation:1},tip,true,OWNER);
     }
     if(round===4&&i===0){
      waitingId=await child(c.parent);
      await db.pool.query("INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES($1,$2,$3,1,'running',now(),now())",[randomUUID(),SPACE,waitingId]);
      const registry=new JobHandlerRegistry();
      registry.register('workspace_slot_acceptance',async()=>{
       await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[waitingId]);
       const run=await load(waitingId!);
       const result=await executeRemoteHostCliAdapter({run:run as any,prompt:'Read current checkpoint',model:null,resume_session_id:null},HOST,LOCATION,{config,db:db.pool,bindings:NO_PROVIDER_BINDINGS,connectionRegistry:hosts});
       expect(launches,JSON.stringify(result)).toBe(1);return {launched:true};
      });
      waitingJob=(await queue.enqueue({job_type:'workspace_slot_acceptance',space_id:SPACE,user_id:OWNER,payload:{run_id:waitingId}})).id;
      worker=new JobWorker(queue,registry,'slot-acceptance',['workspace_slot_acceptance']);
      await db.pool.query("UPDATE runs SET created_at=now()-interval '2 hours' WHERE id=$1",[waitingId]);
      const waiting=await worker.processOne();expect(waiting,JSON.stringify(waiting)).toMatchObject({status:'deferred'});
      expect((await db.pool.query('SELECT status,error,attempts FROM jobs WHERE id=$1',[waitingJob])).rows[0]).toMatchObject({status:'pending',error:'workspace_placement_blocked:child_release_pending',attempts:0});
      expect((await load(waitingId)).status).toBe('running');expect(launches).toBe(0);
      await db.pool.query("UPDATE execution_workspaces SET cleanup_state='blocked' WHERE id=$1",[w.id]);
      const blocked=await executeRemoteHostCliAdapter({run:await load(waitingId) as any,prompt:'Read current checkpoint',model:null,resume_session_id:null},HOST,LOCATION,{config,db:db.pool,bindings:NO_PROVIDER_BINDINGS,connectionRegistry:hosts});
      expect(blocked).toMatchObject({success:false,error_code:'execution_workspace_unavailable'});
      expect(blocked.error_message).toContain('child_release_blocked');
      const {refreshCleanupSummary}=await import('../src/modules/hosts/workspaceCleanup.js');await refreshCleanupSummary(db.pool,w.id);

     }
     if((round===0||round===1)&&i===0){
      await capabilities({native_workspace_integration:true,native_workspace_rebase:true,execution_workspaces:{version:2,reclaim:6,...(round===0?{preserve_source:1}:{})}});
      const r=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].cleanup_json['source-g1'];
      expect(await advanceWorkspaceCleanup(db.pool,w.id,'source-g1',r.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'blocked'});
      expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].cleanup_json['source-g1'].error).toBe(round===0?'workspace_lifecycle_host_upgrade_required':'workspace_preservation_host_upgrade_required');
      await access(paths[i]!);expect(git(['rev-parse',`rainver/workspace-${w.id}-g1`])).toBe(tip);
      await capabilities({native_workspace_integration:true,native_workspace_rebase:true,execution_workspaces:{version:2,reclaim:6,shared_review:1,preserve_source:1,lifecycle:1},workspace_read_only:{supported:true}});
      const {reconcileExecutionWorkspaces}=await import('../src/modules/hosts/workspaceReconcile.js');
      await reconcileExecutionWorkspaces(db.pool,'/',{hosts});
      expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].cleanup_json['source-g1'].state).toBe('pending');
     }

     for(let attempt=0;attempt<12;attempt++){
      const resources=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].cleanup_json;
      const owed=Object.entries(resources).filter(([key,r]:[string,any])=>(!r.kind||key.startsWith('refs-g'))&&r.state!=='cleaned');
      if(!owed.length)break;
      for(const [key,r] of owed as Array<[string,any]>)await advanceWorkspaceCleanup(db.pool,w.id,key,r.operation_id,OWNER,hosts).catch(e=>{if(!['workspace_refs_next_page','workspace_source_repin','workspace_cleanup_dependent_cleanup','host_disconnected'].includes(e.message))throw e;});
     }
     await expect(access(paths[i]!)).rejects.toThrow();
     expect(git(['branch','--list',`rainver/workspace-${w.id}-g1`]),JSON.stringify({round,i,workspace:(await db.pool.query('SELECT retention_json,cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0],changes:(await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE workspace_id=$1',[w.id])).rows})).toBe('');
     const retention=(await db.pool.query('SELECT retention_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].retention_json;
     if(round===1){
      expect(retention.preserved_commit).toBe(tip);recoveries.push(retention.recovery_ref);
      expect(git(['show',`${retention.recovery_ref}:round-${round}-${i}.txt`])).toBe(`round ${round} child ${i}`);
     }else {
      expect(retention.state).toBe('reclaimed');
      const landed=(await db.pool.query("SELECT id,detail_json->'lifecycle' AS lifecycle FROM task_merges WHERE change_set_id=$1",[bound.changeSetId])).rows[0];
      expect(landed.lifecycle).toMatchObject({phase:'complete'});
      const resource=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[w.id])).rows[0].cleanup_json['source-g1'];
      expect(resource.owner_integration_id).toBe(landed.id);
     }
    }
    await db.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1",[blocker]);
    expect(git(['worktree','list','--porcelain']).match(/^worktree /gm)).toHaveLength(2);
    expect(git(['for-each-ref','--format=%(refname)','refs/heads/rainver/']).split('\n')).toHaveLength(1);
   }
   const waitingSink={send(frame:Record<string,unknown>){
    if(frame.type!=='launch')return;
    launches++;
    void (async()=>{
     const ref=(frame as any).workspace.execution_workspace;
     const prepared=await prepareExecutionWorkspace(check.repo,LOCATION,ref,waitingId!);
     await recordWorkspaceLaunch(db.pool,await load(waitingId!),{id:ref.id,generation:ref.generation,start_commit:prepared.startCommit,target_ref:prepared.targetRef,launch_sequence:prepared.launchSequence});
     hosts.receiveComplete(HOST,waitingId!,{exit_code:0,timed_out:false,error:null},String(frame.launch_id));
    })();
   },close(){}};
   hosts.registerConnection(HOST,waitingSink);
   await db.pool.query("UPDATE jobs SET scheduled_at=now()-interval '1 minute' WHERE id=$1",[waitingJob]);
   const resumed=await worker!.processOne();
   expect(resumed,JSON.stringify(resumed)).toMatchObject({status:'completed'});expect(launches).toBe(1);
   hosts.unregisterConnection(HOST,waitingSink);
   await db.pool.query("UPDATE runs SET status='cancelled',ended_at=now() WHERE id=$1",[waitingId]);
   await checkpointWorkspaceRun(db.pool,waitingId!,SPACE,hosts);
   const reused=await ensurePrimaryExecutionWorkspace(db.pool,await load(waitingId!),HOST,LOCATION);
   for(let attempt=0;attempt<12;attempt++){
    const resources=(await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[reused.workspace.id])).rows[0].cleanup_json;
    const owed=Object.entries(resources).filter(([key,r]:[string,any])=>(!r.kind||key.startsWith('refs-g'))&&r.state!=='cleaned');
    if(!owed.length)break;
    for(const [key,r] of owed as Array<[string,any]>)await advanceWorkspaceCleanup(db.pool,reused.workspace.id,key,r.operation_id,OWNER,hosts).catch(e=>{if(!['workspace_refs_next_page','workspace_source_repin'].includes(e.message))throw e;});
   }
   expect(git(['worktree','list','--porcelain']).match(/^worktree /gm)).toHaveLength(2);
   expect(slots.size).toBe(2);expect(peak).toBe(3);
   expect((await db.pool.query('SELECT count(*)::int AS n FROM task_merges')).rows[0].n).toBe(8);
   for(let i=0;i<recoveries.length;i++)expect(git(['show',`${recoveries[i]}:round-1-${i}.txt`])).toBe(`round 1 child ${i}`);
  }finally{for(const [id,launch] of liveLaunches){launch.process.kill();releaseLocationLeases([launch.lease],id);}hosts.requestTaskBranch=original.request;hosts.isOnline=original.online;if(previous===undefined)delete process.env.RAINVER_HOST_CONFIG_DIR;else process.env.RAINVER_HOST_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
 });

 it('reuses one physical conversation branch through forty serial child writes and binding retries',async ctx=>{
  if(!db.available)return ctx.skip();
  const {mkdtemp,mkdir,writeFile,rm,access}=await import('node:fs/promises');
  const {execFileSync}=await import('node:child_process');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {saveConfig}=await import('../../packages/host-daemon/src/config.js');
  const {checkLocationRepository}=await import('../../packages/host-daemon/src/taskWorktree.js');
  const {prepareExecutionWorkspace,executeWorkspaceCommand}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const {recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {checkpointWorkspaceRun}=await import('../src/modules/hosts/workspaceCheckpoints.js');
  const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
  const root=await mkdtemp(join(tmpdir(),'serial-workspace-pg-')),repo=join(root,'repo'),previous=process.env.RAINVER_HOST_CONFIG_DIR;
  await mkdir(repo);process.env.RAINVER_HOST_CONFIG_DIR=join(root,'config');
  const git=(args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
  try{
   git(['init','-q','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.com']);
   await writeFile(join(repo,'file.txt'),'base');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']);
   await saveConfig({server_url:'http://127.0.0.1:9',host_id:HOST,trust:'trusted',token:'fixture',workspaces:{[LOCATION]:repo}});
   const c=await coordinator();
   await db.pool.query('UPDATE execution_workspaces SET base_commit=$2,head_commit=$2,head_sequence=0 WHERE id=$1',[c.workspace,base]);
   await db.pool.query('UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$2 WHERE run_id=$1',[c.parent,base]);
   await db.pool.query('UPDATE workspace_change_sets SET base_commit=$2,source_commit=$2 WHERE id=$1',[c.changeSet,base]);
   const check=await checkLocationRepository(repo);if(check.kind!=='repository')throw new Error('fixture');
   const hosts=new HostConnectionRegistry();
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),...frame} as any);
   let physical='';
   for(let i=0;i<40;i++){
    const id=await child(c.parent,'write','running'),bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION);
    expect(bound).toMatchObject({workspace:{id:c.workspace},sharedWithCoordinator:true});
    expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace}});
    const prepared=await prepareExecutionWorkspace(check.repo,LOCATION,bound.ref,id);
    if(physical)expect(prepared.root).toBe(physical);physical=prepared.root;
    const observed:any=await executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:bound.ref},action:'inspect',run_id:id,retain_branch:true});
    expect(observed.ok).toBe(true);await recordWorkspaceLaunch(db.pool,await load(id),observed.launch_info);
    await writeFile(join(physical,'file.txt'),`serial child ${i}`);
    await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now() WHERE id=$1",[id]);
    await checkpointWorkspaceRun(db.pool,id,SPACE,hosts);
    expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[id])).rows[0].checkpoint_state).toBe('saved');
    expect(git(['for-each-ref','--format=%(refname)','refs/heads/rainver/']).split('\n')).toHaveLength(1);
   }
   expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(1);
   expect(git(['worktree','list','--porcelain']).match(/^worktree /gm)).toHaveLength(2);await access(physical);
   expect(git(['show',`rainver/workspace-${c.workspace}-g1:file.txt`])).toBe('serial child 39');
  }finally{if(previous===undefined)delete process.env.RAINVER_HOST_CONFIG_DIR;else process.env.RAINVER_HOST_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
 });

 it('gives parallel writers independent forks and never places a child in another conversation',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const a=await child(c.parent),b=await child(c.parent);
  const bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(a),HOST,LOCATION);
  expect(bound.workspace).toMatchObject({owner_kind:'delegation',parent_workspace_id:c.workspace});
  // No Room roster and no live concurrent executions: a single temporary slot.
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(b),HOST,LOCATION)).rejects.toThrow('workspace_slot_capacity');
  // A workspace that moved since the coordinator saved, or has another unsettled writer, is not reused either.
  const c2=await coordinator();
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[c2.workspace,'c'.repeat(40)]);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c2.parent)),HOST,LOCATION)).rejects.toThrow('workspace_placement_blocked:parent_checkpoint_moved');
 });

 it('keeps a pending frozen review isolated from new shared writers, and ignores independent fork writers for review',async ctx=>{
  if(!db.available)return ctx.skip();
  await capabilities({execution_workspaces:{version:2,reclaim:6,shared_review:1},workspace_read_only:{supported:true}});
  const c=await coordinator();
  const reader=await child(c.parent,'read');
  await ensurePrimaryExecutionWorkspace(db.pool,await load(reader),HOST,LOCATION);
  const writer=await child(c.parent);
  const fork=await ensurePrimaryExecutionWorkspace(db.pool,await load(writer),HOST,LOCATION);
  expect(fork.workspace.owner_kind).toBe('delegation');
  const second=await child(c.parent,'read');
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(second),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace},review:{commit:B}});
 });

 it('blocks repeated new forks behind a settled temporary resource instead of accumulating history',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator(),a=await child(c.parent),b=await child(c.parent);
  const first=await ensurePrimaryExecutionWorkspace(db.pool,await load(a),HOST,LOCATION);
  await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2 WHERE id=$1",[first.workspace.id,B]);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[a]);
  // The other writer is still live; new work would otherwise keep making forks
  // around the failed child's preservation/cleanup responsibility.
  for(let i=0;i<12;i++){
   const next=await child(c.parent);
   await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(next),HOST,LOCATION)).rejects.toThrow('workspace_placement_blocked:child_release_pending');
   await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[next]);
  }
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(2);
  await db.pool.query("UPDATE execution_workspaces SET retention_json='{\"state\":\"reclaimed\"}'::jsonb WHERE id=$1",[first.workspace.id]);
  expect((await ensurePrimaryExecutionWorkspace(db.pool,await load(b),HOST,LOCATION)).workspace.id).toBe(c.workspace);
 });

 it('reviews the saved checkpoint read-only without a workspace, batch or checkpoint only on an enforcing Host',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  // Without shared_review and verified read-only namespaces: the existing fork.
  const unsupported=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent,'read')),HOST,LOCATION);
  expect(unsupported.workspace.owner_kind).toBe('delegation');
  await capabilities({execution_workspaces:{version:2,reclaim:5,shared_review:1},workspace_read_only:{supported:true,mechanism:'bwrap-v1',reason:null}});
  const c2=await coordinator();
  const reviewer=await child(c2.parent,'read');
  const before=(await db.pool.query("SELECT (SELECT count(*) FROM execution_workspaces)::int AS w,(SELECT count(*) FROM workspace_change_sets)::int AS c,(SELECT count(*) FROM jobs WHERE job_type='execution_workspace_checkpoint')::int AS j")).rows[0];
  const review=await ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION);
  expect(review).toMatchObject({workspace:{id:c2.workspace},changeSetId:null,review:{commit:B},ref:{id:c2.workspace,review_commit:B,base_commit:B}});
  const after=(await db.pool.query("SELECT (SELECT count(*) FROM execution_workspaces)::int AS w,(SELECT count(*) FROM workspace_change_sets)::int AS c,(SELECT count(*) FROM jobs WHERE job_type='execution_workspace_checkpoint')::int AS j")).rows[0];
  expect(after).toEqual(before);
  expect((await db.pool.query("SELECT 1 FROM execution_workspace_runs WHERE run_id=$1",[reviewer])).rowCount).toBe(0);
  // Only the expected basis is recorded before the Host verifies it: nothing claims it was reviewed.
  const basis=((await load(reviewer)).output_json as {review_basis:Record<string,unknown>}).review_basis;
  expect(basis).toMatchObject({execution_workspace_id:c2.workspace,expected_commit:B,mode:'coordinator_workspace',state:'pending'});
  expect(basis).not.toHaveProperty('review_commit');expect(basis).not.toHaveProperty('head');
  expect(reviewBasisLine(await load(reviewer))).toMatch(/^\[Not verified: /);
  // An unbound or independent writing sibling does not own the coordinator tree.
  const c3=await coordinator();
  await child(c3.parent,'write');
  const beside=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c3.parent,'read')),HOST,LOCATION);
  expect(beside).toMatchObject({workspace:{id:c3.workspace},review:{commit:B}});
 });
});

describe('delegated placement around unfinished integration',()=>{
 it('admits a frozen reader beside pending publication without opening a writer gate',async ctx=>{
  if(!db.available)return ctx.skip();
  await capabilities({execution_workspaces:{version:2,reclaim:6,shared_review:1},workspace_read_only:{supported:true}});
  const c=await coordinator();
  await db.pool.query("UPDATE workspace_change_sets SET verification_json=jsonb_build_object('native_progress',jsonb_build_object('status','pending','action','prepare')) WHERE id=$1",[c.changeSet]);
  const reader=await child(c.parent,'read');
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(reader),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace},review:{commit:B}});
  expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(1);
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION)).rejects.toThrow('workspace_placement_blocked:parent_recovery_required');
 });

 it('blocks without allocating another fork when the coordinator needs recovery',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  for(const status of ['prepared','conflict','target_moved','pending']){
   await db.pool.query("UPDATE workspace_change_sets SET verification_json=jsonb_build_object('native_progress',jsonb_build_object('status',$2::text,'action','prepare')) WHERE id=$1",[c.changeSet,status]);
   const id=await child(c.parent);
   await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION)).rejects.toThrow('workspace_placement_blocked:parent_recovery_required');
   await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[id]);
   expect((await db.pool.query('SELECT count(*)::int AS n FROM execution_workspaces')).rows[0].n).toBe(1);
  }
  await db.pool.query("UPDATE workspace_change_sets SET verification_json=jsonb_build_object('native_progress',jsonb_build_object('status','succeeded','action','checkpoint')) WHERE id=$1",[c.changeSet]);
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace},sharedWithCoordinator:true});
 });
});

describe('frozen delegated review basis',()=>{
 const C='c'.repeat(40);
 const counts=async()=>(await db.pool.query("SELECT (SELECT count(*) FROM execution_workspaces)::int AS w,(SELECT count(*) FROM workspace_change_sets)::int AS c,(SELECT count(*) FROM execution_workspace_runs)::int AS b")).rows[0];
 beforeEach(async()=>{if(db.available)await capabilities({execution_workspaces:{version:2,reclaim:5,shared_review:1},workspace_read_only:{supported:true,mechanism:'bwrap-v1',reason:null}});});

 it('replays the frozen review verbatim after the coordinator moved instead of re-placing or forking it',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const reviewer=await child(c.parent,'read');
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION)).toMatchObject({review:{commit:B},ref:{review_commit:B}});
  // The coordinator saved again (B -> C) before the review's retry was launched.
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[c.workspace,C]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[c.changeSet,C]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1",[c.parent,C]);
  const before=await counts();
  const replay=await ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION);
  expect(replay).toMatchObject({workspace:{id:c.workspace},changeSetId:null,review:{commit:B},ref:{id:c.workspace,review_commit:B,base_commit:B}});
  expect(await counts()).toEqual(before);
  // Even a placement that would now fork (a writer beside it) does not re-place the frozen review.
  await child(c.parent,'write');
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION)).toMatchObject({review:{commit:B}});
  expect(await frozenReview(db.pool,reviewer,SPACE)).toMatchObject({expected_commit:B,state:'pending'});
  await capabilities({execution_workspaces:{version:2},workspace_read_only:{supported:false}});
  await expect(ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION)).rejects.toMatchObject({statusCode:409});
  expect(await counts()).toEqual(before);
  expect(await frozenReview(db.pool,reviewer,SPACE)).toMatchObject({expected_commit:B,state:'pending'});
 });

 it.for(['execution_workspace_review_basis_moved','execution_workspace_review_namespace_unavailable'])('records Host refusal %s as not reviewed',async(code,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const reviewer=await child(c.parent,'read');
  await ensurePrimaryExecutionWorkspace(db.pool,await load(reviewer),HOST,LOCATION);
  // Not a Host review refusal code: nothing changes.
  expect(await recordReviewRefusal(db.pool,reviewer,SPACE,'Host is offline.')).toBe(false);
  expect(await recordReviewRefusal(db.pool,reviewer,SPACE,code)).toBe(true);
  expect(await frozenReview(db.pool,reviewer,SPACE)).toMatchObject({expected_commit:B,state:'refused'});
  await recordReviewObservation(db.pool,reviewer,SPACE,{head:B,tree:'d'.repeat(40)});
  expect(await frozenReview(db.pool,reviewer,SPACE)).toMatchObject({state:'refused'});
  expect(reviewBasisLine(await load(reviewer))).toMatch(/^\[Not reviewed: the Host refused to read your workspace at commit bbbbbbbbbbbb/);
 });

 it('marks the review done only when the Host reports reading exactly the expected commit',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const ok=await child(c.parent,'read');
  await ensurePrimaryExecutionWorkspace(db.pool,await load(ok),HOST,LOCATION);
  await recordReviewObservation(db.pool,ok,SPACE,{head:null,tree:null});
  expect(await frozenReview(db.pool,ok,SPACE)).toMatchObject({state:'pending'});
  await recordReviewObservation(db.pool,ok,SPACE,{head:B,tree:'d'.repeat(40)});
  expect(await frozenReview(db.pool,ok,SPACE)).toMatchObject({state:'verified'});
  await db.pool.query("UPDATE runs SET output_json=jsonb_set(output_json,'{review_basis,head}',to_jsonb($2::text)) WHERE id=$1",[ok,B]);
  expect(reviewBasisLine(await load(ok))).toBe('[Reviewed read-only at your workspace, commit bbbbbbbbbbbb.]');
  const c2=await coordinator();
  const other=await child(c2.parent,'read');
  await ensurePrimaryExecutionWorkspace(db.pool,await load(other),HOST,LOCATION);
  await recordReviewObservation(db.pool,other,SPACE,{head:C,tree:null});
  expect(await frozenReview(db.pool,other,SPACE)).toMatchObject({state:'refused'});
  expect(reviewBasisLine(await load(other))).toMatch(/^\[Not reviewed: /);
 });
});
