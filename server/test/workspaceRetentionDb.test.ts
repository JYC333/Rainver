import {mkdtemp,writeFile,chmod,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedRun,seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {loadConfig} from '../src/config.js';
import {HostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import {ensureExecutionWorkspace,recordWorkspaceLaunch} from '../src/modules/projectFolders/executionWorkspaces.js';
import {advanceWorkspaceCleanup,enqueueWorkspaceCleanup,replaceableSourceCleanup} from '../src/modules/hosts/workspaceCleanup.js';
import {assessWorkspaceRetention,classifyLocationRefs,configureWorkspaceRetention,refReleasePlan,type RefRelease} from '../src/modules/hosts/workspaceRetention.js';
import {sharedHostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import {readRunFilePreview} from '../src/modules/runs/filePreview.js';
import {reconcileExecutionWorkspaces} from '../src/modules/hosts/workspaceReconcile.js';
import {enqueueRefRelease} from '../src/modules/hosts/workspaceRefRelease.js';
import {enqueueWorkspaceIntegration} from '../src/modules/hosts/workspaceIntegrations.js';

const SPACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',PROJECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',LOCATION='11111111-1111-4111-8111-111111111111',MACHINE='22222222-2222-4222-8222-222222222222';
const HOST='33333333-3333-4333-8333-333333333333',AGENT='55555555-5555-4555-8555-555555555555',VERSION='66666666-6666-4666-8666-666666666666';
const CONVERSATION='88888888-8888-4888-8888-888888888888',MEMBER='99999999-9999-4999-8999-999999999999';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),D='d'.repeat(40);
const db=useTestDatabase(import.meta.filename);
let roomId='';

beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['host_threads','sessions','workspace_locations','project_folders','tasks','agents','agent_versions','rooms','projects','hosts','machines','space_memberships','users','spaces'],{cascade:true});
 const {now}=await seedSpaceOwnerProject(db.pool,{space:SPACE,owner:OWNER,project:PROJECT,now:new Date().toISOString()});
 roomId=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND is_mainline=true LIMIT 1',[SPACE])).rows[0]!.id;
 await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5)`,[CONVERSATION,SPACE,PROJECT,roomId,now]);
 await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repo','code','active',false,false,$4,$4)`,[FOLDER,SPACE,PROJECT,now]);
 await db.pool.query(`INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'M','desktop',$3,$3)`,[MACHINE,OWNER,now]);
 await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,created_at,updated_at) VALUES($1,$2,$3,'H','remote','linux_native','online','{"execution_workspaces":{"version":2,"reclaim":2}}'::jsonb,$4,$4)`,[HOST,OWNER,MACHINE,now]);
 await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/workspace/repo',true,'active',$5,$5)`,[LOCATION,SPACE,FOLDER,HOST,now]);
 await seedAgentWithVersion(db.pool,{agent:AGENT,version:VERSION,space:SPACE,owner:OWNER,now});
 configureWorkspaceRetention({workspaceReclaimGraceMinutes:10});
});

async function conversationRun(status='running'){
 const id=randomUUID();
 await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
 await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,status=$6,contract_snapshot_json='{"execution_workspace_version":1}' WHERE id=$1`,[id,PROJECT,CONVERSATION,LOCATION,OWNER,status]);
 return (await new PgRunRepository(db.pool).getRun(SPACE,id))!;
}
/** A finished turn whose saved change set closed as `state`, ended `minutes` ago. */
async function settled(state:'integrated'|'no_changes'|'open'|'blocked'|'abandoned',minutes=20,source=B){
 const run=await conversationRun();
 const w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2,base_commit=$3,target_ref='refs/heads/main',head_sequence=3 WHERE id=$1",[w.workspace.id,source,A]);
 await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state='saved',launch_sequence=3 WHERE run_id=$1",[run.id,A,source]);
 await db.pool.query("UPDATE workspace_change_sets SET state=$2,base_commit=$3,source_commit=$4,updated_at=now()-make_interval(mins=>$5) WHERE id=$1",[w.changeSetId,state,A,state==='no_changes'?A:source,minutes]);
 let mergeId:string|null=null;
 if(state==='integrated'){
  mergeId=randomUUID();
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,detail_json,created_at,updated_at,completed_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/main','merged',$9,$10,$10,'{"native_integration":true}'::jsonb,now(),now(),now())`,[mergeId,SPACE,w.workspace.id,w.changeSetId,LOCATION,randomUUID(),source,A,OWNER,C]);
 }
 await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now()-make_interval(mins=>$2),updated_at=now()-make_interval(mins=>$2) WHERE id=$1",[run.id,minutes]);
 const row=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
 return {run,w,row,mergeId};
}
/**
 * A registry whose stubbed Host behaves like a reclaim:2 Host for ref
 * operations: a release_refs reply that ran (it carries an inventory) also
 * proves its operation ended (`ref_operation`). Errors without an inventory
 * (timeout, offline, busy) prove nothing.
 */
function confirmingHosts(){
 const hosts=new HostConnectionRegistry();
 let stub:HostConnectionRegistry['requestTaskBranch']=hosts.requestTaskBranch.bind(hosts);
 Object.defineProperty(hosts,'requestTaskBranch',{configurable:true,get:()=>async(h:string,t:any,frame:any)=>{
  const reply:any=await stub(h,t,frame);
  if(frame.action==='release_refs'&&reply?.inventory&&reply.inventory.ref_operation===undefined)return {...reply,inventory:{...reply.inventory,ref_operation:frame.operation_id}};
  return reply;
 },set:(v)=>{stub=v;}});
 return hosts;
}
const inventory=(over:Record<string,unknown>={})=>({worktree:true,registration:true,branch:true,run_record:false,pending_run_id:null,merge_record:false,quarantined_whole:0,retained_quarantine:0,active:false,free_bytes:null,...over});
const cleaned=(over:Record<string,unknown>={})=>inventory({worktree:false,registration:false,branch:false,owned_refs:[],...over});
async function resource(id:string,key='source-g1'){return (await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[id])).rows[0].cleanup_json[key];}
async function workspace(id:string){return (await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[id])).rows[0];}
/** Run every open ref-page Job of the workspace until each finished (pages re-check shared sources). */
async function drainPages(id:string,hosts:HostConnectionRegistry,limit=12){
 for(let round=0;round<limit;round++){
  const open=Object.entries((await workspace(id)).cleanup_json as Record<string,any>).filter(([k,v])=>k.startsWith('refs-g')&&v.state!=='cleaned');
  if(!open.length)return round;
  for(const [k,v] of open)await advanceWorkspaceCleanup(db.pool,id,k,v.operation_id,OWNER,hosts).catch(e=>{if(!['workspace_refs_next_page','workspace_source_repin'].includes(e.message))throw e;});
 }
 throw new Error('ref pages did not finish');
}
const pageKey=async(id:string)=>Object.keys((await workspace(id)).cleanup_json).find(k=>k.startsWith('refs-g1'))!;
async function queued(id:string,tip=B){await enqueueWorkspaceCleanup(db.pool,await workspace(id),{id,generation:1},tip,true,OWNER);return resource(id);}

