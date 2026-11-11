import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {OperationActor} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedRun,seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {HostConnectionRegistry} from '../src/modules/hosts/connectionRegistry.js';
import {ensureExecutionWorkspace} from '../src/modules/projectFolders/executionWorkspaces.js';
import {assessWorkspaceRetention,configureWorkspaceRetention,reclaimProofCommits,classifyLocationRefs} from '../src/modules/hosts/workspaceRetention.js';
import {reconcileWorkspaceAdoption} from '../src/modules/hosts/workspaceAdoption.js';
import {reconcileExecutionWorkspaces} from '../src/modules/hosts/workspaceReconcile.js';
import {listWorkspaceChanges} from '../src/modules/projectFolders/workspaceChangeList.js';
import {listAgentWorkspaces} from '../src/modules/projectFolders/workspaceOverview.js';
import {advanceWorkspaceCleanup} from '../src/modules/hosts/workspaceCleanup.js';
import {workspaceRetentionRegistration} from '../src/modules/projectFolders/workspaceRetentionOperations.js';
import {workspaceOperationRegistrations} from '../src/modules/projectFolders/workspaceOperations.js';
import {workspaceBranchAlignRegistration,processBranchAlign} from '../src/modules/projectFolders/workspaceBranchAlign.js';
import {admitPublicationPlan,isPlanSwitch} from '../src/modules/projectFolders/workspacePublicationPlan.js';

const SPACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OWNER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',PROJECT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOLDER='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',LOCATION='11111111-1111-4111-8111-111111111111',MACHINE='22222222-2222-4222-8222-222222222222';
const HOST='33333333-3333-4333-8333-333333333333',AGENT='55555555-5555-4555-8555-555555555555',VERSION='66666666-6666-4666-8666-666666666666';
const CONVERSATION='88888888-8888-4888-8888-888888888888',OTHER_CONVERSATION='77777777-7777-4777-8777-777777777777',MEMBER='99999999-9999-4999-8999-999999999999';
const MEMBER_HOST='44444444-4444-4444-8444-444444444444',MEMBER_LOCATION='12121212-1212-4121-8121-121212121212',MEMBER_MACHINE='23232323-2323-4232-8232-232323232323';
const db=useTestDatabase(import.meta.filename);
let repo='',roomId='';
const git=(...args:string[])=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function commitFile(path:string,text:string,message:string){await writeFile(join(repo,path),text);git('add','-A');git('commit','-qm',message);return git('rev-parse','HEAD');}
/** A Host whose Location Git is a real temporary repository. */
function gitHosts(){
 const hosts=new HostConnectionRegistry();
 hosts.runHostCommand=async(_host,input)=>{
  try{return {ok:true,error:null,exit_code:0,stdout:execFileSync('git',input.command.slice(1),{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:'',timed_out:false};}
  catch(error){return {ok:true,error:null,exit_code:(error as {status?:number}).status??1,stdout:'',stderr:'',timed_out:false};}
 };
 return hosts;
}
const user=(id=OWNER):OperationActor=>({space_id:SPACE,principal:{kind:'user',id},on_behalf_of_user_id:id,run_id:null} as unknown as OperationActor);
const agent=(runId:string):OperationActor=>({space_id:SPACE,principal:{kind:'agent',id:AGENT},on_behalf_of_user_id:OWNER,run_id:runId} as unknown as OperationActor);
const definitions=new Map(['workspace.change.get','workspace.change.list','workspace.branch.align','workspace.retention.update','workspace.change.complete','workspace.integration.retry','workspace.change.abandon','workspace.integration.verification.get','workspace.integration.verification.configure'].map(id=>[id,{id} as never]));

beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['host_threads','sessions','workspace_locations','project_folders','tasks','agents','agent_versions','rooms','projects','hosts','machines','space_memberships','users','spaces'],{cascade:true});
 const {now}=await seedSpaceOwnerProject(db.pool,{space:SPACE,owner:OWNER,project:PROJECT,now:new Date().toISOString()});
 await seedSpaceMember(db.pool,{space:SPACE,user:MEMBER,now});
 await db.pool.query("INSERT INTO project_members(project_id,space_id,user_id,role,created_at) VALUES($1,$2,$3,'editor',$4) ON CONFLICT DO NOTHING",[PROJECT,SPACE,MEMBER,now]).catch(()=>undefined);
 roomId=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND is_mainline=true LIMIT 1',[SPACE])).rows[0]!.id;
 for(const id of [CONVERSATION,OTHER_CONVERSATION])await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5)`,[id,SPACE,PROJECT,roomId,now]);
 await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'repo','code','active',false,false,$4,$4)`,[FOLDER,SPACE,PROJECT,now]);
 for(const [machine,owner] of [[MACHINE,OWNER],[MEMBER_MACHINE,MEMBER]])await db.pool.query(`INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'M','desktop',$3,$3)`,[machine,owner,now]);
 for(const [host,owner,machine] of [[HOST,OWNER,MACHINE],[MEMBER_HOST,MEMBER,MEMBER_MACHINE]])await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,created_at,updated_at) VALUES($1,$2,$3,'H','remote','linux_native','online','{"execution_workspaces":{"version":2,"reclaim":4},"native_workspace_integration":true}'::jsonb,$4,$4)`,[host,owner,machine,now]);
 await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/workspace/repo',true,'active',$5,$5)`,[LOCATION,SPACE,FOLDER,HOST,now]);
 await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/member/repo',true,'stale',$5,$5)`,[MEMBER_LOCATION,SPACE,FOLDER,MEMBER_HOST,now]);
 await seedAgentWithVersion(db.pool,{agent:AGENT,version:VERSION,space:SPACE,owner:OWNER,now});
 configureWorkspaceRetention({workspaceReclaimGraceMinutes:10});
 repo=await mkdtemp(join(tmpdir(),'rainver-active-'));
 git('init','-q','-b','main');git('config','user.email','person@example.invalid');git('config','user.name','Person');
});
afterEach(async()=>{if(repo)await rm(repo,{recursive:true,force:true});repo='';});

async function conversationRun(status='succeeded',session=CONVERSATION,instructedBy=OWNER,host=HOST,location=LOCATION){
 const id=randomUUID();
 await seedRun(db.pool,{id,space:SPACE,owner:instructedBy,agent:AGENT,version:VERSION,existingAgent:true});
 await db.pool.query(`UPDATE runs SET project_id=$2,session_id=$3,workspace_location_id=$4,instructed_by_user_id=$5,status='running',contract_snapshot_json='{"execution_workspace_version":1}' WHERE id=$1`,[id,PROJECT,session,location,instructedBy]);
 const run=(await new PgRunRepository(db.pool).getRun(SPACE,id))!;
 const w=await ensureExecutionWorkspace(db.pool,run,host,location);
 await db.pool.query("UPDATE runs SET status=$2::varchar,ended_at=CASE WHEN $2::varchar IN ('succeeded','failed') THEN now()-interval '30 minutes' END WHERE id=$1",[id,status]);
 return {run,w};
}
async function newSession(){const id=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[id,SPACE,PROJECT,roomId]);return id;}
/** A settled turn whose saved batch is base..source, open (saved privately); its own conversation unless given. */
async function savedBatch(base:string,source:string,options:{status?:string;session?:string;checkpoint?:string;location?:string}={}){
 const {run,w}=await conversationRun(options.status,options.session??await newSession(),OWNER,HOST,options.location??LOCATION);
 await db.pool.query("UPDATE execution_workspaces SET state='ready',head_commit=$2,base_commit=$3,target_ref='refs/heads/main',inventory_json='{}'::jsonb WHERE id=$1",[w.workspace.id,source,base]);
 await db.pool.query("UPDATE execution_workspace_runs SET start_commit=$2,checkpoint_commit=$3,checkpoint_state=$4 WHERE run_id=$1",[run.id,base,source,options.checkpoint??'saved']);
 await db.pool.query("UPDATE workspace_change_sets SET state='open',base_commit=$2,source_commit=$3,summary='Feature work',updated_at=now()-interval '20 minutes' WHERE id=$1",[w.changeSetId,base,source]);
 const row=(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[w.workspace.id])).rows[0];
 return {run,w,row,change:w.changeSetId,workspace:w.workspace.id};
}
const state=async(id:string)=>(await db.pool.query<{state:string;verification_json:Record<string,unknown>}>('SELECT state,verification_json FROM workspace_change_sets WHERE id=$1',[id])).rows[0]!;
const row=async(id:string)=>(await db.pool.query('SELECT * FROM execution_workspaces WHERE id=$1',[id])).rows[0];

