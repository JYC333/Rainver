import {mkdtemp,mkdir,writeFile,chmod,unlink,rm} from 'node:fs/promises';
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
import {normalizeHostCapabilities} from '../src/modules/hosts/capabilities.js';
import {PgHostRepository} from '../src/modules/hosts/repository.js';
import {hostSummary,type ExecutionHostRow} from '../src/modules/sessions/executionContextRepository.js';
import {conversationWorkspaceChangesForViewer} from '../src/modules/projectFolders/workspaceReadModel.js';

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


/** Real Host Git and shared PostgreSQL fixture; every resource belongs to this test. */
async function savedHost(c:Awaited<ReturnType<typeof settled>>){
 const root=await mkdtemp(join(tmpdir(),'idle-host-pg-'));
  const previous=process.env.RAINVER_HOST_CONFIG_DIR;
  const repo=join(root,'repo'),config=join(root,'config');await mkdir(repo);await mkdir(config);
  process.env.RAINVER_HOST_CONFIG_DIR=config;
   const git=(args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
   git(['init','-q','-b','main']);git(['config','user.name','Fixture']);git(['config','user.email','fixture@example.com']);
   await writeFile(join(repo,'file.txt'),'base');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']);
   const {saveConfig}=await import('../../packages/host-daemon/src/config.js');
   const {checkLocationRepository}=await import('../../packages/host-daemon/src/taskWorktree.js');
   const {prepareExecutionWorkspace,executeWorkspaceCommand}=await import('../../packages/host-daemon/src/executionWorkspace.js');
   await saveConfig({server_url:'http://127.0.0.1:9',host_id:HOST,trust:'trusted',token:'fixture',workspaces:{[LOCATION]:repo}});
   const check=await checkLocationRepository(repo);if(check.kind!=='repository')throw new Error('fixture');
   const ref={id:c.row.id,generation:1,target_ref:'refs/heads/main'};
   const prepared=await prepareExecutionWorkspace(check.repo,LOCATION,ref,c.run.id);
   const command=async(f:any):Promise<any>=>executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:ref},retain_branch:true,...f});
   await writeFile(join(prepared.root,'file.txt'),'saved');
   const saved=await command({action:'checkpoint',run_id:c.run.id,author:{name:'Fixture',email:'fixture@example.com'},message:'saved'});
   if(!saved.ok||!saved.commit)throw new Error('fixture checkpoint');const tip=saved.commit;
   await db.pool.query('UPDATE execution_workspaces SET base_commit=$2,head_commit=$3 WHERE id=$1',[c.row.id,base,tip]);
   await db.pool.query('UPDATE workspace_change_sets SET base_commit=$2,source_commit=$3 WHERE id=$1',[c.w.changeSetId,base,tip]);
   await db.pool.query('UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3 WHERE run_id=$1',[c.run.id,base,tip]);

 return {root,repo,config,git,ref,prepared,command,base,tip,async close(){
  if(previous===undefined)delete process.env.RAINVER_HOST_CONFIG_DIR;else process.env.RAINVER_HOST_CONFIG_DIR=previous;
  await rm(root,{recursive:true,force:true});
 }};
}

