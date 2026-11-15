import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedConversationMessages,seedSpaceMember} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {runtimeContextModule} from '../src/modules/runtimeContext/index.js';
import {policyModule} from '../src/modules/policy/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';

const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,member:string,other:string,agent:string,app:ReturnType<typeof buildModuleServer>;
const as=(userId:string)=>__setAuthIdentityForTests({spaceId:space,userId});
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rest=(method:'POST'|'PUT',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const direct=async(userId:string)=>{const id=randomUUID();await db.pool.query(`INSERT INTO sessions(id,space_id,user_id,agent_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[id,space,userId,agent]);return id;};
const policy={constraints:{},preferences:{}};
beforeEach(async()=>{
 await resetTables(db.pool,['context_checkpoint_corrections','context_semantic_checkpoints','context_micro_checkpoints','context_events','context_event_scopes','execution_control_snapshots','runs','messages','work_context_setups','runtime_context_policy_audits','runtime_context_policy_bindings','runtime_context_policy_versions','policy_decision_records','sessions','rooms','projects','agents','spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();member=randomUUID();other=randomUUID();agent=randomUUID();
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'S','team',now(),now())",[space]);
 await seedSpaceMember(db.pool,{space,user:owner,role:'owner'});
 await seedSpaceMember(db.pool,{space,user:member,role:'member'});
 await seedSpaceMember(db.pool,{space,user:other,role:'member'});
 await db.pool.query(`INSERT INTO agents(id,space_id,owner_user_id,name,status,agent_kind,visibility,access_level,created_at,updated_at) VALUES($1,$2,$3,'A','active','standard','space_shared','full',now(),now())`,[agent,space,member]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-rc-ops-${process.pid}`}),[runtimeContextModule,policyModule,systemActionsModule]);
 as(member);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('switches a direct conversation as the next Setup version across both entries, keyed and re-authorized on replay',async()=>{
 const session=await direct(member),key=randomUUID();
 const off=await rest('PUT',`/api/v1/runtime-context/work-contexts/${session}/retrieval`,{enabled:true,preferred_domains:['knowledge']},key);
 expect(off.statusCode,off.body).toBe(200);
 expect(off.json().data).toMatchObject({space_id:space,work_context_scope_id:session,version:1});
 expect(Object.keys(off.json().data).sort()).toEqual(['setup_id','space_id','version','work_context_scope_id']);
 const replay=await call('runtime_context.work_context.retrieval.set',{work_context_scope_id:session,enabled:true,preferred_domains:['knowledge']},key);
 expect(replay.json().data).toEqual(off.json().data);
 expect((await call('runtime_context.work_context.retrieval.set',{work_context_scope_id:session,enabled:false},key)).statusCode).toBe(422);
 expect((await rest('PUT',`/api/v1/runtime-context/work-contexts/${session}/retrieval`,{enabled:'yes'})).statusCode).toBe(422);
 expect((await rest('PUT',`/api/v1/runtime-context/work-contexts/${session}/retrieval`,{enabled:true},null)).statusCode).toBe(422);
 const read=await app.inject({method:'GET',url:`/api/v1/runtime-context/work-contexts/${session}/retrieval`});
 expect(read.json()).toEqual({work_context_scope_id:session,enabled:true,preferred_domains:['knowledge'],setup_version:1});
 // The Setup keeps its own scope-authority decision record next to the core audit.
 expect((await db.pool.query(`SELECT action FROM policy_decision_records WHERE space_id=$1 ORDER BY action`,[space])).rows.map(r=>r.action))
  .toEqual(expect.arrayContaining(['runtime_context.work_context.update','work_context_setup.change']));
 // Someone else's conversation is not theirs; a former member's replay is hidden.
 as(other);expect((await call('runtime_context.work_context.retrieval.set',{work_context_scope_id:session,enabled:false})).statusCode).toBe(404);
 as(member);await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,member]);
 expect((await call('runtime_context.work_context.retrieval.set',{work_context_scope_id:session,enabled:true,preferred_domains:['knowledge']},key)).statusCode).toBe(404);
 expect((await db.pool.query('SELECT count(*)::int AS n FROM work_context_setups WHERE work_context_scope_id=$1',[session])).rows[0].n).toBe(1);
});

it('creates a Setup with a stale-base refusal that is cached, and refuses a checkpoint correction without an active checkpoint',async()=>{
 const session=await direct(member);
 const setup={work_context_scope_id:session,scope_kind:'direct_session',project_id:null,project_folder_id:null,agent_id:agent,runtime_ref:null,pinned_refs:[],excluded_refs:[],retrieval_preferences:{},continuity_preferences:{},base_version:null,reason:'Initial'};
 const created=await rest('POST','/api/v1/runtime-context/work-contexts',setup);expect(created.statusCode,created.body).toBe(201);
 expect(created.json().data).toMatchObject({work_context_scope_id:session,version:1});
 const key=randomUUID(),stale=await call('runtime_context.work_context.create',setup,key);
 expect(stale.statusCode).toBe(409);expect(stale.json().error.message).toBe('Work Context Setup base version is stale');
 expect((await call('runtime_context.work_context.create',setup,key)).json()).toMatchObject({error:{message:'Work Context Setup base version is stale'}});
 expect((await call('runtime_context.work_context.create',{...setup,base_version:1,extra:true})).statusCode).toBe(422);
 const correction={checkpoint_id:randomUUID(),canonical_ref:{type:'message',id:randomUUID()},correction:{note:'x'}};
 const refused=await rest('POST',`/api/v1/runtime-context/work-contexts/${session}/checkpoint-corrections`,correction);
 expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.message).toBe('Semantic checkpoint is not active');
 as(other);expect((await call('runtime_context.checkpoint.correct',{...correction,work_context_scope_id:session})).statusCode).toBe(404);
});