describe('isolated source retention',()=>{
 it('reclaims a merged source whose tip is not a target ancestor after the short grace only',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w,mergeId}=await settled('integrated',3);
  const hosts=confirmingHosts(),frames:any[]=[];
  const ownedRecovery=`refs/rainver/recovery/${w.workspace.id}/${B}`,native=`refs/rainver/native-preimages/${w.workspace.id}/g1/${randomUUID()}`,stray=`refs/rainver/recovery/${w.workspace.id}/${D}`;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:B,inventory:inventory({worktree:false,registration:false,owned_refs:[{ref:ownedRecovery,commit:B},{ref:native,commit:D},{ref:stray,commit:D}]}),error:null};
   return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned({owned_refs:[{ref:stray,commit:D}]}),error:null};};
  const first=await queued(w.workspace.id);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError',message:'workspace_cleanup_grace'});
  expect(frames).toHaveLength(0);
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'grace',reason:'merged'});
  expect(await resource(w.workspace.id)).toMatchObject({attempts:0});
  await db.pool.query("UPDATE runs SET ended_at=now()-interval '11 minutes',updated_at=now()-interval '11 minutes'");
  await db.pool.query("UPDATE workspace_change_sets SET updated_at=now()-interval '11 minutes'");
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  const cleanup=frames.find(f=>f.action==='cleanup');
  expect(cleanup).toMatchObject({retain_branch:false,expected_commit:B,workspace:{execution_workspace:{id:w.workspace.id,generation:1,target_ref:'refs/heads/main',materialization_epoch:0}}});
  expect(cleanup.reclaim_proof).toContain(C);
  const released=cleanup.release_refs.map((r:{ref:string})=>r.ref);
  expect(released).toEqual(expect.arrayContaining([ownedRecovery,native,`refs/rainver/recovery/${mergeId}`]));
  expect(released).not.toContain(stray);
  // Shared sources never ride on the planned first frame: a page re-checks and releases them.
  expect(released.filter((r:string)=>r.startsWith('refs/rainver/sources/'))).toEqual([]);
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'reclaiming',reason:'releasing_refs'});
  await drainPages(w.workspace.id,hosts);
  expect(frames.filter(f=>f.action==='release_refs').flatMap(f=>f.release_refs.map((r:{ref:string})=>r.ref))).toEqual(expect.arrayContaining([`refs/rainver/sources/${B}`,`refs/rainver/sources/${C}`]));
  const after=await workspace(w.workspace.id);
  expect(after).toMatchObject({materialization_epoch:1,cleanup_state:'cleaned',retention_json:{state:'reclaimed',reason:'merged',retained_refs:1}});
  // Local-change preimages are kept for their bounded retention, then released by CAS.
  expect(after.cleanup_json['local-preimages-g1']).toMatchObject({kind:'local_preimages',state:'pending',release_refs:expect.arrayContaining([{ref:`refs/rainver/local-preimages/${C}`,prefix:true,due_at:expect.any(String)}])});
 });

 it.for([
  ['open','unpublished_changes'],['blocked','blocked_changes'],['abandoned','kept_without_merging'],
 ] as const)('never releases a %s source by age',async([state,reason],ctx)=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled(state,60*30);
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return (frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}:{ok:true,commit:B,cleanup_state:'cleaned',inventory:cleaned({branch:true}),error:null};};
  const first=await queued(w.workspace.id);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(frames.find(f=>f.action==='cleanup')).toMatchObject({retain_branch:true});
  expect(frames.find(f=>f.action==='cleanup').release_refs).toBeUndefined();
  expect((await workspace(w.workspace.id))).toMatchObject({materialization_epoch:0,retention_json:{state:'retained',reason}});
 });

 it('keeps a parent with an open child, and a private-baseline tip the Host cannot prove',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  const child=randomUUID(),childRun=await conversationRun('succeeded'),delegation=randomUUID();
  await db.pool.query(`INSERT INTO run_delegations(id,space_id,parent_run_id,child_run_id,created_at) VALUES($1,$2,$3,$4,now())`,[delegation,SPACE,childRun.id,childRun.id]).catch(()=>undefined);
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,session_id,parent_workspace_id,generation) VALUES($1,$2,$3,$4,$5,'conversation',$6,$7,2)`,[child,SPACE,PROJECT,LOCATION,HOST,CONVERSATION,w.workspace.id]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit) VALUES($1,$2,$3,2,1,$4,$4,'open',$5,$6)`,[randomUUID(),child,SPACE,childRun.id,A,D]);
  expect(await assessWorkspaceRetention(db.pool,w.workspace.id)).toMatchObject({state:'retained',reason:'child_workspace_dependency'});
  await db.pool.query('DELETE FROM workspace_change_sets WHERE workspace_id=$1',[child]);
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('reclaimable');
  // A snapshot baseline or a quarantined whole tree is retained by the server
  // itself: no epoch is raised and no release is ever sent.
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return (frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}
   :{ok:true,commit:B,cleanup_state:'cleaned',inventory:cleaned({branch:true,branch_retained_reason:'workspace_reclaim_unproven'}),error:null};};
  await db.pool.query("UPDATE execution_workspaces SET baseline_mode='snapshot' WHERE id=$1",[w.workspace.id]);
  expect(await assessWorkspaceRetention(db.pool,w.workspace.id)).toMatchObject({state:'retained',reason:'private_baseline'});
  const snap=await queued(w.workspace.id);
  // Retained work keeps its branch; only its tree follows the 24-hour idle rule.
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',snap.operation_id,OWNER,hosts)).rejects.toMatchObject({message:'workspace_cleanup_idle_period'});
  expect(frames).toHaveLength(0);
  expect(await workspace(w.workspace.id)).toMatchObject({materialization_epoch:0,retention_json:{state:'retained',reason:'private_baseline'}});
  await db.pool.query(`UPDATE execution_workspaces SET baseline_mode='committed',inventory_json='{"quarantined_whole":1}'::jsonb WHERE id=$1`,[w.workspace.id]);
  expect(await assessWorkspaceRetention(db.pool,w.workspace.id)).toMatchObject({state:'retained',reason:'quarantined'});
  await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{}'::jsonb WHERE id=$1`,[w.workspace.id]);
  // A committed baseline the Host cannot prove: kept, and remembered for that tip.
  frames.length=0;
  const first=await queued(w.workspace.id);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(await workspace(w.workspace.id)).toMatchObject({retention_json:{state:'retained',reason:'unmerged_source',proof_refused_tip:B}});
  expect(await assessWorkspaceRetention(db.pool,w.workspace.id)).toMatchObject({state:'retained',reason:'unmerged_source'});
  // The refusal is retried once the target moved through a later integration on this Location.
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,merged_commit,created_at,updated_at,completed_at)
   SELECT $1::varchar,space_id,$2::varchar,id,$3::varchar,id,1,$4::varchar,$5::varchar,$6::varchar,'refs/heads/main','merged',$7::varchar,$5::varchar,now(),now(),now()+interval '1 second' FROM workspace_change_sets WHERE workspace_id=$2::varchar LIMIT 1`,[randomUUID(),w.workspace.id,LOCATION,randomUUID(),D,A,OWNER]);
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('reclaimable');
  await db.pool.query("DELETE FROM task_merges WHERE workspace_id=$1",[w.workspace.id]);
  await db.pool.query('UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1',[w.workspace.id,D]);
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('reclaimable');
 });

 it('continues the same conversation identity after a reclaim, from the target, without sequence regression',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=1,retention_json='{"state":"reclaimed","reason":"merged"}'::jsonb WHERE id=$1`,[w.workspace.id]);
  const next=await conversationRun();
  const bound=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  expect(bound.workspace.id).toBe(w.workspace.id);expect(bound.workspace.generation).toBe(1);
  expect(bound.ref).toMatchObject({id:w.workspace.id,generation:1,sync_to_target:true,materialization_epoch:1,launch_sequence_floor:3});
  expect(bound.ref.base_commit).toBeUndefined();
  await recordWorkspaceLaunch(db.pool,next,{id:w.workspace.id,generation:1,start_commit:C,target_ref:'refs/heads/main',launch_sequence:4});
  expect(await workspace(w.workspace.id)).toMatchObject({retention_json:{state:'active'}});
  // An older Host without the reclaim capability receives no new reference fields.
  await db.pool.query(`UPDATE hosts SET capabilities_json='{"execution_workspaces":{"version":2}}'::jsonb WHERE id=$1`,[HOST]);
  const legacy=await ensureExecutionWorkspace(db.pool,await conversationRun(),HOST,LOCATION);
  expect(legacy.ref).not.toHaveProperty('materialization_epoch');
 });

 it('fences an older release against a newer materialization and resumes a lost reply without re-raising the epoch',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  const hosts=confirmingHosts();let lose=true,cleanups=0;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:A,inventory:inventory(),error:null};
   cleanups++;if(lose)return {ok:false,commit:null,error:'host_timeout'};
   return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  const first=await queued(w.workspace.id,A);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(await resource(w.workspace.id)).toMatchObject({attempts:0,release_epoch:0,state:'retry_wait'});
  expect((await workspace(w.workspace.id)).materialization_epoch).toBe(1);
  lose=false;
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(await workspace(w.workspace.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaimed',reason:'no_changes'}});
  expect(cleanups).toBe(2);
  // A release issued under an epoch that has since moved is obsolete.
  const stale=await queued(w.workspace.id,A);
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=5,cleanup_json=jsonb_set(cleanup_json,'{source-g1,release_epoch}','2'::jsonb) WHERE id=$1`,[w.workspace.id]);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',stale.operation_id,OWNER,hosts)).toEqual({superseded:true});
  // The Host refusing an older epoch is superseded, not a failure.
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=1,retention_json='{}'::jsonb WHERE id=$1`,[w.workspace.id]);
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:A,inventory:inventory(),error:null}:{ok:false,commit:A,cleanup_state:'blocked',error:'workspace_materialization_moved'};
  const moved=await queued(w.workspace.id,A);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',moved.operation_id,OWNER,hosts)).toEqual({superseded:true});
  expect(await resource(w.workspace.id)).toMatchObject({superseded:true,attempts:1});
 });

 it('refuses to raise the epoch when a turn is admitted while the release is being prepared',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  const hosts=confirmingHosts();let sent=false;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if((frame as any).action==='inspect'){await ensureExecutionWorkspace(db.pool,await conversationRun('queued'),HOST,LOCATION);return {ok:true,commit:A,inventory:inventory(),error:null};}
   sent=true;return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  const first=await queued(w.workspace.id,A);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(sent).toBe(false);expect((await workspace(w.workspace.id)).materialization_epoch).toBe(0);
 });

 it('releases shared source refs only without other dependents',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  // A second conversation's blocked batch still depends on commit B.
  const session=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,SPACE,PROJECT,roomId]);
  const run=await conversationRun('succeeded');await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[run.id,session]);
  const foreign=await ensureExecutionWorkspace(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,HOST,LOCATION);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked',source_commit=$2 WHERE id=$1",[foreign.changeSetId,B]);
  const plan=await refReleasePlan(db.pool,{id:w.workspace.id,generation:1,execution_host_id:HOST},[]);
  expect(plan.sources.map(r=>r.ref)).not.toContain(`refs/rainver/sources/${B}`);
  expect(plan.sources.map(r=>r.ref)).toContain(`refs/rainver/sources/${C}`);
  expect(plan.release.map(r=>r.ref).filter(r=>r.startsWith('refs/rainver/sources/'))).toEqual([]);
  expect(plan.retained).toBe(1);
 });

 it('waits for an offline Host during a release without spending attempts, then finishes at the same tip',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const hosts=confirmingHosts();let offline=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if(offline)return {ok:false,commit:null,error:'host_offline'};
   return (frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}:{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  const first=await queued(w.workspace.id);
  for(let i=0;i<5;i++)await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(await resource(w.workspace.id)).toMatchObject({attempts:0,state:'retry_wait'});
  expect((await workspace(w.workspace.id)).materialization_epoch).toBe(0);
  offline=false;
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  await drainPages(w.workspace.id,hosts);
  expect(await workspace(w.workspace.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaimed'}});
 });

 it('offers proven-closed sources for release from reconciliation, including retired owners, and only while the Host is online',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  await db.pool.query("UPDATE execution_workspaces SET state='retired',cleanup_state='cleaned',cleanup_json=jsonb_build_object('source-g1',jsonb_build_object('version',1,'operation_id',$2::text,'workspace',jsonb_build_object('id',id,'generation',1),'expected_commit',$3::text,'retain_branch',true,'state','cleaned','attempts',1,'error',null,'next_retry_at',null)) WHERE id=$1",[w.workspace.id,randomUUID(),B]);
  const hosts=confirmingHosts();hosts.isOnline=()=>false;
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await resource(w.workspace.id)).state).toBe('cleaned');
  hosts.isOnline=()=>true;
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:B,inventory:inventory(),refs:[],refs_next:null,error:null});
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect(await resource(w.workspace.id)).toMatchObject({state:'pending',expected_commit:B});
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'workspace_id'=$1",[w.workspace.id])).rowCount).toBe(1);
  expect((await workspace(w.workspace.id)).state).toBe('retired');
 });

 it('lets only a current Project writer hold, reclaim now or retry through Operation Core',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated',2);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor,runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),owner=sessionActor({spaceId:SPACE,userId:OWNER});
  const run=(await new PgRunRepository(db.pool).getRun(SPACE,(await db.pool.query('SELECT run_id FROM execution_workspace_runs WHERE workspace_id=$1',[w.workspace.id])).rows[0].run_id))!;
  const call=(input:Record<string,unknown>,actor=owner)=>engine.execute('workspace.retention.update',{change_set_id:w.changeSetId,...input},actor,randomUUID(),randomUUID());
  const agent=await call({action:'reclaim_now'},await runActor(db.pool,run));expect(agent.http_status).toBe(404);
  await seedSpaceMember(db.pool,{space:SPACE,user:MEMBER});
  const viewer=await call({action:'hold',hold_days:3},sessionActor({spaceId:SPACE,userId:MEMBER}));expect([403,404]).toContain(viewer.http_status);
  expect((await workspace(w.workspace.id)).retention_json.hold_until).toBeUndefined();
  const held=await call({action:'hold',hold_days:3});expect(held.http_status,JSON.stringify(held.body)).toBe(200);
  expect(held.body).toMatchObject({data:{retention:{state:'held',reason:'held_by_user'}}});
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('held');
  const now=await call({action:'reclaim_now'});expect(now.http_status,JSON.stringify(now.body)).toBe(200);
  expect(await resource(w.workspace.id)).toMatchObject({state:'pending'});
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('reclaimable');
  expect((await call({action:'retry'})).http_status).toBe(409);
  // Unmerged work cannot be reclaimed early.
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
  await db.pool.query("UPDATE execution_workspaces SET cleanup_json='{}'::jsonb WHERE id=$1",[w.workspace.id]);
  expect((await call({action:'reclaim_now'})).http_status).toBe(409);
 });

 it('lets a launch during an in-flight release rebuild from the target, records its start, and keeps a late reply from overwriting it',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const hosts=confirmingHosts();let release:any=null;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:B,inventory:inventory({worktree:false,registration:false}),error:null};
   release=f;return {ok:false,commit:null,error:'host_timeout'};};
  const first=await queued(w.workspace.id);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(release).toMatchObject({retain_branch:false});
  expect(await workspace(w.workspace.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaiming'}});
  // The Host may already have removed the branch: the next turn must not start from the released tip.
  const next=await conversationRun();
  const bound=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  expect(bound.ref).toMatchObject({sync_to_target:true,materialization_epoch:1});
  expect(bound.ref.base_commit).toBeUndefined();
  await recordWorkspaceLaunch(db.pool,next,{id:w.workspace.id,generation:1,start_commit:D,target_ref:'refs/heads/main',launch_sequence:4});
  expect(await workspace(w.workspace.id)).toMatchObject({base_commit:D,head_commit:D,retention_json:{state:'active'}});
  // The delayed reply of the older release arrives: bookkeeping only, `active` stays.
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:null,inventory:cleaned(),error:null}
   :{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};
  await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now()-interval '20 minutes' WHERE id=$1",[next.id]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[next.id,D]);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(await workspace(w.workspace.id)).toMatchObject({head_commit:D,retention_json:{state:'active'}});
 });

 it('releases more refs than one frame or Host page holds, page by page, and only then reports reclaimed',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const sha=(i:number)=>i.toString(16).padStart(40,'e');
  const owned=Array.from({length:450},(_,i)=>({ref:`refs/rainver/native-preimages/${w.workspace.id}/g1/${randomUUID()}`,commit:sha(i)})).sort((a,b)=>a.ref<b.ref?-1:1);
  let live=new Set(owned.map(o=>o.ref));const releasedNames:string[]=[];
  const page=(after?:string)=>{const rest=owned.filter(o=>live.has(o.ref)&&(!after||o.ref>after));return {owned_refs:rest.slice(0,200),owned_refs_truncated:rest.length>200,owned_refs_next:rest.length>200?rest[199]!.ref:null};};
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:f.list_after?null:B,inventory:inventory({worktree:false,registration:false,branch:!f.list_after,...page(f.list_after)}),error:null};
   const names=(f.release_refs??[]).map((r:{ref:string})=>r.ref);expect(names.length).toBeLessThanOrEqual(200);
   // Every later page carries the release's epoch, so the Host can tell a rebuild's refs apart.
   if(f.action==='release_refs'){expect(f.workspace.execution_workspace.materialization_epoch).toBe(0);pageFrames++;}
   // The first later page reports one family unfinished: it must come back, not count as released.
   if(f.action==='release_refs'&&!truncatedOnce){truncatedOnce=true;const [head,...others]=names;for(const n of others){live.delete(n);releasedNames.push(n);}
    return {ok:false,commit:null,cleanup_state:'retry_wait',inventory:cleaned({retained_refs:[{ref:head,reason:'ref_release_truncated'}]}),error:'workspace_refs_incomplete'};}
   for(const n of names){live.delete(n);releasedNames.push(n);}
   return f.action==='cleanup'?{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(page()),error:null}:{ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null};};
  let truncatedOnce=false,pageFrames=0;
  const first=await queued(w.workspace.id);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  // Owned refs beyond the first Host page remain: not reclaimed yet.
  expect(await workspace(w.workspace.id)).toMatchObject({cleanup_state:'pending',retention_json:{state:'reclaiming',reason:'releasing_refs'}});
  let pages=0;const key=await pageKey(w.workspace.id);
  expect(key).toBe('refs-g1-e0');
  for(;;){
   const r=await resource(w.workspace.id,key);
   if(r.state==='cleaned')break;
   expect(++pages).toBeLessThan(10);
   await advanceWorkspaceCleanup(db.pool,w.workspace.id,key,r.operation_id,OWNER,hosts).catch(e=>{if(e.message!=='workspace_refs_next_page')throw e;});
  }
  expect(pages).toBeGreaterThanOrEqual(2);
  expect(live.size).toBe(0);
  expect(new Set(releasedNames.filter(n=>n.includes('/native-preimages/'))).size).toBe(450);
  expect(truncatedOnce).toBe(true);expect(pageFrames).toBeGreaterThanOrEqual(2);
  // The last page records the real outcome, never a lingering `releasing_refs`.
  expect(await workspace(w.workspace.id)).toMatchObject({retention_json:{state:'reclaimed',reason:'merged',retained_refs:0}});
  expect((await resource(w.workspace.id,key)).attempts).toBeLessThanOrEqual(1);
 });

 it('re-delivers a failed release with its epoch and plan after retry, and never shortcuts a release with an absent branch',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  const hosts=confirmingHosts(),frames:any[]=[];let fail=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:fail?A:null,inventory:fail?inventory():cleaned(),error:null};
   if(fail)return {ok:false,commit:null,cleanup_state:'blocked',inventory:cleaned({retained_refs:[{ref:'refs/rainver/x',reason:'ref_release_failed'}]}),error:'workspace_refs_retained'};
   return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  const first=await queued(w.workspace.id,A);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  const blocked=await resource(w.workspace.id);
  expect(blocked).toMatchObject({state:'blocked',release_epoch:0});
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const retried=await engine.execute('workspace.retention.update',{change_set_id:w.changeSetId,action:'retry'},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(retried.http_status,JSON.stringify(retried.body)).toBe(200);
  const restored=await resource(w.workspace.id);
  expect(restored).toMatchObject({state:'pending',release_epoch:0,attempts:0,retain_branch:false});
  expect(restored.operation_id).not.toBe(blocked.operation_id);
  // The branch is already gone on the Host: the release is still sent (same epoch) to finish refs/receipts.
  fail=false;frames.length=0;
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',restored.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(frames.find(f=>f.action==='cleanup')).toMatchObject({retain_branch:false,workspace:{execution_workspace:{materialization_epoch:0}}});
  expect(await workspace(w.workspace.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaimed'}});
  // A fresh release whose branch is absent from the start is also sent, not marked cleaned blindly.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json='{}'::jsonb WHERE id=$1`,[w.workspace.id]);
  frames.length=0;
  const absent=await queued(w.workspace.id,A);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',absent.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(frames.find(f=>f.action==='cleanup')).toMatchObject({retain_branch:false,workspace:{execution_workspace:{materialization_epoch:1}}});
 });

 it('schedules reclaim_now immediately and re-offers a Job parked on a hold or idle timer when eligibility changes',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated',3);
  const jobAt=async(op:string)=>(await db.pool.query<{at:Date}>("SELECT scheduled_at AS at FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'operation_id'=$1",[op])).rows[0]?.at;
  // Default enqueue looks after the grace; reclaim_now does not wait for it.
  const parked=await queued(w.workspace.id);
  expect((await jobAt(parked.operation_id))!.getTime()).toBeGreaterThan(Date.now()+60_000);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),owner=sessionActor({spaceId:SPACE,userId:OWNER});
  const call=(input:Record<string,unknown>)=>engine.execute('workspace.retention.update',{change_set_id:w.changeSetId,...input},owner,randomUUID(),randomUUID());
  expect((await call({action:'reclaim_now'})).http_status).toBe(200);
  const now=await resource(w.workspace.id);
  expect(now.operation_id).not.toBe(parked.operation_id);
  expect((await jobAt(now.operation_id))!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
  // The old Job is fenced by operation id.
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',parked.operation_id,OWNER,confirmingHosts())).toEqual({skipped:true});
  // A Job parked in retry_wait on a long hold/idle timer is replaced when the hold is released.
  await db.pool.query("UPDATE runs SET ended_at=now()-interval '1 hour',updated_at=now()-interval '1 hour'");
  await db.pool.query("UPDATE workspace_change_sets SET updated_at=now()-interval '1 hour'");
  expect((await call({action:'hold',hold_days:2})).http_status).toBe(200);
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1}',cleanup_json->'source-g1'||jsonb_build_object('state','retry_wait','next_retry_at',(now()+interval '2 days')::text)) WHERE id=$1`,[w.workspace.id]);
  const waiting=await resource(w.workspace.id);
  expect((await call({action:'release_hold'})).http_status).toBe(200);
  const reoffered=await resource(w.workspace.id);
  expect(reoffered.operation_id).not.toBe(waiting.operation_id);
  expect((await jobAt(reoffered.operation_id))!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
  // Reconciliation re-offers a source parked on the 24-hour idle timer once it became reclaimable.
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1}',cleanup_json->'source-g1'||jsonb_build_object('state','retry_wait','next_retry_at',(now()+interval '20 hours')::text)) WHERE id=$1`,[w.workspace.id]);
  const idle=await resource(w.workspace.id);
  const hosts=confirmingHosts();hosts.isOnline=()=>true;
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:B,inventory:inventory(),refs:[],refs_next:null,error:null});
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  const fresh=await resource(w.workspace.id);
  expect(fresh.operation_id).not.toBe(idle.operation_id);
  expect((await jobAt(fresh.operation_id))!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
 });

 it('keeps a hold from masking a retained reason, counts shared dependents, and attributes batch bases',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('open');
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js'),{sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const held=await engine.execute('workspace.retention.update',{change_set_id:w.changeSetId,action:'hold',hold_days:3},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
  expect(held.http_status).toBe(200);
  expect(held.body).toMatchObject({data:{retention:{state:'retained',reason:'unpublished_changes'}}});
  expect((await workspace(w.workspace.id)).retention_json.hold_until).toEqual(expect.any(String));
  // A ref named after a batch base is attributed, not reported as unclaimed.
  expect(await classifyLocationRefs(db.pool,HOST,[{ref:`refs/rainver/sources/${A}`,commit:A},{ref:`refs/rainver/sources/${D}`,commit:D}])).toEqual([{ref:`refs/rainver/sources/${D}`,reason:'unknown_owner'}]);
 });

 it('counts shared refs kept for another dependent in the reclaimed retention',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const session=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,SPACE,PROJECT,roomId]);
  const run=await conversationRun('succeeded');await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[run.id,session]);
  const foreign=await ensureExecutionWorkspace(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,HOST,LOCATION);
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked',source_commit=$2 WHERE id=$1",[foreign.changeSetId,B]);
  const hosts=confirmingHosts();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}:{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};
  const first=await queued(w.workspace.id);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  await drainPages(w.workspace.id,hosts);
  expect(await workspace(w.workspace.id)).toMatchObject({retention_json:{state:'reclaimed',retained_refs:1}});
 });

 it('reads a past Run version through its history after a reclaim and reports expiry explicitly, never on a Host outage',async ctx=>{
  if(!db.available)return ctx.skip();
  const {run,w}=await settled('integrated');
  const original=sharedHostConnectionRegistry.requestTaskBranch;
  let reply:any={ok:true,commit:null,file:{path:'notes.txt',content_base64:Buffer.from('draft one').toString('base64')},error:null};
  sharedHostConnectionRegistry.requestTaskBranch=(async()=>reply) as any;
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  const read=()=>readRunFilePreview(db.pool,config,{spaceId:SPACE,userId:OWNER} as any,run.id,'/workspace/repo/notes.txt');
  try{
   const future=new Date(Date.now()+86400_000).toISOString(),past=new Date(Date.now()-1000).toISOString();
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed','reclaimed_at',now()::text,'history_until',$2::text) WHERE id=$1`,[w.workspace.id,future]);
   expect(await read()).toEqual({kind:'text',name:'notes.txt',content:'draft one'});
   // Before the retention end even a gone version is not called expired.
   reply={ok:false,commit:null,error:'workspace_file_version_unavailable'};
   await expect(read()).rejects.toMatchObject({statusCode:404});
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('history_until',$2::text) WHERE id=$1`,[w.workspace.id,past]);
   expect(await read()).toEqual({kind:'expired',name:'/workspace/repo/notes.txt',expired_at:past});
   // After the end: a missing path in a present version, a refused read and an offline Host are never expiry.
   for(const error of ['workspace_file_unavailable','workspace_file_outside_scope','host_offline','workspace_host_operation_failed']){
    reply={ok:false,commit:null,error};
    await expect(read()).rejects.toMatchObject({statusCode:404});
   }
   // No history ref was needed (every version was target history): the end is the release plus the retention.
   reply={ok:false,commit:null,error:'workspace_file_version_unavailable'};
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed','reclaimed_at',now()::text,'history_until',null) WHERE id=$1`,[w.workspace.id]);
   await expect(read()).rejects.toMatchObject({statusCode:404});
   const old=new Date(Date.now()-31*86400_000).toISOString();
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed','reclaimed_at',$2::text,'history_until',null) WHERE id=$1`,[w.workspace.id,old]);
   expect(await read()).toMatchObject({kind:'expired',name:'/workspace/repo/notes.txt'});
   // A generation never released has no retention end at all.
   await db.pool.query(`UPDATE execution_workspaces SET retention_json='{}'::jsonb WHERE id=$1`,[w.workspace.id]);
   await expect(read()).rejects.toMatchObject({statusCode:404});
  }finally{sharedHostConnectionRegistry.requestTaskBranch=original;}
 });
 it('rebuilds a released workspace from the target when an earlier Run opened its batch but failed before launch',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=1,retention_json=jsonb_build_object('state','reclaimed','reason','no_changes','reclaimed_at',now()::text) WHERE id=$1`,[w.workspace.id]);
  const failed=await conversationRun();
  const first=await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION);
  expect(first.ref).toMatchObject({sync_to_target:true,materialization_epoch:1});expect(first.ref.base_commit).toBeUndefined();
  // PG failure/launch failure: the Run ends without a start, its open batch stays.
  await db.pool.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1",[failed.id]);
  const second=await conversationRun();
  const joined=await ensureExecutionWorkspace(db.pool,second,HOST,LOCATION);
  expect(joined.changeSetId).toBe(first.changeSetId);
  // The joined open batch does not make the released tip a base again.
  expect(joined.ref).toMatchObject({sync_to_target:true,materialization_epoch:1});expect(joined.ref.base_commit).toBeUndefined();
  await recordWorkspaceLaunch(db.pool,second,{id:w.workspace.id,generation:1,start_commit:D,target_ref:'refs/heads/main',launch_sequence:4});
  expect(await workspace(w.workspace.id)).toMatchObject({base_commit:D,head_commit:D,retention_json:{state:'active'}});
  // Two bindings on the batch: its base still moves to the rebuilt start.
  expect((await db.pool.query('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[joined.changeSetId])).rows[0].base_commit).toBe(D);
  // Once launched, the next Run continues that batch from its own tip, not the target.
  const third=await ensureExecutionWorkspace(db.pool,await conversationRun(),HOST,LOCATION);
  expect(third.ref.sync_to_target).toBeUndefined();expect(third.ref.base_commit).toBe(D);
 });

 it('re-judges an issued release that never reached the Host once a quarantine appears, and reconciliation never replaces it',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('no_changes');
  const hosts=confirmingHosts(),frames:any[]=[];let quarantined=0;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:A,inventory:inventory({worktree:false,registration:false,quarantined_whole:quarantined}),error:null};
   if(f.action==='list_refs')return {ok:false,commit:null,error:'host_offline'};
   if(!quarantined)return {ok:false,commit:null,error:'task_busy'};
   return {ok:false,commit:A,cleanup_state:'blocked',inventory:inventory({worktree:false,registration:false,quarantined_whole:1}),error:'workspace_quarantined'};};
  const first=await queued(w.workspace.id,A);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError',message:'task_busy'});
  const issued=await resource(w.workspace.id);
  expect(issued).toMatchObject({state:'retry_wait',release_epoch:0,retain_branch:false});
  // Reconciliation sees the idle tree at a different tip: the issued release is not overwritten.
  await db.pool.query("UPDATE execution_workspaces SET updated_at=now()-interval '2 days' WHERE id=$1",[w.workspace.id]);
  const online=hosts.isOnline;hosts.isOnline=()=>true;
  hosts.requestTaskBranch=(async(_h:any,_t:any,frame:any)=>frame.action==='inspect'?{ok:true,commit:D,inventory:inventory({quarantined_whole:0}),error:null}:{ok:false,commit:null,error:'host_offline'}) as any;
  await reconcileExecutionWorkspaces(db.pool,'/tmp/unused',{hosts});
  hosts.isOnline=online;
  expect((await resource(w.workspace.id)).operation_id).toBe(issued.operation_id);
  // The branch is still there (busy, never ran) and now beside a quarantine: no release is sent.
  quarantined=1;frames.length=0;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:A,inventory:inventory({worktree:false,registration:false,quarantined_whole:1}),error:null};
   return {ok:false,commit:A,cleanup_state:'blocked',inventory:inventory({worktree:false,registration:false,quarantined_whole:1}),error:'workspace_quarantined'};};
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',issued.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  const sent=frames.find(f=>f.action==='cleanup');
  expect(sent).toMatchObject({retain_branch:true});expect(sent.release_refs).toBeUndefined();
  expect(sent.workspace.execution_workspace.materialization_epoch).toBeUndefined();
  const after=await resource(w.workspace.id);
  expect(after.release_epoch).toBeUndefined();expect(after).toMatchObject({state:'blocked',error:'workspace_quarantined'});
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'retained',reason:'quarantined'});
  // That blocked request removed nothing: a fresh one may follow once the quarantine is resolved.
  expect(replaceableSourceCleanup(after)).toBe(true);
  expect(replaceableSourceCleanup({...after,error:'workspace_cleanup_incomplete'})).toBe(false);
  expect(replaceableSourceCleanup({...issued,state:'running'})).toBe(false);
 });

 it('schedules expiry for Run history the Host kept even when the release itself stops blocked',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const hosts=confirmingHosts();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory({worktree:false,registration:false}),error:null}
   :{ok:false,commit:null,cleanup_state:'blocked',inventory:cleaned({history_refs:[B],retained_refs:[{ref:'refs/rainver/x',reason:'ref_release_failed'}]}),error:'workspace_refs_retained'};
  const first=await queued(w.workspace.id);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  const history=await resource(w.workspace.id,'run-history-g1');
  expect(history).toMatchObject({kind:'run_history',state:'pending',release_refs:[{ref:`refs/rainver/run-history/${w.workspace.id}/g1/${B}`,expected_commit:B}]});
  expect(Date.parse(history.next_retry_at)).toBeGreaterThan(Date.now()+29*86400_000);
 });
 it('lets a rebuild during later ref pages keep what it references while the old release still clears its own refs',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w,mergeId}=await settled('integrated');
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=1,retention_json=jsonb_build_object('state','reclaiming','reason','releasing_refs') WHERE id=$1`,[w.workspace.id]);
  const pages=[{ref:`refs/rainver/recovery/${mergeId}`},{ref:`refs/rainver/sources/${C}`,expected_commit:C},{ref:`refs/rainver/sources/${B}`,expected_commit:B}];
  const {key}=await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'ref_pages',pages,OWNER,new Date(),{owned_after:null,retained_count:0,workspace:{id:w.workspace.id,generation:1},release_epoch:0,reason_on_finish:'merged'});
  // A new turn rebuilds and its open batch now starts at C.
  const next=await conversationRun();
  const bound=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  await recordWorkspaceLaunch(db.pool,next,{id:w.workspace.id,generation:1,start_commit:C,target_ref:'refs/heads/main',launch_sequence:4});
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null};};
  const r=await resource(w.workspace.id,key);
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,key,r.operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  const sent=frames.find(f=>f.action==='release_refs');
  expect(sent.workspace.execution_workspace.materialization_epoch).toBe(0);
  // The old release's own merge recovery ref and unreferenced source go; the rebuild's base stays.
  expect(sent.release_refs.map((x:{ref:string})=>x.ref)).toEqual([`refs/rainver/recovery/${mergeId}`,`refs/rainver/sources/${B}`]);
  expect(bound.changeSetId).toBeTruthy();
  // The rebuild owns the visible state: the late last page does not mark it reclaimed.
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'active',retained_refs:1});
 });

 /** Another conversation's workspace on the same Host, with one batch. */
 async function foreignWorkspace(){
  const session=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,SPACE,PROJECT,roomId]);
  const run=await conversationRun('succeeded');await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[run.id,session]);
  const foreign=await ensureExecutionWorkspace(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,HOST,LOCATION);
  await db.pool.query("UPDATE execution_workspaces SET target_ref='refs/heads/main' WHERE id=$1",[foreign.workspace.id]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[run.id,C]);
  return foreign;
 }
 const sourcePage=async(id:string,refs:RefRelease[]=[{ref:`refs/rainver/sources/${C}`,expected_commit:C}])=>(await enqueueRefRelease(db.pool,await workspace(id),'ref_pages',refs,OWNER,new Date(),{owned_after:null,retained_count:0,workspace:{id,generation:1},release_epoch:0,release_id:'r-0',reason_on_finish:'merged'})).key;

 it('re-checks a shared source against every workspace on the Host at page time, not the plan snapshot',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const plan=await refReleasePlan(db.pool,{id:w.workspace.id,generation:1,execution_host_id:HOST},[]);
  expect(plan.sources.map(r=>r.ref)).toContain(`refs/rainver/sources/${C}`);
  // After planning, another workspace's integration starts depending on C.
  const foreign=await foreignWorkspace();
  await db.pool.query("UPDATE workspace_change_sets SET state='ready',base_commit=$2,source_commit=$3 WHERE id=$1",[foreign.changeSetId,A,C]);
  expect(await enqueueWorkspaceIntegration(db.pool,foreign.changeSetId,SPACE,OWNER)).toEqual(expect.any(String));
  const key=await sourcePage(w.workspace.id,plan.sources);
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null};};
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,key,(await resource(w.workspace.id,key)).operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(frames.flatMap(f=>(f.release_refs??[]).map((r:{ref:string})=>r.ref))).not.toContain(`refs/rainver/sources/${C}`);
  expect((await resource(w.workspace.id,key)).retained_count).toBeGreaterThanOrEqual(1);
 });

 /** A Host call the test holds open, as a slow Host deletion whose reply has not come back. */
 function heldHost(){
  let open!:()=>void;const released=new Promise<void>(r=>{open=r;});
  let entered!:()=>void;const reached=new Promise<void>(r=>{entered=r;});
  return {released,reached,open,entered};
 }

 // Shared-source deletion fences, writers and re-pin failures: workspaceSourceFenceDb.test.ts.

 it('lets a renewal during an unconfirmed Run-history deletion win, and never lets an older Job claim or delete after it',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const history=`refs/rainver/run-history/${w.workspace.id}/g1/${D}`;
  const old=await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[{ref:history,expected_commit:D,kept_epoch:0}],OWNER,new Date(Date.now()-1000));
  const oldOp=(await resource(w.workspace.id,old.key)).operation_id;
  const hosts=confirmingHosts(),frames:any[]=[],held=heldHost();
  // The Host refuses the older expiry once a newer release kept the commit (its keeper epoch is 1).
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);held.entered();await held.released;
   return {ok:true,commit:null,inventory:cleaned({retained_refs:[{ref:history,reason:'ref_renewed'}]}),error:'workspace_refs_retained'};};
  const stale=advanceWorkspaceCleanup(db.pool,w.workspace.id,old.key,oldOp,OWNER,hosts);
  await held.reached;
  // A newer release reports D kept again under epoch 1: renewed (fresh due, fresh operation id), the claim carried along.
  const later=new Date(Date.now()+86400_000);
  await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[{ref:history,expected_commit:D,kept_epoch:1}],OWNER,later);
  const renewed=await resource(w.workspace.id,old.key);
  expect(renewed).toMatchObject({inflight:{operation_id:frames[0].operation_id},release_refs:[{ref:history,kept_epoch:1,due_at:later.toISOString()}]});
  // The carried-over claim is continued now, not at the renewed due time.
  expect(Date.parse(renewed.next_retry_at)).toBeLessThan(Date.now()+60_000);
  held.open();
  // The older Job's reply cannot write anything: it no longer owns the resource.
  expect(await stale).toEqual({skipped:true});
  // Nor can it claim (and so send) anything again.
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,old.key,oldOp,OWNER,hosts)).toEqual({skipped:true});
  expect(frames).toHaveLength(1);
  // The current Job re-sends the same unconfirmed operation, and keeps the renewed item with its own due time.
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,old.key,renewed.operation_id,OWNER,hosts)).rejects.toMatchObject({message:'workspace_refs_not_due'});
  expect(frames.map(f=>f.operation_id)).toEqual([frames[0].operation_id,frames[0].operation_id]);
  expect(frames[0].release_refs).toEqual([{ref:history,expected_commit:D,kept_epoch:0}]);
  const after=await resource(w.workspace.id,old.key);
  expect(after).toMatchObject({state:'pending',release_refs:[{ref:history,kept_epoch:1,due_at:later.toISOString()}],next_retry_at:later.toISOString()});
  expect(after.inflight).toBeUndefined();
  // A re-report without a newer keeper epoch is no renewal; local preimages are never renewed.
  await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[{ref:history,expected_commit:D,kept_epoch:1}],OWNER,new Date(later.getTime()+86400_000));
  expect((await resource(w.workspace.id,old.key)).release_refs).toEqual([{ref:history,expected_commit:D,kept_epoch:1,due_at:later.toISOString()}]);
  const pre={ref:`refs/rainver/local-preimages/${C}`,prefix:true};
  const p1=await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'local_preimages',[pre],OWNER,new Date(Date.now()+1000));
  await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'local_preimages',[pre],OWNER,later);
  expect((await resource(w.workspace.id,p1.key)).release_refs).toEqual([{...pre,due_at:p1.at.toISOString()}]);
 });

 it('reads every Run-history page past the 1000-ref inventory bound before releasing, durably and from the cursor',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const commit=(i:number)=>i.toString(16).padStart(40,'0');
  const all=Array.from({length:2300},(_,i)=>commit(i+1));
  const ref=(c:string)=>`refs/rainver/run-history/${w.workspace.id}/g1/${c}`;
  const due=new Date(Date.now()+86400_000);
  // The release reply carried the first page and a cursor.
  const first=await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',all.slice(0,1000).map(c=>({ref:ref(c),expected_commit:c,kept_epoch:0})),OWNER,due,{history_scan:{after:all[999]!,due_at:due.toISOString(),epoch:0}});
  // The scan starts now, not at the release's (later) due time.
  expect(first.at.getTime()).toBeLessThan(Date.now()+60_000);
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   const from=all.indexOf(f.history_after)+1,page=all.slice(from,from+1000),next=from+1000<all.length?page.at(-1):null;
   return {ok:true,commit:null,inventory:cleaned({history_refs:page,history_refs_next:next,history_epochs:{}}),error:null};};
  let rounds=0;
  for(;rounds<6;rounds++){
   const r=await resource(w.workspace.id,first.key);
   const done=await advanceWorkspaceCleanup(db.pool,w.workspace.id,first.key,r.operation_id,OWNER,hosts).then(()=>true,e=>{if(e.message==='workspace_history_next_page')return false;if(e.message==='workspace_refs_not_due')return true;throw e;});
   if(done)break;
  }
  expect(frames.map(f=>[f.action,f.history_after])).toEqual([['inspect',all[999]],['inspect',all[1999]]]);
  const listed=await resource(w.workspace.id,first.key);
  expect(listed.history_scan).toBeUndefined();
  expect(listed.release_refs).toHaveLength(2300);
  expect(listed.release_refs.every((r:RefRelease)=>r.due_at===due.toISOString())).toBe(true);
  expect(listed).toMatchObject({state:'pending',next_retry_at:due.toISOString()});
 });

 it('lets the last page of an older release never finish a newer release of the same workspace',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const key=await sourcePage(w.workspace.id,[{ref:`refs/rainver/recovery/${randomUUID()}`}]);
  // A newer release (epoch 1, its own id) is in progress when the old page finishes.
  await db.pool.query(`UPDATE execution_workspaces SET materialization_epoch=2,retention_json=jsonb_build_object('state','reclaiming','reason','reclaiming','release_epoch',1,'release_id','r-1','retained_refs',5) WHERE id=$1`,[w.workspace.id]);
  const hosts=confirmingHosts();
  hosts.requestTaskBranch=async():Promise<any>=>({ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null});
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,key,(await resource(w.workspace.id,key)).operation_id,OWNER,hosts)).toEqual({cleanup_state:'cleaned'});
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'reclaiming',release_epoch:1,release_id:'r-1',retained_refs:5});
  // The same epoch with another release id is not this release either.
  const again=await sourcePage(w.workspace.id,[{ref:`refs/rainver/recovery/${randomUUID()}`}]);
  expect(again).toBe(key);
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaiming','release_epoch',0,'release_id','r-other') WHERE id=$1`,[w.workspace.id]);
  await advanceWorkspaceCleanup(db.pool,w.workspace.id,again,(await resource(w.workspace.id,again)).operation_id,OWNER,hosts);
  expect((await workspace(w.workspace.id)).retention_json.state).toBe('reclaiming');
  // Its own release (epoch and id) is finished by it.
  const own=await sourcePage(w.workspace.id,[{ref:`refs/rainver/recovery/${randomUUID()}`}]);
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaiming','release_epoch',0,'release_id','r-0') WHERE id=$1`,[w.workspace.id]);
  await advanceWorkspaceCleanup(db.pool,w.workspace.id,own,(await resource(w.workspace.id,own)).operation_id,OWNER,hosts);
  expect((await workspace(w.workspace.id)).retention_json).toMatchObject({state:'reclaimed',reason:'merged'});
 });

 it('merges delayed releases of the same generation with per-item due times, idempotently, and releases only what is due',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('integrated');
  const ref=(c:string)=>({ref:`refs/rainver/run-history/${w.workspace.id}/g1/${c}`,expected_commit:c});
  const soon=new Date(Date.now()-1000),late=new Date(Date.now()+86400_000);
  // First release keeps B (due now); a second release of the same generation keeps D (due later).
  await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[ref(B)],OWNER,soon);
  const second=await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[ref(D)],OWNER,late);
  // Reporting the first release again changes nothing about B's due time.
  await enqueueRefRelease(db.pool,await workspace(w.workspace.id),'run_history',[ref(B)],OWNER,new Date(soon.getTime()-5000));
  const merged=await resource(w.workspace.id,second.key);
  expect(merged.release_refs).toEqual(expect.arrayContaining([{...ref(B),due_at:soon.toISOString()},{...ref(D),due_at:late.toISOString()}]));
  expect(merged.release_refs).toHaveLength(2);
  expect(second.until.toISOString()).toBe(late.toISOString());
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null};};
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,second.key,merged.operation_id,OWNER,hosts)).rejects.toMatchObject({message:'workspace_refs_not_due'});
  // Only B was due; the Host never sees the internal due field.
  expect(frames.map(f=>f.release_refs)).toEqual([[ref(B)]]);
  expect(await resource(w.workspace.id,second.key)).toMatchObject({state:'pending',release_refs:[{...ref(D),due_at:late.toISOString()}],next_retry_at:late.toISOString()});
 });

 it('schedules expiry for Run history reported by a release reply that is only retried, and a Host read fault is never expiry',async ctx=>{
  if(!db.available)return ctx.skip();
  const {run,w}=await settled('integrated');
  const hosts=confirmingHosts();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory({worktree:false,registration:false}),error:null}
   :{ok:false,commit:B,cleanup_state:'retry_wait',inventory:inventory({worktree:false,registration:false,history_refs:[D]}),error:'workspace_run_history_failed'};
  const first=await queued(w.workspace.id);
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  const history=await resource(w.workspace.id,'run-history-g1');
  expect(history).toMatchObject({kind:'run_history',state:'pending',release_refs:[expect.objectContaining({ref:`refs/rainver/run-history/${w.workspace.id}/g1/${D}`,expected_commit:D})]});
  const original=sharedHostConnectionRegistry.requestTaskBranch;
  sharedHostConnectionRegistry.requestTaskBranch=(async()=>({ok:false,commit:null,error:'workspace_file_read_failed'})) as any;
  try{
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed','history_until',$2::text) WHERE id=$1`,[w.workspace.id,new Date(Date.now()-1000).toISOString()]);
   await expect(readRunFilePreview(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),{spaceId:SPACE,userId:OWNER} as any,run.id,'/workspace/repo/notes.txt')).rejects.toMatchObject({statusCode:503});
  }finally{sharedHostConnectionRegistry.requestTaskBranch=original;}
 });
});