describe('isolated source retention',()=>{
 it('waits for execution prerequisites without exhausting the checkpoint budget or turning a failed attempt into a safety block',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open'),failed=await conversationRun();
  await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[failed.id]);
  await db.pool.query("UPDATE hosts SET capabilities_json='{}'::jsonb WHERE id=$1",[HOST]);
  const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async():Promise<any>=>({ok:true,unchanged_commit:B});
  const {checkpointWorkspaceRun}=await import('../src/modules/hosts/workspaceCheckpoints.js');
  await expect(checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,{exhausted:true})).rejects.toMatchObject({name:'JobDeferredError',message:'execution_workspace_host_upgrade_required'});
  expect((await db.pool.query('SELECT checkpoint_state,checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0])
   .toMatchObject({checkpoint_state:'pending',checkpoint_recovery_json:{state:'waiting',error:'execution_workspace_host_upgrade_required'}});
  expect((await workspace(c.row.id)).state).toBe('ready');
  await db.pool.query(`UPDATE hosts SET capabilities_json='{"execution_workspaces":{"version":2,"reclaim":7}}'::jsonb WHERE id=$1`,[HOST]);
  await checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,{exhausted:true});
  expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0].checkpoint_state).toBe('saved');
 });

 it.for(['admission','periodic','never_materialized'] as const)('converges an exhausted pre-launch checkpoint through %s and admits the next turn using real Host evidence',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open'),real=await savedHost(c);
  try{
   if(mode==='never_materialized')await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[c.row.id]);
   const failed=await conversationRun(),binding=await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION),oldRequest=randomUUID();
   await db.pool.query("UPDATE runs SET status='failed',error_message='execution_workspace_host_upgrade_required' WHERE id=$1",[failed.id]);
   await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_recovery_json=$2::jsonb WHERE run_id=$1",[failed.id,JSON.stringify({state:'exhausted',error:'execution_workspace_host_upgrade_required',request_id:oldRequest})]);
   const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>real.command(frame);
   const next=await conversationRun();
   if(mode==='periodic')await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
   else await expect(ensureExecutionWorkspace(db.pool,next,HOST,LOCATION)).rejects.toMatchObject({name:'JobDeferredError',message:'workspace_checkpoint_recovering'});
   const recovery=(await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0].checkpoint_recovery_json;
   expect(recovery).toMatchObject({state:'requested',request_id:expect.any(String)});expect(recovery.request_id).not.toBe(oldRequest);
   expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'checkpoint_recovery_id'=$1",[recovery.request_id])).rowCount).toBe(1);
   const {checkpointWorkspaceRun}=await import('../src/modules/hosts/workspaceCheckpoints.js');
   expect(await checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,{workspaceId:binding.workspace.id,launchSequence:0,recoveryId:oldRequest})).toMatchObject({superseded:true});
   await checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,{workspaceId:binding.workspace.id,launchSequence:0,recoveryId:recovery.request_id,exhausted:true});
   expect((await db.pool.query('SELECT start_commit,checkpoint_state,checkpoint_commit,checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0])
    .toMatchObject({start_commit:null,checkpoint_state:'saved',checkpoint_commit:mode==='never_materialized'?null:real.tip,checkpoint_recovery_json:{state:'settled',outcome:mode==='never_materialized'?'not_started':'unchanged'}});
   const resumed=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
   expect(resumed.workspace.id).toBe(binding.workspace.id);
   expect(await real.git(['show',`${real.tip}:file.txt`])).toBe('saved');
   if(mode==='never_materialized')expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[binding.changeSetId])).rows[0].state).toBe('no_changes');
  }finally{await real.close();}
 });

 it.for([true,false])('recovers the earlier dispatched attempt and its dirty files even when the latest retry never launched (exit initially confirmed=%s)',async(initiallyConfirmed,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open'),real=await savedHost(c);
  try{
   const failed=await conversationRun(),binding=await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION),nonce=randomUUID();
   const daemon=await import(new URL('../../packages/host-daemon/src/executionWorkspace.ts',import.meta.url).href);
   const task=await import(new URL('../../packages/host-daemon/src/taskWorktree.ts',import.meta.url).href);
   const checked=await task.checkLocationRepository(real.repo);expect(checked.kind).toBe('repository');
   const prepared=await daemon.prepareExecutionWorkspace(checked.repo,LOCATION,binding.ref,failed.id);
   await writeFile(join(prepared.root,'recovered.txt'),'orphaned work must survive');
   await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,launch_id,created_at,updated_at)
    VALUES($1,$2,$3,1,'orphaned',$4,now(),now()),($5,$2,$3,2,'failed',NULL,now(),now())`,[randomUUID(),SPACE,failed.id,nonce,randomUUID()]);
   await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[failed.id]);
   await db.pool.query(`UPDATE execution_workspace_runs SET checkpoint_recovery_json='{"state":"exhausted","error":"execution_workspace_host_upgrade_required"}' WHERE run_id=$1`,[failed.id]);
   const next=await conversationRun();await expect(ensureExecutionWorkspace(db.pool,next,HOST,LOCATION)).rejects.toMatchObject({name:'JobDeferredError'});
   let confirmed=initiallyConfirmed;const stopped:string[]=[];
   const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>real.command(frame);
   hosts.stopAttempt=async(_host,_run,launch)=>{stopped.push(launch);return confirmed;};
   const {checkpointWorkspaceRun}=await import('../src/modules/hosts/workspaceCheckpoints.js');
   const recovery=(await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0].checkpoint_recovery_json;
   const attempt={workspaceId:binding.workspace.id,launchSequence:0,recoveryId:recovery.request_id,confirmParkedExit:true};
   if(!confirmed){
    await expect(checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,attempt)).rejects.toMatchObject({name:'JobDeferredError'});
    expect((await db.pool.query('SELECT start_commit FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0].start_commit).toBeNull();
    confirmed=true;
   }
   expect(await checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,attempt)).toMatchObject({superseded:true});
   const current=(await db.pool.query('SELECT launch_sequence,checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0];
   expect(current.launch_sequence).toBeGreaterThan(0);
   await checkpointWorkspaceRun(db.pool,failed.id,SPACE,hosts,undefined,{workspaceId:binding.workspace.id,launchSequence:current.launch_sequence,recoveryId:current.checkpoint_recovery_json.request_id??'',confirmParkedExit:true});
   const saved=(await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0];
   expect(saved.checkpoint_state).toBe('saved');expect(stopped).toContain(nonce);
   expect(real.git(['show',`${saved.checkpoint_commit}:recovered.txt`])).toBe('orphaned work must survive');
   expect((await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION)).workspace.id).toBe(binding.workspace.id);
  }finally{await real.close();}
 });

 it.for(['unchanged','dirty','offline','active','head_advanced','generation_changed','base_raced','source_generation_changed'] as const)('settles only a batch-owned unchanged base from real Host evidence: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open'),real=await savedHost(c);
  try{
   await db.pool.query("UPDATE workspace_change_sets SET state='abandoned' WHERE id=$1",[c.w.changeSetId]);
   const failed=await conversationRun(),binding=await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION);
   await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[failed.id]);
   await db.pool.query("UPDATE workspace_change_sets SET source_commit=NULL,state='abandoned' WHERE id=$1",[binding.changeSetId]);
   await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[c.row.id]);
   if(mode==='head_advanced'){
    await writeFile(join(real.prepared.root,'later.txt'),'a later batch owns this new head');
    execFileSync('git',['add','later.txt'],{cwd:real.prepared.root});
    execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-qm','later batch'],{cwd:real.prepared.root});
    const later=execFileSync('git',['rev-parse','HEAD'],{cwd:real.prepared.root,encoding:'utf8'}).trim();
    await db.pool.query('UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1',[c.row.id,later]);
   }
   if(mode==='generation_changed'||mode==='source_generation_changed'){
    await db.pool.query('UPDATE execution_workspaces SET generation=generation+1 WHERE id=$1',[c.row.id]);
    // A real new-generation tree proves the same tip. An old batch still cannot
    // borrow that otherwise valid Host evidence.
    const {checkLocationRepository}=await import('../../packages/host-daemon/src/taskWorktree.js');
    const {prepareExecutionWorkspace}=await import('../../packages/host-daemon/src/executionWorkspace.js');
    const checked=await checkLocationRepository(real.repo);
    if(checked.kind!=='repository')throw new Error('fixture repository');
    await prepareExecutionWorkspace(checked.repo,LOCATION,{...real.ref,generation:2,base_commit:real.tip},failed.id);
   }
   if(mode==='source_generation_changed')await db.pool.query('UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1',[binding.changeSetId,real.tip]);
   if(mode==='dirty')await writeFile(join(real.prepared.root,'unknown.txt'),'real unsaved work');
   if(mode==='active')await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[failed.id]);
   const hosts=new HostConnectionRegistry();hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
    const reply=await real.command(frame);
    if(mode==='base_raced')await db.pool.query('UPDATE workspace_change_sets SET base_commit=$2 WHERE id=$1',[binding.changeSetId,C]);
    return mode==='offline'?{ok:false,error:'host_offline'}:reply;
   };
   const {recoverUnlaunchedWorkspaceCheckpoint}=await import('../src/modules/projectFolders/workspaceUnlaunchedCheckpoint.js');
   expect(await recoverUnlaunchedWorkspaceCheckpoint(db.pool,failed.id,c.row.id,SPACE,hosts)).toBe(mode==='unchanged');
   const record=(await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0];
   expect(record.checkpoint_state).toBe(mode==='unchanged'?'saved':'pending');
   const change=(await db.pool.query('SELECT state,source_commit FROM workspace_change_sets WHERE id=$1',[binding.changeSetId])).rows[0];
   expect(change).toEqual({state:'abandoned',source_commit:mode==='unchanged'||mode==='source_generation_changed'?real.tip:null});
   if(['head_advanced','generation_changed','base_raced'].includes(mode)){
    const {assessWorkspaceDiscards}=await import('../src/modules/projectFolders/workspaceDiscard.js');
    expect((await assessWorkspaceDiscards(db.pool,[binding.changeSetId],new Map())).get(binding.changeSetId)?.blocker).not.toBeNull();
    expect((await db.pool.query('SELECT cleanup_json FROM execution_workspaces WHERE id=$1',[c.row.id])).rows[0].cleanup_json).toEqual({});
   }
   if(mode==='dirty')expect(await import('node:fs/promises').then(fs=>fs.readFile(join(real.prepared.root,'unknown.txt'),'utf8'))).toBe('real unsaved work');
  }finally{await real.close();}
 });

 it('rechecks the observation after unlocked Host I/O before acknowledging an unlaunched checkpoint',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open'),failed=await conversationRun();
  await ensureExecutionWorkspace(db.pool,failed,HOST,LOCATION);
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[failed.id]);
  const hosts=new HostConnectionRegistry();
  hosts.requestTaskBranch=async():Promise<any>=>{
   // This update can complete because Host I/O holds no workspace row lock.
   await db.pool.query('UPDATE execution_workspaces SET revision=revision+1 WHERE id=$1',[c.row.id]);
   return {ok:true,unchanged_commit:B};
  };
  const {recoverUnlaunchedWorkspaceCheckpoint}=await import('../src/modules/projectFolders/workspaceUnlaunchedCheckpoint.js');
  expect(await recoverUnlaunchedWorkspaceCheckpoint(db.pool,failed.id,c.row.id,SPACE,hosts)).toBe(false);
  expect((await db.pool.query('SELECT checkpoint_state FROM execution_workspace_runs WHERE run_id=$1',[failed.id])).rows[0].checkpoint_state).toBe('pending');
 });

 it('retains the current primary physical workspace after publication without waiting for its own active cwd',async ctx=>{
  if(!db.available)return ctx.skip();
  const {recordWorkspaceLanding,refreshWorkspaceLifecycle}=await import('../src/modules/hosts/workspaceLifecycle.js');
  const c=await settled('integrated'),f=await savedHost(c),hosts=new HostConnectionRegistry();
  try{
   await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,lifecycle}','1') WHERE id=$1",[HOST]);
   await recordWorkspaceLanding(db.pool,c.mergeId!);
   await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
   hosts.requestTaskBranch=async()=>{throw new Error('primary cwd must not be removed');};
   const first=await queued(c.row.id,f.tip);
   expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned',source_retained:true});
   await refreshWorkspaceLifecycle(db.pool,c.row.id);
   const {readFile}=await import('node:fs/promises');
   expect(await readFile(join(f.prepared.root,'file.txt'),'utf8')).toBe('saved');
   expect(f.git(['worktree','list','--porcelain']).split('worktree ').length-1).toBe(2);
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[c.run.id]);
   expect(await assessWorkspaceRetention(db.pool,c.row.id)).toMatchObject({state:'retained',reason:'primary_conversation'});
   expect((await db.pool.query("SELECT detail_json->'lifecycle' AS lifecycle FROM task_merges WHERE id=$1",[c.mergeId])).rows[0].lifecycle).toMatchObject({operation_id:c.mergeId,phase:'complete',source_retained:true});
  }finally{await f.close();}
 });

 it('reclaims closed work immediately even after recent activity and legacy grace configuration',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',60*30);
  await db.pool.query('UPDATE execution_workspaces SET updated_at=now() WHERE id=$1',[c.row.id]);
  await db.pool.query('UPDATE workspace_change_sets SET updated_at=now() WHERE id=$1',[c.w.changeSetId]);
  await db.pool.query('UPDATE runs SET updated_at=now() WHERE id=$1',[c.run.id]);
  expect(await assessWorkspaceRetention(db.pool,c.row.id)).toMatchObject({state:'reclaimable'});
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('content_changed_at',now()) WHERE id=$1`,[c.row.id]);
  expect(await assessWorkspaceRetention(db.pool,c.row.id)).toMatchObject({state:'reclaimable'});
  await db.pool.query(`UPDATE execution_workspaces SET retention_json='{}' WHERE id=$1`,[c.row.id]);
  await db.pool.query('UPDATE runs SET ended_at=now() WHERE id=$1',[c.run.id]);
  expect(await assessWorkspaceRetention(db.pool,c.row.id)).toMatchObject({state:'reclaimable'});
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
  expect(await assessWorkspaceRetention(db.pool,c.row.id)).toMatchObject({state:'active',reason:'run_active'});
 });

 it('replays a lost idle capture reply at its original operation even after the branch tip moved',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open',60*30),first=await queued(c.row.id),hosts=confirmingHosts(),frames:any[]=[];
  let captured=false;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:captured?D:B,inventory:inventory(),error:null};
   if(!captured){captured=true;return {ok:false,error:'host_offline'};}
   return {ok:false,commit:D,inventory:inventory(),error:'workspace_content_captured'};
  };
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_content_changed');
  expect(frames.filter(f=>f.action==='cleanup').map(f=>f.operation_id)).toEqual([first.operation_id,first.operation_id]);
  expect((await workspace(c.row.id)).head_commit).toBe(D);
 });

 it('immediately removes a just-merged branch and worktree through real PostgreSQL and Host Git',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',0);
  const fixture=await savedHost(c),{git,prepared,command,base,tip}=fixture;
  try{
   git(['merge','--ff-only',tip]);
   await db.pool.query('UPDATE task_merges SET source_commit=$2,task_commit=$2,merged_commit=$2,base_commit=$3,onto_commit=$3 WHERE workspace_id=$1',[c.row.id,tip,base]);
   const first=await queued(c.row.id,tip),hosts=new HostConnectionRegistry();
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>command(frame);
   expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
   await drainPages(c.row.id,hosts);
   const seen:any=await command({action:'inspect'});
   expect(seen.inventory).toMatchObject({branch:false,worktree:false,registration:false});
   expect(git(['branch','--list',`rainver/workspace-${c.row.id}-g1`])).toBe('');
   expect(git(['worktree','list','--porcelain'])).not.toContain(prepared.root);
   expect((await workspace(c.row.id)).retention_json).toMatchObject({state:'reclaimed'});
  }finally{
   await fixture.close();
  }
 });

 it('continues Host admission beyond 4096 entries without exhausting retries and retains unknown ignored bytes',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',0),fixture=await savedHost(c);
  const {git,repo,config,prepared,tip,base,command}=fixture;
  try{
   await writeFile(join(repo,'.git','info','exclude'),'asset.secret\n');
   await writeFile(join(prepared.root,'asset.secret'),'unique ignored bytes');
   const quarantine=join(config,'task-worktrees-quarantine',LOCATION);await mkdir(quarantine,{recursive:true});
   for(let i=0;i<4100;i++)await mkdir(join(quarantine,`shell-${String(i).padStart(5,'0')}-retired`));
   git(['merge','--ff-only',tip]);
   await db.pool.query('UPDATE task_merges SET source_commit=$2,task_commit=$2,merged_commit=$2,base_commit=$3 WHERE workspace_id=$1',[c.row.id,tip,base]);
   const first=await queued(c.row.id,tip),hosts=new HostConnectionRegistry();
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>command(frame);
   let waits=0,cleaned=false;
   for(let i=0;i<40;i++){
    try{const result=await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts);cleaned=(result as any).cleanup_state==='cleaned';if(cleaned)break;}
    catch(e){if(!(e instanceof Error)||e.message!=='workspace_ignored_scan_pending')throw e;waits++;}
    expect(await resource(c.row.id)).toMatchObject({state:'retry_wait',attempts:0,error:'workspace_ignored_scan_pending'});
    if(i===1)await mkdir(join(quarantine,'aaa-new-retired'));
   }
   expect(waits).toBe(0);expect(cleaned).toBe(true);
   await drainPages(c.row.id,hosts);
   expect((await command({action:'inspect'})).inventory).toMatchObject({branch:false,worktree:false,registration:false});
   expect(git(['worktree','list','--porcelain'])).not.toContain(prepared.root);
   expect(await (await import('node:fs/promises')).readFile(join(quarantine,`workspace:${c.row.id}:1-preserved-ignored`,'files','asset.secret'),'utf8')).toBe('unique ignored bytes');
  }finally{await fixture.close();}
 });

 it('wakes a retired refused source on an external Git merge in the very next pass and physically reclaims it',async ctx=>{
  if(!db.available)return ctx.skip();
  await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,lifecycle}','1') WHERE id=$1",[HOST]);
  const c=await settled('integrated',0),fixture=await savedHost(c);
  const {git,command,tip,base,prepared}=fixture;
  try{
   await db.pool.query('UPDATE task_merges SET source_commit=$2,task_commit=$2,merged_commit=$2,base_commit=$3 WHERE workspace_id=$1',[c.row.id,tip,base]);
   const first=await queued(c.row.id,tip),hosts=new HostConnectionRegistry();
   hosts.isOnline=()=>true;hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>command(frame);
   await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts);
   expect((await workspace(c.row.id)).retention_json).toMatchObject({reason:'unmerged_source',proof_refused_tip:tip});
   expect((await command({action:'inspect'})).inventory).toMatchObject({branch:true});
   // A just-recorded observation must not impose the old five-minute delay.
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_observed_at',now(),'proof_observation',jsonb_build_object('generation',1,'source',$2::text,'target',$3::text)) WHERE id=$1`,[c.row.id,tip,base]);
   git(['merge','--ff-only',tip]);
   await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[c.row.id]);
   expect((await reconcileExecutionWorkspaces(db.pool,'/',{hostId:HOST,hosts})).failures).toEqual([]);
   const next=await resource(c.row.id);
   expect(next.operation_id).not.toBe(first.operation_id);
   expect((await workspace(c.row.id)).retention_json.proof_refused_tip).toBeUndefined();
   await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',next.operation_id,OWNER,hosts);
   await drainPages(c.row.id,hosts);
   expect((await command({action:'inspect'})).inventory).toMatchObject({branch:false,worktree:false,registration:false});
   expect(git(['branch','--list',`rainver/workspace-${c.row.id}-g1`])).toBe('');
   expect(git(['worktree','list','--porcelain'])).not.toContain(prepared.root);
  }finally{await fixture.close();}
 });

 it.for(['target','source'] as const)('resets pin backoff on real %s movement without losing unpublished bytes',async(direction,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',0),fixture=await savedHost(c);
  const {git,command,tip,base,prepared,repo}=fixture;
  try{
   await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','6') WHERE id=$1",[HOST]);
   // The recovery ref is the only extra durable copy; refusing it must leave
   // both the ref and exact readable Git bytes, not merely a DB status.
   const pin=`refs/rainver/recovery/${c.row.id}/${tip}`;git(['update-ref',pin,tip]);
   const {key}=await enqueueRefRelease(db.pool,await workspace(c.row.id),'ref_pages',[{ref:pin,expected_commit:tip}],OWNER,new Date(),{owned_after:null,retained_count:0,workspace:{id:c.row.id,generation:1,target_ref:'refs/heads/main'},release_epoch:0,reason_on_finish:'merged'});
   const hosts=new HostConnectionRegistry();hosts.isOnline=()=>true;
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>command(frame);
   let page=await resource(c.row.id,key);
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,page.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
   page=await resource(c.row.id,key);
   expect(page).toMatchObject({state:'retry_wait',proof_waits:1});
   expect(git(['show',`${pin}:file.txt`])).toBe('saved');
   await db.pool.query(`UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_observed_at',now(),'proof_observation',jsonb_build_object('generation',1,'source',$2::text,'target',$3::text)),cleanup_json=jsonb_set(cleanup_json,ARRAY[$4],(cleanup_json->$4)||jsonb_build_object('proof_waits',9,'next_retry_at',now()+interval '7 days')) WHERE id=$1`,[c.row.id,tip,base,key]);
   if(direction==='target')git(['merge','--ff-only',tip]);
   else{
    await writeFile(join(repo,'outside.txt'),'new target-independent source');
    git(['add','outside.txt']);git(['commit','-qm','new version']);
    // Move only the fixture source, never any shared repository reference.
    git(['update-ref',`refs/heads/rainver/workspace-${c.row.id}-g1`,git(['rev-parse','HEAD']),tip]);
   }
   expect((await reconcileExecutionWorkspaces(db.pool,'/',{hostId:HOST,hosts})).failures).toEqual([]);
   const awake=await resource(c.row.id,key);
   expect(awake).toMatchObject({state:'pending',proof_waits:0,next_retry_at:null});
   expect(awake.operation_id).not.toBe(page.operation_id);
   if(direction==='target'){
    await advanceWorkspaceCleanup(db.pool,c.row.id,key,awake.operation_id,OWNER,hosts);
    expect(git(['for-each-ref','--format=%(refname)',pin])).toBe('');
    expect(git(['show','refs/heads/main:file.txt'])).toBe('saved');
   }else{
    await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,awake.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
    expect(git(['show',`${pin}:file.txt`])).toBe('saved');
    expect(await (await import('node:fs/promises')).readFile(join(prepared.root,'file.txt'),'utf8')).toBe('saved');
   }
  }finally{await fixture.close();}
 });

 it('runs lost capture reply through real Host Git, server acknowledgement, idle grace and new cleanup',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open',60*30);
  const fixture=await savedHost(c),{git,command,prepared,tip}=fixture;
  try{
   await writeFile(join(prepared.root,'file.txt'),'idle unique bytes');
   const first=await queued(c.row.id,tip),hosts=new HostConnectionRegistry();let lost=false;
   hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
    const answer=await command(frame);
    if((frame as any).action==='cleanup'&&!lost){lost=true;return {ok:false,error:'host_offline'};}
    return answer;
   };
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('host_offline');
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_content_changed');
   const fresh=await resource(c.row.id),captured=(await workspace(c.row.id)).head_commit;
   expect(captured).not.toBe(tip);expect(git(['show',`${captured}:file.txt`])).toBe('idle unique bytes');
   expect(fresh.operation_id).not.toBe(first.operation_id);
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',fresh.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_idle_period');
   await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_set(retention_json,'{content_changed_at}',to_jsonb((now()-interval '25 hours')::text)) WHERE id=$1",[c.row.id]);
   expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',fresh.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
   const seen:any=await command({action:'inspect'});
   expect(seen.inventory).toMatchObject({branch:true,worktree:false,registration:false});
  }finally{
   await fixture.close();
  }
 });

 it('acknowledges a replayed capture once, replaces the request and cleans after the unchanged idle deadline',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open',60*30),first=await queued(c.row.id),hosts=confirmingHosts();
  let captured=false;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:captured?D:B,inventory:inventory(),error:null};
   if(f.operation_id===first.operation_id){captured=true;return {ok:false,commit:D,inventory:inventory(),error:'workspace_content_captured'};}
   return {ok:true,commit:D,cleanup_state:'cleaned',inventory:cleaned({branch:true}),error:null};
  };
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_content_changed');
  const fresh=await resource(c.row.id),at=(await workspace(c.row.id)).retention_json.content_changed_at;
  expect(fresh.operation_id).not.toBe(first.operation_id);expect(fresh.expected_commit).toBe(D);
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).toMatchObject({skipped:true});
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',fresh.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_idle_period');
  expect((await workspace(c.row.id)).retention_json.content_changed_at).toBe(at);
  await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_set(retention_json,'{content_changed_at}',to_jsonb((now()-interval '25 hours')::text)) WHERE id=$1",[c.row.id]);
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',fresh.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
 });

 it('never accepts an unknown cleanup action as proof of completion',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open',60*30),first=await queued(c.row.id),hosts=confirmingHosts();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}:{ok:true,commit:B,inventory:cleaned(),error:null};
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_incomplete');
 });

 it('revokes a dirty branch release and preserves later captured edits as a new unpublished batch',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',60*30),first=await queued(c.row.id),hosts=confirmingHosts();
  let physical=false;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:B,inventory:inventory(),error:null};
   physical=f.retain_branch;
   return f.retain_branch?{ok:false,commit:D,inventory:inventory(),error:'workspace_content_captured'}:{ok:false,commit:B,inventory:inventory(),error:'workspace_uncheckpointed'};
  };
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).toEqual({superseded:true});
  const replacement=await resource(c.row.id);
  expect(replacement).toMatchObject({retain_branch:true});expect(replacement.release_epoch).toBeUndefined();
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',replacement.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_content_changed');
  expect(physical).toBe(true);
  expect((await db.pool.query("SELECT state,base_commit,source_commit FROM workspace_change_sets WHERE workspace_id=$1 AND state='open'",[c.row.id])).rows).toEqual([{state:'open',base_commit:B,source_commit:D}]);
 });

 it('records safe idle capture as new unpublished work and starts the physical clock at content change',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open',60*30),first=await queued(c.row.id);
  const hosts=confirmingHosts();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>(frame as any).action==='inspect'?{ok:true,commit:B,inventory:inventory(),error:null}:{ok:false,commit:D,inventory:inventory(),error:'workspace_content_captured'};
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_content_changed');
  expect(await workspace(c.row.id)).toMatchObject({head_commit:D,retention_json:{content_changed_at:expect.any(String)}});
  expect((await db.pool.query('SELECT source_commit,state FROM workspace_change_sets WHERE id=$1',[c.w.changeSetId])).rows[0]).toMatchObject({source_commit:D,state:'open'});
  const next=await queued(c.row.id,D);
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',next.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_idle_period');
 });

 it.for(['settled','lost_reply'] as const)('keeps an unproven checkpoint in a scheduled ref Job and releases it on a later proven retry: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await settled('integrated',60),pin=`refs/rainver/recovery/${c.row.id}/${B}`;
  await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','6') WHERE id=$1",[HOST]);
  const first=await queued(c.row.id),hosts=confirmingHosts();let proven=false;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:B,inventory:inventory({owned_refs:[{ref:pin,commit:B}]}),error:null};
   if(f.action==='release_refs'){
    expect(f.reclaim_proof).toContain(C);
    return {ok:true,inventory:{ref_operation:f.operation_id,retained_refs:proven?[]:[{ref:pin,reason:'checkpoint_not_in_target'}]},error:null};
   }
   return {ok:true,cleanup_state:'cleaned',inventory:cleaned({owned_refs:[{ref:pin,commit:B}],retained_refs:[{ref:pin,reason:'checkpoint_not_in_target'}]}),error:null};
  };
  await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts);
  const key=await pageKey(c.row.id),r=await resource(c.row.id,key);
  expect(r.release_refs).toContainEqual({ref:pin,expected_commit:B});
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,r.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
  expect(await resource(c.row.id,key)).toMatchObject({state:'retry_wait',next_retry_at:expect.any(String),error:'checkpoint_not_in_target',release_refs:expect.arrayContaining([{ref:pin,expected_commit:B}])});
  const firstWait=await resource(c.row.id,key);
  expect(firstWait.proof_waits).toBe(1);
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,firstWait.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
  const secondWait=await resource(c.row.id,key);
  expect(secondWait.proof_waits).toBe(2);
  expect(Date.parse(secondWait.next_retry_at!)-Date.parse(firstWait.next_retry_at!)).toBeGreaterThanOrEqual(3600_000);
  for(let i=3;i<=10;i++){
   const start=Date.now();
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,firstWait.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
   const retry=await resource(c.row.id,key),delay=Date.parse(retry.next_retry_at!)-start;
   expect(retry.proof_waits).toBe(Math.min(i,9));
   expect(delay).toBeGreaterThanOrEqual(Math.min(7*86400_000,3600_000*2**(i-1)));
   expect(delay).toBeLessThan(7*86400_000+10_000);
  }
  // Existing backoff wakes once when history-backed release becomes available.
  const oldClaim={operation_id:randomUUID(),refs:[{ref:pin,expected_commit:B}],sources:[],fence:2};
  if(mode==='lost_reply')await db.pool.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2,'inflight'],$3::jsonb) WHERE id=$1",[c.row.id,key,JSON.stringify(oldClaim)]);
  const sleeping=await resource(c.row.id,key);
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await resource(c.row.id,key)).operation_id).toBe(sleeping.operation_id);
  await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','7') WHERE id=$1",[HOST]);
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  const upgraded=await resource(c.row.id,key);
  expect(upgraded).toMatchObject({state:'pending',next_retry_at:null});
  expect(upgraded.operation_id).not.toBe(sleeping.operation_id);
  if(mode==='lost_reply'){
   expect(upgraded.inflight).toEqual(oldClaim);
   expect(upgraded.history_proof_level).toBeUndefined();
  }else expect(upgraded.history_proof_level).toBe(7);
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,upgraded.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
  if(mode==='lost_reply'){
   // The old operation's frozen refusal settles first. It has not yet tried
   // the new proof, so wake once more for a genuinely fresh claim.
   expect((await resource(c.row.id,key)).inflight).toBeUndefined();
   await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
   const fresh=await resource(c.row.id,key);
   expect(fresh).toMatchObject({state:'pending',history_proof_level:7});
   await expect(advanceWorkspaceCleanup(db.pool,c.row.id,key,fresh.operation_id,OWNER,hosts)).rejects.toThrow('checkpoint_not_in_target');
  }
  const stillUnproven=await resource(c.row.id,key);
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect(await resource(c.row.id,key)).toEqual(stillUnproven);
  const {wakeWorkspaceProofs}=await import('../src/modules/hosts/workspaceProofWake.js');
  const beforeWake=await resource(c.row.id,key);
  await wakeWorkspaceProofs(db.pool,c.row,OWNER,B,D);
  const awake=await resource(c.row.id,key);
  expect(awake).toMatchObject({state:'pending',proof_waits:0,attempts:0,next_retry_at:null});
  expect(awake.operation_id).not.toBe(beforeWake.operation_id);
  // JSONB ordering must not renew an unchanged observation's wait.
  await db.pool.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||jsonb_build_object('state','retry_wait','error','checkpoint_not_in_target','proof_waits',9,'next_retry_at',now()+interval '7 days')) WHERE id=$1",[c.row.id,key]);
  await wakeWorkspaceProofs(db.pool,c.row,OWNER,B,D);
  expect((await resource(c.row.id,key)).proof_waits).toBe(9);
  await wakeWorkspaceProofs(db.pool,c.row,OWNER,B,A);
  expect((await resource(c.row.id,key)).proof_waits).toBe(0);
  proven=true;
  // Upgrade an older persisted blocked pin without requiring a manual retry.
  await db.pool.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY[$2],(cleanup_json->$2)||jsonb_build_object('state','blocked','next_retry_at',null)) WHERE id=$1",[c.row.id,key]);
  await db.pool.query("DELETE FROM jobs WHERE job_type='execution_workspace_cleanup' AND payload_json->>'resource_key'=$1",[key]);
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup' AND status='pending' AND payload_json->>'resource_key'=$1",[key])).rowCount).toBeGreaterThan(0);
  const resumed=await resource(c.row.id,key);
  expect(resumed.state).toBe('pending');
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,key,resumed.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
 });

 it('reclaims a just-merged source immediately with exact Host proof, without waiting for grace',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w,mergeId}=await settled('integrated',0);
  const hosts=confirmingHosts(),frames:any[]=[];
  const ownedRecovery=`refs/rainver/recovery/${w.workspace.id}/${B}`,native=`refs/rainver/native-preimages/${w.workspace.id}/g1/${randomUUID()}`,stray=`refs/rainver/recovery/${w.workspace.id}/${D}`;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);const f=frame as any;
   if(f.action==='inspect')return {ok:true,commit:B,inventory:inventory({worktree:false,registration:false,owned_refs:[{ref:ownedRecovery,commit:B},{ref:native,commit:D},{ref:stray,commit:D}]}),error:null};
   return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned({owned_refs:[{ref:stray,commit:D}]}),error:null};};
  const first=await queued(w.workspace.id);
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

 it('journals explicit discard through cleanup and ref pages, expires recovery history, and never transfers it to a moved tip',async ctx=>{
  if(!db.available)return ctx.skip();
  const {w}=await settled('abandoned',30);
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','5') WHERE id=$1`,[HOST]);
  await db.pool.query(`UPDATE workspace_change_sets SET verification_json='{"closure_review":{"disposition":"discard_requested"}}' WHERE id=$1`,[w.changeSetId]);
  await db.pool.query(`UPDATE execution_workspaces SET state='retired',baseline_mode='snapshot',retention_json=jsonb_build_object('discard_intent',jsonb_build_object('generation',1,'source_commit',$2::text,'change_set_id',$3::text)) WHERE id=$1`,[w.workspace.id,B,w.changeSetId]);
  const first=await queued(w.workspace.id);
  const hosts=confirmingHosts(),frames:any[]=[];let moved=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:moved?C:B,inventory:inventory(),error:null};
   return {ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned({history_refs:[B],history_epochs:{[B]:0}}),error:null};
  };
  await expect(advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_discard_tip_changed');
  expect(frames.some(f=>f.action==='cleanup')).toBe(false);
  expect((await resource(w.workspace.id)).expected_commit).toBe(B);
  moved=false;
  await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',first.operation_id,OWNER,hosts);
  const release=frames.find(f=>f.action==='cleanup');
  expect(release).toMatchObject({discard_commit:B,expected_commit:B,retain_branch:false});
  expect(release.history_commits).toEqual(expect.arrayContaining([A,B]));
  expect(release.reclaim_proof).not.toContain(B);
  await drainPages(w.workspace.id,hosts);
  const after=await workspace(w.workspace.id);
  expect(after.retention_json).toMatchObject({state:'reclaimed',reason:'discarded',history_until:expect.any(String)});
  expect(after.cleanup_json['run-history-g1']).toMatchObject({kind:'run_history',state:'pending',release_refs:expect.arrayContaining([expect.objectContaining({expected_commit:B,due_at:expect.any(String)})])});
  expect(frames.filter(f=>f.action==='release_refs').flatMap(f=>f.release_refs)).toContainEqual(expect.objectContaining({ref:`refs/rainver/sources/${B}`}));
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
  // An external merge has no database task_merge row. A bounded periodic
  // retry must still send the same source/base/generation to the Host for proof.
  await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_refused_at',now()-interval '2 hours') WHERE id=$1",[w.workspace.id]);
  expect((await assessWorkspaceRetention(db.pool,w.workspace.id)).state).toBe('reclaimable');
  await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_refused_at',now()) WHERE id=$1",[w.workspace.id]);
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

 it.for(['current','future_cleanup','real_cleanup_block'] as const)('recovers conversation admission after an actual daemon heartbeat without turning closed history into decisions: %s',async(mode,ctx)=>{
  if(!db.available)return ctx.skip();
  const history=[await settled('no_changes'),await settled('no_changes'),await settled('no_changes')];
  const w=history[0]!.w.workspace;
  expect(new Set(history.map(c=>c.w.workspace.id)).size).toBe(1);
  const cleanup={version:1,workspace:{id:w.id,generation:1},operation_id:randomUUID(),expected_commit:B,retain_branch:true,
   state:mode==='real_cleanup_block'?'blocked':'cleaned',attempts:0,error:mode==='real_cleanup_block'?'workspace_dirty':null,next_retry_at:null};
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=$2::jsonb,cleanup_state='blocked',
   retention_json='{"state":"retained","reason":"kept_without_merging"}',inventory_json='{"reconciliation_error":"execution_workspace_host_upgrade_required"}' WHERE id=$1`,[w.id,JSON.stringify({'source-g1':cleanup})]);
  await db.pool.query("UPDATE hosts SET capabilities_json='{}'::jsonb WHERE id=$1",[HOST]);
  const hosts=confirmingHosts();let online=true,inspections=0;
  hosts.isOnline=()=>online;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if((frame as any).action==='list_refs')return {ok:true,refs:[],next:null,error:null};
   expect((frame as any).action).toBe('inspect');inspections++;
   return {ok:true,commit:B,inventory:inventory(),error:null};
  };
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await workspace(w.id)).cleanup_state).toBe(mode==='real_cleanup_block'?'blocked':'retry_wait');
  expect(inspections).toBe(0);
  const daemon=await import(new URL('../../packages/host-daemon/src/capabilities.ts',import.meta.url).href);
  const offered={...daemon.executionWorkspaceCapability('linux'),...(mode==='future_cleanup'?{reclaim:8}:{})};
  const capabilities=normalizeHostCapabilities({execution_workspaces:offered});
  expect(await new PgHostRepository(db.pool).recordHeartbeat(HOST,{platform:'linux',arch:'x64',daemon_version:'0.4.8',capabilities_json:capabilities})).toBe(true);
  const host=(await db.pool.query<ExecutionHostRow>('SELECT * FROM hosts WHERE id=$1',[HOST])).rows[0]!;
  expect(hostSummary(host,CONVERSATION)).toMatchObject({online:true,isolated_workspaces_available:true});
  // Existing blocked summaries need a successful, fenced Host observation to clear.
  await db.pool.query("UPDATE execution_workspaces SET cleanup_state='blocked' WHERE id=$1",[w.id]);
  online=false;await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await workspace(w.id)).cleanup_state).toBe('blocked');
  online=true;
  expect((await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts})).failures).toEqual([]);
  const after=await workspace(w.id);
  expect(after.inventory_json).not.toHaveProperty('reconciliation_error');
  expect(after.cleanup_state).toBe(mode==='real_cleanup_block'?'blocked':'pending');
  if(mode==='real_cleanup_block')expect(after.cleanup_json['source-g1']).toEqual(cleanup);
  else expect(after.cleanup_json['source-g1']).toMatchObject({error:null,expected_commit:B,workspace:{id:w.id,generation:1}});
  const pending=await conversationWorkspaceChangesForViewer(db.pool,SPACE,CONVERSATION,OWNER);
  expect(pending!.entries).toHaveLength(mode==='real_cleanup_block'?3:0);
  // Cleanup attention never prevents a supported conversation from acquiring its own binding.
  const next=await conversationRun();
  const admitted=await ensureExecutionWorkspace(db.pool,next,HOST,LOCATION);
  expect(admitted.workspace.id).toBe(w.id);
  // Future additive cleanup levels must still carry the known launch fence.
  expect(admitted.ref.materialization_epoch).toBe(0);
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

 it('retires cleanup attention for abandoned unsaved history only after a fenced Host absence receipt',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('abandoned');
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=NULL WHERE id=$1",[c.w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked',checkpoint_commit=NULL WHERE run_id=$1",[c.run.id]);
  await db.pool.query(`UPDATE execution_workspaces SET state='retired',head_commit=NULL,cleanup_state='blocked',
   inventory_json='{"reconciliation_error":"workspace_checkpoint_blocked"}' WHERE id=$1`,[c.row.id]);
  const hosts=confirmingHosts();hosts.isOnline=()=>true;let present=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   const action=(frame as any).action;
   if(action==='list_refs')return {ok:true,refs:[],refs_next:null,error:null};
   expect(action).toBe('inspect');
   return {ok:true,commit:null,inventory:present?inventory():cleaned(),error:null};
  };
  await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
  expect((await workspace(c.row.id)).cleanup_state).toBe('blocked');
  present=false;
  await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json-'assessed_at' WHERE id=$1",[c.row.id]);
  expect((await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts})).failures).toEqual([]);
  // A queued checkpoint is still an obligation, even for closed history.
  expect((await workspace(c.row.id)).cleanup_state).toBe('blocked');
  await db.pool.query("UPDATE jobs SET status='failed' WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[c.run.id]);
  expect((await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts})).failures).toEqual([]);
  expect(await workspace(c.row.id)).toMatchObject({cleanup_state:'cleaned',head_commit:null,
   inventory_json:{checkpoint_history_generation:1,checkpoint_history_epoch:0,checkpoint_history_closed_at:expect.any(String)},
   retention_json:{state:'retained',reason:'kept_without_merging'}});
  expect((await db.pool.query('SELECT checkpoint_state,checkpoint_commit FROM execution_workspace_runs WHERE run_id=$1',[c.run.id])).rows[0]).toEqual({checkpoint_state:'blocked',checkpoint_commit:null});
  expect((await conversationWorkspaceChangesForViewer(db.pool,SPACE,CONVERSATION,OWNER))!.entries).toEqual([]);
  const {workspaceRecoveryDiagnostics}=await import('../src/modules/projectFolders/workspaceRecoveryDiagnostics.js');
  expect(await workspaceRecoveryDiagnostics(db.pool,c.row.id,c.w.changeSetId!)).toContainEqual(expect.objectContaining({kind:'checkpoint',recovery_action:null,guidance:expect.stringContaining('Historical checkpoint failure')}));
  const {listAgentWorkspaces}=await import('../src/modules/projectFolders/workspaceOverview.js');
  expect((await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'current',limit:50})).items).toEqual([]);
  expect((await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'history',limit:50})).items[0]).toMatchObject({work_state:'kept'});
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_cleanup'")).rowCount).toBe(0);
  // New work invalidates the history receipt; the old failure is never rewritten as saved.
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[c.w.changeSetId]);
  const {lockUnchangedIdleWorkspace}=await import('../src/modules/hosts/workspaceReconcileFence.js');
  expect(await lockUnchangedIdleWorkspace(db.pool,await workspace(c.row.id))).toBe(false);
  expect((await workspace(c.row.id)).cleanup_state).toBe('blocked');
 });

 it('keeps absent closed history unresolved when Host observations are incomplete, quarantined or stale',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('abandoned');
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=NULL WHERE id=$1",[c.w.changeSetId]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[c.run.id]);
  await db.pool.query("UPDATE execution_workspaces SET state='retired',head_commit=NULL,cleanup_state='blocked' WHERE id=$1",[c.row.id]);
  const {recordClosedCheckpointHistory}=await import('../src/modules/hosts/workspaceReconcileFence.js');
  const before=await workspace(c.row.id);
  for(const blocked of [{},{...cleaned(),registration:true},{...cleaned(),run_record:true},{...cleaned(),quarantined_whole:1}]){
   expect(await recordClosedCheckpointHistory(db.pool,before,blocked)).toBe(false);
  }
  await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=materialization_epoch+1 WHERE id=$1',[c.row.id]);
  expect(await recordClosedCheckpointHistory(db.pool,before,cleaned())).toBe(false);
  expect((await workspace(c.row.id)).cleanup_state).toBe('blocked');
 });

 it('releases missing-acknowledged child dependencies while preserving unresolved children and open work',async ctx=>{
  if(!db.available)return ctx.skip();
  const parent=await settled('no_changes'),child=randomUUID(),change=randomUUID();
  await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,session_id,parent_workspace_id,generation,state,head_commit,cleanup_state,inventory_json,retention_json)
   VALUES($1,$2,$3,$4,$5,'conversation',$6,$7,2,'retired',$8,'cleaned',$9::jsonb,
   jsonb_build_object('state','missing','reason','missing_acknowledged','missing_acknowledged_at',now()))`,[child,SPACE,PROJECT,LOCATION,HOST,CONVERSATION,parent.row.id,D,JSON.stringify(cleaned())]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit)
   VALUES($1,$2,$3,2,1,$4,$4,'abandoned',$5,$6)`,[change,child,SPACE,parent.run.id,A,D]);
  const {workspaceDiscardDependenciesActive}=await import('../src/modules/projectFolders/workspaceDiscardDependencies.js');
  expect(await assessWorkspaceRetention(db.pool,parent.row.id)).toMatchObject({state:'reclaimable'});
  expect(await workspaceDiscardDependenciesActive(db.pool,parent.row.id,parent.w.changeSetId!)).toBe(false);
  for(const patch of ["retention_json=retention_json-'missing_acknowledged_at'","inventory_json=jsonb_set(inventory_json,'{branch}','true')","cleanup_state='blocked'"]){
   const before=await workspace(child);
   await db.pool.query(`UPDATE execution_workspaces SET ${patch} WHERE id=$1`,[child]);
   expect(await assessWorkspaceRetention(db.pool,parent.row.id)).toMatchObject({reason:'child_workspace_dependency'});
   expect(await workspaceDiscardDependenciesActive(db.pool,parent.row.id,parent.w.changeSetId!)).toBe(true);
   await db.pool.query('UPDATE execution_workspaces SET retention_json=$2::jsonb,inventory_json=$3::jsonb,cleanup_state=$4 WHERE id=$1',[child,JSON.stringify(before.retention_json),JSON.stringify(before.inventory_json),before.cleanup_state]);
  }
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[change]);
  expect(await workspaceDiscardDependenciesActive(db.pool,parent.row.id,parent.w.changeSetId!)).toBe(true);
 });

 it('diagnoses current recovery independently of old cleanup keys and never advertises launched or safety-blocked debt',async ctx=>{
  if(!db.available)return ctx.skip();
  const {workspaceRecoveryDiagnostics,workspaceRecoveryBlocker}=await import('../src/modules/projectFolders/workspaceRecoveryDiagnostics.js');
  const c=await settled('no_changes'),current=await queued(c.row.id,A);
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=cleanup_json||jsonb_build_object('old',$2::jsonb) WHERE id=$1`,[c.row.id,JSON.stringify({...current,workspace:{...current.workspace,generation:0},state:'blocked',error:'workspace_cleanup_incomplete'})]);
  expect(await workspaceRecoveryBlocker(db.pool,c.row.id)).toBeNull();
  expect(await workspaceRecoveryDiagnostics(db.pool,c.row.id,c.w.changeSetId!)).toEqual(expect.arrayContaining([
   expect.objectContaining({state:'blocked',recovery_action:null}),
   expect.objectContaining({state:'pending',recovery_action:'workspace.retention.update'})
  ]));
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[c.run.id]);
  expect(await workspaceRecoveryDiagnostics(db.pool,c.row.id,c.w.changeSetId!)).toEqual(expect.arrayContaining([expect.objectContaining({kind:'checkpoint',recovery_action:null})]));
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1}', $2::jsonb) WHERE id=$1`,[c.row.id,JSON.stringify({...current,state:'blocked',error:'workspace_cleanup_incomplete'})]);
  expect(await workspaceRecoveryBlocker(db.pool,c.row.id)).toBe('workspace_discard_safety_blocked');
  expect((await workspaceRecoveryDiagnostics(db.pool,c.row.id,c.w.changeSetId!)).every(d=>d.recovery_action===null)).toBe(true);
 });

 it('limits get recovery hints and execution to the selected batch while each batch can recover its own checkpoint',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('abandoned'),other=await conversationRun('failed'),otherChange=randomUUID();
  await db.pool.query("UPDATE runs SET status='failed' WHERE id=$1",[c.run.id]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=NULL WHERE id=$1",[c.w.changeSetId]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,space_id,workspace_id,generation,sequence,state,base_commit,originating_run_id,root_run_id)
   SELECT $2,space_id,workspace_id,generation,sequence+1,'abandoned',base_commit,$3,$3 FROM workspace_change_sets WHERE id=$1`,[c.w.changeSetId,otherChange,other.id]);
  await db.pool.query(`INSERT INTO execution_workspace_runs(run_id,space_id,workspace_id,change_set_id,access_mode,launch_sequence,checkpoint_state)
   VALUES($1,$2,$3,$4,'write',0,'pending')`,[other.id,SPACE,c.row.id,otherChange]);
  await db.pool.query(`UPDATE execution_workspace_runs SET start_commit=NULL,launch_sequence=0,checkpoint_state='pending',checkpoint_recovery_json=jsonb_build_object('state','exhausted','error',CASE WHEN run_id=$2 THEN 'selected_checkpoint_failed' ELSE 'other_checkpoint_failed' END,'request_id',run_id)
   WHERE workspace_id=$1`,[c.row.id,c.run.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=sessionActor({spaceId:SPACE,userId:OWNER});
  const get=async(id:string)=>{const r=await engine.execute('workspace.change.get',{change_set_id:id},actor,randomUUID(),undefined);expect(r.http_status,JSON.stringify(r.body)).toBe(200);return (r.body as any).data;};
  const a=await get(c.w.changeSetId!);
  expect(a.diagnostics).toEqual(expect.arrayContaining([
   expect.objectContaining({reason:'selected_checkpoint_failed',recovery_action:'workspace.retention.update'}),
   expect.objectContaining({reason:'other_checkpoint_failed',recovery_action:null,guidance:expect.stringContaining('authorized for its own batch')})
  ]));
  const before=(await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[other.id])).rows[0];
  const jobs=async()=>Number((await db.pool.query("SELECT count(*) FROM jobs WHERE job_type='execution_workspace_checkpoint' AND payload_json->>'run_id'=$1",[other.id])).rows[0].count);
  const count=await jobs();
  const recover=async(id:string,revision:number)=>{const r=await engine.execute('workspace.retention.update',{change_set_id:id,expected_revision:revision,action:'recover'},actor,randomUUID(),randomUUID());expect(r.http_status,JSON.stringify(r.body)).toBe(200);};
  await recover(c.w.changeSetId!,a.revision);
  expect((await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[other.id])).rows[0]).toEqual(before);
  expect(await jobs()).toBe(count);
  const b=await get(otherChange);
  expect(b.diagnostics).toContainEqual(expect.objectContaining({reason:'other_checkpoint_failed',recovery_action:'workspace.retention.update'}));
  await recover(otherChange,b.revision);
  expect((await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[other.id])).rows[0].checkpoint_recovery_json.state).toBe('requested');
  expect(await jobs()).toBe(count+1);
 });

 it('keeps launched pending recovery diagnostics, applicability and execution behind the same current-generation gate',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('open');
  await db.pool.query(`UPDATE execution_workspace_runs SET checkpoint_state='pending',checkpoint_recovery_json='{"state":"exhausted"}' WHERE run_id=$1`,[c.run.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri})),actor=sessionActor({spaceId:SPACE,userId:OWNER});
  const read=await engine.execute('workspace.change.get',{change_set_id:c.w.changeSetId},actor,randomUUID(),undefined);
  expect(read.http_status,JSON.stringify(read.body)).toBe(200);const data=(read.body as any).data;
  expect(data.diagnostics).toContainEqual(expect.objectContaining({kind:'checkpoint',recovery_action:null}));
  expect(data.actions).toContainEqual(expect.objectContaining({action:'recover',available:false,blocker:'checkpoint_pending'}));
  const before=(await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[c.run.id])).rows[0];
  const beforeJobs=(await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint'")).rowCount;
  const result=await engine.execute('workspace.retention.update',{change_set_id:c.w.changeSetId,expected_revision:data.revision,action:'recover'},actor,randomUUID(),randomUUID());
  expect(result.http_status).toBe(409);expect(result.body).toMatchObject({error:{metadata:{code:'checkpoint_pending'}}});
  expect((await db.pool.query('SELECT checkpoint_recovery_json FROM execution_workspace_runs WHERE run_id=$1',[c.run.id])).rows[0]).toEqual(before);
  expect((await db.pool.query("SELECT 1 FROM jobs WHERE job_type='execution_workspace_checkpoint'")).rowCount).toBe(beforeJobs);
 });

 it('reclaims a stale running cleanup Job and replays its original request without a second enqueue',async ctx=>{
  if(!db.available)return ctx.skip();
  const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
  const c=await settled('no_changes'),first=await queued(c.row.id,A);
  const hosts=confirmingHosts(),sent:any[]=[];
  let lose=true;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if((frame as any).action==='inspect')return {ok:true,commit:A,inventory:inventory(),error:null};
   sent.push(frame);return lose?{ok:false,error:'host_timeout'}:{ok:true,cleanup_state:'cleaned',inventory:cleaned(),error:null};
  };
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  await db.pool.query(`UPDATE jobs SET status='running',claimed_by='interrupted-worker',attempts=1,heartbeat_at=now()-interval '20 minutes',updated_at=now()-interval '20 minutes'
   WHERE job_type='execution_workspace_cleanup' AND payload_json->>'operation_id'=$1`,[first.operation_id]);
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1,state}','"running"') WHERE id=$1`,[c.row.id]);
  expect(await new PgJobQueueRepository(db.pool).reclaimStuckJobs(600)).toMatchObject({reclaimed_count:1});
  expect((await db.pool.query("SELECT status,payload_json FROM jobs WHERE payload_json->>'operation_id'=$1",[first.operation_id])).rows).toMatchObject([{status:'pending',payload_json:{operation_id:first.operation_id}}]);
  lose=false;
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
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
  expect(restored.operation_id).toBe(blocked.operation_id);
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
  // Default publication cleanup is already immediate; reclaim_now also refreshes its request.
  const parked=await queued(w.workspace.id);
  expect((await jobAt(parked.operation_id))!.getTime()).toBeLessThanOrEqual(Date.now()+1000);
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
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[w.workspace.id]);
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
  await expect(ensureExecutionWorkspace(db.pool,second,HOST,LOCATION)).rejects.toMatchObject({name:'JobDeferredError'});
  const {recoverUnlaunchedWorkspaceCheckpoint}=await import('../src/modules/projectFolders/workspaceUnlaunchedCheckpoint.js');
  const hosts=confirmingHosts();hosts.requestTaskBranch=async():Promise<any>=>({ok:true,inventory:cleaned()});
  expect(await recoverUnlaunchedWorkspaceCheckpoint(db.pool,failed.id,w.workspace.id,SPACE,hosts)).toBe(true);
  const joined=await ensureExecutionWorkspace(db.pool,second,HOST,LOCATION);
  expect(joined.changeSetId).not.toBe(first.changeSetId);
  // The joined open batch does not make the released tip a base again.
  expect(joined.ref).toMatchObject({sync_to_target:true,materialization_epoch:1});expect(joined.ref.base_commit).toBeUndefined();
  await recordWorkspaceLaunch(db.pool,second,{id:w.workspace.id,generation:1,start_commit:D,target_ref:'refs/heads/main',launch_sequence:4});
  expect(await workspace(w.workspace.id)).toMatchObject({base_commit:D,head_commit:D,retention_json:{state:'active'}});
  // The empty failed batch closed; the new batch uses the actual rebuilt start.
  expect((await db.pool.query('SELECT base_commit FROM workspace_change_sets WHERE id=$1',[joined.changeSetId])).rows[0].base_commit).toBe(D);
  // Once launched, the next Run continues that batch from its own tip, not the target.
  const third=await ensureExecutionWorkspace(db.pool,await conversationRun(),HOST,LOCATION);
  expect(third.ref.sync_to_target).toBeUndefined();expect(third.ref.base_commit).toBe(D);
 });

 it('replays an unconfirmed issued release unchanged and retains the Host quarantine refusal',async ctx=>{
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
  // Busy is not proof of nonexecution. Replay the same request; Host quarantine guards refuse it.
  quarantined=1;frames.length=0;
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{const f=frame as any;frames.push(f);
   if(f.action==='inspect')return {ok:true,commit:A,inventory:inventory({worktree:false,registration:false,quarantined_whole:1}),error:null};
   return {ok:false,commit:A,cleanup_state:'blocked',inventory:inventory({worktree:false,registration:false,quarantined_whole:1}),error:'workspace_quarantined'};};
  expect(await advanceWorkspaceCleanup(db.pool,w.workspace.id,'source-g1',issued.operation_id,OWNER,hosts)).toEqual({cleanup_state:'blocked'});
  const sent=frames.find(f=>f.action==='cleanup');
  expect(sent).toEqual(issued.cleanup_request);
  expect(sent.workspace.execution_workspace.materialization_epoch).toBe(0);
  const after=await resource(w.workspace.id);
  expect(after.release_epoch).toBe(0);expect(after).toMatchObject({state:'blocked',error:'workspace_quarantined'});
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
 it.for(['integrated','no_changes'] as const)('releases an unproven delegated %s source only on its exact reviewed discard',async(state,ctx)=>{
  if(!db.available)return ctx.skip();
  const c=await childFixture();
  await db.pool.query("UPDATE workspace_change_sets SET state=$2 WHERE id=$1",[c.change,state]);
  expect(await assessWorkspaceRetention(db.pool,c.id)).toMatchObject({state:'retained',reason:'child_adoption_unproven'});
  await db.pool.query(`UPDATE workspace_change_sets SET verification_json=verification_json||'{"closure_review":{"disposition":"discard_requested"}}'::jsonb WHERE id=$1`,[c.change]);
  await db.pool.query(`UPDATE execution_workspaces SET state='retired',retention_json=retention_json||jsonb_build_object('discard_intent',jsonb_build_object('generation',1,'source_commit',$2::text,'change_set_id',$3::text)) WHERE id=$1`,[c.id,D,c.change]);
  expect(await assessWorkspaceRetention(db.pool,c.id)).toMatchObject({state:'reclaimable',reason:'discarded'});
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
  expect(await assessWorkspaceRetention(db.pool,c.id)).toMatchObject({state:'active',reason:'run_active'});
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[c.run.id]);
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[c.id,C]);
  expect(await assessWorkspaceRetention(db.pool,c.id)).not.toMatchObject({state:'reclaimable',reason:'discarded'});
  expect((await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0]).toMatchObject({state});
 });
 it('keeps one integration identity across awaiting release, cleanup failure and confirmed release',async ctx=>{
  if(!db.available)return ctx.skip();
  const {recordWorkspaceLanding,refreshWorkspaceLifecycle}=await import('../src/modules/hosts/workspaceLifecycle.js');
  const c=await childFixture(),id=randomUUID(),attempt=randomUUID();
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[c.change]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,detail_json,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/parent','merged',$9,$10,$10,'{}',now(),now())`,[id,SPACE,c.id,c.change,LOCATION,attempt,D,A,OWNER,C]);
  const lifecycle=async()=>(await db.pool.query("SELECT status,detail_json->'lifecycle' AS lifecycle FROM task_merges WHERE id=$1",[id])).rows[0];
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[c.run.id]);
  await recordWorkspaceLanding(db.pool,id);await refreshWorkspaceLifecycle(db.pool,c.id);
  expect(await lifecycle()).toMatchObject({status:'merged',lifecycle:{operation_id:id,phase:'awaiting_release',source_commit:D,base_commit:A,generation:1,landed_commit:C}});
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[c.run.id]);
  await refreshWorkspaceLifecycle(db.pool,c.id);
  expect((await lifecycle()).lifecycle).toMatchObject({operation_id:id,phase:'cleanup'});
  await db.pool.query("UPDATE execution_workspaces SET cleanup_state='blocked' WHERE id=$1",[c.id]);
  await refreshWorkspaceLifecycle(db.pool,c.id);await recordWorkspaceLanding(db.pool,id);
  expect(await lifecycle()).toMatchObject({status:'merged',lifecycle:{operation_id:id,phase:'blocked'}});
  await db.pool.query(`UPDATE execution_workspaces SET cleanup_state='cleaned',retention_json='{"state":"reclaimed"}',inventory_json='{"worktree":false,"registration":false,"branch":false}' WHERE id=$1`,[c.id]);
  await refreshWorkspaceLifecycle(db.pool,c.id);
  expect((await lifecycle()).lifecycle).toMatchObject({operation_id:id,phase:'complete',source_retained:false});
  expect((await db.pool.query('SELECT count(*)::int AS n FROM task_merges WHERE workspace_id=$1',[c.id])).rows[0].n).toBe(1);
 });

 it('backfills only a trustworthy legacy landing and keeps incomplete physical evidence pending',async ctx=>{
  if(!db.available)return ctx.skip();
  const {backfillWorkspaceLifecycle,refreshWorkspaceLifecycle}=await import('../src/modules/hosts/workspaceLifecycle.js');
  const c=await childFixture(),id=randomUUID();
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[c.change]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,merged_commit,detail_json,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/parent','merged',$9,$10,'{}',now(),now())`,[id,SPACE,c.id,c.change,LOCATION,randomUUID(),D,A,OWNER,C]);
  await db.pool.query(`UPDATE execution_workspaces SET retention_json='{"state":"reclaimed"}',cleanup_state='cleaned' WHERE id=$1`,[c.id]);
  expect(await backfillWorkspaceLifecycle(db.pool,c.id)).toBe(1);
  const read=async()=>(await db.pool.query("SELECT status,detail_json->'lifecycle' AS lifecycle FROM task_merges WHERE id=$1",[id])).rows[0];
  expect(await read()).toMatchObject({status:'merged',lifecycle:{operation_id:id,phase:'cleanup'}});
  expect(await backfillWorkspaceLifecycle(db.pool,c.id)).toBe(0);
  await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"worktree":false,"registration":false,"branch":false}' WHERE id=$1`,[c.id]);
  await refreshWorkspaceLifecycle(db.pool,c.id);expect((await read()).lifecycle.phase).toBe('complete');
  // Later slot materializations cannot reopen an already confirmed release.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json='{"state":"active"}',inventory_json='{"worktree":true,"registration":true,"branch":true}' WHERE id=$1`,[c.id]);
  await refreshWorkspaceLifecycle(db.pool,c.id);expect((await read()).lifecycle.phase).toBe('complete');
  expect((await db.pool.query('SELECT count(*)::int AS n FROM task_merges WHERE workspace_id=$1',[c.id])).rows[0].n).toBe(1);
 });

 it('checks older parent publications and backfills controlled child adoption without changing its integrated outcome',async ctx=>{
  if(!db.available)return ctx.skip();
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const c=await childFixture(),newer=randomUUID();
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit)
   SELECT $1,workspace_id,space_id,generation,sequence+1,originating_run_id,root_run_id,'integrated',base_commit,$2 FROM workspace_change_sets WHERE id=$3`,[newer,B,c.parent.w.changeSetId]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,created_at,updated_at,completed_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/main','merged',$9,$7,$7,now(),now(),now()+interval '1 minute')`,[randomUUID(),SPACE,c.parent.row.id,newer,LOCATION,randomUUID(),B,A,OWNER]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[c.change]);
  const childMerge=randomUUID();
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,created_at,updated_at,completed_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,'refs/heads/parent','merged',$9,$10,$10,now(),now(),now())`,[childMerge,SPACE,c.id,c.change,LOCATION,randomUUID(),D,A,OWNER,C]);
  c.hosts.runHostCommand=async(_h,input)=>({ok:true,error:null,exit_code:input.command.includes('diff')&&input.command.includes('--quiet')&&input.command.includes(B)?1:0,stdout:input.command.includes('--quiet')?'':'server/example.ts\0',stderr:'',timed_out:false});
  expect(await reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).toBe(true);
  expect((await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0]).toMatchObject({state:'integrated',verification_json:{already_present_at:C,adoption_source:D,adoption_target_ref:'refs/heads/main'}});
  expect((await db.pool.query('SELECT status FROM task_merges WHERE id=$1',[childMerge])).rows[0].status).toBe('merged');
  await db.pool.query("UPDATE runs SET ended_at=now()-interval '20 minutes' WHERE id=$1",[c.run.id]);
  const first=await queued(c.id,D),hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return (frame as any).action==='inspect'?{ok:true,commit:D,inventory:inventory(),error:null}:{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  await advanceWorkspaceCleanup(db.pool,c.id,'source-g1',first.operation_id,OWNER,hosts);
  expect(frames.find(f=>f.action==='cleanup')).toMatchObject({workspace:{execution_workspace:{target_ref:'refs/heads/main'}},reclaim_proof:expect.arrayContaining([C])});
 });

 it('records and backfills exact native child landing before parent publication without guessing Git history',async ctx=>{
  if(!db.available)return ctx.skip();
  const {recordNativeChildAdoption}=await import('../src/modules/hosts/workspaceNativeAdoption.js');
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const {reclaimCheckpoint}=await import('../src/modules/hosts/workspaceRetention.js');
  const c=await childFixture(),merge=randomUUID(),attempt=randomUUID();
  const target=`refs/heads/rainver/workspace-${c.parent.row.id}-g1`;
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[c.parent.w.changeSetId]);
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[c.parent.mergeId]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrated' WHERE id=$1",[c.change]);
  await db.pool.query("UPDATE execution_workspaces SET target_ref=$2 WHERE id=$1",[c.id,target]);
  await db.pool.query(`INSERT INTO task_merges(id,space_id,workspace_id,change_set_id,workspace_location_id,basis,generation,attempt_id,source_commit,base_commit,target_ref,status,requested_by_user_id,task_commit,merged_commit,detail_json,created_at,updated_at,completed_at)
   VALUES($1,$2,$3,$4,$5,$4,1,$6,$7,$8,$9,'merged',$10,$11,$11,'{"native_integration":true}',now(),now(),now())`,[merge,SPACE,c.id,c.change,LOCATION,attempt,D,A,target,OWNER,C]);
  // Neither a saved parent checkpoint nor a published parent batch is needed:
  // the successful child's exact controlled landing supplies the recovery owner.
  await db.pool.query('UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1',[c.parent.row.id,C]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1",[c.parent.run.id,B]);
  expect(await recordNativeChildAdoption(db.pool,c.id)).toBe(true);
  const proof=(await db.pool.query('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0];
  expect(proof).toMatchObject({state:'integrated',verification_json:{adoption_proof:'native_parent_landing',adoption_source:D,adoption_base:A,adoption_generation:1,adoption_integration_id:merge,adoption_attempt_id:attempt,adoption_target_ref:target}});
  expect(await reclaimCheckpoint(db.pool,await workspace(c.id))).toEqual({workspace_id:c.parent.row.id,generation:1,commit:C,base_commit:A});
  expect(await recordNativeChildAdoption(db.pool,c.id)).toBe(false);
  // Historical repair uses this same mechanism, without external history scans.
  await db.pool.query("UPDATE workspace_change_sets SET verification_json='{}'::jsonb WHERE id=$1",[c.change]);
  c.hosts.runHostCommand=async()=>{throw new Error('unexpected Git fallback');};
  expect(await reconcilePublishedWorkspaceChild(db.pool,await workspace(c.id),OWNER,c.hosts,'/workspace')).toBe(true);
  await db.pool.query("UPDATE workspace_change_sets SET verification_json='{}'::jsonb WHERE id=$1",[c.change]);
  await db.pool.query('UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1',[c.parent.row.id,B]);
  expect(await recordNativeChildAdoption(db.pool,c.id)).toBe(false);
  // New publications freeze the parent identity before dispatch, so later
  // parent work does not force a history scan to recover the exact landing.
  await db.pool.query("UPDATE task_merges SET detail_json=detail_json||jsonb_build_object('native_parent',jsonb_build_object('id',$2::text,'generation',1)) WHERE id=$1",[merge,c.parent.row.id]);
  expect(await recordNativeChildAdoption(db.pool,c.id)).toBe(true);
  await db.pool.query("UPDATE workspace_change_sets SET verification_json='{}'::jsonb WHERE id=$1",[c.change]);
  await db.pool.query('UPDATE execution_workspaces SET head_commit=$2,generation=2 WHERE id=$1',[c.parent.row.id,C]);
  expect(await recordNativeChildAdoption(db.pool,c.id)).toBe(false);
 });

 it('adopts an unpublished exact parent checkpoint and gates child release on reclaim:6',async ctx=>{
  if(!db.available)return ctx.skip();
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const c=await childFixture();
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','6') WHERE id=$1`,[HOST]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[c.parent.w.changeSetId]);
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[c.parent.mergeId]);
  await db.pool.query('UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1',[c.parent.run.id,C]);
  expect(await reconcilePublishedWorkspaceChild(db.pool,c.row,OWNER,c.hosts,'/workspace')).toBe(true);
  expect((await db.pool.query('SELECT verification_json FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0].verification_json).toMatchObject({adoption_proof:'parent_checkpoint_paths',adoption_checkpoint:{workspace_id:c.parent.row.id,generation:1,commit:C,base_commit:A,source_commit:D,child_generation:1}});
  expect(await assessWorkspaceRetention(db.pool,c.parent.row.id)).toMatchObject({reason:'child_workspace_dependency'});
  const hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return (frame as any).action==='inspect'?{ok:true,commit:D,inventory:inventory(),error:null}:{ok:true,commit:null,cleanup_state:'cleaned',inventory:cleaned(),error:null};};
  await db.pool.query("UPDATE runs SET ended_at=now()-interval '20 minutes' WHERE id=$1",[c.run.id]);
  const first=await queued(c.id,D);
  await advanceWorkspaceCleanup(db.pool,c.id,'source-g1',first.operation_id,OWNER,hosts);
  expect(frames.find(f=>f.action==='cleanup')).toMatchObject({reclaim_checkpoint:{workspace_id:c.parent.row.id,generation:1,commit:C,base_commit:A},retain_branch:false,expected_commit:D});
  await drainPages(c.id,hosts);
  expect((await assessWorkspaceRetention(db.pool,c.parent.row.id)).reason).not.toBe('child_workspace_dependency');
 });

 it('retains an empty child private baseline through a parent-owned checkpoint before offering release',async ctx=>{
  if(!db.available)return ctx.skip();
  const {reconcilePublishedWorkspaceChild}=await import('../src/modules/hosts/workspaceAdoption.js');
  const {reclaimCheckpoint,reclaimBaseCommits}=await import('../src/modules/hosts/workspaceRetention.js');
  const c=await childFixture();
  await db.pool.query("UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','6') WHERE id=$1",[HOST]);
  await db.pool.query("UPDATE workspace_change_sets SET state='no_changes',source_commit=base_commit WHERE id=$1",[c.change]);
  await db.pool.query('UPDATE execution_workspaces SET head_commit=base_commit WHERE id=$1',[c.id]);
  await db.pool.query('UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1',[c.run.id,A]);
  await db.pool.query("UPDATE workspace_change_sets SET state='open' WHERE id=$1",[c.parent.w.changeSetId]);
  await db.pool.query("UPDATE task_merges SET status='failed' WHERE id=$1",[c.parent.mergeId]);
  await db.pool.query('UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1',[c.parent.run.id,C]);
  expect(await reconcilePublishedWorkspaceChild(db.pool,await workspace(c.id),OWNER,c.hosts,'/workspace')).toBe(true);
  expect(await reclaimCheckpoint(db.pool,await workspace(c.id))).toEqual({workspace_id:c.parent.row.id,generation:1,commit:C,base_commit:A});
  expect(await reclaimBaseCommits(db.pool,c.id,1)).toContain(A);
  // No proof if the parent's exact history no longer preserves that baseline.
  await db.pool.query("UPDATE workspace_change_sets SET verification_json='{}'::jsonb WHERE id=$1",[c.change]);
  c.hosts.runHostCommand=async()=>({ok:true,error:null,exit_code:1,stdout:'',stderr:'',timed_out:false});
  expect(await reconcilePublishedWorkspaceChild(db.pool,await workspace(c.id),OWNER,c.hosts,'/workspace')).toBe(false);
 });

 it('does not let a checkpoint adoption recorded on a newer Host authorize an older Host release',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await childFixture();
  await db.pool.query("UPDATE workspace_change_sets SET state='no_changes',verification_json=jsonb_build_object('adoption_checkpoint',jsonb_build_object('workspace_id',$2::text,'generation',1,'commit',$3::text,'base_commit',$4::text,'source_commit',$5::text,'child_generation',1)) WHERE id=$1",[c.change,c.parent.row.id,C,A,D]);
  const first=await queued(c.id,D),hosts=confirmingHosts(),frames:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{frames.push(frame);return {ok:true,commit:D,cleanup_state:'cleaned',inventory:inventory({worktree:false,registration:false}),error:null};};
  await expect(advanceWorkspaceCleanup(db.pool,c.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_host_upgrade_required');
  expect(frames).toHaveLength(0);
 });

 it('refuses parent branch and ref-page release after the pinning Host downgrades below six',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await childFixture();
  await db.pool.query("UPDATE workspace_change_sets SET state='no_changes',verification_json=jsonb_build_object('adoption_checkpoint',jsonb_build_object('workspace_id',$2::text,'generation',1,'commit',$3::text,'base_commit',$4::text,'source_commit',$5::text,'child_generation',1)) WHERE id=$1",[c.change,c.parent.row.id,C,A,D]);
  await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','reclaimed') WHERE id=$1",[c.id]);
  const first=await queued(c.parent.row.id),hosts=confirmingHosts();let calls=0;
  hosts.requestTaskBranch=async():Promise<any>=>{calls++;throw new Error('must not dispatch');};
  await expect(advanceWorkspaceCleanup(db.pool,c.parent.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_host_upgrade_required');
  await enqueueRefRelease(db.pool,c.parent.row,'local_preimages',[{ref:`refs/rainver/recovery/${c.parent.row.id}/${C}`,expected_commit:C}],OWNER,new Date());
  const r=await resource(c.parent.row.id,'local-preimages-g1');
  await expect(advanceWorkspaceCleanup(db.pool,c.parent.row.id,'local-preimages-g1',r.operation_id,OWNER,hosts)).rejects.toThrow('workspace_cleanup_host_upgrade_required');
  expect(calls).toBe(0);
 });

 it('resolves private parent targets only through the bounded same-location ownership chain',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await childFixture();
  await db.pool.query('UPDATE execution_workspaces SET target_ref=$2 WHERE id=$1',[c.id,`refs/heads/rainver/workspace-${c.parent.row.id}-g1`]);
  const {reclaimTarget}=await import('../src/modules/hosts/workspaceRetention.js');
  expect(await reclaimTarget(db.pool,await workspace(c.id))).toBe('refs/heads/main');
  const ancestor=await settled('open',60);
  await db.pool.query('UPDATE execution_workspaces SET parent_workspace_id=$2,target_ref=$3 WHERE id=$1',[c.parent.row.id,ancestor.row.id,'refs/heads/release']);
  expect(await reclaimTarget(db.pool,await workspace(c.id))).toBe('refs/heads/release');
  await db.pool.query('UPDATE execution_workspaces SET parent_workspace_id=id WHERE id=$1',[c.id]);
  expect(await reclaimTarget(db.pool,await workspace(c.id))).toBe(`refs/heads/rainver/workspace-${c.parent.row.id}-g1`);
 });

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

it('renews an expired physical-only operation only for the exact current source and repeats cleanup checks',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('open',60*30),r=await queued(c.row.id),hosts=confirmingHosts();let expire=true;
 hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
  if((frame as any).action==='inspect')return {ok:true,commit:B,inventory:inventory()};
  return expire?{ok:false,error:'workspace_cleanup_expired',cleanup_state:'blocked'}:{ok:true,cleanup_state:'cleaned',inventory:cleaned({branch:true})};
 };
 expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',r.operation_id,OWNER,hosts)).toMatchObject({renewed:true});
 const renewed=await resource(c.row.id);expect(renewed.operation_id).not.toBe(r.operation_id);expect(renewed).toMatchObject({state:'pending',attempts:0,expected_commit:B});
 expire=false;await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',renewed.operation_id,OWNER,hosts);
 expect(await resource(c.row.id)).toMatchObject({state:'cleaned',attempts:1});
});