describe('automatic closure of adopted and unchanged work',()=>{
 it('closes saved work after an external squash rewrite only on exact target content, then offers it to retention',async ctx=>{
  if(!db.available)return ctx.skip();
  const base=await commitFile('app.txt','v1\n','base');
  git('checkout','-q','-b','work');await commitFile('feature.txt','feature\n','feat: one');const source=await commitFile('app.txt','v2\n','feat: two');
  git('checkout','-q','main');
  const c=await savedBatch(base,source);
  const hosts=gitHosts();
  // Not in the target yet: retained, and the refused proof is remembered for this tip.
  expect(await reconcileWorkspaceAdoption(db.pool,c.row,OWNER,hosts,'/workspace')).toBe(false);
  expect((await state(c.change)).state).toBe('open');
  expect((await row(c.workspace)).retention_json.adoption_check).toMatchObject({source});
  // Same commit title with different content is not adoption.
  await commitFile('feature.txt','something else\n','feat: one');
  expect(await reconcileWorkspaceAdoption(db.pool,await row(c.workspace),OWNER,hosts,'/workspace')).toBe(false);
  // The person squash-merges (history rewritten): the content is identical.
  git('checkout','-q','work','--','feature.txt','app.txt');git('commit','-qm','squash: feature');
  const tip=await commitFile('unrelated.txt','later\n','unrelated');
  expect(await reconcileWorkspaceAdoption(db.pool,await row(c.workspace),OWNER,hosts,'/workspace')).toBe(true);
  expect(await state(c.change)).toMatchObject({state:'no_changes',verification_json:{adoption_proof:'target_paths_match',already_present_at:tip,adoption_target_ref:'refs/heads/main'}});
  expect(await assessWorkspaceRetention(db.pool,c.workspace)).toMatchObject({reason:'no_changes'});
  expect(await reclaimProofCommits(db.pool,c.workspace,1)).toContain(tip);
  // Idempotent.
  expect(await reconcileWorkspaceAdoption(db.pool,await row(c.workspace),OWNER,hosts,'/workspace')).toBe(false);
 });

 it('keeps later target edits, active Runs, pending checkpoints, quarantine and private ancestry-only evidence',async ctx=>{
  if(!db.available)return ctx.skip();
  const base=await commitFile('app.txt','v1\n','base');
  git('checkout','-q','-b','work');const source=await commitFile('app.txt','v2\n','feat');
  git('checkout','-q','main');git('merge','-q','--ff-only','work');
  // Ancestry holds, but the target later changed the same path: not exact, kept.
  await commitFile('app.txt','v3\n','later edit');
  const edited=await savedBatch(base,source);
  expect(await reconcileWorkspaceAdoption(db.pool,edited.row,OWNER,gitHosts(),'/workspace')).toBe(false);
  expect((await state(edited.change)).state).toBe('open');
  await commitFile('app.txt','v2\n','restore');
  for(const kind of ['running','checkpoint','quarantine'] as const){
   const c=await savedBatch(base,source,{session:kind==='running'?OTHER_CONVERSATION:CONVERSATION,status:kind==='running'?'running':'succeeded',checkpoint:kind==='checkpoint'?'pending':'saved'});
   if(kind==='quarantine')await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"quarantined_whole":1}'::jsonb WHERE id=$1`,[c.workspace]);
   expect(await reconcileWorkspaceAdoption(db.pool,await row(c.workspace),OWNER,gitHosts(),'/workspace'),kind).toBe(false);
   expect((await state(c.change)).state,kind).toBe('open');
  }
 });

 it('closes a settled batch with nothing saved without asking the Host',async ctx=>{
  if(!db.available)return ctx.skip();
  const base=await commitFile('app.txt','v1\n','base');
  const c=await savedBatch(base,base);
  const hosts=new HostConnectionRegistry();
  hosts.runHostCommand=async()=>{throw new Error('Host must not be asked');};
  await db.pool.query("UPDATE execution_workspaces SET target_ref=NULL WHERE id=$1",[c.workspace]);
  expect(await reconcileWorkspaceAdoption(db.pool,await row(c.workspace),OWNER,hosts,'/workspace')).toBe(true);
  expect(await state(c.change)).toMatchObject({state:'no_changes',verification_json:{no_change_reason:'empty_saved_delta'}});
 });

 it('survives a Host failure in scheduled reconciliation and closes on a later pass (restart retry)',async ctx=>{
  if(!db.available)return ctx.skip();
  const base=await commitFile('app.txt','v1\n','base');
  git('checkout','-q','-b','work');const source=await commitFile('app.txt','v2\n','feat');git('checkout','-q','main');git('merge','-q','--squash','work');git('commit','-qm','squash');
  const c=await savedBatch(base,source);
  const offline=new HostConnectionRegistry();offline.isOnline=()=>true;
  offline.runHostCommand=async()=>({ok:false,error:'host_offline',exit_code:1,stdout:'',stderr:'',timed_out:false});
  Object.defineProperty(offline,'requestTaskBranch',{value:async()=>({ok:false,branch:null,commit:null,error:'host_offline'})});
  expect((await reconcileExecutionWorkspaces(db.pool,'/workspace',{hosts:offline})).failures).toEqual([]);
  expect((await state(c.change)).state).toBe('open');
  expect((await row(c.workspace)).cleanup_state).not.toBe('blocked');
  const online=gitHosts();online.isOnline=()=>true;
  Object.defineProperty(online,'requestTaskBranch',{value:async()=>({ok:false,branch:null,commit:null,error:'host_offline'})});
  await reconcileExecutionWorkspaces(db.pool,'/workspace',{hosts:online});
  expect((await state(c.change)).state).toBe('no_changes');
 });
});

