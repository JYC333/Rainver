import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,utimes,readdir,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {PoolClient} from 'pg';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {waitForBackendWait,waitForBlockedBy} from './support/lockWait.js';
import {isSourceReleasePending} from '../src/modules/hosts/workspaceSourceFence.js';
import {seedAgentWithVersion,seedRun,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {HostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import {ensureExecutionWorkspace} from '../src/modules/projectFolders/executionWorkspaces.js';
import {advanceWorkspaceCleanup} from '../src/modules/hosts/workspaceCleanup.js';
import {classifyLocationRefs,configureWorkspaceRetention,freeSourceCommits,type RefRelease} from '../src/modules/hosts/workspaceRetention.js';
import {reconcileExecutionWorkspaces} from '../src/modules/hosts/workspaceReconcile.js';
import {enqueueRefRelease} from '../src/modules/hosts/workspaceRefRelease.js';
import {freezeSubmittedWorkspaceCommit,pinRegisteredSource} from '../src/modules/projectFolders/workspaceCommitSubmission.js';

/**
 * The shared-source deletion fence (hosts/workspaceSourceFence, migration
 * 0019) against real PostgreSQL: a dependent of a commit can never take effect
 * between the claim of that commit's shared-ref deletion and the proven end of
 * that Host operation, whatever happens to the request; protection that did
 * not complete never reads as finished; old-protocol Hosts are paused, not
 * exhausted. Only the temporary test repository is ever garbage-collected.
 */
const SPACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',PROJECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',LOCATION='11111111-1111-4111-8111-111111111111',MACHINE='22222222-2222-4222-8222-222222222222';
const HOST='33333333-3333-4333-8333-333333333333',AGENT='55555555-5555-4555-8555-555555555555',VERSION='66666666-6666-4666-8666-666666666666';
const CONVERSATION='88888888-8888-4888-8888-888888888888';
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
const db=useTestDatabase(import.meta.filename);
let roomId='';

beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['host_threads','sessions','workspace_locations','project_folders','tasks','agents','agent_versions','rooms','projects','hosts','machines','space_memberships','users','spaces','workspace_source_releases'],{cascade:true});
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
const repos:string[]=[];
afterEach(async()=>{for(const r of repos.splice(0))await rm(r,{recursive:true,force:true});});

async function conversationRun(status='running',session=CONVERSATION){
 const id=randomUUID();
 await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
 await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,status=$6,contract_snapshot_json='{"execution_workspace_version":1}' WHERE id=$1`,[id,PROJECT,session,LOCATION,OWNER,status]);
 return (await new PgRunRepository(db.pool).getRun(SPACE,id))!;
}
/** A closed (merged) workspace whose merge references `commit` as its candidate and merged commit. */
async function releasing(commit=C,session=CONVERSATION){
 const run=await conversationRun('running',session);
 const w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2,base_commit=$3,target_ref='refs/heads/main',head_sequence=3 WHERE id=$1",[w.workspace.id,B,A]);
 await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state='saved',launch_sequence=3 WHERE run_id=$1",[run.id,A,B]);
 await db.pool.query("UPDATE workspace_change_sets SET state='integrated',base_commit=$2,source_commit=$3 WHERE id=$1",[w.changeSetId,A,B]);
 await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,detail_json,created_at,updated_at,completed_at)
  VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/main','merged',$9,$10,$10,'{"native_integration":true}'::jsonb,now(),now(),now())`,[randomUUID(),SPACE,w.workspace.id,w.changeSetId,LOCATION,randomUUID(),B,A,OWNER,commit]);
 await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now()-interval '20 minutes',updated_at=now()-interval '20 minutes' WHERE id=$1",[run.id]);
 return w;
}
/** Another conversation's workspace on the same Host, with one open batch (base A, nothing saved). */
async function other(){
 const session=randomUUID();
 await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,SPACE,PROJECT,roomId]);
 const run=await conversationRun('succeeded',session);
 const w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET target_ref='refs/heads/main',state='ready' WHERE id=$1",[w.workspace.id]);
 await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2,start_commit=$2 WHERE run_id=$1",[run.id,A]);
 await db.pool.query("UPDATE workspace_change_sets SET base_commit=$2 WHERE id=$1",[w.changeSetId,A]);
 return {...w,run};
}
async function workspace(id:string){return (await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[id])).rows[0];}
async function resource(id:string,key:string){return (await workspace(id)).cleanup_json[key];}
async function intents(){return (await db.pool.query<{commit:string;operation_id:string}>('SELECT commit,operation_id FROM workspace_source_releases ORDER BY commit')).rows;}
const page=async(id:string,refs:RefRelease[]=[{ref:`refs/rainver/sources/${C}`,expected_commit:C}])=>(await enqueueRefRelease(db.pool,await workspace(id),'ref_pages',refs,OWNER,new Date(),{owned_after:null,retained_count:0,workspace:{id,generation:1},release_epoch:0,release_id:'r-0',reason_on_finish:'merged'})).key;
const cleaned=(over:Record<string,unknown>={})=>({worktree:false,registration:false,branch:false,run_record:false,pending_run_id:null,merge_record:false,quarantined_whole:0,retained_quarantine:0,active:false,free_bytes:null,owned_refs:[],...over});
const confirm=(frame:any,over:Record<string,unknown>={})=>({ok:true,commit:null,inventory:cleaned({retained_refs:[],ref_operation:frame.operation_id,...(frame.pin_sources?{pinned_sources:frame.pin_sources}:{}),...(frame.keep_sources||frame.release_keepers?{kept_sources:[]}:{}),...over}),error:null});
const releaseFrames=(frames:any[])=>frames.filter(f=>f.action==='release_refs');
const advance=async(id:string,key:string,hosts:HostConnectionRegistry)=>advanceWorkspaceCleanup(db.pool,id,key,(await resource(id,key)).operation_id,OWNER,hosts);

/** One transaction on its own connection, with a short fence wait (the trigger's default is 10 s). */
async function write<T>(fn:(c:PoolClient)=>Promise<T>,waitMs=150):Promise<T>{
 const c=await db.pool.connect();
 try{
  await c.query(`SET rainver.source_release_wait_ms='${waitMs}'`);
  await c.query('BEGIN');
  const result=await fn(c);
  await c.query('COMMIT');
  return result;
 }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}
 finally{await c.query('RESET rainver.source_release_wait_ms').catch(()=>undefined);c.release();}
}
const PENDING={message:'workspace_source_release_pending'};