it('does not transfer an expired operation onto a newly admitted materialization',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('open',60*30),r=await queued(c.row.id),hosts=confirmingHosts();
 hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
  if((frame as any).action==='inspect')return {ok:true,commit:B,inventory:inventory()};
  await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=materialization_epoch+1 WHERE id=$1',[c.row.id]);
  return {ok:false,error:'workspace_cleanup_expired',cleanup_state:'blocked'};
 };
 expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',r.operation_id,OWNER,hosts)).toMatchObject({blocked:true});
 expect(await resource(c.row.id)).toMatchObject({operation_id:r.operation_id,state:'blocked',error:'workspace_cleanup_expired_recheck_required',attempts:0});
});

it('bounds proof probes independently of refusal backoff and permits target movement on the next due observation',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('integrated',0),{claimWorkspaceProofProbe,wakeWorkspaceProofs}=await import('../src/modules/hosts/workspaceProofWake.js');
 expect(await claimWorkspaceProofProbe(db.pool,c.row.id)).toBe(true);
 expect(await claimWorkspaceProofProbe(db.pool,c.row.id)).toBe(false);
 await db.pool.query("UPDATE execution_workspaces SET retention_json=retention_json||jsonb_build_object('proof_probe_at',now()-interval '6 minutes','proof_refused_reason','unmerged_source','proof_refused_tip',$2::text) WHERE id=$1",[c.row.id,B]);
 expect(await claimWorkspaceProofProbe(db.pool,c.row.id)).toBe(true);
 await wakeWorkspaceProofs(db.pool,c.row,OWNER,B,D);
 expect((await workspace(c.row.id)).retention_json.proof_refused_reason).toBeUndefined();
 expect(await claimWorkspaceProofProbe(db.pool,c.row.id)).toBe(false);
});

