import {waitForBlockedBy} from './support/lockWait.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedRun,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {contentAccessModule} from '../src/modules/contentAccess/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';

const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,admin:string,member:string,reviewer:string,app:ReturnType<typeof buildModuleServer>;
const as=(userId:string)=>__setAuthIdentityForTests({spaceId:space,userId});
const put=(id:string,payload:object,key:string|null=randomUUID())=>app.inject({method:'PUT',url:`/api/v1/content-access/artifact/${id}`,payload,headers:key?{'idempotency-key':key}:{}});
const post=(id:string,path:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/content-access/artifact/${id}/${path}`,payload,headers:{'idempotency-key':key}});
const policy=(visibility:string,grants:object[]=[],extra:object={})=>({visibility,access_level:'full',project_id:null,grants,...extra});
async function artifact(visibility='private',taintOwner:string|null=null):Promise<string>{
 const id=randomUUID();
 const taint=taintOwner?{context_taint:{schema_version:1,narrowest_visibility:'private',input_owner_user_ids:[taintOwner],non_instructing_owner_user_ids:[taintOwner],personal_memory_grant_ids:[]}}:{};
 await db.pool.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,export_formats_json,visibility,access_level,owner_user_id,metadata_json,created_at,updated_at)
  VALUES($1,$2,'report','Report','[]'::jsonb,$3,'full',$4,$5::jsonb,now(),now())`,[id,space,visibility,owner,JSON.stringify(taint)]);
 return id;
}
const row=async(id:string)=>(await db.pool.query('SELECT visibility,access_level FROM artifacts WHERE id=$1',[id])).rows[0];
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();admin=randomUUID();member=randomUUID();reviewer=randomUUID();
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Team','team',now(),now())",[space]);
 for(const [user,role] of [[owner,'member'],[admin,'admin'],[member,'member'],[reviewer,'member']] as const)await seedSpaceMember(db.pool,{space,user,role});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[contentAccessModule,systemActionsModule]);
 as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('changes who may read once per key, for the owner or a Space manager only, with an identity receipt',async()=>{
 const id=await artifact(),key=randomUUID(),input=policy('selected_users',[{user_id:member,access_level:'summary'}]);
 const first=await put(id,input,key);expect(first.statusCode,first.body).toBe(200);
 expect(first.json().data).toEqual({space_id:space,resource_type:'artifact',resource_id:id});
 const replay=await app.inject({method:'POST',url:'/api/v1/actions/content.access.update',payload:{...input,resource_type:'artifact',resource_id:id},headers:{'idempotency-key':key}});
 expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT grantee_user_id,access_level FROM content_access_grants WHERE resource_id=$1 AND revoked_at IS NULL',[id])).rows).toEqual([{grantee_user_id:member,access_level:'summary'}]);
 expect((await put(id,policy('space_shared'),key)).statusCode).toBe(422);
 expect((await put(id,input,null)).statusCode).toBe(422);
 const outsider=randomUUID();await db.pool.query("INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'X','active',now(),now(),'outsider@test.invalid','system')",[outsider]);
 const bad=await put(id,policy('selected_users',[{user_id:outsider,access_level:'full'}]));expect(bad.statusCode).toBe(422);expect(bad.json().error.message).toBe('All grantees must be active members of this space');
 as(member);
 expect((await put(id,policy('space_shared'))).statusCode).toBe(404);
 as(admin);
 expect((await put(id,policy('space_shared'))).statusCode).toBe(200);
 expect(await row(id)).toEqual({visibility:'space_shared',access_level:'full'});
 // A receipt is released only while its caller may still manage the resource.
 await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,admin]);
 as(owner);await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 expect((await put(id,input,key)).statusCode).toBe(404);
});

it('narrows only after the owner reads its recorded exposure, then consumes that disclosure',async()=>{
 const id=await artifact('space_shared');
 const refused=await put(id,policy('private'));expect(refused.statusCode).toBe(409);
 expect(refused.json().error.metadata).toMatchObject({code:'demotion_disclosure_required'});
 as(admin);
 expect((await post(id,'demotion-disclosures',{target_visibility:'private'})).statusCode).toBe(404);
 as(owner);
 const key=randomUUID();
 const disclosed=await post(id,'demotion-disclosures',{target_visibility:'private'},key);expect(disclosed.statusCode,disclosed.body).toBe(201);
 const receipt=disclosed.json().data;
 expect(receipt).toMatchObject({resource_type:'artifact',resource_id:id,target_visibility:'private'});expect(receipt).not.toHaveProperty('exposure');
 expect((await post(id,'demotion-disclosures',{target_visibility:'private'},key)).json().data).toEqual(receipt);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM content_demotion_disclosures')).rows[0].n).toBe(1);
 const read=await app.inject({method:'GET',url:`/api/v1/content-access/artifact/${id}/demotion-disclosures/${receipt.confirmation_id}`});
 expect(read.statusCode,read.body).toBe(200);expect(read.json()).toMatchObject({confirmation_id:receipt.confirmation_id,consumed:false,exposure:{readers:[],consuming_runs:[],shared_derived_outputs:[]}});
 as(admin);
 expect((await app.inject({method:'GET',url:`/api/v1/content-access/artifact/${id}/demotion-disclosures/${receipt.confirmation_id}`})).statusCode).toBe(404);
 as(owner);
 const narrowed=await put(id,policy('private',[],{demotion_confirmation_id:receipt.confirmation_id}));expect(narrowed.statusCode,narrowed.body).toBe(200);
 expect(await row(id)).toEqual({visibility:'private',access_level:'full'});
 expect((await db.pool.query('SELECT consumed_at IS NOT NULL AS consumed FROM content_demotion_disclosures')).rows).toEqual([{consumed:true}]);
});