describe('shared-source deletion fence',()=>{
 it('refuses every dependent writer while a claimed deletion is unconfirmed — timeout, disconnect, lost reply, restart — until that same operation is confirmed',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing();
  const second=await other(),third=await other();
  // A batch that already closed on C is no dependent at claim time; reopening it later would be one.
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated',source_commit=$2 WHERE id=$1",[third.changeSetId,C]);
  // An integration of another workspace in progress on unrelated commits.
  const mergeId=randomUUID();
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$7,'refs/heads/main','rebasing',$8,now(),now())`,[mergeId,SPACE,second.workspace.id,second.changeSetId,LOCATION,randomUUID(),A,OWNER]);
  const key=await page(w.workspace.id);
  const frames:any[]=[];
  // Round 1: the Host got the deletion (it may run it) but the reply is lost.
  let hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:false,commit:null,error:'host_timeout'};};
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  const op=releaseFrames(frames)[0]!.operation_id;
  expect(await intents()).toEqual([{commit:C,operation_id:op}]);

  // Every writer of a dependent of C on this Host is refused now.
  const writers:Array<[string,(c:PoolClient)=>Promise<unknown>]>=[
   ['batch checkpoint (source)',c=>c.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[second.changeSetId,C])],
   ['independent submitted commit',c=>c.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{submitted_commit}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({source_commit:C,user_id:OWNER})])],
   ['launch / new batch base',c=>c.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,base_commit,state) VALUES($1,$2,$3,1,7,$4,$4,$5,'ready')`,[randomUUID(),second.workspace.id,SPACE,second.run.id,C])],
   ['reopened closed batch',c=>c.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[third.changeSetId])],
   ['integration insert',c=>c.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/main','queued',$9,now(),now())`,[randomUUID(),SPACE,third.workspace.id,third.changeSetId,LOCATION,randomUUID(),C,A,OWNER])],
   ['integration / resolution progress (candidate)',c=>c.query('UPDATE task_merges SET task_commit=$2 WHERE id=$1',[mergeId,C])],
  ];
  for(const [name,writer] of writers)await expect(write(writer),name).rejects.toMatchObject(PENDING);
  // Writes that create no dependent of C are admitted: the releasing workspace's
  // own abandoned batch (its retention already judged it), unrelated commits.
  await write(c=>c.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,base_commit,source_commit,state) VALUES($1,$2,$3,1,9,$4,$4,$5,$5,'abandoned')`,[randomUUID(),w.workspace.id,SPACE,second.run.id,C]));
  await write(c=>c.query('UPDATE task_merges SET task_commit=$2 WHERE id=$1',[mergeId,B]));

  // Round 2: the Host connection dropped. Still fenced, the same operation is what gets re-sent.
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:false,commit:null,error:'host_offline'};};
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_offline'});
  // A service restart: a new registry and a new Job, nothing in memory survives. The fence did.
  hosts=new HostConnectionRegistry();
  expect(await intents()).toEqual([{commit:C,operation_id:op}]);
  expect((await resource(w.workspace.id,key))).toMatchObject({inflight:{operation_id:op,sources:[C]},attempts:0});
  await expect(write(writers[0]![1])).rejects.toMatchObject(PENDING);
  // Round 3: the Host replays the finished operation; only now does the fence end.
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return confirm(frame);};
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(releaseFrames(frames).map(f=>f.operation_id)).toEqual([op,op,op]);
  expect(await intents()).toEqual([]);
  await write(writers[0]![1]);
  expect((await db.pool.query('SELECT source_commit FROM workspace_change_sets WHERE id=$1',[second.changeSetId])).rows[0].source_commit).toBe(C);
 });

 it('orders a racing writer and the claim by the per-commit lock: a dependent committed first keeps the ref, one after is refused',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing(),second=await other();
  const key=await page(w.workspace.id);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return confirm(frame);};
  // The writer's trigger holds the (Host, C) lock in an open transaction while the claim starts.
  const c=await db.pool.connect();
  let round:Promise<unknown>,settled=false;
  try{
   const holder=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await c.query('BEGIN');
   await c.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[second.changeSetId,C]);
   round=advance(w.workspace.id,key,hosts).finally(()=>{settled=true;});
   // Barrier: the claim is blocked on a lock this writer holds.
   await waitForBlockedBy(db.pool,holder,{settled:()=>settled});
   expect(settled).toBe(false);
   expect(frames).toEqual([]); // the claim waits for the writer
   await c.query('COMMIT');
  }finally{c.release();}
  expect(await round!).toEqual({cleanup_state:'cleaned'});
  // C now has a dependent: nothing was sent for it and no intent was recorded.
  expect(releaseFrames(frames).flatMap(f=>(f.release_refs??[]).map((r:{ref:string})=>r.ref))).not.toContain(`refs/rainver/sources/${C}`);
  expect(await intents()).toEqual([]);
  expect((await resource(w.workspace.id,key)).retained_count).toBe(1);
 });

 it('lets a waiting writer in as soon as the Host confirms the deletion, and not before',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing(),second=await other();
  const key=await page(w.workspace.id);
  let open!:()=>void,entered!:()=>void;
  const released=new Promise<void>(r=>{open=r;}),reached=new Promise<void>(r=>{entered=r;});
  const hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{entered();await released;return confirm(frame);};
  const round=advance(w.workspace.id,key,hosts);
  await reached; // the Host deletion has started
  let admittedAt=0,writerPid=0,writerSettled=false;
  const writer=write(async c=>{
   writerPid=(await c.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   return c.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[second.changeSetId,C]);
  },5000).then(()=>{admittedAt=Date.now();}).finally(()=>{writerSettled=true;});
  // Barrier: the writer's trigger found the claimed deletion and sleeps in its fence loop.
  await vi.waitUntil(()=>writerPid>0||writerSettled);
  await waitForBackendWait(db.pool,writerPid,'PgSleep',{settled:()=>writerSettled});
  expect(writerSettled).toBe(false);
  expect(admittedAt).toBe(0);
  const confirmedAt=Date.now();open();
  expect(await round).toEqual({cleanup_state:'cleaned'});
  await writer;
  expect(admittedAt).toBeGreaterThanOrEqual(confirmedAt);
 });

 it('never reports a release finished while a protection is incomplete: a missing re-pin stays claimed and fails visibly',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing(),second=await other();
  const key=await page(w.workspace.id);
  const hosts=new HostConnectionRegistry(),frames:any[]=[];
  let pinned:string[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   frames.push(frame);
   // A dependent written outside the fence (before it existed) appears while the Host deletes.
   if(!(frame as any).pin_sources){await db.pool.query('DELETE FROM workspace_source_releases');await db.pool.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[second.changeSetId,C]);}
   return confirm(frame,(frame as any).pin_sources?{pinned_sources:pinned}:{});
  };
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'workspace_source_repin'});
  // The Host cannot re-pin it (Git already pruned the object): retried, never cleaned.
  const outcomes:unknown[]=[];
  for(let i=0;i<12&&outcomes.at(-1)!=='blocked';i++){
   const outcome=await advance(w.workspace.id,key,hosts).then(o=>(o as {cleanup_state?:string}).cleanup_state,e=>e.message);
   outcomes.push(outcome);
   const r=await resource(w.workspace.id,key);
   expect(r.state).not.toBe('cleaned');
   expect(r.inflight).toMatchObject({refs:[],pins:[C]});
   expect(r.error).toBe('workspace_source_repin_missing');
  }
  expect(outcomes.at(-1)).toBe('blocked');
  expect(outcomes.slice(0,-1).every(o=>o==='workspace_source_repin_missing')).toBe(true);
  expect((await workspace(w.workspace.id)).retention_json.state).not.toBe('reclaimed');
  // Reconciliation does not re-judge a failure the Host confirmed as an old-protocol pause.
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  expect((await resource(w.workspace.id,key)).state).toBe('blocked');
  // Once the object is pinned the release finishes, and only then.
  pinned=[C];
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||'{"state":"retry_wait","attempts":0}'::jsonb) WHERE id=$1`,[w.workspace.id,key]);
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  expect((await resource(w.workspace.id,key)).error).toBeNull();
 });

 it('pauses ref work for an old-protocol Host without sending or spending attempts, and resumes the same operation after the upgrade',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing();
  const key=await page(w.workspace.id);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:true,commit:null,inventory:cleaned({retained_refs:[]}),error:null};};
  // Earlier, before this Host was paused, a claim went out and was never confirmed.
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:false,commit:null,error:'host_timeout'};};
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  const op=releaseFrames(frames)[0]!.operation_id;
  // The Host reconnects reporting the old protocol: nothing is sent to it, however often the Job runs.
  await db.pool.query(`UPDATE hosts SET capabilities_json='{"execution_workspaces":{"version":2,"reclaim":1}}'::jsonb WHERE id=$1`,[HOST]);
  const sent=frames.length;
  for(let i=0;i<12;i++)await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_upgrade_required'});
  expect(frames.length).toBe(sent);
  expect(await resource(w.workspace.id,key)).toMatchObject({state:'retry_wait',attempts:0,error:'host_upgrade_required',inflight:{operation_id:op}});
  expect(await intents()).toEqual([{commit:C,operation_id:op}]);
  // A resource an older server exhausted against that Host (blocked, no level recorded).
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||'{"state":"blocked","attempts":8,"error":"workspace_refs_release_unconfirmed"}'::jsonb) WHERE id=$1`,[w.workspace.id,key]);
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  expect((await resource(w.workspace.id,key)).state).toBe('blocked'); // still the old protocol
  // Upgrade: reconciliation resumes it at once, re-sending the same operation; the Host re-executes it under its journal.
  await db.pool.query(`UPDATE hosts SET capabilities_json='{"execution_workspaces":{"version":2,"reclaim":2}}'::jsonb WHERE id=$1`,[HOST]);
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  const resumed=await resource(w.workspace.id,key);
  expect(resumed).toMatchObject({state:'pending',attempts:0,error:null,inflight:{operation_id:op}});
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'operation_id'=$1",[resumed.operation_id])).rowCount).toBe(1);
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return confirm(frame);};
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(releaseFrames(frames).at(-1)!.operation_id).toBe(op);
  expect(await intents()).toEqual([]);
  // A resource blocked against a current-protocol Host is not re-opened by the upgrade path.
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||'{"state":"blocked","attempts":8,"error":"workspace_refs_release_unconfirmed","blocked_host_level":2}'::jsonb) WHERE id=$1`,[w.workspace.id,key]);
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  expect((await resource(w.workspace.id,key)).state).toBe('blocked');
 });

 it('with a real repository and Git GC: an old object whose only ref is being deleted gains no dependent, and a later submission is refused before it takes effect',async ctx=>{
  if(!db.available)return ctx.skip();
  const repo=await mkdtemp(join(tmpdir(),'rainver-fence-'));repos.push(repo);
  const git=(args:string[],env:Record<string,string>={})=>execFileSync('git',args,{cwd:repo,encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',HOME:repo,...env}}).trim();
  git(['init','-q','-b','main']);git(['config','user.email','p@example.com']);git(['config','user.name','P']);git(['config','gc.auto','0']);
  git(['commit','-q','--allow-empty','-m','base']);
  const parent=git(['rev-parse','HEAD']);
  // A frozen source two years old, reachable only through its shared ref.
  const old={GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'};
  const frozen=git(['commit-tree',`${parent}^{tree}`,'-p',parent,'-m','frozen source'],old);
  git(['update-ref',`refs/rainver/sources/${frozen}`,frozen]);
  const ancient=new Date('2024-01-01T00:00:00Z');
  for(const dir of await readdir(join(repo,'.git','objects')))if(/^[0-9a-f]{2}$/.test(dir))for(const f of await readdir(join(repo,'.git','objects',dir)))await utimes(join(repo,'.git','objects',dir,f),ancient,ancient);
  expect((await stat(join(repo,'.git','objects',frozen.slice(0,2),frozen.slice(2)))).mtime.getTime()).toBe(ancient.getTime());

  const w=await releasing(frozen),second=await other();
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${frozen}`,expected_commit:frozen}]);
  const hosts=new HostConnectionRegistry();
  let lose=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   // The Host really deletes by CAS, then normal maintenance runs; the first reply is lost.
   for(const r of (frame as any).release_refs??[])try{git(['update-ref','-d',r.ref,r.expected_commit]);}catch{/* already gone: done */}
   git(['gc','-q','--prune=2.weeks.ago']);
   if(lose){lose=false;return {ok:false,commit:null,error:'host_timeout'};}
   return confirm(frame);
  };
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  expect(()=>git(['cat-file','-e',`${frozen}^{commit}`])).toThrow(); // pruned: no re-pin could bring it back
  // While unconfirmed, a submission of that commit cannot register.
  await expect(write(c=>c.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{submitted_commit}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({source_commit:frozen,user_id:OWNER})]))).rejects.toMatchObject(PENDING);
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  // After the proven end the submission registers, but it only takes effect after a
  // pin of the exact object on the Host, which Git no longer has: refused, nothing applied.
  await db.pool.query("UPDATE workspace_change_sets SET state='ready',base_commit=$2,source_commit=$2,verification_json=jsonb_set(verification_json,'{submitted_commit}',$3::jsonb) WHERE id=$1",[second.changeSetId,parent,JSON.stringify({source_commit:frozen,user_id:OWNER})]);
  const runGit=(command:string[])=>{try{return {ok:true,exit_code:0,timed_out:false,stdout:git(command.slice(1)),stderr:'',error:null};}catch{return {ok:true,exit_code:1,timed_out:false,stdout:'',stderr:'',error:null};}};
  hosts.runHostCommand=async(_h,frame)=>runGit(frame.command) as any;
  const change=(await db.pool.query('SELECT id,base_commit,source_commit,verification_json FROM workspace_change_sets WHERE id=$1',[second.changeSetId])).rows[0];
  await expect(freezeSubmittedWorkspaceCommit(db.pool,await workspace(second.workspace.id),change,second.run,OWNER,hosts)).rejects.toMatchObject({message:'workspace_commit_unavailable'});
  expect((await db.pool.query('SELECT source_commit FROM workspace_change_sets WHERE id=$1',[second.changeSetId])).rows[0].source_commit).toBe(parent);
  // An object Git still has is pinned on the Host before the submission takes effect.
  const kept=git(['commit-tree',`${parent}^{tree}`,'-p',parent,'-m','kept submission']);
  await db.pool.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{submitted_commit}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({source_commit:kept,user_id:OWNER})]);
  const fresh=(await db.pool.query('SELECT id,base_commit,source_commit,verification_json FROM workspace_change_sets WHERE id=$1',[second.changeSetId])).rows[0];
  expect(await freezeSubmittedWorkspaceCommit(db.pool,await workspace(second.workspace.id),fresh,second.run,OWNER,hosts)).toEqual({base_commit:parent,source_commit:kept});
  expect(git(['rev-parse',`refs/rainver/sources/${kept}`])).toBe(kept);
 });
});

/** A temporary Git repository (the only one ever garbage-collected here) and a simulated Host that really runs ref operations in it. */
async function tempRepo(){
 const repo=await mkdtemp(join(tmpdir(),'rainver-settle-'));repos.push(repo);
 const git=(args:string[],env:Record<string,string>={})=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',HOME:repo,...env}}).trim();
 git(['init','-q','-b','main']);git(['config','user.email','p@example.com']);git(['config','user.name','P']);git(['config','gc.auto','0']);
 git(['commit','-q','--allow-empty','-m','base']);
 const parent=git(['rev-parse','HEAD']);
 const old={GIT_AUTHOR_DATE:'2024-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2024-01-01T00:00:00Z'};
 // An old frozen source reachable only through its shared ref: GC prunes it at once once unreachable.
 const frozen=git(['commit-tree',`${parent}^{tree}`,'-p',parent,'-m','frozen source'],old);
 git(['update-ref',`refs/rainver/sources/${frozen}`,frozen]);
 const ancient=new Date('2024-01-01T00:00:00Z');
 for(const dir of await readdir(join(repo,'.git','objects')))if(/^[0-9a-f]{2}$/.test(dir))for(const f of await readdir(join(repo,'.git','objects',dir)))await utimes(join(repo,'.git','objects',dir,f),ancient,ancient);
 const present=(c:string)=>{try{git(['cat-file','-e',`${c}^{commit}`]);return true;}catch{return false;}};
 const ref=(c:string)=>{try{return git(['rev-parse','--verify','--quiet',`refs/rainver/sources/${c}`]);}catch{return null;}};
 // Strictly more aggressive than Git's own maintenance: any unreachable object goes at once, at every step.
 const gc=()=>git(['gc','-q','--prune=now']);
 const keeperRef=(frame:any,c:string)=>`refs/rainver/source-keepers/${frame.workspace?.execution_workspace?.id??'w'}/g${frame.workspace?.execution_workspace?.generation??1}/${c}`;
 const named=(name:string)=>{try{return git(['rev-parse','--verify','--quiet',name]);}catch{return null;}};
 /**
  * Journaled like the Host (reclaim 4), in its order, with Git GC after every
  * step: keepers, settle (finished or cancelled for good), shared names, keeper
  * drops, then releases — a shared source only for a fence-marked request.
  */
 const journal=new Map<string,{state:'done'|'cancelled';retained?:Array<{ref:string;reason:string}>;result?:any}>();
 const host=async(frame:any):Promise<any>=>{
  const prior=journal.get(frame.operation_id);
  if(prior?.state==='cancelled')return {ok:false,commit:null,error:'workspace_ref_operation_cancelled'};
  if(prior?.result)return prior.result;
  for(const c of frame.keep_sources??[])if(present(c)&&named(keeperRef(frame,c))!==c)git(['update-ref',keeperRef(frame,c),c,'']);
  gc();
  const settled=(frame.settle_operations??[]).map((id:string)=>{const p=journal.get(id);if(p?.state==='done')return {operation_id:id,state:'finished',retained_refs:p.retained??[]};journal.set(id,{state:'cancelled'});return {operation_id:id,state:'cancelled'};});
  gc();
  const pinned:string[]=[];
  for(const c of frame.pin_sources??[]){if(ref(c)===c||present(c)&&(git(['update-ref',`refs/rainver/sources/${c}`,c,'']),true))pinned.push(c);}
  gc();
  for(const c of frame.release_keepers??[])if(ref(c)===c&&named(keeperRef(frame,c)))git(['update-ref','-d',keeperRef(frame,c)]);
  const kept=[...new Set([...(frame.keep_sources??[]),...(frame.release_keepers??[])])].filter(c=>named(keeperRef(frame,c))===c);
  gc();
  const retained:Array<{ref:string;reason:string}>=[];
  for(const r of frame.release_refs??[]){
   if(r.ref.startsWith('refs/rainver/sources/')&&!frame.source_fence){retained.push({ref:r.ref,reason:'ref_release_unfenced'});continue;}
   try{git(['update-ref','-d',r.ref,r.expected_commit]);}catch{/* gone */}
  }
  gc();
  const result=confirm(frame,{retained_refs:retained,...(frame.pin_sources?{pinned_sources:pinned}:{}),...(frame.settle_operations?{settled_operations:settled}:{}),...(frame.keep_sources||frame.release_keepers?{kept_sources:kept}:{})});
  journal.set(frame.operation_id,{state:'done',retained,result});
  return result;
 };
 const keeper=(workspaceId:string,c:string)=>named(`refs/rainver/source-keepers/${workspaceId}/g1/${c}`);
 return {repo,git,parent,frozen,present,ref,gc,journal,host,keeper};
}
/** A cleanup resource as a pre-fence server left it: an unconfirmed deletion of `commit` without the fence mark. */
async function legacyClaim(workspaceId:string,key:string,commit:string,operationId=randomUUID()){
 await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||$3::jsonb) WHERE id=$1`,[workspaceId,key,JSON.stringify({state:'retry_wait',error:'host_upgrade_required',attempts:0,
  inflight:{operation_id:operationId,refs:[{ref:`refs/rainver/sources/${commit}`,expected_commit:commit}],sources:[commit],owned_after:null,shared_retained:0}})]);
 return operationId;
}
/** 0020's backfill statement, exactly as the migration runs it. */
async function backfill(){
 const sql=(await readFile(join(import.meta.dirname,'..','migrations','0017_isolated_workspaces_and_retention.sql'),'utf8')).split('--> statement-breakpoint').find(x=>x.includes('One intent per unended operation'))!;
 await db.pool.query(sql);
}
const setLevel=(level:number)=>db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_build_object('execution_workspaces',jsonb_build_object('version',2,'reclaim',$2::int)) WHERE id=$1`,[HOST,level]);

describe('pre-fence deletions, native commits, Run start and recovery',()=>{
 it('settles a deletion claimed before the fence instead of re-sending it: its dependent commit is kept, settled and restored in one Host operation, through a late delivery and GC',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w=await releasing(t.frozen),second=await other();
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  // Before the fence: a claim went out unconfirmed, then a batch registered the commit (no trigger yet).
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[second.changeSetId,t.frozen]);
  const legacy=await legacyClaim(w.workspace.id,key,t.frozen);
  await backfill();
  expect(await intents()).toEqual([{commit:t.frozen,operation_id:legacy}]);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return t.host(frame);};
  // A Host that cannot keep and settle (reclaim 2, or 3 which settled without keepers) gets nothing; the fence stays.
  for(const level of [2,3]){
   await setLevel(level);
   for(let i=0;i<2;i++)await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_upgrade_required'});
   await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  }
  expect(frames).toEqual([]);
  expect(await resource(w.workspace.id,key)).toMatchObject({state:'retry_wait',attempts:0,error:'host_upgrade_required',required_host_level:4,inflight:{operation_id:legacy}});
  // Upgrade: reconcile resumes it; one operation keeps, settles and restores. Nothing is pinned afterwards.
  await setLevel(4);
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'workspace_ref_operation_settled'});
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({action:'release_refs',settle_operations:[legacy],keep_sources:[t.frozen],pin_sources:[t.frozen],release_keepers:[t.frozen],release_refs:[]});
  expect(frames.some(f=>f.operation_id===legacy)).toBe(false);
  expect(t.journal.get(legacy)?.state).toBe('cancelled');
  expect(await intents()).toEqual([]);
  // Right at the settle's confirmation the shared name holds the commit again; the keeper it replaced is gone.
  expect(t.ref(t.frozen)).toBe(t.frozen);
  expect(t.keeper(w.workspace.id,t.frozen)).toBeNull();
  const settled=await resource(w.workspace.id,key);
  expect(settled.inflight).toBeUndefined();expect(settled.keepers).toBeUndefined();
  // The cancelled operation arrives late (a slow or reconnecting copy): it deletes nothing.
  expect(await t.host({operation_id:legacy,release_refs:[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]})).toMatchObject({ok:false,error:'workspace_ref_operation_cancelled'});
  t.gc();
  expect(t.ref(t.frozen)).toBe(t.frozen);
  // The page claims its list again, fenced, and keeps the dependent's commit.
  while((await resource(w.workspace.id,key)).state!=='cleaned'){
   await advance(w.workspace.id,key,hosts).catch(e=>{if(!/workspace_/.test(e.message))throw e;});
  }
  expect(frames.flatMap(f=>(f.release_refs??[]).map((r:{ref:string})=>r.ref))).not.toContain(`refs/rainver/sources/${t.frozen}`);
  t.gc();
  expect(t.present(t.frozen)).toBe(true);
  expect((await resource(w.workspace.id,key)).retained_count).toBe(1);
 });

 it('keeps every pre-fence operation of one commit fenced: the first settle keeps it under its keeper through an old copy and GC, the last restores the shared name, and the keeper is dropped before the resource finishes',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w1=await releasing(t.frozen);
  const session=randomUUID();
  await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,SPACE,PROJECT,roomId]);
  const w2=await releasing(t.frozen,session);
  expect(w2.workspace.id).not.toBe(w1.workspace.id);
  const k1=await page(w1.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  const k2=await page(w2.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  const second=await other();
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[second.changeSetId,t.frozen]);
  const op1=await legacyClaim(w1.workspace.id,k1,t.frozen),op2=await legacyClaim(w2.workspace.id,k2,t.frozen);
  // What 0019 left: one intent for the commit (DISTINCT ON). 0020 restores one per operation.
  await db.pool.query('INSERT INTO workspace_source_releases(host_id,commit,workspace_id,generation,operation_id) VALUES($1,$2,$3,1,$4)',[HOST,t.frozen,w1.workspace.id,op1]);
  await backfill();await backfill(); // idempotent
  expect((await intents()).map(i=>i.operation_id).sort()).toEqual([op1,op2].sort());
  await setLevel(4);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return t.host(frame);};
  // The first settle (op2's copy was delivered earlier and may still run): the commit is kept
  // under w1's keeper, not under the shared name, and no new dependent may register.
  await expect(advance(w1.workspace.id,k1,hosts)).rejects.toMatchObject({message:'workspace_ref_operation_settled'});
  expect(frames[0]).toMatchObject({settle_operations:[op1],keep_sources:[t.frozen]});
  expect(frames[0].pin_sources).toBeUndefined();
  expect(t.keeper(w1.workspace.id,t.frozen)).toBe(t.frozen);
  expect((await resource(w1.workspace.id,k1)).keepers).toEqual([t.frozen]);
  expect(await intents()).toEqual([{commit:t.frozen,operation_id:op2}]);
  await expect(write(c=>c.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{native_request}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({id:randomUUID(),submitted_commit:t.frozen})]))).rejects.toMatchObject(PENDING);
  // op2's old copy reaches this (reclaim 4) Host late: unfenced, it deletes no shared source.
  expect((await t.host({operation_id:op2,release_refs:[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]})).inventory.retained_refs).toEqual([{ref:`refs/rainver/sources/${t.frozen}`,reason:'ref_release_unfenced'}]);
  expect(t.ref(t.frozen)).toBe(t.frozen);
  // Had an old Host run it before the upgrade, the shared name would be gone; the keeper keeps the object through GC.
  t.git(['update-ref','-d',`refs/rainver/sources/${t.frozen}`]);t.gc();
  expect(t.present(t.frozen)).toBe(true);
  // w1 waits for op2 (another operation still fences the name): never `cleaned` while its keeper remains.
  for(let i=0;i<4;i++)await advance(w1.workspace.id,k1,hosts).catch(e=>{if(!/workspace_/.test(e.message))throw e;});
  expect((await resource(w1.workspace.id,k1))).toMatchObject({state:'retry_wait',keepers:[t.frozen]});
  expect(frames.flatMap(f=>f.pin_sources??[])).toEqual([]);
  // The last settle keeps, settles (finished: its copy ran) and restores the shared name in one operation.
  await expect(advance(w2.workspace.id,k2,hosts)).rejects.toMatchObject({message:/workspace_/});
  const last=frames.find(f=>f.settle_operations?.[0]===op2);
  expect(last).toMatchObject({keep_sources:[t.frozen],pin_sources:[t.frozen],release_keepers:[t.frozen]});
  expect(t.ref(t.frozen)).toBe(t.frozen);
  expect(t.keeper(w2.workspace.id,t.frozen)).toBeNull();
  expect(await intents()).toEqual([]);
  // w1 then restores (already present) and drops its own keeper, and only then finishes.
  for(const [id,k] of [[w1.workspace.id,k1],[w2.workspace.id,k2]] as const)
   while((await resource(id,k)).state!=='cleaned')await advance(id,k,hosts).catch(e=>{if(!/workspace_/.test(e.message))throw e;});
  expect(frames.some(f=>f.release_keepers?.[0]===t.frozen&&!f.settle_operations&&f.workspace.execution_workspace.id===w1.workspace.id)).toBe(true);
  expect(t.keeper(w1.workspace.id,t.frozen)).toBeNull();
  expect((await resource(w1.workspace.id,k1)).keepers).toBeUndefined();
  t.gc();
  expect(t.ref(t.frozen)).toBe(t.frozen);
  await write(c=>c.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{native_request}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({id:randomUUID(),submitted_commit:t.frozen})]));
 });

 it('is why 0020 is a maintenance migration: the previous release\'s claim statement fails against its key',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing();
  // The claim of the release before 0020, verbatim: it names the dropped (host_id, commit) key.
  await expect(db.pool.query(`INSERT INTO workspace_source_releases(host_id,commit,workspace_id,generation,operation_id)
   SELECT $1,c,$2,$3,$4 FROM unnest($5::text[]) c ON CONFLICT (host_id,commit) DO UPDATE SET operation_id=EXCLUDED.operation_id
   WHERE workspace_source_releases.operation_id=EXCLUDED.operation_id RETURNING commit`,[HOST,w.workspace.id,1,randomUUID(),[C]])).rejects.toMatchObject({code:'42P10'});
  const sql=await readFile(join(import.meta.dirname,'..','migrations','0017_isolated_workspaces_and_retention.sql'),'utf8');
  expect(sql.split('\n',20)).toContain('-- rainver:maintenance');
 });

 it('blocks visibly, never cleaned, when a dependent commit was already pruned before the settle first reached it',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w=await releasing(t.frozen),second=await other();
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[second.changeSetId,t.frozen]);
  const legacy=await legacyClaim(w.workspace.id,key,t.frozen);
  await backfill();
  // Before the upgrade: an old Host ran the unfenced deletion and GC pruned the object.
  t.git(['update-ref','-d',`refs/rainver/sources/${t.frozen}`]);t.gc();
  expect(t.present(t.frozen)).toBe(false);
  await setLevel(4);
  const hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>t.host(frame);
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'blocked'});
  expect(t.journal.get(legacy)?.state).toBe('cancelled');
  expect(await resource(w.workspace.id,key)).toMatchObject({state:'blocked',error:'workspace_source_lost_before_fence',lost_sources:[t.frozen]});
  // Not re-opened as old-protocol work by reconciliation.
  await reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts});
  expect((await resource(w.workspace.id,key)).state).toBe('blocked');
 });

 it('never re-sends a settle an earlier server persisted without keepers: a new keeper-first operation settles the whole (nested, partly executed) chain, and a deletion that already ran still leaves the dependent commit referenced through GC and restart',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w=await releasing(t.frozen),second=await other();
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[second.changeSetId,t.frozen]);
  const legacy=await legacyClaim(w.workspace.id,key,t.frozen);
  await backfill();
  // An earlier server wrapped the deletion in a settle without keepers, then renewed it
  // (a nested wrapper); the inner wrapper already ran on the Host, its reply lost.
  const inner=randomUUID(),outer=randomUUID();
  const deletion=(await resource(w.workspace.id,key)).inflight;
  const wrapped={operation_id:outer,refs:[],sources:[],fence:2,settle:{operation_id:inner,refs:[],sources:[],fence:2,settle:deletion}};
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2,'inflight'],$3::jsonb) WHERE id=$1`,[w.workspace.id,key,JSON.stringify(wrapped)]);
  t.journal.set(inner,{state:'done',retained:[],result:{ok:true}});
  // The old deletion itself also already ran: the shared name is gone, the object not yet pruned.
  t.git(['update-ref','-d',`refs/rainver/sources/${t.frozen}`]);
  expect(t.present(t.frozen)).toBe(true);
  await setLevel(4);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  let lose=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);if(lose){lose=false;return {ok:false,commit:null,error:'host_timeout'};}return t.host(frame);};
  // First round: the conversion is persisted before sending; the reply is lost (timeout).
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  const converted=(await resource(w.workspace.id,key)).inflight;
  expect(converted).toMatchObject({keeper_first:true,keep:[t.frozen],pins:[t.frozen],release_keepers:[t.frozen],settle:{operation_id:outer}});
  expect([outer,inner,legacy]).not.toContain(converted.operation_id);
  // Restart: the same new id is re-sent, never reconverted; the legacy ids are only settled.
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'workspace_ref_operation_settled'});
  expect(frames.map(f=>f.operation_id)).toEqual([converted.operation_id,converted.operation_id]);
  expect(frames[1]).toMatchObject({settle_operations:[outer,inner,legacy],keep_sources:[t.frozen],pin_sources:[t.frozen],release_keepers:[t.frozen],release_refs:[]});
  expect(t.journal.get(outer)?.state).toBe('cancelled');
  expect(t.journal.get(inner)?.state).toBe('done');
  expect(t.journal.get(legacy)?.state).toBe('cancelled');
  expect(await intents()).toEqual([]);
  t.gc();
  expect(t.ref(t.frozen)).toBe(t.frozen);
  expect(t.present(t.frozen)).toBe(true);
  expect(t.keeper(w.workspace.id,t.frozen)).toBeNull();
  // Late copies of every legacy id delete nothing.
  for(const id of [outer,legacy])expect(await t.host({operation_id:id,release_refs:[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]})).toMatchObject({ok:false,error:'workspace_ref_operation_cancelled'});
  t.gc();
  expect(t.ref(t.frozen)).toBe(t.frozen);
 });

 it('retries a keeper the Host could not write (ref lock, I/O) with the same operation: never read as a lost source, never settled or cleaned before the keeper exists',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w=await releasing(t.frozen),second=await other();
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[second.changeSetId,t.frozen]);
  const legacy=await legacyClaim(w.workspace.id,key,t.frozen);
  await backfill();
  await setLevel(4);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  let failing=2;
  // The Host's keeper write fails (it throws before settling: no ref_operation in the reply).
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);if(failing>0){failing--;return {ok:false,commit:null,cleanup_state:'retry_wait',error:'workspace_source_ref_write_failed'};}return t.host(frame);};
  for(let i=0;i<2;i++){
   await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'workspace_source_ref_write_failed'});
   const r=await resource(w.workspace.id,key);
   expect(r).toMatchObject({state:'retry_wait',error:'workspace_source_ref_write_failed',attempts:0});
   expect(r.lost_sources).toBeUndefined();
   expect(t.journal.get(legacy)).toBeUndefined();
   expect(await intents()).toEqual([{commit:t.frozen,operation_id:legacy}]);
  }
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'workspace_ref_operation_settled'});
  expect(new Set(frames.map(f=>f.operation_id)).size).toBe(1);
  expect(t.journal.get(legacy)?.state).toBe('cancelled');
  t.gc();
  expect(t.ref(t.frozen)).toBe(t.frozen);
 });

 it('registers, counts and pins a native request\'s explicit commit like every other dependent',async ctx=>{
  if(!db.available)return ctx.skip();
  const t=await tempRepo();
  const w=await releasing(t.frozen),second=await other();
  const native=(c:string)=>(q:PoolClient)=>q.query("UPDATE workspace_change_sets SET verification_json=jsonb_set(verification_json,'{native_request}',$2::jsonb) WHERE id=$1",[second.changeSetId,JSON.stringify({id:randomUUID(),action:'prepare',submitted_commit:c})]);
  // Counted: a registered native commit is never released.
  await write(native(t.frozen));
  const fence={hostId:HOST,workspaceId:w.workspace.id,generation:1};
  expect(await freeSourceCommits(db.pool,fence,[t.frozen])).toEqual([]);
  expect(await classifyLocationRefs(db.pool,HOST,[{ref:`refs/rainver/sources/${t.frozen}`,commit:t.frozen}])).toEqual([]);
  // Fenced: while a deletion of the commit is unended, the request cannot register.
  await write(c=>c.query("UPDATE workspace_change_sets SET verification_json=verification_json-'native_request' WHERE id=$1",[second.changeSetId]));
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${t.frozen}`,expected_commit:t.frozen}]);
  const hosts=new HostConnectionRegistry();let lose=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const reply=await t.host(frame);if(lose){lose=false;return {ok:false,commit:null,error:'host_timeout'};}return reply;};
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  await expect(write(native(t.frozen))).rejects.toMatchObject(PENDING);
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  // Pinned before use: a pruned object is refused; a present one is pinned under its shared name.
  const attempt=async(argv:string[])=>{try{return t.git(argv);}catch{return null;}};
  expect(t.present(t.frozen)).toBe(false);
  await write(native(t.frozen));
  await expect(pinRegisteredSource(attempt,t.frozen)).rejects.toMatchObject({message:'workspace_commit_unavailable'});
  const kept=t.git(['commit-tree',`${t.parent}^{tree}`,'-p',t.parent,'-m','native submission']);
  await write(native(kept));
  await pinRegisteredSource(attempt,kept);
  t.gc();
  expect(t.ref(kept)).toBe(kept);
  expect(await freeSourceCommits(db.pool,fence,[kept])).toEqual([]);
 });

 it('starts a Run while a deletion of its workspace\'s commit is unended: a rebuild registers no released tip, any other start waits outside its transaction',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing();
  // W's own release page is deleting its old tip's shared ref, reply lost.
  const key=await page(w.workspace.id,[{ref:`refs/rainver/sources/${B}`,expected_commit:B}]);
  const hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async():Promise<any>=>({ok:false,commit:null,error:'host_timeout'});
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  expect((await intents()).map(i=>i.commit)).toEqual([B]);
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed','reason','merged') WHERE id=$1`,[w.workspace.id]);
  // Rebuild after reclaim: no launch yet, two Runs join; nothing waits, the released tip is no base.
  const started=Date.now();
  const first=await ensureExecutionWorkspace(db.pool,await conversationRun(),HOST,LOCATION);
  const again=await ensureExecutionWorkspace(db.pool,await conversationRun(),HOST,LOCATION);
  expect(Date.now()-started).toBeLessThan(3000);
  expect(again.changeSetId).toBe(first.changeSetId);
  expect(first.ref.base_commit).toBeUndefined();
  expect((await db.pool.query('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[first.changeSetId])).rows[0].base_commit).toBeNull();

  // Another conversation whose tip is that same commit, not released: its new batch is a real
  // dependent. The start rolls back, waits outside (the row lock is free meanwhile) and
  // succeeds once the deletion's confirmation committed — never a failed Run.
  const third=await other();
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[third.workspace.id,B]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated',source_commit=$2 WHERE id=$1",[third.changeSetId,A]);
  const session=(await workspace(third.workspace.id)).session_id;
  // Delegate pool: records the start's real fence refusal and holds its next attempt
  // (outside any transaction) until the row-lock check below has run.
  let resolved=false,refused=0,reopen!:()=>void;
  let refusedAndReleased!:()=>void;
  const outside=new Promise<void>(r=>{refusedAndReleased=r;}),gate=new Promise<void>(r=>{reopen=r;});
  const delegate=new Proxy(db.pool,{get(target,prop){
   if(prop!=='connect'){const v=Reflect.get(target,prop);return typeof v==='function'?v.bind(target):v;}
   return async()=>{
    if(refused)await gate;
    const client=await target.connect();
    let sawRefusal=false;
    return new Proxy(client,{get(t,p){
     if(p==='query')return (...args:Parameters<PoolClient['query']>)=>(t.query as (...a:unknown[])=>Promise<unknown>)(...args).catch((error:unknown)=>{if(isSourceReleasePending(error))sawRefusal=true;throw error;});
     if(p==='release')return (...args:unknown[])=>{(t.release as (...a:unknown[])=>void)(...args);if(sawRefusal){refused++;refusedAndReleased();}};
     const v=Reflect.get(t,p);return typeof v==='function'?v.bind(t):v;
    }});
   };
  }});
  const pendingStart=ensureExecutionWorkspace(delegate,await conversationRun('running',session),HOST,LOCATION).finally(()=>{resolved=true;});
  await Promise.race([outside,pendingStart]);
  expect(resolved).toBe(false);
  expect(refused).toBe(1); // the start met the fence and rolled back
  const c=await db.pool.connect();
  try{await c.query('BEGIN');await c.query('SELECT 1 FROM execution_workspaces WHERE id=$1 FOR UPDATE NOWAIT',[third.workspace.id]);await c.query('ROLLBACK');}finally{c.release();}
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>confirm(frame);
  expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
  expect(resolved).toBe(false);
  reopen();
  const started2=await pendingStart;
  expect(refused).toBe(1); // admitted on the retry after the confirmation
  expect((await db.pool.query('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[started2.changeSetId])).rows[0].base_commit).toBe(B);
  expect(await intents()).toEqual([]);
 });

 it('restores paused ref work from the row as it is now: a same-operation Job that advanced meanwhile is never overwritten',async ctx=>{
  if(!db.available)return ctx.skip();
  const w=await releasing();
  const key=await page(w.workspace.id);
  const frames:any[]=[],hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:false,commit:null,error:'host_timeout'};};
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_timeout'});
  const op=releaseFrames(frames)[0]!.operation_id;
  await setLevel(1);
  await expect(advance(w.workspace.id,key,hosts)).rejects.toMatchObject({message:'host_upgrade_required'});
  await setLevel(2);
  // Barrier: reconciliation has scanned the paused resource but waits on its per-workspace lock.
  const barrier=await db.pool.connect();
  let reconciled:Promise<unknown>,reconcileSettled=false;
  try{
   const holder=(await barrier.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await barrier.query('BEGIN');
   await barrier.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`workspace-reconcile:${w.workspace.id}`]);
   reconciled=reconcileExecutionWorkspaces(db.pool,'/tmp',{hostId:HOST,hosts}).finally(()=>{reconcileSettled=true;});
   await waitForBlockedBy(db.pool,holder,{settled:()=>reconcileSettled});
   expect(reconcileSettled).toBe(false);
   // Meanwhile the same operation's Job runs: confirms the deletion and finishes the page.
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return confirm(frame);};
   expect(await advance(w.workspace.id,key,hosts)).toEqual({cleanup_state:'cleaned'});
   await barrier.query('COMMIT');
  }finally{barrier.release();}
  await reconciled!;
  const after=await resource(w.workspace.id,key);
  expect(after).toMatchObject({state:'cleaned',error:null});
  expect(after.inflight).toBeUndefined();
  expect(await intents()).toEqual([]);
  expect(releaseFrames(frames).map(f=>f.operation_id)).toEqual([op,op]);
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND status='pending' AND payload_json->>'resource_key'=$1 AND payload_json->>'operation_id'<>$2",[key,after.operation_id])).rowCount).toBe(0);
 });
});