it('keeps quota blocks visible without spending attempts, then resumes after capacity may have changed',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('open',60*30),r=await queued(c.row.id),hosts=confirmingHosts();let full=true;
 hosts.isOnline=()=>true;
 hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
  if((frame as any).action==='inspect')return {ok:true,commit:B,inventory:inventory()};
  return full?{ok:false,error:'workspace_ignored_quota',cleanup_state:'blocked'}:{ok:true,cleanup_state:'cleaned',inventory:cleaned({branch:true})};
 };
 expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',r.operation_id,OWNER,hosts)).toMatchObject({blocked:true});
 expect(await resource(c.row.id)).toMatchObject({state:'blocked',attempts:0,error:'workspace_ignored_quota'});
 await db.pool.query("UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1,next_retry_at}',to_jsonb((now()-interval '1 minute')::text)) WHERE id=$1",[c.row.id]);
 full=false;await reconcileExecutionWorkspaces(db.pool,'/unused',{hosts});
 const next=await resource(c.row.id);expect(next.state).toBe('pending');expect(next.operation_id).toBe(r.operation_id);
 await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',next.operation_id,OWNER,hosts);
 expect(await resource(c.row.id)).toMatchObject({state:'cleaned'});
});

it('binds a real PG resolution Run to its frozen attempt epoch after Host release, rebuild and Git conflict',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('integrated',0),f=await savedHost(c);
 try{
  const {checkLocationRepository}=await import('../../packages/host-daemon/src/taskWorktree.js');
  const {prepareExecutionWorkspace,executeWorkspaceCommand}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const {executeWorkspaceIntegration}=await import('../../packages/host-daemon/src/workspaceIntegration.js');
  const {integrationWorkspaceForRun}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  f.git(['merge','--ff-only',f.tip]);
  const releaseRef={...f.ref,materialization_epoch:0};
  expect(await f.command({action:'cleanup',expected_commit:f.tip,retain_branch:false,workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:releaseRef}})).toMatchObject({ok:true,inventory:{branch:false,worktree:false}});
  await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=1 WHERE id=$1',[c.row.id]);
  const repo=await checkLocationRepository(f.repo);if(repo.kind!=='repository')throw new Error('fixture');
  const fresh={...f.ref,materialization_epoch:1,sync_to_target:true},sourceRun=randomUUID();
  const source=await prepareExecutionWorkspace(repo.repo,LOCATION,fresh,sourceRun);
  await writeFile(join(source.root,'file.txt'),'new source conflict');
  const saved=await executeWorkspaceCommand(f.repo,{type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:fresh},action:'checkpoint',retain_branch:true,run_id:sourceRun,author:{name:'Test',email:'t@example.com'},message:'new source'});
  if(!saved.ok||!saved.commit)throw new Error('checkpoint');
  await writeFile(join(f.repo,'file.txt'),'new target conflict');f.git(['commit','-qam','target conflict']);
  const run=await conversationRun(),attempt=randomUUID();
  await db.pool.query("UPDATE task_merges SET status='resolving',attempt_id=$2,resolution_run_id=$3,detail_json=detail_json||jsonb_build_object('materialization_epoch',1) WHERE id=$1",[c.mergeId,attempt,run.id]);
  await db.pool.query('UPDATE runs SET contract_snapshot_json=contract_snapshot_json||$2::jsonb WHERE id=$1',[run.id,JSON.stringify({workspace_integration_id:c.mergeId,workspace_integration_attempt_id:attempt})]);
  await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=2 WHERE id=$1',[c.row.id]);
  const bound=await integrationWorkspaceForRun(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,HOST,LOCATION);
  expect(bound.ref).toMatchObject({materialization_epoch:1,integration_id:attempt});
  const frame={type:'workspace_integration' as const,request_id:randomUUID(),workspace:{kind:'location' as const,workspace_location_id:LOCATION,execution_workspace:{...bound.ref,integration_id:attempt,target_ref:'refs/heads/main'}},action:'prepare' as const,source_commit:saved.commit,base_commit:f.tip,target_ref:'refs/heads/main',author:{name:'Test',email:'t@example.com'},message:'integration conflict'};
  expect(await executeWorkspaceIntegration(f.repo,frame)).toMatchObject({outcome:'conflict'});
  await db.pool.query("UPDATE task_merges SET detail_json=detail_json-'materialization_epoch' WHERE id=$1",[c.mergeId]);
  const legacy=await integrationWorkspaceForRun(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,run.id))!,HOST,LOCATION);
  expect(legacy.ref.materialization_epoch).toBeUndefined();
  frame.workspace.execution_workspace={...frame.workspace.execution_workspace,materialization_epoch:legacy.ref.materialization_epoch};
  expect(await executeWorkspaceIntegration(f.repo,{...frame,action:'repair',repair_mode:'agent_resolution'})).toMatchObject({ok:true});
  const {prepareExecutionWorkspaceResolution}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const repair=await prepareExecutionWorkspaceResolution(repo.repo,LOCATION,bound.ref);
  await writeFile(join(repair.root,'file.txt'),'resolved after release');
  const fixed=await executeWorkspaceIntegration(f.repo,{...frame,action:'continue'});expect(fixed).toMatchObject({ok:true,outcome:'rebased'});
  expect(f.git(['show',`${fixed.candidate_commit}:file.txt`])).toBe('resolved after release');
  await expect(prepareExecutionWorkspace(repo.repo,LOCATION,{...bound.ref,materialization_epoch:0},randomUUID())).rejects.toThrow('workspace_materialization_stale');
  expect(await executeWorkspaceCommand(f.repo,{type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:fresh},action:'cleanup',expected_commit:saved.commit,discard_commit:saved.commit,retain_branch:false})).toMatchObject({ok:true,inventory:{branch:false,worktree:false,materialization_epoch:2}});
  await expect(prepareExecutionWorkspace(repo.repo,LOCATION,legacy.ref,randomUUID())).rejects.toThrow('workspace_materialization_stale');
  await prepareExecutionWorkspace(repo.repo,LOCATION,{...fresh,materialization_epoch:2},randomUUID());
  await expect(prepareExecutionWorkspace(repo.repo,LOCATION,legacy.ref,randomUUID())).rejects.toThrow('workspace_materialization_stale');
 }finally{await f.close();}
});