it('sends tainted widening to owner review through one canonical egress proposal',async()=>{
 const id=await artifact('private',reviewer);
 const refused=await put(id,policy('space_shared'));expect(refused.statusCode).toBe(409);
 expect(refused.json().error.metadata).toMatchObject({code:'context_taint_approval_required',required_approver_user_ids:[reviewer]});
 const key=randomUUID(),input=policy('space_shared');
 const requested=await post(id,'publication-proposals',input,key);expect(requested.statusCode,requested.body).toBe(201);
 const receipt=requested.json().data;expect(receipt).toMatchObject({space_id:space,required_approver_user_ids:[reviewer]});
 expect((await post(id,'publication-proposals',input,key)).json().data).toEqual(receipt);
 expect((await post(id,'publication-proposals',input)).json().data.proposal_id).toBe(receipt.proposal_id);
 expect((await db.pool.query("SELECT proposal_type,status FROM proposals WHERE id=$1",[receipt.proposal_id])).rows).toEqual([{proposal_type:'egress_review',status:'pending'}]);
 expect((await db.pool.query("SELECT grantee_user_id FROM content_access_grants WHERE resource_type='proposal' AND resource_id=$1",[receipt.proposal_id])).rows).toEqual([{grantee_user_id:reviewer}]);
 expect(await row(id)).toEqual({visibility:'private',access_level:'full'});
 const plain=await artifact();
 expect((await post(plain,'publication-proposals',input)).statusCode).toBe(422);
});

it('holds each grantee membership until commit, so a concurrent exit refuses the grant',async()=>{
 const id=await artifact();
 const exit=await db.pool.connect();
 try{
  await exit.query('BEGIN');const {rows:[{pid}]}=await exit.query<{pid:number}>('SELECT pg_backend_pid() AS pid');
  await exit.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,member]);
  const pending=put(id,policy('selected_users',[{user_id:member,access_level:'full'}]));
  await waitForBlockedBy(db.pool,pid);
  await exit.query('COMMIT');
  const r=await pending;expect(r.statusCode).toBe(422);
 }finally{exit.release();}
 expect((await db.pool.query('SELECT id FROM content_access_grants WHERE resource_id=$1',[id])).rows).toEqual([]);
 expect(await row(id)).toEqual({visibility:'private',access_level:'full'});
});

