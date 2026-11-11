import {canonicalRunOutput} from '../src/modules/runs/orchestrationResults.js';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedRun,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {loadConfig} from '../src/config.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';

/**
 * A person's retry of a frozen fast-forward/merge integration, end to end: the
 * Operation Core admits it on real PostgreSQL, the integration Job drives a
 * real Host (the daemon's own integration code over a temporary Git
 * repository), and the target receives the recorded chain — never a squash —
 * or a clear refusal when the target moved under a fast-forward.
 */
const SPACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',PROJECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',LOCATION='11111111-1111-4111-8111-111111111111',MACHINE='22222222-2222-4222-8222-222222222222';
const HOST='33333333-3333-4333-8333-333333333333',AGENT='55555555-5555-4555-8555-555555555555',VERSION='66666666-6666-4666-8666-666666666666',CONVERSATION='88888888-8888-4888-8888-888888888888';
const db=useTestDatabase(import.meta.filename);
let sandbox='',repo='',previousConfigDir:string|undefined;
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
async function commit(file:string,text:string,message:string){await writeFile(join(repo,file),text);git('add',file);git('commit','-qm',message);return git('rev-parse','HEAD');}

beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['sessions','workspace_locations','project_folders','agents','agent_versions','rooms','projects','hosts','machines','space_memberships','users','spaces'],{cascade:true});
 const {now}=await seedSpaceOwnerProject(db.pool,{space:SPACE,owner:OWNER,project:PROJECT,now:new Date().toISOString()});
 const room=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND is_mainline=true LIMIT 1',[SPACE])).rows[0]!.id;
 await db.pool.query(`INSERT INTO sessions (id,space_id,project_id,room_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,$5)`,[CONVERSATION,SPACE,PROJECT,room,now]);
 await db.pool.query(`INSERT INTO project_folders (id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES ($1,$2,$3,'repo','code','active',false,false,$4,$4)`,[FOLDER,SPACE,PROJECT,now]);
 await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,$2,'Test machine','desktop',$3,$3)`,[MACHINE,OWNER,now]);
 await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,created_at,updated_at)
  VALUES ($1,$2,$3,'Test host','remote','linux_native','online','{"execution_workspaces":{"version":2}}'::jsonb,$4,$4)`,[HOST,OWNER,MACHINE,now]);
 await db.pool.query(`INSERT INTO workspace_locations (id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at)
  VALUES ($1,$2,$3,$4,'remote','/workspace/repo',true,'active',$5,$5)`,[LOCATION,SPACE,FOLDER,HOST,now]);
 await seedAgentWithVersion(db.pool,{agent:AGENT,version:VERSION,space:SPACE,owner:OWNER,now});
 sandbox=await realpath(await mkdtemp(join(tmpdir(),'rainver-frozen-retry-')));repo=join(sandbox,'repo');await mkdir(repo);
 previousConfigDir=process.env.RAINVER_HOST_CONFIG_DIR;process.env.RAINVER_HOST_CONFIG_DIR=join(sandbox,'host');await mkdir(process.env.RAINVER_HOST_CONFIG_DIR);
 git('init','-q','-b','master');git('config','user.name','Person');git('config','user.email','person@example.test');
});
afterEach(async()=>{if(previousConfigDir===undefined)delete process.env.RAINVER_HOST_CONFIG_DIR;else process.env.RAINVER_HOST_CONFIG_DIR=previousConfigDir;if(sandbox)await rm(sandbox,{recursive:true,force:true});});