for(const mode of ['current','legacy-history','unknown','live'] as const)it(`renews candidate cleanup with ${mode} owner after source release or visibly blocks it`,async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('integrated',0),f=await savedHost(c);
 try{
  const {executeWorkspaceIntegration}=await import('../../packages/host-daemon/src/workspaceIntegration.js');
  const {executeWorkspaceCommand}=await import('../../packages/host-daemon/src/executionWorkspace.js');
  const {workspaceWorktreeKey}=await import('../../packages/host-daemon/src/worktreeIdentity.js');
  const attempt=(await db.pool.query('SELECT attempt_id FROM task_merges WHERE id=$1',[c.mergeId])).rows[0].attempt_id;
  const ref={...f.ref,integration_id:attempt,materialization_epoch:0};
  const prepared=await executeWorkspaceIntegration(f.repo,{type:'workspace_integration',request_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:ref},action:'prepare',source_commit:f.tip,base_commit:f.base,target_ref:'refs/heads/main',author:{name:'T',email:'t@example.com'},message:'candidate'});
  expect(prepared).toMatchObject({ok:true,outcome:'rebased'});
  const key=workspaceWorktreeKey(ref),candidate=join(f.config,'task-worktrees',LOCATION,key);
  f.git(['merge','--ff-only',f.tip]);
  await db.pool.query('UPDATE task_merges SET source_commit=$2,task_commit=$3,merged_commit=$2,base_commit=$4 WHERE id=$1',[c.mergeId,f.tip,prepared.candidate_commit,f.base]);
  const hosts=new HostConnectionRegistry(),sent:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{sent.push(frame);return executeWorkspaceCommand(f.repo,{type:'execution_workspace_command',request_id:randomUUID(),...frame} as any);};
  const source=await queued(c.row.id,f.tip);
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',source.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
  expect((await workspace(c.row.id)).materialization_epoch).toBe(1);
  await enqueueWorkspaceCleanup(db.pool,await workspace(c.row.id),ref,prepared.candidate_commit!,false,OWNER);
  const old=await resource(c.row.id,attempt);
  if(mode!=='current'){
   await db.pool.query("UPDATE execution_workspaces SET cleanup_json=cleanup_json #- ARRAY[$2,'attempt_merge_id'] WHERE id=$1",[c.row.id,attempt]);
   const history={previous_attempt:randomUUID(),previous_detail:{previous_attempt:randomUUID(),previous_detail:{previous_attempt:attempt,previous_detail:{}}}};
   await db.pool.query("UPDATE task_merges SET attempt_id=$2,detail_json=$3::jsonb WHERE id=$1",[c.mergeId,randomUUID(),JSON.stringify(mode==='unknown'?{}:history)]);
   if(mode==='live'){
    const run=await conversationRun();
    await db.pool.query('UPDATE runs SET contract_snapshot_json=contract_snapshot_json||$2::jsonb WHERE id=$1',[run.id,JSON.stringify({workspace_integration_id:c.mergeId,workspace_integration_attempt_id:attempt})]);
    await expect(advanceWorkspaceCleanup(db.pool,c.row.id,attempt,old.operation_id,OWNER,hosts)).rejects.toThrow('workspace_candidate_settlement_unproven');
    expect(f.git(['worktree','list','--porcelain'])).toContain(candidate);return;
   }
   if(mode==='unknown'){
    expect(await advanceWorkspaceCleanup(db.pool,c.row.id,attempt,old.operation_id,OWNER,hosts)).toMatchObject({blocked:true});
    expect(await resource(c.row.id,attempt)).toMatchObject({state:'blocked',error:'workspace_candidate_owner_unproven',next_retry_at:null});
    expect(f.git(['worktree','list','--porcelain'])).toContain(candidate);return;
   }
  }
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,attempt,old.operation_id,OWNER,hosts)).toMatchObject({renewed:true});
  const renewed=await resource(c.row.id,attempt);
  expect(renewed).toMatchObject({state:'pending',attempt_merge_id:c.mergeId,workspace:{materialization_epoch:1}});
  expect(renewed.operation_id).not.toBe(old.operation_id);
  expect(f.git(['worktree','list','--porcelain'])).toContain(candidate);
  expect(await advanceWorkspaceCleanup(db.pool,c.row.id,attempt,renewed.operation_id,OWNER,hosts)).toMatchObject({cleanup_state:'cleaned'});
  expect((await resource(c.row.id,attempt)).superseded).not.toBe(true);
  expect(f.git(['worktree','list','--porcelain'])).not.toContain(candidate);
  const inspect:any=await executeWorkspaceCommand(f.repo,{type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:{...ref,materialization_epoch:1}},action:'inspect',retain_branch:true});
  expect(inspect.inventory).toMatchObject({branch:false,worktree:false,registration:false,merge_record:false});
  expect(sent.filter(x=>x.action==='cleanup'&&x.workspace.execution_workspace.integration_id===attempt).map(x=>x.workspace.execution_workspace.materialization_epoch)).toEqual([0,1]);
 }finally{await f.close();}
});