describe('records whose branch was removed outside Rainver',()=>{
 it('reports missing without claiming a merge, keeps it current, and closes it only on the person’s request',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await savedBatch('a'.repeat(40),'b'.repeat(40));
  await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"branch":false,"worktree":false,"registration":false}'::jsonb WHERE id=$1`,[c.workspace]);
  expect(await assessWorkspaceRetention(db.pool,c.workspace)).toMatchObject({state:'missing',reason:'branch_missing'});
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','missing','reason','branch_missing') WHERE id=$1`,[c.workspace]);
  const current=await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'current',limit:20});
  expect(current.items.find(i=>i.workspace_id===c.workspace)).toMatchObject({work_state:'missing'});
  const retention=workspaceRetentionRegistration(definitions);
  await expect(retention.execute(db.pool,{change_set_id:c.change,action:'acknowledge_missing'},agent(c.run.id),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
  const result=await retention.execute(db.pool,{change_set_id:c.change,action:'acknowledge_missing'},user(),Object.freeze({requestId:randomUUID(),idempotencyKey:null})) as {retention:{state:string;reason:string}};
  expect(result.retention).toMatchObject({state:'missing',reason:'missing_acknowledged'});
  expect(await state(c.change)).toMatchObject({state:'abandoned',verification_json:{missing_acknowledged:true,abandon_reason:'branch_missing_acknowledged'}});
  expect((await db.pool.query('SELECT count(*)::int AS n FROM workspace_change_sets WHERE id=$1',[c.change])).rows[0].n).toBe(1);
  const history=await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'history',limit:20});
  expect(history.items.find(i=>i.workspace_id===c.workspace)).toMatchObject({work_state:'missing_closed'});
  expect((await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'current',limit:20})).items.some(i=>i.workspace_id===c.workspace)).toBe(false);
  // A second acknowledgement has nothing left to close.
  await expect(retention.execute(db.pool,{change_set_id:c.change,action:'acknowledge_missing'},user(),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
 });
 it('ranks live Runs and batches above a recorded missing branch, across recovery, a failed batch and generations',async ctx=>{
  if(!db.available)return ctx.skip();
  const session=await newSession();
  const c=await savedBatch('a'.repeat(40),'b'.repeat(40),{session});
  const workState=async(view:'current'|'history'='current',id=c.workspace)=>(await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view,limit:50})).items.find(i=>i.workspace_id===id)?.work_state;
  // The record says missing (assessed after the saved batch it describes); the branch is back and a new Run of the same generation works in it.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','missing','reason','branch_missing','assessed_at',now()::text) WHERE id=$1`,[c.workspace]);
  expect(await workState()).toBe('missing');
  const next=randomUUID(),change=randomUUID();
  await seedRun(db.pool,{id:next,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET project_id=$2,session_id=$3,instructed_by_user_id=$4,status='running' WHERE id=$1",[next,PROJECT,session,OWNER]);
  // The earlier saved batch was kept without merging; the new turn opens the next batch.
  await db.pool.query("UPDATE workspace_change_sets SET state='abandoned' WHERE id=$1",[c.change]);
  await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit,updated_at) VALUES($1,$2,$3,1,2,$4,$4,'open',$5,NULL,now())`,[change,c.workspace,SPACE,next,'b'.repeat(40)]);
  await db.pool.query(`INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'pending')`,[next,c.workspace,SPACE,change]);
  expect(await workState()).toBe('running');
  // Its batch merging, then failed and blocked on a decision: live facts, not the old reading.
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[next]);
  await db.pool.query("UPDATE workspace_change_sets SET state='integrating' WHERE id=$1",[change]);
  expect(await workState()).toBe('integrating');
  await db.pool.query("UPDATE workspace_change_sets SET state='blocked' WHERE id=$1",[change]);
  expect(await workState()).toBe('attention');
  // Closed missing records never outrank later saved work.
  await db.pool.query("UPDATE workspace_change_sets SET state='open',source_commit=$2 WHERE id=$1",[change,'c'.repeat(40)]);
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','missing','reason','missing_acknowledged') WHERE id=$1`,[c.workspace]);
  expect(await workState()).toBe('saved');
  await db.pool.query("UPDATE workspace_change_sets SET state='abandoned' WHERE id=$1",[change]);
  expect(await workState('history')).toBe('missing_closed');
  // A later generation of the same conversation has its own state; the old one stays closed history.
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[c.workspace]);
  const later=await conversationRun('running',session);
  expect(later.w.workspace.id).not.toBe(c.workspace);
  expect(await workState('current',later.w.workspace.id)).toBe('running');
  expect(await workState('history')).toBe('missing_closed');
 });
 it('shows a later Run\'s saved work as unmerged, not missing, once that Run ends; a reading newer than the work still stands',async ctx=>{
  if(!db.available)return ctx.skip();
  const session=await newSession();
  const c=await savedBatch('a'.repeat(40),'b'.repeat(40),{session});
  const {recordRetention}=await import('../src/modules/hosts/workspaceRetention.js');
  const {recordWorkspaceLaunch}=await import('../src/modules/projectFolders/executionWorkspaces.js');
  const {readAllVisibleWorkspaceChanges,workspaceChangesForConversation}=await import('../src/modules/projectFolders/workspaceReadModel.js');
  const reassess=async()=>{const a=await assessWorkspaceRetention(db.pool,c.workspace);await recordRetention(db.pool,c.workspace,{...a});return a;};
  const overview=async()=>(await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'current',limit:50})).items.find(i=>i.workspace_id===c.workspace);
  const changeView=async()=>(await readAllVisibleWorkspaceChanges(db.pool,SPACE,OWNER,{where:'c.id=$2',params:[c.change]}))[0]!.change;
  const pending=async()=>(await workspaceChangesForConversation(db.pool,{spaceId:SPACE,sessionId:session,projectId:PROJECT},OWNER)).entries.find(e=>e.change.change_set_id===c.change)!.change;
  const listed=async()=>(await listWorkspaceChanges(db.pool,user(),{scope:'project',project_id:PROJECT,limit:50})).items.find(i=>i.change_set_id===c.change)!;
  // The branch was removed outside Rainver: a real missing reading with nothing newer is shown everywhere.
  await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"branch":false,"worktree":false}'::jsonb WHERE id=$1`,[c.workspace]);
  expect(await reassess()).toMatchObject({state:'missing',reason:'branch_missing'});
  expect(await overview()).toMatchObject({work_state:'missing'});
  expect((await changeView()).retention).toMatchObject({state:'missing'});
  expect((await pending()).retention).toMatchObject({state:'missing'});
  expect(await listed()).toMatchObject({retention_state:'missing'});
  // A new Run of the same conversation joins the unmerged batch; the Host's launch report proves the branch exists.
  const next=randomUUID();
  await seedRun(db.pool,{id:next,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
  await db.pool.query("UPDATE runs SET project_id=$2,session_id=$3,instructed_by_user_id=$4,workspace_location_id=$5,status='running' WHERE id=$1",[next,PROJECT,session,OWNER,LOCATION]);
  await db.pool.query(`INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'pending')`,[next,c.workspace,SPACE,c.change]);
  await recordWorkspaceLaunch(db.pool,(await new PgRunRepository(db.pool).getRun(SPACE,next))!,{id:c.workspace,generation:1,start_commit:'b'.repeat(40),target_ref:'refs/heads/main',launch_sequence:2});
  expect(await overview()).toMatchObject({work_state:'running'});
  // It saves more work and ends.
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved',checkpoint_commit=$2 WHERE run_id=$1",[next,'c'.repeat(40)]);
  await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2,updated_at=now() WHERE id=$1",[c.change,'c'.repeat(40)]);
  await db.pool.query("UPDATE runs SET status='succeeded',ended_at=now() WHERE id=$1",[next]);
  // The re-assessment at its end does not read the stale inventory as missing again.
  expect((await reassess())).toMatchObject({state:'retained',reason:'unpublished_changes'});
  expect(await overview()).toMatchObject({work_state:'saved'});
  // A missing reading older than the newly saved work (not yet re-assessed) is stale for it on every surface.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','missing','reason','branch_missing','assessed_at',(now()-interval '5 minutes')::text) WHERE id=$1`,[c.workspace]);
  expect(await overview()).toMatchObject({work_state:'saved',retention:null});
  expect((await changeView()).retention).toBeUndefined();
  expect((await pending()).retention).toBeUndefined();
  expect(await listed()).toMatchObject({retention_state:null,saved_difference:true});
  // One taken after it stands: the branch really is gone again and the unmerged work is not hidden.
  await db.pool.query(`UPDATE execution_workspaces SET retention_json=jsonb_build_object('state','missing','reason','branch_missing','assessed_at',(now()+interval '1 second')::text) WHERE id=$1`,[c.workspace]);
  expect(await overview()).toMatchObject({work_state:'missing'});
  expect((await changeView()).retention).toMatchObject({state:'missing'});
 });
 it('treats a released branch as reclaimed, not missing, and attributes branch-alignment recovery refs',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await savedBatch('a'.repeat(40),'b'.repeat(40));
  await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"branch":false,"worktree":false}'::jsonb,retention_json='{"state":"reclaimed","reason":"merged"}'::jsonb WHERE id=$1`,[c.workspace]);
  expect((await assessWorkspaceRetention(db.pool,c.workspace)).state).not.toBe('missing');
  const intent=randomUUID();
  await db.pool.query("INSERT INTO project_folder_io_intents(id,space_id,project_id,user_id,folder_id,kind,scope_key,status,frozen_json,effect_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'branch_align','k','succeeded','{}','{}',now(),now())",[intent,SPACE,PROJECT,OWNER,FOLDER]);
  const unclaimed=await classifyLocationRefs(db.pool,HOST,[{ref:`refs/rainver/branch-backups/${intent}`,commit:'a'.repeat(40)},{ref:`refs/rainver/branch-backups/${randomUUID()}`,commit:'a'.repeat(40)}]);
  expect(unclaimed).toHaveLength(1);
 });
});