/** master at `base`; a reviewed chain of three commits from it; a native integration of that chain that ended with its Run. */
async function frozenIntegration(strategy:'fast_forward'|'merge',targetMoves:'clean'|'conflict'|'none'){
 const base=await commit('a.txt','a\n','base');
 git('checkout','-q','-b','feature');
 const chain=[await commit('f1.txt','1\n','chain 1'),await commit('f2.txt','2\n','chain 2'),await commit('a.txt','a chain\n','chain 3')];
 const tip=chain[2]!;
 git('checkout','-q','master');
 if(targetMoves==='clean')await commit('m.txt','m\n','target moved');
 if(targetMoves==='conflict')await commit('a.txt','a target\n','target moved on a.txt');
 const {ensureExecutionWorkspace}=await import('../src/modules/projectFolders/executionWorkspaces.js');
 const {enqueueWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
 const id=randomUUID();await seedRun(db.pool,{id,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
 await db.pool.query(`UPDATE runs SET status='succeeded',ended_at=now(),project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,contract_snapshot_json='{"execution_workspace_version":1}' WHERE id=$1`,[id,PROJECT,CONVERSATION,LOCATION,OWNER]);
 const run=(await new PgRunRepository(db.pool).getRun(SPACE,id))!,w=await ensureExecutionWorkspace(db.pool,run,HOST,LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2,base_commit=$3,target_ref='refs/heads/master' WHERE id=$1",[w.workspace.id,tip,base]);
 await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state='saved' WHERE run_id=$1",[id,base,tip]);
 await db.pool.query("UPDATE workspace_change_sets SET state='ready',summary='Reviewed chain',base_commit=$2,source_commit=$3,completion_basis=$4 WHERE id=$1",[w.changeSetId,base,tip,id]);
 await db.pool.query('UPDATE runs SET output_json=$2::jsonb WHERE id=$1',[id,JSON.stringify(canonicalRunOutput({success:true,outputText:'',outputJson:{execution_workspace_location:{kind:'location',workspace_location_id:LOCATION,execution_workspace:w.ref},execution_workspace_access:[]}}))]);
 const mergeId=(await enqueueWorkspaceIntegration(db.pool,w.changeSetId,SPACE,OWNER))!;
 const plan={publication_plan:{strategy,target_ref:null,requested_by_user_id:OWNER,requested_by_run_id:id},publication:{strategy,chain_tip:tip,chain_length:3}};
 // The native Agent prepared and recorded the chain, then its Run ended before publishing.
 await db.pool.query("UPDATE task_merges SET status='failed',source_commit=$3,base_commit=$4,detail_json=$2::jsonb WHERE id=$1",[mergeId,JSON.stringify({native_integration:true,reply_owner_run_id:id,error:'integration_current_run_ended',...plan}),tip,base]);
 await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[w.changeSetId]);
 return {base,chain,tip,mergeId,changeSetId:w.changeSetId,plan};
}

/** A Host whose integration answers come from the daemon's own code over the temporary repository. */
async function realHost(){
 const {HostConnectionRegistry}=await import('../src/modules/hosts/connectionRegistry.js');
 // Not a literal: the daemon's sources type-check in their own package, outside the server's rootDir.
 const daemonIntegration=fileURLToPath(new URL('../../packages/host-daemon/src/workspaceIntegration.ts',import.meta.url));
 const {executeWorkspaceIntegration}=await import(daemonIntegration) as {executeWorkspaceIntegration:(repo:string,frame:unknown)=>Promise<unknown>};
 const hosts=new HostConnectionRegistry(),actions:string[]=[];
 hosts.requestTaskBranch=(async(_host:string,type:string,frame:any)=>{
  if(type!=='workspace_integration')throw new Error(`unexpected Host request ${type}`);
  actions.push(frame.action);
  return executeWorkspaceIntegration(repo,frame);
 }) as never;
 return {hosts,actions};
}
async function retry(mergeId:string,extra:Record<string,unknown>={}){
 const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
 const {sessionActor}=await import('../src/modules/systemActions/operations/actor.js');
 const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
 const revision=(await db.pool.query('SELECT revision FROM task_merges WHERE id=$1',[mergeId])).rows[0].revision;
 return engine.execute('workspace.integration.retry',{integration_id:mergeId,expected_revision:revision,...extra},sessionActor({spaceId:SPACE,userId:OWNER}),randomUUID(),randomUUID());
}
async function advance(mergeId:string,hosts:unknown){
 const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
 return advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts:hosts as never,verify:async()=>({status:'passed',checks:[{key:'pnpm test',status:'passed'}]} as never)});
}
const row=async(id:string)=>(await db.pool.query('SELECT * FROM task_merges WHERE id=$1',[id])).rows[0];

describe('a person retries a frozen chain integration without an Agent',()=>{
 it('publishes a merge plan as an ordinary merge commit of the recorded chain, not a squash',async ctx=>{
  if(!db.available)ctx.skip();
  const {chain,tip,mergeId,changeSetId,plan}=await frozenIntegration('merge','clean');
  const movedTarget=git('rev-parse','master');
  const admitted=await retry(mergeId);
  expect(admitted.http_status,JSON.stringify(admitted.body)).toBe(200);
  // The frozen plan and recorded chain stay top-level; the person's retry carries no Agent ownership.
  expect((await row(mergeId)).detail_json).toMatchObject({...plan,previous_detail:{reply_owner_run_id:expect.any(String)}});
  expect((await row(mergeId)).detail_json.reply_owner_run_id).toBeUndefined();
  const {hosts,actions}=await realHost();
  expect(await advance(mergeId,hosts)).toMatchObject({status:'integrated'});
  expect(actions).toEqual(['prepare','seal','finish']);
  const published=git('rev-parse','master');
  expect(git('rev-parse',`${published}^1`)).toBe(movedTarget);
  expect(git('rev-parse',`${published}^2`)).toBe(tip);
  // Every chain commit is target history, with its own identity.
  for(const c of chain)expect(execFileSync('git',['merge-base','--is-ancestor',c,'master'],{cwd:repo}).length).toBe(0);
  expect(git('show','master:a.txt')).toBe('a chain');expect(git('show','master:m.txt')).toBe('m');
  expect(await row(mergeId)).toMatchObject({status:'merged',merged_commit:published});
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[changeSetId])).rows[0].state).toBe('integrated');
 });

 it('squashes a refused chain into its target only when explicitly asked; a recorded chain stays a chain',async ctx=>{
  if(!db.available)ctx.skip();
  const {mergeId,changeSetId,plan}=await frozenIntegration('merge','clean');
  expect((await retry(mergeId,{publication:{strategy:'squash'}})).http_status).toBe(409);
  // The Host refused this chain at prepare, so no chain tip was ever recorded.
  await db.pool.query('UPDATE task_merges SET detail_json=$2::jsonb WHERE id=$1',[mergeId,JSON.stringify({native_integration:true,error:'native_publication_chain_base_not_target_history',publication_plan:plan.publication_plan})]);
  expect((await retry(mergeId)).http_status).toBe(409);
  // A rebase is replayed only in an Agent session; the person's route cannot start one.
  expect((await retry(mergeId,{publication:{strategy:'rebase'}})).http_status).toBe(409);
  const movedTarget=git('rev-parse','master');
  const admitted=await retry(mergeId,{publication:{strategy:'squash'}});
  expect(admitted.http_status,JSON.stringify(admitted.body)).toBe(200);
  const detail=(await row(mergeId)).detail_json;
  expect(detail.publication_plan).toEqual({strategy:'squash',target_ref:null,requested_by_user_id:OWNER,requested_by_run_id:null,replaced_plan:{strategy:'merge',error:'native_publication_chain_base_not_target_history'}});
  expect(detail.publication).toBeUndefined();
  const {hosts}=await realHost();
  expect(await advance(mergeId,hosts)).toMatchObject({status:'integrated'});
  const published=git('rev-parse','master');
  // One new commit on the target tip, not a merge commit carrying the chain.
  expect(git('rev-list','--parents','-n','1',published).split(' ')).toEqual([published,movedTarget]);
  expect(git('show','master:a.txt')).toBe('a chain');expect(git('show','master:f2.txt')).toBe('2');expect(git('show','master:m.txt')).toBe('m');
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[changeSetId])).rows[0].state).toBe('integrated');
 });

 it('fast-forwards the target to the recorded chain tip itself',async ctx=>{
  if(!db.available)ctx.skip();
  const {tip,mergeId}=await frozenIntegration('fast_forward','none');
  expect((await retry(mergeId)).http_status).toBe(200);
  const {hosts}=await realHost();
  expect(await advance(mergeId,hosts)).toMatchObject({status:'integrated'});
  expect(git('rev-parse','master')).toBe(tip);
  expect(await row(mergeId)).toMatchObject({status:'merged',merged_commit:tip});
 });

 it('refuses clearly, without a repair or a squash, when the target moved under a fast-forward',async ctx=>{
  if(!db.available)ctx.skip();
  const {mergeId,changeSetId,plan}=await frozenIntegration('fast_forward','clean');
  const target=git('rev-parse','master');
  expect((await retry(mergeId)).http_status).toBe(200);
  const {hosts,actions}=await realHost();
  expect(await advance(mergeId,hosts)).toMatchObject({status:'failed'});
  expect(actions).not.toContain('repair');
  expect(git('rev-parse','master')).toBe(target);
  expect(await row(mergeId)).toMatchObject({status:'failed',detail_json:{error:'native_publication_fast_forward_target_moved',...plan}});
  expect((await db.pool.query('SELECT state FROM workspace_change_sets WHERE id=$1',[changeSetId])).rows[0].state).toBe('blocked');
 });

 it('hands a new conflict to the controlled repair with the person\'s instruction, keeping the merge plan',async ctx=>{
  if(!db.available)ctx.skip();
  const {mergeId,plan}=await frozenIntegration('merge','conflict');
  const target=git('rev-parse','master');
  // The first retry meets the conflict; it is recorded with its exact paths.
  expect((await retry(mergeId)).http_status).toBe(200);
  const {hosts,actions}=await realHost();
  const {advanceWorkspaceIntegration}=await import('../src/modules/hosts/workspaceIntegrations.js');
  const dispatched:string[][]=[];
  const repair=async(_c:unknown,_p:unknown,_cfg:unknown,m:{detail_json:Record<string,unknown>},_w:unknown,_o:unknown,files:string[])=>{dispatched.push(files);expect(m.detail_json.publication_plan).toMatchObject({strategy:'merge'});return null;};
  expect(await advanceWorkspaceIntegration(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}),mergeId,SPACE,{hosts:hosts as never,repair:repair as never,verify:async()=>{throw new Error('a conflict is not verified');}})).toMatchObject({status:'conflict'});
  expect(dispatched).toEqual([['a.txt']]);
  expect(await row(mergeId)).toMatchObject({status:'conflict',detail_json:{conflicted_files:['a.txt'],...plan}});
  // The person's own resolution instruction is accepted for exactly those paths and keeps the plan.
  const resolved=await retry(mergeId,{resolution:'Keep both lines of a.txt.'});
  expect(resolved.http_status,JSON.stringify(resolved.body)).toBe(200);
  expect((await row(mergeId)).detail_json).toMatchObject({...plan,human_resolution:{instruction:'Keep both lines of a.txt.',user_id:OWNER,paths:['a.txt']}});
  expect(git('rev-parse','master')).toBe(target);
  expect(actions.filter(a=>a==='finish')).toEqual([]);
  // The controlled repair Run (visible, owned by the person's integration) edits only the frozen conflict.
  const repairRun=randomUUID();
  const resolve=async(_c:unknown,_p:unknown,_cfg:unknown,m:{attempt_id:string;detail_json:Record<string,unknown>},_w:unknown,_o:unknown,files:string[])=>{
   expect(files).toEqual(['a.txt']);expect(m.detail_json.human_resolution).toMatchObject({instruction:'Keep both lines of a.txt.'});
   // This attempt's integration worktree (the earlier attempt's is retained for its cleanup).
   const worktree=git('worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).map(l=>l.slice(9)).find(p=>p!==repo&&p.includes(m.attempt_id))!;
   await writeFile(join(worktree,'a.txt'),'a target\na chain\n');
   await seedRun(db.pool,{id:repairRun,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
   await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now(),project_id=$2,instructed_by_user_id=$3 WHERE id=$1",[repairRun,PROJECT,OWNER]);
   return repairRun;
  };
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),verify=async()=>({status:'passed',checks:[{key:'pnpm test',status:'passed'}]} as never);
  await expect(advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts:hosts as never,repair:resolve as never,verify})).rejects.toThrow('integration_repair_dispatched');
  expect(await row(mergeId)).toMatchObject({status:'resolving',resolution_run_id:repairRun});
  const outcome=await advanceWorkspaceIntegration(db.pool,config,mergeId,SPACE,{hosts:hosts as never,repair:resolve as never,verify});
  expect(outcome,JSON.stringify((await row(mergeId)).detail_json)).toMatchObject({status:'integrated'});
  const published=git('rev-parse','master');
  // Still the frozen merge plan: target tip and recorded chain tip as parents, the resolved content as tree.
  expect(git('rev-parse',`${published}^1`)).toBe(target);
  expect(git('rev-parse',`${published}^2`)).toBe(plan.publication.chain_tip);
  expect(git('show','master:a.txt')).toBe('a target\na chain');
  expect(await row(mergeId)).toMatchObject({status:'merged',merged_commit:published,detail_json:{...plan,completed_repair_runs:[repairRun]}});
 });
});