describe('published delegated checkpoint adoption',()=>{
 async function childFixture(){
  const parent=await settled('integrated');
  const run=await conversationRun('succeeded'),id=randomUUID(),change=randomUUID(),delegation=randomUUID(),group=randomUUID(),message=randomUUID();
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Implement',0,'/',now())`,[message,SPACE,CONVERSATION,OWNER]);
  await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Adoption','Implement','active',now(),now())`,[group,SPACE,OWNER,roomId,CONVERSATION,message,PROJECT]);
  await db.pool.query(`INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,requesting_agent_id,target_agent_id,status,instruction,completed_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,'succeeded','Implement',now(),now(),now())`,[delegation,SPACE,group,parent.run.id,run.id,AGENT]);
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,delegation_id,parent_workspace_id,generation,state,base_commit,head_commit,target_ref)
   VALUES($1,$2,$3,$4,$5,'delegation',$6,$7,1,'ready',$8,$9,'refs/heads/parent')`,[id,SPACE,PROJECT,LOCATION,HOST,delegation,parent.row.id,A,D]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit) VALUES($1,$2,$3,1,1,$4,$4,'open',$5,$6)`,[change,id,SPACE,run.id,A,D]);
  await db.pool.query(`INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state,start_commit,checkpoint_commit) VALUES($1,$2,$3,$4,'saved',$5,$6)`,[run.id,id,SPACE,change,A,D]);
  const hosts=new HostConnectionRegistry();
  hosts.runHostCommand=async(_host,input)=>({ok:true,error:null,exit_code:0,stdout:input.command.includes('--quiet')?'':'server/example.ts\0',stderr:'',timed_out:false});
  return {parent,run,id,change,hosts,row:await workspace(id)};
 }
 it('discovers manual adoption through scheduled reconciliation and offers the child to existing cleanup',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await childFixture();
  c.hosts.isOnline=()=>true;
  Object.defineProperty(c.hosts,'requestTaskBranch',{value:async()=>({ok:true,branch:'rainver/fixture',commit:D,inventory:inventory(),refs:[]})});
  const result=await reconcileExecutionWorkspaces(db.pool,'/workspace',{hosts:c.hosts});
  expect(result.failures).toEqual([]);
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0].state).toBe('no_changes');
  expect(await resource(c.id)).toMatchObject({workspace:{id:c.id},state:'pending'});
 });
 for(const modeMatches of [true,false])it(`uses actual Git to prove content, literal paths, deletions and mode (matching=${modeMatches})`,async ctx=>{
  if(!db.available)return ctx.skip();
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const c=await childFixture(),root=await mkdtemp(join(tmpdir(),'workspace-adoption-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try{
   git('init','-q');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
   await writeFile(join(root,'file[1].txt'),'old');await writeFile(join(root,'gone.txt'),'gone');await writeFile(join(root,'tool.sh'),'echo ok');
   git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD').trim();
   await writeFile(join(root,'file[1].txt'),'new');await unlink(join(root,'gone.txt'));await chmod(join(root,'tool.sh'),0o755);
   git('add','-A');git('commit','-qm','child');const source=git('rev-parse','HEAD').trim();
   await writeFile(join(root,'unrelated.txt'),'later');if(!modeMatches)await chmod(join(root,'tool.sh'),0o644);
   git('add','-A');git('commit','-qm','published');const published=git('rev-parse','HEAD').trim();
   await db.pool.query('UPDATE execution_workspaces SET base_commit=$2,head_commit=$3 WHERE id=$1',[c.id,base,source]);
   await db.pool.query('UPDATE workspace_change_sets SET base_commit=$2,source_commit=$3 WHERE id=$1',[c.change,base,source]);
   await db.pool.query('UPDATE task_merges SET merged_commit=$2 WHERE id=$1',[c.parent.mergeId,published]);
   c.hosts.runHostCommand=async(_host,input)=>{
    try{return {ok:true,error:null,exit_code:0,stdout:git(...input.command.slice(1)),stderr:'',timed_out:false};}
    catch{return {ok:true,error:null,exit_code:1,stdout:'',stderr:'',timed_out:false};}
   };
   expect(await reconcilePublishedWorkspaceChild(db.pool,await workspace(c.id),OWNER,c.hosts,'/workspace')).toBe(modeMatches);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('closes an adopted open child and lets the existing retention assessment proceed, idempotently',async ctx=>{
  if(!db.available)return ctx.skip();
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const c=await childFixture();
  expect(await assessWorkspaceRetention(db.pool,c.id)).toMatchObject({reason:'unpublished_changes'});
  expect(await reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).toBe(true);
  const result=(await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0];
  expect(result).toMatchObject({state:'no_changes',verification_json:{adopted_by_change_id:c.parent.w.changeSetId,already_present_at:C}});
  expect((await assessWorkspaceRetention(db.pool,c.id)).reason).not.toBe('unpublished_changes');
  expect(await reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).toBe(false);
 });
 for(const kind of ['different','unpublished_parent','active','checkpoint_pending','native_request_pending','changed_during_proof','unsafe_path','truncated_paths','parent_changed','became_active','host_failure'] as const){
  it(`retains a child when ${kind}`,async ctx=>{
   if(!db.available)return ctx.skip();
   const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
   const c=await childFixture();
   if(kind==='unpublished_parent')await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[c.parent.mergeId]);
   if(kind==='active')await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
   if(kind==='native_request_pending')await db.pool.query(`UPDATE workspace_change_sets SET verification_json='{"native_progress":{"status":"pending"}}'::jsonb WHERE id=$1`,[c.change]);
   if(kind==='checkpoint_pending')await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[c.run.id]);
   c.hosts.runHostCommand=async(_host,input)=>{
    const compare=input.command.includes('--quiet');
    if(compare&&kind==='parent_changed')await db.pool.query('UPDATE task_merges SET merged_commit=$2 WHERE id=$1',[c.parent.mergeId,B]);
    if(compare&&kind==='became_active')await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
    if(compare&&kind==='changed_during_proof')await db.pool.query('UPDATE workspace_change_sets SET source_commit=$2,revision=revision+1 WHERE id=$1',[c.change,B]);
    return {ok:kind!=='host_failure',error:kind==='host_failure'?'host_offline':null,exit_code:compare&&kind==='different'?1:0,stdout:compare?'':kind==='unsafe_path'?'../secret\0':kind==='truncated_paths'?'server/example.ts':'server/example.ts\0',stderr:'',timed_out:false};
   };
   if(kind==='host_failure')await expect(reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).rejects.toThrow('host_offline');
   else expect(await reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).toBe(false);
   expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0].state).toBe('open');
  });
 }
});