describe('Active management for Agents and people',()=>{
 it('pages a conversation tree with nested delegations, hides other Hosts and people, and explains closability',async ctx=>{
  if(!db.available)return ctx.skip();
  const FOLDER2=randomUUID(),LOCATION2=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'second','code','active',false,false,now(),now())`,[FOLDER2,SPACE,PROJECT]);
  await db.pool.query(`INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,display_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'remote','/workspace/second',true,'active',now(),now())`,[LOCATION2,SPACE,FOLDER2,HOST]);
  const saved=await savedBatch('a'.repeat(40),'b'.repeat(40),{session:CONVERSATION});
  const active=await savedBatch('a'.repeat(40),'c'.repeat(40),{session:CONVERSATION,status:'running',location:LOCATION2});
  // Two delegation levels below the conversation's workspace: an empty and a saved batch.
  const group=randomUUID();
  const message=randomUUID();
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Implement',0,'/',now())`,[message,SPACE,CONVERSATION,OWNER]);
  await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Delegation','Implement','active',now(),now())`,[group,SPACE,OWNER,roomId,CONVERSATION,message,PROJECT]);
  let parent=saved.workspace;const children:string[]=[];
  for(const source of ['a'.repeat(40),'d'.repeat(40)]){
   const run=randomUUID(),delegation=randomUUID(),id=randomUUID(),change=randomUUID();
   await seedRun(db.pool,{id:run,space:SPACE,owner:OWNER,agent:AGENT,version:VERSION,existingAgent:true});
   await db.pool.query("UPDATE runs SET project_id=$2,instructed_by_user_id=$3,status='succeeded' WHERE id=$1",[run,PROJECT,OWNER]);
   await db.pool.query(`INSERT INTO run_delegations(id,space_id,group_id,parent_run_id,child_run_id,requesting_agent_id,target_agent_id,status,instruction,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6,'succeeded','Implement',now(),now())`,[delegation,SPACE,group,saved.run.id,run,AGENT]);
   await db.pool.query(`INSERT INTO execution_workspaces(id,space_id,project_id,workspace_location_id,execution_host_id,owner_kind,delegation_id,parent_workspace_id,generation,state,base_commit,head_commit,target_ref)
    VALUES($1,$2,$3,$4,$5,'delegation',$6,$7,1,'ready',$8,$9,'refs/heads/parent')`,[id,SPACE,PROJECT,LOCATION,HOST,delegation,parent,'a'.repeat(40),source]);
   await db.pool.query(`INSERT INTO workspace_change_sets(id,workspace_id,space_id,generation,sequence,originating_run_id,root_run_id,state,base_commit,source_commit) VALUES($1,$2,$3,1,1,$4,$4,'open',$5,$6)`,[change,id,SPACE,run,'a'.repeat(40),source]);
   await db.pool.query(`INSERT INTO execution_workspace_runs(run_id,workspace_id,space_id,change_set_id,checkpoint_state) VALUES($1,$2,$3,$4,'saved')`,[run,id,SPACE,change]);
   children.push(change);parent=id;
  }
  // Another person's Host, and another conversation of the same person.
  const FOLDER3=randomUUID();
  await db.pool.query(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'member','code','active',false,false,now(),now())`,[FOLDER3,SPACE,PROJECT]);
  await db.pool.query("UPDATE workspace_locations SET status='active',project_folder_id=$2 WHERE id=$1",[MEMBER_LOCATION,FOLDER3]);
  const foreign=await conversationRun('succeeded',CONVERSATION,MEMBER,MEMBER_HOST,MEMBER_LOCATION).catch(()=>null);
  const elsewhere=await savedBatch('a'.repeat(40),'e'.repeat(40),{session:OTHER_CONVERSATION});
  const caller=agent(active.run.id);
  const seen:Array<Record<string,unknown>>=[];let cursor:string|undefined;
  for(let page=0;page<10;page++){
   const result=await listWorkspaceChanges(db.pool,caller,{scope:'conversation',limit:2,...(cursor?{cursor}:{})});
   expect(result.items.length).toBeLessThanOrEqual(2);
   seen.push(...result.items);cursor=result.next_cursor??undefined;
   if(!cursor)break;
  }
  const ids=seen.map(i=>i.change_set_id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual([saved.change,active.change,...children].sort());
  expect(ids).not.toContain(elsewhere.change);
  if(foreign)expect(ids).not.toContain(foreign.w.changeSetId);
  const by=(id:string)=>seen.find(i=>i.change_set_id===id)!;
  expect(by(children[0]!)).toMatchObject({closable:true,close_blocker:null,saved_difference:false,owner_kind:'delegation',same_conversation:true});
  expect(by(children[1]!)).toMatchObject({closable:false,close_blocker:'review_required',same_conversation:true});
  // Same conversation, but another Location's generation the caller does not write: abandon's authorizer refuses it, so the list says so.
  expect(by(saved.change)).toMatchObject({closable:false,close_blocker:'requires_person',saved_difference:true,summary:'Feature work'});
  expect(by(active.change)).toMatchObject({closable:false,close_blocker:'run_active'});
  // Project scope: other conversations appear as metadata only and need the person.
  const project=await listWorkspaceChanges(db.pool,caller,{scope:'project',limit:50});
  expect(project.items.find(i=>i.change_set_id===elsewhere.change)).toMatchObject({summary:null,conversation_id:null,closable:false,close_blocker:'requires_person'});
  if(foreign)expect(project.items.some(i=>i.change_set_id===foreign.w.changeSetId)).toBe(false);
  // The person sees the same rows with summaries and may close saved work.
  const person=await listWorkspaceChanges(db.pool,user(),{scope:'project',project_id:PROJECT,limit:50});
  expect(person.items.find(i=>i.change_set_id===elsewhere.change)).toMatchObject({summary:'Feature work',closable:true});
  await expect(listWorkspaceChanges(db.pool,user(),{scope:'conversation',project_id:PROJECT})).rejects.toThrow();
  // The overview aggregates delegations by their parent workspace id.
  // An open delegated batch with nothing saved is not pending work; the saved one is.
  const current=await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'current',limit:50});
  const history=await listAgentWorkspaces(db.pool,{spaceId:SPACE,userId:OWNER},PROJECT,{view:'history',limit:50});
  expect(current.items.filter(i=>i.parent_workspace_id).map(i=>i.work_state)).toEqual(['saved']);
  expect(history.items.filter(i=>i.parent_workspace_id).map(i=>i.work_state)).toEqual(['idle']);
  expect(current.items.find(i=>i.parent_workspace_id)!.parent_workspace_id).not.toBe(saved.workspace);
  // What the list calls closable, the same Agent can actually close; the rest stay refused.
  const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
  const close=async(change:string,actor:OperationActor)=>{
   const revision=(await db.pool.query<{revision:number}>('SELECT revision FROM workspace_change_sets WHERE id=$1',[change])).rows[0]?.revision??1;
   const raw={change_set_id:change,expected_revision:revision,reason:'cleanup'};
   await abandon.authorize(db.pool,raw,actor,await abandon.resolve(db.pool,raw,actor));
   return abandon.execute(db.pool,raw,actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  };
  // Another conversation's Agent sees the delegation as needing the person, and is refused.
  const otherAgent=agent(elsewhere.run.id);
  expect((await listWorkspaceChanges(db.pool,otherAgent,{scope:'project',limit:50})).items.find(i=>i.change_set_id===children[0])).toMatchObject({closable:false,close_blocker:'requires_person'});
  await expect(close(children[0]!,otherAgent)).rejects.toThrow();
  // Saved unadopted delegated work, a batch with a live Run, an unknown id and another person's Host stay refused.
  await expect(close(children[1]!,caller)).rejects.toThrow();
  await expect(close(active.change,caller)).rejects.toThrow();
  await expect(close(randomUUID(),caller)).rejects.toThrow();
  if(foreign)await expect(close(foreign.w.changeSetId,caller)).rejects.toThrow();
  for(const id of [children[0]!,children[1]!,active.change])expect((await state(id)).state).not.toBe('abandoned');
  // list -> get -> abandon: what the caller lists and may close, at any delegation depth, it may also read in detail.
  const registration=(id:string)=>workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id===id)!;
  const get=registration('workspace.change.get');
  const read=async(change:string,actor:OperationActor)=>{const raw={change_set_id:change};await get.authorize(db.pool,raw,actor,await get.resolve(db.pool,raw,actor));return await get.execute(db.pool,raw,actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null})) as Record<string,unknown>;};
  const notFound={code:'operation_not_found',httpStatus:404};
  for(const child of children)expect(await read(child,caller)).toMatchObject({change_set_id:child,state:'open',can_retry:false});
  // Reading never widens writing: the delegated batch is still not completed by this caller.
  const complete=registration('workspace.change.complete'),completeRaw={change_set_id:children[0],expected_revision:1,summary:'Publish'};
  await expect((async()=>complete.authorize(db.pool,completeRaw,caller,await complete.resolve(db.pool,completeRaw,caller)))()).rejects.toMatchObject(notFound);
  // Another conversation's Agent, another conversation of the same person, another person's Host and an unknown id stay unreadable.
  await expect(read(children[0]!,otherAgent)).rejects.toMatchObject(notFound);
  await expect(read(elsewhere.change,caller)).rejects.toMatchObject(notFound);
  if(foreign)await expect(read(foreign.w.changeSetId,caller)).rejects.toMatchObject(notFound);
  await expect(read(randomUUID(),caller)).rejects.toMatchObject(notFound);
  // The caller's own batch keeps its retry hint.
  expect(await read(active.change,caller)).toMatchObject({change_set_id:active.change,can_retry:true});
  await close(children[0]!,caller);
  expect((await state(children[0]!)).state).toBe('abandoned');
  expect(await read(children[0]!,caller)).toMatchObject({state:'abandoned',can_retry:false});
  // A delegated origin Run whose body this person may no longer read hides the record from the detail read as from the list.
  const hiddenOrigin=(await db.pool.query<{originating_run_id:string}>('SELECT originating_run_id FROM workspace_change_sets WHERE id=$1',[children[1]])).rows[0]!.originating_run_id;
  await db.pool.query("UPDATE runs SET owner_user_id=$2,instructed_by_user_id=$2,visibility='space_shared',access_level='summary' WHERE id=$1",[hiddenOrigin,MEMBER]);
  await expect(read(children[1]!,caller)).rejects.toMatchObject(notFound);
  expect((await listWorkspaceChanges(db.pool,caller,{scope:'conversation',limit:50})).items.some(i=>i.change_set_id===children[1])).toBe(false);
 });

 it.for([false,true])('withdraws reviewed saved work (missing=%s) only for the exact version and direct user request, retaining unique source evidence',async (missing,ctx)=>{
  if(!db.available)return ctx.skip();
  const session=await newSession(),base='a'.repeat(40),source='b'.repeat(40);
  const saved=await savedBatch(base,source,{session});
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[saved.workspace]);
  if(missing)await db.pool.query(`UPDATE execution_workspaces SET inventory_json='{"branch":false,"worktree":false}',retention_json='{"state":"missing","reason":"branch_missing"}' WHERE id=$1`,[saved.workspace]);
  const turn=await conversationRun('running',session),actor=agent(turn.run.id);
  const quote='检查完后关闭这些过时工作区';
  await db.pool.query("UPDATE runs SET trigger_origin='manual',instruction=$2 WHERE id=$1",[turn.run.id,quote]);
  const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
  const current=(await db.pool.query<{revision:number}>('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0]!.revision;
  const raw={change_set_id:saved.change,expected_revision:current,reason:'Reviewed obsolete iteration',review:{source_commit:source,user_request_quote:quote,findings:'Superseded implementation iteration; preserve source because adoption is not proven.'}};
  const close=(input=raw)=>abandon.execute(db.pool,input,actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  expect((await listWorkspaceChanges(db.pool,actor,{scope:'conversation'})).items.find(i=>i.change_set_id===saved.change)).toMatchObject({closable:false,close_blocker:'review_required'});
  await expect(close({...raw,review:{...raw.review,user_request_quote:'invented authorization'}})).rejects.toThrow();
  await expect(close({...raw,review:{...raw.review,source_commit:'c'.repeat(40)}})).rejects.toThrow();
  await expect(close({...raw,expected_revision:current+1})).rejects.toThrow();
  await db.pool.query("UPDATE runs SET trigger_origin='automation' WHERE id=$1",[turn.run.id]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE runs SET trigger_origin='manual' WHERE id=$1",[turn.run.id]);
  await db.pool.query("UPDATE runs SET status='running' WHERE id=$1",[saved.run.id]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[saved.run.id]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='pending' WHERE run_id=$1",[saved.run.id]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[saved.run.id]);
  await abandon.authorize(db.pool,raw,actor,await abandon.resolve(db.pool,raw,actor));
  expect(await close()).toMatchObject({state:'abandoned',revision:current+1});
  expect(await state(saved.change)).toMatchObject({state:'abandoned',verification_json:{closure_review:{...raw.review,user_id:OWNER,reviewed_by_run_id:turn.run.id,disposition:'withdrawn_retaining_source'}}});
  expect(await assessWorkspaceRetention(db.pool,saved.workspace)).toMatchObject(missing?{state:'missing',reason:'missing_acknowledged'}:{state:'retained',reason:'kept_without_merging'});
  expect((await listWorkspaceChanges(db.pool,actor,{scope:'conversation'})).items.some(i=>i.change_set_id===saved.change)).toBe(false);
  expect(await row(saved.workspace)).toMatchObject({head_commit:source});
  expect((await reclaimProofCommits(db.pool,saved.workspace,1))).not.toContain(source);
  await expect(close()).rejects.toThrow();
 });

 it('explicitly discards an already withdrawn exact saved generation, never reclassifies it as merged',async ctx=>{
  if(!db.available)return ctx.skip();
  const session=await newSession(),base='a'.repeat(40),source='b'.repeat(40);
  const saved=await savedBatch(base,source,{session});
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[saved.workspace]);
  const turn=await conversationRun('running',session),actor=agent(turn.run.id);
  const quote='把审核过时的分支和工作树文件都回收';
  await db.pool.query("UPDATE runs SET trigger_origin='manual',instruction=$2 WHERE id=$1",[turn.run.id,quote]);
  const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
  const revision=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0].revision;
  await abandon.execute(db.pool,{change_set_id:saved.change,expected_revision:revision,reason:'Withdraw obsolete iteration',review:{source_commit:source,user_request_quote:quote,findings:'Superseded work'}},actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  const raw={change_set_id:saved.change,expected_revision:revision+1,reason:'Discard reviewed obsolete source',reclaim:true,review:{source_commit:source,user_request_quote:quote,findings:'Audited obsolete iteration; explicitly discard its saved source'}};
  const close=()=>abandon.execute(db.pool,raw,actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  // Old Host cannot implement the exact discard contract.
  await expect(close()).rejects.toThrow();
  await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','5') WHERE id=$1`,[HOST]);
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='blocked' WHERE run_id=$1",[saved.run.id]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_state='saved' WHERE run_id=$1",[saved.run.id]);
  expect(await close()).toMatchObject({state:'abandoned',revision:revision+2});
  expect(await assessWorkspaceRetention(db.pool,saved.workspace)).toMatchObject({state:'reclaimable',reason:'discarded'});
  expect(await row(saved.workspace)).toMatchObject({state:'retired',retention_json:{discard_intent:{source_commit:source,generation:1,review:raw.review}}});
  expect((await reclaimProofCommits(db.pool,saved.workspace,1))).not.toContain(source);
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[saved.workspace,'c'.repeat(40)]);
  expect(await assessWorkspaceRetention(db.pool,saved.workspace)).toMatchObject({state:'retained',reason:'kept_without_merging'});
 });

 it('runs reviewed discard from admission to the real Host: branch and worktree gone, history expires',async ctx=>{
  if(!db.available)return ctx.skip();
  // Dynamic URLs keep this integration test's daemon runtime outside server's rootDir compilation.
  const daemon=await import(new URL('../../packages/host-daemon/src/executionWorkspace.ts',import.meta.url).href);
  const task=await import(new URL('../../packages/host-daemon/src/taskWorktree.ts',import.meta.url).href);
  const config=await import(new URL('../../packages/host-daemon/src/config.ts',import.meta.url).href);
  const configDir=await realpath(await mkdtemp(join(tmpdir(),'rainver-discard-host-'))),previous=process.env.RAINVER_HOST_CONFIG_DIR;
  process.env.RAINVER_HOST_CONFIG_DIR=configDir;
  try{
   repo=await realpath(repo);
   await config.saveConfig({server_url:'http://127.0.0.1:9',host_id:HOST,trust:'trusted',token:'fixture',workspaces:{[LOCATION]:repo}});
   const base=await commitFile('base.txt','base','base'),session=await newSession();
   const saved=await savedBatch(base,base,{session});
   const ref={id:saved.workspace,generation:1,target_ref:'refs/heads/main',base_commit:base,materialization_epoch:0};
   const check=await task.checkLocationRepository(repo);expect(check.kind).toBe('repository');
   const prepared=await daemon.prepareExecutionWorkspace(check.repo,LOCATION,ref,saved.run.id);
   await writeFile(join(prepared.root,'obsolete.txt'),'obsolete source');
   const command=(extra:Record<string,unknown>)=>({type:'execution_workspace_command',request_id:randomUUID(),operation_id:randomUUID(),workspace:{kind:'location',workspace_location_id:LOCATION,execution_workspace:ref},retain_branch:true,...extra});
   const checkpoint=await daemon.executeWorkspaceCommand(repo,command({action:'checkpoint',run_id:saved.run.id,author:{name:'Agent',email:'agent@example.invalid'},message:'save obsolete'}));
   expect(checkpoint.ok).toBe(true);const source=checkpoint.commit;
   await db.pool.query("UPDATE execution_workspaces SET state='retired',head_commit=$2 WHERE id=$1",[saved.workspace,source]);
   await db.pool.query("UPDATE workspace_change_sets SET source_commit=$2 WHERE id=$1",[saved.change,source]);
   await db.pool.query("UPDATE execution_workspace_runs SET checkpoint_commit=$2 WHERE run_id=$1",[saved.run.id,source]);
   await db.pool.query(`UPDATE hosts SET capabilities_json=jsonb_set(capabilities_json,'{execution_workspaces,reclaim}','5') WHERE id=$1`,[HOST]);
   const turn=await conversationRun('running',session),actor=agent(turn.run.id),quote='丢弃审核过时版本，回收分支和工作树文件';
   await db.pool.query("UPDATE runs SET trigger_origin='manual',instruction=$2 WHERE id=$1",[turn.run.id,quote]);
   const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
   const revision=(await db.pool.query('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0].revision;
   await abandon.execute(db.pool,{change_set_id:saved.change,expected_revision:revision,reason:'discard obsolete source',reclaim:true,review:{source_commit:source,user_request_quote:quote,findings:'Reviewed obsolete implementation, explicitly discard'}},actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
   const hosts=new HostConnectionRegistry();
   hosts.requestTaskBranch=async(_h,_t,payload):Promise<any>=>daemon.executeWorkspaceCommand(repo,{type:'execution_workspace_command',request_id:randomUUID(),...payload});
   const advance=async()=>{
    const resources=(await row(saved.workspace)).cleanup_json;
    for(const [key,value] of Object.entries(resources) as [string,any][]){
     if(value.state==='cleaned'||['run_history','local_preimages'].includes(value.kind))continue;
     await advanceWorkspaceCleanup(db.pool,saved.workspace,key,value.operation_id,OWNER,hosts);
    }
   };
   await advance();await advance();
   const after=await row(saved.workspace);
   expect(after.retention_json).toMatchObject({state:'reclaimed',reason:'discarded',history_until:expect.any(String)});
   expect(existsSync(prepared.root)).toBe(false);
   expect(git('for-each-ref','--format=%(refname)',`refs/heads/rainver/workspace-${saved.workspace}-g1`)).toBe('');
   const history=`refs/rainver/run-history/${saved.workspace}/g1/${source}`;
   expect(git('show',`${history}:obsolete.txt`)).toBe('obsolete source');
   const expiry=after.cleanup_json['run-history-g1'];
   expect(expiry.release_refs).toEqual(expect.arrayContaining([expect.objectContaining({ref:history,due_at:expect.any(String)})]));
   // Make only the isolated fixture's retention due; the existing expiry Job removes it by CAS.
   await db.pool.query(`UPDATE execution_workspaces SET cleanup_json=jsonb_set(cleanup_json,ARRAY['run-history-g1','release_refs'],(SELECT jsonb_agg(x||jsonb_build_object('due_at','2000-01-01T00:00:00Z')) FROM jsonb_array_elements(cleanup_json->'run-history-g1'->'release_refs') x)) WHERE id=$1`,[saved.workspace]);
   await advanceWorkspaceCleanup(db.pool,saved.workspace,'run-history-g1',expiry.operation_id,OWNER,hosts);
   expect(git('for-each-ref','--format=%(refname)',history)).toBe('');
  }finally{
   if(previous===undefined)delete process.env.RAINVER_HOST_CONFIG_DIR;else process.env.RAINVER_HOST_CONFIG_DIR=previous;
   await rm(configDir,{recursive:true,force:true});
  }
 },15000);

 it.for(['room','direct'] as const)('closes reviewed work from the canonical %s message with empty legacy input, never history or attachments',async (kind,ctx)=>{
  if(!db.available)return ctx.skip();
  const session=await newSession(),source='b'.repeat(40);
  if(kind==='direct')await db.pool.query('UPDATE sessions SET room_id=NULL,user_id=$2 WHERE id=$1',[session,OWNER]);
  const saved=await savedBatch('a'.repeat(40),source,{session});
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[saved.workspace]);
  const turn=await conversationRun('running',session),actor=agent(turn.run.id),message=randomUUID();
  const quote='检查后关闭这些过时记录';
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,run_id,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user',$5,$6,1,'/',now())`,[message,SPACE,session,OWNER,quote,turn.run.id]);
  const chat={schema_version:'chat_turn.v1',session_id:session,user_id:OWNER,agent_id:AGENT,project_id:PROJECT,user_message_id:message};
  const setTurn=async(value:unknown,prompt:string|null=null)=>db.pool.query("UPDATE runs SET trigger_origin='manual',prompt=$3,instruction=NULL,model_override_json=$2::jsonb WHERE id=$1",[turn.run.id,JSON.stringify({execution_mode:kind==='room'?'room_conversation.v1':'conversation.v1',chat_turn:value}),prompt]);
  await setTurn(chat);
  const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
  const revision=(await db.pool.query<{revision:number}>('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0]!.revision;
  const raw={change_set_id:saved.change,expected_revision:revision,reason:'Retire reviewed iteration',review:{source_commit:source,user_request_quote:quote,findings:'Obsolete reviewed iteration; retain source.'}};
  const close=()=>abandon.execute(db.pool,raw,actor,Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  for(const extra of [{user_message_id:randomUUID()},{session_id:OTHER_CONVERSATION},{user_id:MEMBER},{agent_id:MEMBER},{project_id:MEMBER},{kind:'handoff'},{schema_version:'invalid'}]){
   await setTurn({...chat,...extra},quote); // A matching assembled prompt is never a fallback.
   await expect(close()).rejects.toThrow();
  }
  await setTurn({...chat,assigned_task:quote});
  await db.pool.query("UPDATE messages SET content='Status only' WHERE id=$1",[message]);
  // A previous message and assigned_task quoting the request are not current authority.
  await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user',$5,0,'/',now())`,[randomUUID(),SPACE,session,OWNER,quote]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE messages SET content=$2,user_id=$3 WHERE id=$1",[message,quote,MEMBER]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE messages SET user_id=$2,role='assistant' WHERE id=$1",[message,OWNER]);
  await expect(close()).rejects.toThrow();
  await db.pool.query("UPDATE messages SET role='user' WHERE id=$1",[message]);
  if(kind==='room'){
   await db.pool.query("UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2",[roomId,OWNER]);
   await expect(close()).rejects.toThrow();
   await db.pool.query("UPDATE room_user_members SET status='active' WHERE room_id=$1 AND user_id=$2",[roomId,OWNER]);
  }else{
   await db.pool.query('UPDATE messages SET run_id=$2 WHERE id=$1',[message,saved.run.id]);
   await expect(close()).rejects.toThrow();
   await db.pool.query('UPDATE messages SET run_id=$2 WHERE id=$1',[message,turn.run.id]);
  }
  await setTurn(chat);
  await db.pool.query(`UPDATE runs SET permission_snapshot_json='{"tool_grants":[{"action_id":"workspace.change.abandon"}]}' WHERE id=$1`,[turn.run.id]);
  const {operationRuntime}=await import('../src/modules/systemActions/operations/runtime.js');
  const {runActor}=await import('../src/modules/systemActions/operations/actor.js');
  const {loadConfig}=await import('../src/config.js');
  const engine=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const currentRun=(await new PgRunRepository(db.pool).getRun(SPACE,turn.run.id))!;
  const result=await engine.execute('workspace.change.abandon',raw,await runActor(db.pool,currentRun),randomUUID(),randomUUID());
  expect(result.http_status,JSON.stringify(result.body)).toBe(200);
  expect(await state(saved.change)).toMatchObject({verification_json:{closure_review:{request_source:{kind:'message',id:message},reviewed_by_run_id:turn.run.id}}});
  expect(await assessWorkspaceRetention(db.pool,saved.workspace)).toMatchObject({state:'retained',reason:'kept_without_merging'});
 });

 it('refuses an Agent closing unadopted saved work but lets it withdraw an empty batch',async ctx=>{
  if(!db.available)return ctx.skip();
  const session=await newSession();
  const saved=await savedBatch('a'.repeat(40),'b'.repeat(40),{session});
  const abandon=workspaceOperationRegistrations(definitions).find(r=>(r.definition as unknown as {id:string}).id==='workspace.change.abandon')!;
  // The next turn of the same conversation works in a fresh generation of the same Location.
  await db.pool.query("UPDATE execution_workspaces SET state='retired' WHERE id=$1",[saved.workspace]);
  const turn=await conversationRun('running',session);
  const current=(await db.pool.query<{revision:number}>('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0]!.revision;
  await expect(abandon.execute(db.pool,{change_set_id:saved.change,expected_revision:current,reason:'superseded'},agent(turn.run.id),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
  expect((await state(saved.change)).state).toBe('open');
  await db.pool.query('UPDATE workspace_change_sets SET source_commit=base_commit WHERE id=$1',[saved.change]);
  const next=(await db.pool.query<{revision:number}>('SELECT revision FROM workspace_change_sets WHERE id=$1',[saved.change])).rows[0]!.revision;
  await abandon.execute(db.pool,{change_set_id:saved.change,expected_revision:next,reason:'empty'},agent(turn.run.id),Object.freeze({requestId:randomUUID(),idempotencyKey:null}));
  expect((await state(saved.change)).state).toBe('abandoned');
 });
});

describe('controlled Git publication and branch alignment',()=>{
 it('freezes Git publication plans without a publication grade, refusing changed plans and child targets',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await savedBatch('a'.repeat(40),'b'.repeat(40));
  const target={id:c.change,workspace_id:c.workspace,execution_host_id:HOST},person=user();
  // Without a request a new integration rebases onto the workspace target.
  expect(await admitPublicationPlan(db.pool,target,undefined,undefined,person)).toEqual({strategy:'rebase',target_ref:null});
  expect(await admitPublicationPlan(db.pool,target,{strategy:'fast_forward',target_branch:'release'},undefined,person)).toEqual({strategy:'fast_forward',target_ref:'refs/heads/release'});
  // Squash only on the person's own request: directly, or quoted from the Agent turn's current message.
  expect(await admitPublicationPlan(db.pool,target,{strategy:'squash'},undefined,person)).toEqual({strategy:'squash',target_ref:null});
  const turn=await conversationRun('running',await newSession()),asked='这次合并用 squash 压成一个提交';
  await db.pool.query("UPDATE runs SET trigger_origin='manual',instruction=$2 WHERE id=$1",[turn.run.id,asked]);
  const refusal=async(admission:Promise<unknown>)=>admission.then(()=>null,(error:{body:(id:string)=>{error:{metadata?:{code?:string}}}})=>error.body('request').error.metadata?.code);
  expect(await refusal(admitPublicationPlan(db.pool,target,{strategy:'squash'},undefined,agent(turn.run.id)))).toBe('workspace_squash_requires_person_request');
  expect(await refusal(admitPublicationPlan(db.pool,target,{strategy:'squash',user_request_quote:'随便 squash 吧'},undefined,agent(turn.run.id)))).toBe('workspace_squash_requires_person_request');
  expect(await admitPublicationPlan(db.pool,target,{strategy:'squash',user_request_quote:'用 squash 压成一个提交'},undefined,agent(turn.run.id))).toEqual({strategy:'squash',target_ref:null});
  const frozen={status:'verifying',detail_json:{publication_plan:{strategy:'fast_forward',target_ref:'refs/heads/release'}}};
  expect(await admitPublicationPlan(db.pool,target,undefined,frozen,person)).toEqual({strategy:'fast_forward',target_ref:'refs/heads/release'});
  await expect(admitPublicationPlan(db.pool,target,{strategy:'merge',target_branch:'release'},frozen,person)).rejects.toThrow();
  await expect(admitPublicationPlan(db.pool,target,{strategy:'squash'},frozen,person)).rejects.toThrow();
  await expect(admitPublicationPlan(db.pool,target,{strategy:'rebase'},frozen,person)).rejects.toThrow();
  // A legacy integration admitted without a plan stays squash.
  expect(await admitPublicationPlan(db.pool,target,undefined,{status:'failed',detail_json:{}},person)).toBeNull();
  // A failed chain the Host never held may switch to rebase, or squash on request, into its frozen
  // target; never to another target or chain, never while in flight or once recorded.
  const refused={status:'failed',detail_json:{error:'native_publication_chain_base_not_target_history',publication_plan:{strategy:'merge',target_ref:'refs/heads/release'}}};
  const rebase=await admitPublicationPlan(db.pool,target,{strategy:'rebase'},refused,agent(turn.run.id));
  expect(rebase).toEqual({strategy:'rebase',target_ref:'refs/heads/release'});
  expect(isPlanSwitch(refused,rebase)).toBe(true);
  await expect(admitPublicationPlan(db.pool,target,{strategy:'squash'},refused,agent(turn.run.id))).rejects.toThrow();
  expect(await admitPublicationPlan(db.pool,target,{strategy:'squash',target_branch:'release'},refused,person)).toEqual({strategy:'squash',target_ref:'refs/heads/release'});
  await expect(admitPublicationPlan(db.pool,target,{strategy:'rebase',target_branch:'other'},refused,person)).rejects.toThrow();
  await expect(admitPublicationPlan(db.pool,target,{strategy:'fast_forward',target_branch:'release'},refused,person)).rejects.toThrow();
  await expect(admitPublicationPlan(db.pool,target,{strategy:'rebase'},{...refused,status:'conflict'},person)).rejects.toThrow();
  await expect(admitPublicationPlan(db.pool,target,{strategy:'rebase'},{...refused,detail_json:{...refused.detail_json,publication:{strategy:'merge',chain_tip:'c'.repeat(40),chain_length:2}}},person)).rejects.toThrow();
  expect(await admitPublicationPlan(db.pool,target,{strategy:'merge'},undefined,person)).toEqual({strategy:'merge',target_ref:null});
  const parent=await savedBatch('a'.repeat(40),'c'.repeat(40));
  await db.pool.query('UPDATE execution_workspaces SET parent_workspace_id=$2 WHERE id=$1',[c.workspace,parent.workspace]);
  await expect(admitPublicationPlan(db.pool,target,{strategy:'merge',target_branch:'release'},undefined,person)).rejects.toThrow();
 });

 it('admits only the person, freezes tips, serializes per branch and records the Host facts',async ctx=>{
  if(!db.available)return ctx.skip();
  const registration=workspaceBranchAlignRegistration(definitions);
  const input={project_id:PROJECT,folder_id:FOLDER,source_branch:'dev',target_branch:'master',mode:'reset' as const,expected_source_commit:'a'.repeat(40),expected_target_commit:'b'.repeat(40),reason:'Align dev after the reviewed master merge'};
  const run=await conversationRun('running',await newSession());
  await expect(registration.execute(db.pool,input,agent(run.run.id),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
  await expect(registration.execute(db.pool,input,user(MEMBER),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
  const receipt=await registration.execute(db.pool,input,user(),Object.freeze({requestId:randomUUID(),idempotencyKey:null})) as {intent_id:string;status:string};
  expect(receipt.status).toBe('pending');
  await expect(registration.execute(db.pool,input,user(),Object.freeze({requestId:randomUUID(),idempotencyKey:null}))).rejects.toThrow();
  const frames:unknown[]=[];
  const hosts=new HostConnectionRegistry();
  Object.defineProperty(hosts,'requestTaskBranch',{configurable:true,writable:true,value:async(_h:string,type:string,frame:unknown)=>{frames.push({type,frame});return {ok:false,error:'host_offline',outcome:null,previous_commit:null,aligned_commit:null,backup_ref:null,worktree_updated:false};}});
  await expect(processBranchAlign(db.pool,{workspaceRoot:'/workspace'},receipt.intent_id,SPACE,hosts)).rejects.toThrow('host_offline');
  Object.defineProperty(hosts,'requestTaskBranch',{value:async(_h:string,type:string,frame:unknown)=>{frames.push({type,frame});return {ok:true,error:null,outcome:'aligned',previous_commit:'a'.repeat(40),aligned_commit:'b'.repeat(40),backup_ref:`refs/rainver/branch-backups/${receipt.intent_id}`,worktree_updated:true};}});
  expect(await processBranchAlign(db.pool,{workspaceRoot:'/workspace'},receipt.intent_id,SPACE,hosts)).toMatchObject({status:'succeeded'});
  expect(frames.at(-1)).toMatchObject({type:'git_branch_align',frame:{operation_id:receipt.intent_id,source_ref:'refs/heads/dev',target_ref:'refs/heads/master',mode:'reset',expected_source_commit:'a'.repeat(40),expected_target_commit:'b'.repeat(40)}});
  const intent=(await db.pool.query('SELECT status,result_json FROM project_folder_io_intents WHERE id=$1',[receipt.intent_id])).rows[0];
  expect(intent).toMatchObject({status:'succeeded',result_json:{aligned_commit:'b'.repeat(40),worktree_updated:true}});
  // Finished: a new alignment of the same branch is admitted again.
  const next=await registration.execute(db.pool,{...input,expected_source_commit:'b'.repeat(40)},user(),Object.freeze({requestId:randomUUID(),idempotencyKey:null})) as {intent_id:string;status:string};
  expect(next.status).toBe('pending');
  // The Location now resolves to another repository than the one the Host journaled: a person decides.
  Object.defineProperty(hosts,'requestTaskBranch',{value:async()=>({ok:false,error:'workspace_branch_align_repository_changed',outcome:null,previous_commit:null,aligned_commit:null,backup_ref:null,worktree_updated:false})});
  expect(await processBranchAlign(db.pool,{workspaceRoot:'/workspace'},next.intent_id,SPACE,hosts)).toMatchObject({status:'needs_attention'});
  expect((await db.pool.query('SELECT error_code FROM project_folder_io_intents WHERE id=$1',[next.intent_id])).rows[0]).toMatchObject({error_code:'workspace_branch_align_repository_changed'});
 });
});