it('probes all 250 waiting owners fairly across slow rounds independently of id pages',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('open',0),ids=Array.from({length:249},()=>randomUUID()),changes=ids.map(()=>randomUUID());
 await db.pool.query(`INSERT INTO execution_workspaces SELECT (jsonb_populate_record(NULL::execution_workspaces,to_jsonb(w)||jsonb_build_object('id',i.id,'generation',i.n+1,'cleanup_json','{}'::jsonb,'retention_json',jsonb_build_object('proof_refused_reason','unmerged_source')))).* FROM execution_workspaces w CROSS JOIN unnest($2::text[]) WITH ORDINALITY AS i(id,n) WHERE w.id=$1`,[c.row.id,ids]);
 await db.pool.query(`INSERT INTO workspace_change_sets SELECT (jsonb_populate_record(NULL::workspace_change_sets,to_jsonb(c)||jsonb_build_object('id',i.change,'workspace_id',i.id,'generation',i.n+1))).* FROM workspace_change_sets c CROSS JOIN unnest($2::text[],$3::text[]) WITH ORDINALITY AS i(id,change,n) WHERE c.id=$1`,[c.w.changeSetId,ids,changes]);
 await db.pool.query(`INSERT INTO execution_workspace_runs SELECT (jsonb_populate_record(NULL::execution_workspace_runs,to_jsonb(b)||jsonb_build_object('workspace_id',i.id,'change_set_id',i.change))).* FROM execution_workspace_runs b CROSS JOIN unnest($2::text[],$3::text[]) AS i(id,change) WHERE b.workspace_id=$1`,[c.row.id,ids,changes]);
 await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_build_object('proof_refused_reason','unmerged_source')");
 const hosts=new HostConnectionRegistry(),seen:string[]=[];hosts.isOnline=()=>true;
 hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{seen.push((frame as any).workspace.execution_workspace.id);return {ok:false,error:'timeout'};};
 const {probeWorkspaceProofs}=await import('../src/modules/hosts/workspaceProofWake.js');
 for(let round=0;round<63;round++){
  const before=seen.length;await probeWorkspaceProofs(db.pool,hosts,'/unused',HOST);
  expect(seen.length-before).toBeLessThanOrEqual(4);
  // Every round may itself be slower than five minutes. Relative age still
  // yields to untouched/null owners rather than reprobing the fixed prefix.
  await db.pool.query("UPDATE execution_workspaces SET retention_json=jsonb_set(retention_json,'{proof_probe_at}',to_jsonb(((retention_json->>'proof_probe_at')::timestamptz-interval '6 minutes')::text)) WHERE retention_json ? 'proof_probe_at'");
 }
 expect(new Set(seen).size).toBe(250);
 const ordered=[c.row.id,...ids].sort();expect(seen).toContain(ordered.at(-1));
 console.info('proof fairness: 250 owners reached across 63 slow rounds, at most 4 per round');
});