it('releases a recorded disclosure only as far as each named Run and output is still readable',async()=>{
 const source=await artifact('space_shared'),project=randomUUID(),agent=randomUUID(),version=randomUUID();
 const grant=(type:string,id:string,level:string)=>db.pool.query(`INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,now(),now())`,[randomUUID(),space,type,id,owner,level,member]);
 // A colleague's Run whose recorded context consumed the source, shared with the owner at `level`.
 const consumingRun=async(instruction:string,level:'full'|'summary',existingAgent:boolean)=>{
  const id=randomUUID(),control=randomUUID(),delivery=randomUUID();
  await seedRun(db.pool,{id,space,owner:member,agent,version,existingAgent});
  await db.pool.query("UPDATE runs SET instruction=$2,visibility='selected_users' WHERE id=$1",[id,instruction]);
  await grant('run',id,level);
  await db.pool.query("INSERT INTO execution_control_snapshots(id,space_id,run_id,snapshot_json,created_at) VALUES($1,$2,$3,'{}'::jsonb,now())",[control,space,id]);
  await db.pool.query("INSERT INTO invocation_deliveries(id,space_id,invocation_id,attempt,execution_control_snapshot_id,runtime_key,renderer_version,delivery_metadata_json,created_at) VALUES($1,$2,$3,1,$4,'opencode','test.v1','{}'::jsonb,now())",[delivery,space,id,control]);
  await db.pool.query("INSERT INTO invocation_snapshots(id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5::jsonb,'accepted',now(),now())",[randomUUID(),space,id,delivery,JSON.stringify({source_refs:[{type:'artifact',id:source}]})]);
  return id;
 };
 const output=async(runId:string,title:string,projectId:string|null=null)=>{
  const id=randomUUID();
  await db.pool.query(`INSERT INTO artifacts(id,space_id,run_id,project_id,artifact_type,title,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,'report',$5,'[]'::jsonb,'selected_users','full',$6,now(),now())`,[id,space,runId,projectId,title,member]);
  await grant('artifact',id,'full');
  return id;
 };
 const grantedRun=await consumingRun('GRANTED INSTRUCTION','full',false);
 const summaryRun=await consumingRun('SUMMARY ONLY INSTRUCTION','summary',true);
 const privatized=await output(grantedRun,'PRIVATIZED TITLE');
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'P','active',now(),now())",[project,space,member]);
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,owner]);
 const projected=await output(grantedRun,'PROJECT TITLE',project);
 const get=async(confirmation:string)=>{const r=await app.inject({method:'GET',url:`/api/v1/content-access/artifact/${source}/demotion-disclosures/${confirmation}`});expect(r.statusCode,r.body).toBe(200);return r.json();};
 const disclose=async(target:string)=>{const r=await post(source,'demotion-disclosures',{target_visibility:target});expect(r.statusCode,r.body).toBe(201);return r.json().data.confirmation_id as string;};
 const title=(body:any,id:string)=>[...body.exposure.consuming_runs.map((r:any)=>[r.run_id,r.title]),...body.exposure.shared_derived_outputs.map((o:any)=>[o.id,o.title])].find(([k])=>k===id)?.[1];
 const stored=async(id:string)=>(await db.pool.query('SELECT exposure_snapshot_json::text AS s FROM content_demotion_disclosures WHERE id=$1',[id])).rows[0].s as string;

 const used=await disclose('selected_users');
 const before=await get(used);
 expect(title(before,grantedRun)).toBe('GRANTED INSTRUCTION');
 expect(title(before,privatized)).toBe('PRIVATIZED TITLE');
 expect(title(before,projected)).toBe('PROJECT TITLE');
 // A Run's title is its instruction: a summary reader gets the pointer only.
 expect(title(before,summaryRun)).toBe(`Run ${summaryRun.slice(0,8)}`);
 expect(JSON.stringify(before)).not.toContain('SUMMARY ONLY INSTRUCTION');
 // An unchanged exposure still matches the recorded snapshot, so the demotion commits.
 const demoted=await put(source,policy('selected_users',[{user_id:member,access_level:'full'}],{demotion_confirmation_id:used}));expect(demoted.statusCode,demoted.body).toBe(200);
 const pending=await disclose('private'),expired=await disclose('private');
 const storedBefore=await stored(pending);expect(storedBefore).toContain('GRANTED INSTRUCTION');

 // Access to each named object is withdrawn while the owner still owns the source.
 await db.pool.query("UPDATE content_access_grants SET revoked_at=now() WHERE resource_type='run' AND resource_id=$1",[grantedRun]);
 await db.pool.query("UPDATE artifacts SET visibility='private' WHERE id=$1",[privatized]);
 await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[project,owner]);
 await db.pool.query("UPDATE content_demotion_disclosures SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired]);
 for(const [confirmation,consumed] of [[used,true],[pending,false],[expired,false]] as const){
  const after=await get(confirmation);
  expect(after.consumed).toBe(consumed);
  expect(title(after,grantedRun)).toBe(`Run ${grantedRun.slice(0,8)}`);
  expect(title(after,privatized)).toBe(`Artifact ${privatized.slice(0,8)}`);
  expect(title(after,projected)).toBe(`Artifact ${projected.slice(0,8)}`);
  // The pointers stay disclosed; only the text goes.
  expect(after.exposure.consuming_runs.map((r:any)=>r.link).sort()).toEqual([`/runs/${grantedRun}`,`/runs/${summaryRun}`].sort());
  expect(after.exposure.shared_derived_outputs.map((o:any)=>o.id).sort()).toEqual([privatized,projected].sort());
  for(const secret of ['GRANTED INSTRUCTION','PRIVATIZED TITLE','PROJECT TITLE','SUMMARY ONLY INSTRUCTION'])expect(JSON.stringify(after)).not.toContain(secret);
 }
 // Reads leave the recorded snapshot as it was; the demotion still compares against it.
 expect(await stored(pending)).toBe(storedBefore);
 const changed=await put(source,policy('private',[],{demotion_confirmation_id:pending}));
 expect(changed.statusCode,changed.body).toBe(409);expect(changed.json().error.metadata).toMatchObject({code:'demotion_exposure_changed'});
 const fresh=await disclose('private');
 expect(JSON.stringify(await get(fresh))).not.toContain('GRANTED INSTRUCTION');
 expect((await put(source,policy('private',[],{demotion_confirmation_id:fresh}))).statusCode).toBe(200);
});