it('corrects the active semantic checkpoint through the operation with the person\'s own canonical Message, refusing stale checkpoints and foreign authority',async()=>{
 const session=await direct(member),run=randomUUID(),mine=randomUUID(),theirs=randomUUID(),checkpoint=randomUUID();
 const setup={work_context_scope_id:session,scope_kind:'direct_session',project_id:null,project_folder_id:null,agent_id:agent,runtime_ref:null,pinned_refs:[],excluded_refs:[],retrieval_preferences:{},continuity_preferences:{},base_version:null,reason:'Initial'};
 expect((await rest('POST','/api/v1/runtime-context/work-contexts',setup)).statusCode).toBe(201);
 // A Run of this conversation whose execution control names the Work Context scope.
 const version=randomUUID();
 await db.pool.query(`INSERT INTO agent_versions(id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at) VALUES($1,$2,$3,'v1','A','{}','{}','[]','{}',now())`,[version,agent,space]);
 await db.pool.query(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,session_id,run_type,trigger_origin,status,mode,required_sandbox_level,instructed_by_user_id,owner_user_id,created_at,updated_at,execution_kind) VALUES($1,$2,$3,$4,$5,'agent','manual','queued','live','none',$6,$6,now(),now(),'agent')`,[run,space,agent,version,session,member]);
 await db.pool.query(`INSERT INTO execution_control_snapshots(id,space_id,run_id,snapshot_json,created_at) VALUES($1,$2,$3,$4::jsonb,now())`,[randomUUID(),space,run,JSON.stringify({work_context_scope_id:session})]);
 await seedConversationMessages(db.pool,{space,session,messages:[{id:mine,role:'user',content:'Correct this',userId:member,metadata:{}},{id:theirs,role:'user',content:'Not mine',userId:owner,metadata:{}}]});
 // No producer writes semantic checkpoints yet; the correction owner reads the active row.
 const seed=(id:string,version:number,status:string)=>db.pool.query(`INSERT INTO context_semantic_checkpoints(id,space_id,work_context_scope_id,version,covered_cursor,status,checkpoint_json,extractor_ref_json,created_at) VALUES($1,$2,$3,$4,0,$5,$6::jsonb,'{"type":"extractor","id":"test"}',now())`,
  [id,space,session,version,status,JSON.stringify({id,space_id:space,work_context_scope_id:session,version,covered_cursor:0,goals:[],user_intent:[],decisions:[],constraints:[],facts:[],open_questions:[],tasks:[],artifact_refs:[],tool_refs:[],correction_refs:[],source_refs:[],extractor_ref:{type:'extractor',id:'test'},created_at:new Date().toISOString()})]);
 await seed(checkpoint,1,'active');
 const url=`/api/v1/runtime-context/work-contexts/${session}/checkpoint-corrections`,key=randomUUID();
 const body={checkpoint_id:checkpoint,canonical_ref:{type:'message',id:mine},correction:{note:'The deadline is Friday'}};
 const corrected=await rest('POST',url,body,key);expect(corrected.statusCode,corrected.body).toBe(201);
 const receipt=corrected.json().data;expect(Object.keys(receipt).sort()).toEqual(['correction_id','space_id','work_context_scope_id']);
 expect(receipt).toMatchObject({space_id:space,work_context_scope_id:session});
 expect((await db.pool.query('SELECT semantic_checkpoint_id,created_by_user_id,correction_json FROM context_checkpoint_corrections WHERE id=$1',[receipt.correction_id])).rows[0]).toEqual({semantic_checkpoint_id:checkpoint,created_by_user_id:member,correction_json:{note:'The deadline is Friday'}});
 expect((await db.pool.query(`SELECT count(*)::int n FROM context_events WHERE work_context_scope_id=$1 AND event_type='checkpoint_corrected' AND canonical_ref_json->>'id'=$2`,[session,receipt.correction_id])).rows[0].n).toBe(1);
 // Keyed replay returns the receipt, a changed body under the key is refused, and nothing is written twice.
 expect((await call('runtime_context.checkpoint.correct',{...body,work_context_scope_id:session},key)).json().data).toEqual(receipt);
 expect((await call('runtime_context.checkpoint.correct',{...body,correction:{note:'Other'},work_context_scope_id:session},key)).statusCode).toBe(422);
 // Only the correcting person's own canonical Message.
 const foreign=await rest('POST',url,{...body,canonical_ref:{type:'message',id:theirs}});expect(foreign.statusCode,foreign.body).toBe(422);
 // A superseded base is stale.
 await db.pool.query(`UPDATE context_semantic_checkpoints SET status='superseded' WHERE id=$1`,[checkpoint]);await seed(randomUUID(),2,'active');
 const stale=await rest('POST',url,body);expect(stale.statusCode).toBe(409);expect(stale.json().error.message).toBe('Semantic checkpoint is not active');
 as(other);expect((await call('runtime_context.checkpoint.correct',{...body,work_context_scope_id:session})).statusCode).toBe(404);
 as(member);await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,member]);
 expect((await call('runtime_context.checkpoint.correct',{...body,work_context_scope_id:session},key)).statusCode).toBe(404);
 expect((await db.pool.query('SELECT count(*)::int n FROM context_checkpoint_corrections WHERE work_context_scope_id=$1',[session])).rows[0].n).toBe(1);
});

it('keeps Runtime Context Policy scope authority, stale bases and replay authority under the operation',async()=>{
 as(member);
 expect((await rest('PUT',`/api/v1/runtime-context/policies/space/${space}`,{base_version_id:null,policy,reason:'r'})).statusCode).toBe(404);
 as(owner);const key=randomUUID();
 const written=await rest('PUT',`/api/v1/runtime-context/policies/space/${space}`,{base_version_id:null,policy,reason:'Initial'},key);
 expect(written.statusCode,written.body).toBe(200);
 const version=written.json().data.version_id;expect(written.json().data).toEqual({space_id:space,scope_type:'space',scope_id:space,version_id:version});
 expect((await call('runtime_context.policy.write',{scope_type:'space',scope_id:space,base_version_id:null,policy,reason:'Initial'},key)).json().data).toEqual(written.json().data);
 const stale=await call('runtime_context.policy.write',{scope_type:'space',scope_id:space,base_version_id:null,policy,reason:'Again'});
 expect(stale.statusCode).toBe(409);expect(stale.json().error.message).toBe('Runtime Context Policy base version is stale');
 expect((await app.inject({method:'GET',url:`/api/v1/runtime-context/policies/space/${space}`})).json()).toMatchObject({id:version,version:1});
 expect((await db.pool.query('SELECT count(*)::int AS n FROM runtime_context_policy_audits WHERE space_id=$1',[space])).rows[0].n).toBe(1);
 // A person's own preferences, never constraints; never someone else's.
 as(member);
 const mine=await call('runtime_context.policy.write',{scope_type:'user',scope_id:member,base_version_id:null,policy,reason:'Mine'});expect(mine.statusCode,mine.body).toBe(200);
 expect((await call('runtime_context.policy.write',{scope_type:'user',scope_id:other,base_version_id:null,policy,reason:'Theirs'})).statusCode).toBe(404);
 // Losing owner standing hides the replay.
 as(owner);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 expect((await call('runtime_context.policy.write',{scope_type:'space',scope_id:space,base_version_id:null,policy,reason:'Initial'},key)).statusCode).toBe(404);
});

it('switches a Room Conversation for its active members only, waiting on the Room before the session',async()=>{
 const project=randomUUID(),room=randomUUID(),session=randomUUID();
 await db.pool.query(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'P','active',now(),now())`,[project,space,member]);
 await db.pool.query(`INSERT INTO rooms(id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'R','active',now(),now())`,[room,space,project,member]);
 await db.pool.query(`INSERT INTO room_user_members(id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'owner','active',now(),now())`,[randomUUID(),space,room,member]);
 await db.pool.query(`INSERT INTO sessions(id,space_id,project_id,room_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',now(),now())`,[session,space,project,room]);
 const key=randomUUID(),url=`/api/v1/runtime-context/room-conversations/${session}/retrieval`;
 const set=await rest('PUT',url,{enabled:true,preferred_domains:['knowledge']},key);expect(set.statusCode,set.body).toBe(200);
 expect(set.json().data).toEqual({space_id:space,session_id:session});
 expect((await app.inject({method:'GET',url})).json()).toMatchObject({enabled:true,preferred_domains:['knowledge']});
 as(other);expect((await call('runtime_context.room_conversation.retrieval.set',{session_id:session,enabled:false})).statusCode).toBe(404);
 as(member);
 // A Room writer holding the Room (as the Agent context reset does) finishes first.
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM rooms WHERE id=$1 FOR UPDATE',[room]);
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const pending=call('runtime_context.room_conversation.retrieval.set',{session_id:session,enabled:false});
  await waitForBlockedBy(db.pool,pid);
  await holder.query("UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2",[room,member]);await holder.query('COMMIT');
  expect((await pending).statusCode).toBe(404);
 }finally{holder.release();}
 expect((await db.pool.query(`SELECT metadata_json->'knowledge_retrieval'->>'enabled' AS enabled FROM sessions WHERE id=$1`,[session])).rows[0].enabled).toBe('true');
 // The removed member's earlier receipt is no longer released.
 expect((await call('runtime_context.room_conversation.retrieval.set',{session_id:session,enabled:true,preferred_domains:['knowledge']},key)).statusCode).toBe(404);
});