it('freezes the epoch in an actual newly enqueued integration attempt',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('open',0);
 await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=3 WHERE id=$1',[c.row.id]);
 await db.pool.query("UPDATE workspace_change_sets SET state='ready' WHERE id=$1",[c.w.changeSetId]);
 const id=await enqueueWorkspaceIntegration(db.pool,c.w.changeSetId,SPACE,OWNER);
 expect(id).toBeTruthy();
 await db.pool.query('UPDATE execution_workspaces SET materialization_epoch=4 WHERE id=$1',[c.row.id]);
 const m=(await db.pool.query('SELECT * FROM task_merges WHERE id=$1',[id])).rows[0];
 const {integrationWorkspaceReference}=await import('../src/modules/hosts/workspaceIntegrations.js');
 expect(integrationWorkspaceReference(m)).toMatchObject({materialization_epoch:3,integration_id:m.attempt_id});
});

it('never treats an old Host ambiguous candidate refusal as supersession',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('integrated',0),attempt=(await db.pool.query('SELECT attempt_id FROM task_merges WHERE id=$1',[c.mergeId])).rows[0].attempt_id;
 await enqueueWorkspaceCleanup(db.pool,c.row,{id:c.row.id,generation:1,integration_id:attempt,materialization_epoch:0},B,false,OWNER);
 const r=await resource(c.row.id,attempt),hosts=confirmingHosts();
 hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error:'workspace_materialization_moved',inventory:inventory()});
 await expect(advanceWorkspaceCleanup(db.pool,c.row.id,attempt,r.operation_id,OWNER,hosts)).rejects.toThrow('workspace_candidate_materialization_unproven');
 expect(await resource(c.row.id,attempt)).toMatchObject({state:'retry_wait',attempts:0});
 expect((await resource(c.row.id,attempt)).superseded).not.toBe(true);
});

