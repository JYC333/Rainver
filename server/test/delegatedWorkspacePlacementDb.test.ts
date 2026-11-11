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
let roomId='',groupId='';

async function capabilities(value:Record<string,unknown>){await db.pool.query('UPDATE hosts SET capabilities_json=$2::jsonb WHERE id=$1',[HOST,JSON.stringify(value)]);}
beforeEach(async()=>{
 if(!db.available)return;
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
 await db.pool.query("UPDATE runs SET parent_run_id=$2,root_run_id=$2,run_group_id=$3,delegation_id=$4 WHERE id=$1",[id,parent,groupId,delegation]);
 return id;
}

describe('delegated workspace placement',()=>{
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
  // A retry of the same child keeps its frozen binding.
  expect(await ensurePrimaryExecutionWorkspace(db.pool,await load(first),HOST,LOCATION)).toMatchObject({workspace:{id:c.workspace},sharedWithCoordinator:true});
  // While it is unfinished, the next delegated writer is not serial: it forks.
  const second=await child(c.parent);
  const forked=await ensurePrimaryExecutionWorkspace(db.pool,await load(second),HOST,LOCATION);
  expect(forked.workspace).toMatchObject({owner_kind:'delegation',parent_workspace_id:c.workspace});
  expect(forked.sharedWithCoordinator).toBeUndefined();
 });

 it('gives parallel writers independent forks and never places a child in another conversation',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  const a=await child(c.parent),b=await child(c.parent);
  for(const id of [a,b]){
   const bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(id),HOST,LOCATION);
   expect(bound.workspace).toMatchObject({owner_kind:'delegation',parent_workspace_id:c.workspace});
  }
  // A workspace that moved since the coordinator saved, or has another unsettled writer, is not reused either.
  const c2=await coordinator();
  await db.pool.query("UPDATE execution_workspaces SET head_commit=$2 WHERE id=$1",[c2.workspace,'c'.repeat(40)]);
  const moved=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c2.parent)),HOST,LOCATION);
  expect(moved.workspace.owner_kind).toBe('delegation');
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
  // A reviewer beside an unfinished writing sibling reads an independent fork of the checkpoint.
  const c3=await coordinator();
  await child(c3.parent,'write');
  const beside=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c3.parent,'read')),HOST,LOCATION);
  expect(beside.workspace.owner_kind).toBe('delegation');
 });
});

describe('delegated placement around unfinished integration',()=>{
 it('forks instead of joining a batch the coordinator left prepared or conflicted',async ctx=>{
  if(!db.available)return ctx.skip();
  const c=await coordinator();
  for(const status of ['prepared','conflict','target_moved','pending']){
   await db.pool.query("UPDATE workspace_change_sets SET verification_json=jsonb_build_object('native_progress',jsonb_build_object('status',$2::text,'action','prepare')) WHERE id=$1",[c.changeSet,status]);
   const bound=await ensurePrimaryExecutionWorkspace(db.pool,await load(await child(c.parent)),HOST,LOCATION);
   expect(bound.workspace.owner_kind).toBe('delegation');
   await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[(await db.pool.query<{run_id:string}>("SELECT run_id FROM execution_workspace_runs WHERE workspace_id=$1",[bound.workspace.id])).rows[0]!.run_id]);
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