it('keeps a candidate source-fence refusal visible while a repair attempt is still live',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('integrated',0),attempt=(await db.pool.query('SELECT attempt_id FROM task_merges WHERE id=$1',[c.mergeId])).rows[0].attempt_id;
 await enqueueWorkspaceCleanup(db.pool,c.row,{id:c.row.id,generation:1,integration_id:attempt,materialization_epoch:0},B,false,OWNER);
 await db.pool.query("UPDATE execution_workspaces SET materialization_epoch=1 WHERE id=$1",[c.row.id]);
 await db.pool.query("UPDATE task_merges SET status='resolving' WHERE id=$1",[c.mergeId]);
 const r=await resource(c.row.id,attempt),hosts=confirmingHosts();
 hosts.requestTaskBranch=async():Promise<any>=>({ok:false,error:'workspace_source_materialization_moved',inventory:inventory({materialization_epoch:0})});
 await expect(advanceWorkspaceCleanup(db.pool,c.row.id,attempt,r.operation_id,OWNER,hosts)).rejects.toThrow('workspace_candidate_settlement_unproven');
 expect(await resource(c.row.id,attempt)).toMatchObject({state:'retry_wait',attempts:0,error:'workspace_candidate_settlement_unproven',operation_id:r.operation_id});
});

describe('interrupted cleanup delivery',()=>{
 it('preserves the original wait reason if a newer cleanup supersedes its deferred save',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('no_changes'),first=await queued(c.row.id,A),hosts=confirmingHosts(),newId=randomUUID();
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if((frame as any).action==='inspect')return {ok:true,commit:A,inventory:inventory(),error:null};
   await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,'{source-g1,operation_id}',to_jsonb($2::text)) WHERE id=$1`,[c.row.id,newId]);
   return {ok:false,error:'host_timeout'};
  };
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toThrow('host_timeout');
  expect(await resource(c.row.id)).toMatchObject({operation_id:newId,state:'running',cleanup_sent:true});
 });

 it('freezes release authority before Host effects and replays the identical request after a lost receipt',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await settled('no_changes'),first=await queued(c.row.id,A),hosts=confirmingHosts();
  const sent:any[]=[];
  hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
   if((frame as any).action==='inspect')return {ok:true,commit:A,inventory:inventory(),error:null};
   const persisted=await resource(c.row.id);
   expect(persisted).toMatchObject({operation_id:first.operation_id,release_epoch:0,cleanup_sent:true,cleanup_request:frame});
   expect((await workspace(c.row.id)).materialization_epoch).toBe(1);
   sent.push(structuredClone(frame));
   return sent.length===1?{ok:false,error:'host_timeout'}:{ok:true,cleanup_state:'cleaned',inventory:cleaned(),error:null};
  };
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  const pending=await resource(c.row.id);
  expect(replaceableSourceCleanup(pending)).toBe(false);
  // Duplicate enqueue must keep the original effect, plan and owner.
  await enqueueWorkspaceCleanup(db.pool,await workspace(c.row.id),{id:c.row.id,generation:1},B,true,OWNER);
  expect(await resource(c.row.id)).toEqual(pending);
  await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts);
  expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
  expect(await workspace(c.row.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaimed'}});
 });
});

it('rolls back the release epoch when durable plan persistence is interrupted, then safely retries',async ctx=>{
 if(!db.available)return ctx.skip();
 const c=await settled('no_changes'),first=await queued(c.row.id,A),hosts=confirmingHosts();let effects=0;
 hosts.requestTaskBranch=async(_h,_t,frame):Promise<any>=>{
  if((frame as any).action==='inspect')return {ok:true,commit:A,inventory:inventory(),error:null};
  effects++;return {ok:true,cleanup_state:'cleaned',inventory:cleaned(),error:null};
 };
 // Fault injection belongs only to this test file's isolated PostgreSQL clone.
 await db.pool.query(`CREATE FUNCTION test_release_plan_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
   IF NEW.cleanup_json->'source-g1' ? 'release_epoch' THEN RAISE EXCEPTION 'test release plan interrupted'; END IF;
   RETURN NEW;
  END $$`);
 await db.pool.query('CREATE TRIGGER test_release_plan_interrupt BEFORE UPDATE OF cleanup_json ON execution_workspaces FOR EACH ROW EXECUTE FUNCTION test_release_plan_interrupt()');
 try{
  await expect(advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts)).rejects.toMatchObject({name:'JobDeferredError'});
  expect(effects).toBe(0);
  expect((await workspace(c.row.id)).materialization_epoch).toBe(0);
  expect((await workspace(c.row.id)).retention_json.state).not.toBe('reclaiming');
  expect((await resource(c.row.id)).release_epoch).toBeUndefined();
 }finally{
  await db.pool.query('DROP TRIGGER test_release_plan_interrupt ON execution_workspaces');
  await db.pool.query('DROP FUNCTION test_release_plan_interrupt()');
 }
 await advanceWorkspaceCleanup(db.pool,c.row.id,'source-g1',first.operation_id,OWNER,hosts);
 expect(effects).toBe(1);
 expect(await workspace(c.row.id)).toMatchObject({materialization_epoch:1,retention_json:{state:'reclaimed'}});
});
