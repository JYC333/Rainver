import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';

const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,personal:string,connection:string,channel:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
const rest=(method:'POST'|'PATCH'|'DELETE',url:string,payload?:object,key=randomUUID())=>app.inject({method,url,...(payload?{payload}:{}),headers:{'idempotency-key':key}});
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;
const as=(userId:string,spaceId=space)=>__setAuthIdentityForTests({spaceId,userId});
async function refuse<T>(table:string,run:()=>Promise<T>):Promise<T>{
  await db.pool.query("CREATE FUNCTION refuse_source_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE storage'; END $$");
  await db.pool.query(`CREATE TRIGGER refuse_source_object BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_source_object()`);
  try{return await run();}finally{await db.pool.query(`DROP TRIGGER refuse_source_object ON ${table}`);await db.pool.query('DROP FUNCTION refuse_source_object()');}
}
async function seedItem(input:{owner?:string;visibility?:string;project?:string|null}={}){
  const id=randomUUID();
  await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,visibility,access_level,item_type,title,excerpt,source_uri,canonical_uri,first_seen_at,last_seen_at,content_state,retention_policy,metadata_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'full','external_url','PRIVATE TITLE','Excerpt','https://example.test/a','https://example.test/a',now(),now(),'metadata_only','metadata_only','{"created_by":"manual_url"}',now(),now())`,[id,space,input.project??null,input.owner??owner,input.visibility??'private']);
  return id;
}

beforeEach(async()=>{
  await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();personal=randomUUID();connection=randomUUID();channel=randomUUID();
  const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);
  await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
  await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
  await db.pool.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',now(),now())",[randomUUID(),space,channel,owner]);
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[sourcesModule,knowledgeModule,systemActionsModule]);
  as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('saves a context-free URL once into Personal across REST/generic replay, with an identity-only receipt',async()=>{
  const key=randomUUID(),body={url:'https://example.test/paper#frag',title:'PRIVATE TITLE',queue_content:true};
  const first=await rest('POST','/api/v1/sources/items/manual-url',body,key);
  expect(first.statusCode,first.body).toBe(201);expect(first.body).not.toContain('PRIVATE');
  expect(first.json().data.space_id).toBe(personal);
  expect((await call('source.item.save_url',body,key)).json()).toEqual(first.json());
  expect((await call('source.item.save_url',{...body,title:'Other'},key)).statusCode).toBe(422);
  expect(await rows('SELECT space_id,visibility,canonical_uri,content_state FROM source_items')).toEqual([{space_id:personal,visibility:'private',canonical_uri:'https://example.test/paper',content_state:'content_queued'}]);
  expect(await rows("SELECT job_type,status FROM extraction_jobs")).toEqual([{job_type:'manual_url',status:'pending'}]);
  // One admission record per invocation (create, replay, refused key reuse), all placed in Personal.
  expect(await rows("SELECT decision,space_id,metadata_json->>'request_space_id' AS request_space FROM policy_decision_records WHERE action='source.item_create' AND space_id=$1",[personal])).toEqual(Array(3).fill({decision:'allow',space_id:personal,request_space:space}));
});

it('refuses a URL save whose Source retention policy forbids full text, caches the consent refusal and leaves nothing',async()=>{
  const key=randomUUID(),body={url:'https://example.test/x',connection_id:connection,queue_content:true};
  const r=await rest('POST','/api/v1/sources/items/manual-url',body,key);
  expect(r.statusCode,r.body).toBe(409);
  expect(r.json().error).toMatchObject({code:'operation_conflict',domain:'sources',metadata:{code:'source_retention_policy',requested:'full_text'}});
  const replay=await call('source.item.save_url',body,key);expect(replay.statusCode).toBe(409);expect(replay.json().error.metadata).toEqual(r.json().error.metadata);
  expect(await rows('SELECT id FROM source_items')).toEqual([]);expect(await rows('SELECT id FROM extraction_jobs')).toEqual([]);
  const ok=await call('source.item.save_url',{...body,queue_content:false});expect(ok.statusCode,ok.body).toBe(201);expect(ok.json().data.space_id).toBe(space);
});

it('keeps the legal connection + project_id combinations and refuses only the inconsistent ones',async()=>{
  // A connection without a Project may still file into a Project its caller writes.
  const filed=await call('source.item.save_url',{url:'https://example.test/y',connection_id:connection,project_id:project});
  expect(filed.statusCode,filed.body).toBe(201);
  expect(await rows('SELECT project_id,connection_id FROM source_items WHERE id=$1',[filed.json().data.id])).toEqual([{project_id:project,connection_id:connection}]);
  // Without Project write the same request writes nothing.
  const outsider=randomUUID();await seedSpaceMember(db.pool,{space,user:outsider,role:'member'});
  await db.pool.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'subscribed',now(),now())",[randomUUID(),space,channel,outsider]);
  as(outsider);expect((await call('source.item.save_url',{url:'https://example.test/z',connection_id:connection,project_id:project})).statusCode).not.toBe(201);as(owner);
  expect(await rows("SELECT id FROM source_items WHERE canonical_uri='https://example.test/z'")).toEqual([]);
  // A Project connection may restate its own Project, never name another one.
  await db.pool.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[connection,project]);
  const restated=await call('source.item.save_url',{url:'https://example.test/w',connection_id:connection,project_id:project});expect(restated.statusCode,restated.body).toBe(201);
  const other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) SELECT $1,space_id,'Other',status,owner_user_id,now(),now() FROM projects WHERE id=$2",[other,project]);
  const wrong=await call('source.item.save_url',{url:'https://example.test/v',connection_id:connection,project_id:other});
  expect(wrong.statusCode).toBe(422);expect(wrong.json().error.message).toBe('This Source belongs to a different Project');
  // Evidence: a source decides the Project; restating it is accepted, a different one refused.
  const item=await seedItem({project,visibility:'space_shared'});
  const same=await call('source.evidence.create',{source_item_id:item,project_id:project,title:'Same'});expect(same.statusCode,same.body).toBe(201);
  const differ=await call('source.evidence.create',{source_item_id:item,project_id:other,title:'Differ'});
  expect(differ.statusCode).toBe(422);expect(differ.json().error.message).toBe('Evidence sources must use the same Project context');
  expect(await rows("SELECT title,project_id FROM extracted_evidence ORDER BY title")).toEqual([{title:'Same',project_id:project}]);
});

it('keeps saving the URL when the derived retrieval projection fails inside the operation transaction',async()=>{
  const r=await refuse('retrieval_objects',()=>call('source.item.save_url',{url:'https://example.test/indexed',project_id:project}));
  expect(r.statusCode,r.body).toBe(201);expect(r.json().data.space_id).toBe(space);
  expect(await rows('SELECT project_id,visibility FROM source_items')).toEqual([{project_id:project,visibility:'space_shared'}]);
});

it('routes the retained actions URL by product: queue writes one Job intent, triage only the reader state',async()=>{
  const item=await seedItem(),key=randomUUID();
  const queued=await rest('POST',`/api/v1/sources/items/${item}/actions`,{action:'archive_snapshot'},key);
  expect(queued.statusCode,queued.body).toBe(200);expect(queued.body).not.toContain('PRIVATE');
  expect((await call('source.item.queue',{source_item_id:item,action:'archive_snapshot'},key)).json()).toEqual(queued.json());
  expect((await call('source.item.queue',{source_item_id:item,action:'queue_content'},key)).statusCode).toBe(422);
  expect(await rows('SELECT job_type FROM extraction_jobs WHERE source_item_id=$1',[item])).toEqual([{job_type:'snapshot'}]);
  const triaged=await rest('POST',`/api/v1/sources/items/${item}/actions`,{action:'mark_selected'});expect(triaged.statusCode,triaged.body).toBe(200);
  expect(await rows('SELECT library_status FROM source_item_user_states WHERE source_item_id=$1',[item])).toEqual([{library_status:'selected'}]);
  // Admission is recorded per invocation under the deciding product's policy (queue, replay, refused reuse, triage).
  expect((await rows("SELECT action FROM policy_decision_records WHERE resource_id=$1 ORDER BY created_at",[item])).map(r=>r.action)).toEqual(['source.item_create','source.item_create','source.item_create','source.item_update']);
  expect((await rest('POST',`/api/v1/sources/items/${item}/actions`,{action:'delete_everything'})).statusCode).toBe(422);
  expect((await rest('POST',`/api/v1/sources/items/${item}/actions`,{action:'mark_selected',source_item_id:randomUUID()})).statusCode).toBe(422);
});

it('reassigns a saved URL Source and refuses non-manual items with a cached owner refusal',async()=>{
  const item=await seedItem();
  const moved=await rest('PATCH',`/api/v1/sources/items/${item}`,{connection_id:connection});expect(moved.statusCode,moved.body).toBe(200);
  expect(await rows('SELECT connection_id FROM source_items WHERE id=$1',[item])).toEqual([{connection_id:connection}]);
  await db.pool.query("UPDATE source_items SET metadata_json='{}' WHERE id=$1",[item]);
  const key=randomUUID(),refused=await call('source.item.update',{source_item_id:item,connection_id:null},key);
  expect(refused.statusCode,refused.body).toBe(422);expect(refused.json().error.message).toBe('Only manually saved URL items can change source');
  const replayed=await call('source.item.update',{source_item_id:item,connection_id:null},key);
  expect(replayed.statusCode).toBe(422);expect({...replayed.json().error,request_id:null}).toEqual({...refused.json().error,request_id:null});
});

it('hides items without current reach, rechecks reach on replay and never answers a foreign Space',async()=>{
  const item=await seedItem(),key=randomUUID();
  expect((await call('source.item.triage',{source_item_id:item,action:'read_later'},key)).statusCode).toBe(200);
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});as(peer);
  const denied=await call('source.item.triage',{source_item_id:item,action:'read_later'});expect(denied.statusCode).toBe(404);expect(denied.body).not.toContain('PRIVATE');
  as(owner);await db.pool.query('UPDATE source_items SET owner_user_id=$2 WHERE id=$1',[item,peer]);
  expect((await call('source.item.triage',{source_item_id:item,action:'read_later'},key)).statusCode).toBe(404);
  const foreign={space:randomUUID(),owner:randomUUID(),project:randomUUID()};await seedSpaceOwnerProject(db.pool,foreign);as(foreign.owner,foreign.space);
  expect((await call('source.item.queue',{source_item_id:item,action:'queue_content'})).statusCode).toBe(404);
  expect(await rows('SELECT id FROM extraction_jobs')).toEqual([]);
});

it('creates, reviews and links evidence; duplicate links are a cached refusal; replay follows current evidence reach',async()=>{
  const item=await seedItem({visibility:'space_shared'});
  const created=await rest('POST','/api/v1/sources/evidence',{source_item_id:item,title:'Claim',content_excerpt:'PRIVATE excerpt'});
  expect(created.statusCode,created.body).toBe(201);expect(created.body).not.toContain('PRIVATE');
  const evidence=created.json().data.id;
  const reviewed=await rest('PATCH',`/api/v1/sources/evidence/${evidence}`,{status:'rejected',metadata:{reason:'off topic'}});expect(reviewed.statusCode,reviewed.body).toBe(200);
  // Replaced metadata keeps the canonical observation history.
  expect(await rows("SELECT status,metadata_json->>'reason' AS reason,jsonb_array_length(metadata_json->'evidence_observations') AS observations FROM extracted_evidence WHERE id=$1",[evidence])).toEqual([{status:'rejected',reason:'off topic',observations:1}]);
  expect((await call('source.evidence.update',{evidence_id:evidence})).statusCode).toBe(422);
  expect((await call('source.evidence.create',{source_item_id:item,title:'x',status:'active'})).statusCode).toBe(422);
  const key=randomUUID(),link={evidence_id:evidence,target_type:'project',target_id:project,link_type:'supports'};
  const linked=await rest('POST','/api/v1/sources/evidence-links',link,key);expect(linked.statusCode,linked.body).toBe(201);
  expect(linked.json().data).toMatchObject({evidence_id:evidence,space_id:space});
  const duplicate=await call('source.evidence.link',link);expect(duplicate.statusCode,duplicate.body).toBe(409);expect(duplicate.json().error.domain).toBe('sources');
  expect(await rows('SELECT target_type,link_type FROM evidence_links')).toEqual([{target_type:'project',link_type:'supports'}]);
  expect((await call('source.evidence.link',{...link,target_id:randomUUID()})).statusCode).toBe(404);
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query("UPDATE source_items SET visibility='private',owner_user_id=$2 WHERE id=$1",[item,peer]);
  await db.pool.query("UPDATE extracted_evidence SET visibility='private',owner_user_id=$2 WHERE id=$1",[evidence,peer]);
  expect((await call('source.evidence.link',link,key)).statusCode).toBe(404);
});

it.each(['extracted_evidence','operation_idempotency','policy_decision_records'])('rolls evidence, receipt and audit back together when %s fails',async table=>{
  const item=await seedItem();
  const r=await refuse(table,()=>call('source.evidence.create',{source_item_id:item,title:'No partial'}));
  expect(r.statusCode,r.body).toBe(table==='policy_decision_records'?503:500);expect(r.body).not.toContain('PRIVATE');
  expect(await rows('SELECT id FROM extracted_evidence')).toEqual([]);expect(await rows('SELECT id FROM operation_idempotency')).toEqual([]);
});

it('a real granted Agent Run cannot reach any human Source object or Note link command',async()=>{
  const item=await seedItem(),run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
  const commands=[['source.item.save_url',{url:'https://example.test/agent'}],['source.item.update',{source_item_id:item,connection_id:null}],['source.item.queue',{source_item_id:item,action:'queue_content'}],['source.item.triage',{source_item_id:item,action:'mark_selected'}],['source.evidence.create',{source_item_id:item,title:'x'}],['source.evidence.update',{evidence_id:item,status:'archived'}],['source.evidence.link',{evidence_id:item,target_type:'space',target_id:space}],['knowledge.note.link.create',{note_id:item,target_type:'source',target_id:item}],['knowledge.note.link.delete',{note_id:item,link_id:item}],['knowledge.note.jot',{text:'x',project_id:project}]] as const;
  await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[run,owner,JSON.stringify({tool_grants:commands.map(([action_id])=>({action_id}))})]);
  const actor=await runActor(db.pool,(await new PgRunRepository(db.pool).getRun(space,run))!);
  const runtime=await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  for(const [id,input] of commands)expect((await runtime.execute(id,input,actor,randomUUID(),randomUUID())).http_status,id).toBe(404);
  expect(await rows('SELECT id FROM extraction_jobs')).toEqual([]);expect(await rows("SELECT id FROM space_objects WHERE object_type='note'")).toEqual([]);
});

async function seedSourceObject(title='Paper'){
  const id=randomUUID();
  await db.pool.query("INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,created_by_user_id,created_at,updated_at) VALUES($1,$2,'source',$3,'space_shared',$4,$4,now(),now())",[id,space,title,owner]);
  await db.pool.query("INSERT INTO sources(object_id,space_id,status,source_type,uri,metadata_json) VALUES($1,$2,'processed','paper','https://example.test/p','{}'::jsonb)",[id,space]);
  return id;
}

it('links and unlinks a Note across REST/generic replay and records note.link.create admission',async()=>{
  const note=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:owner},{title:'Note',primary_project_id:project})).id),source=await seedSourceObject();
  const key=randomUUID(),body={target_type:'source',target_id:source,link_type:'references'};
  const linked=await rest('POST',`/api/v1/knowledge/notes/${note}/links`,body,key);expect(linked.statusCode,linked.body).toBe(201);
  expect((await call('knowledge.note.link.create',{...body,note_id:note},key)).json()).toEqual(linked.json());
  expect((await call('knowledge.note.link.create',{...body,note_id:note})).json().error).toMatchObject({code:'operation_conflict',message:'This link already exists'});
  expect((await call('knowledge.note.link.create',{...body,link_type:'cites',note_id:note})).statusCode).toBe(422);
  const link=linked.json().data.id;expect(await rows('SELECT id FROM note_links')).toEqual([{id:link}]);
  const removed=await rest('DELETE',`/api/v1/knowledge/notes/${note}/links/${link}`);expect(removed.statusCode,removed.body).toBe(200);
  expect(await rows('SELECT id FROM note_links')).toEqual([]);
  // Link, replay, refused duplicate and unlink; schema-invalid input is refused before admission.
  expect((await rows("SELECT decision FROM policy_decision_records WHERE action='note.link.create' AND resource_id=$1",[note])).length).toBe(4);
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});as(peer);
  expect((await call('knowledge.note.link.create',{...body,note_id:note},key)).statusCode).toBe(404);
});

it('jots a Note and its link atomically, appends on repeat and conflicts on a mismatched Project',async()=>{
  const source=await seedSourceObject('Attention'),body={target_id:source,text:'First thought',project_id:project};
  const first=await rest('POST','/api/v1/knowledge/notes/jot',body);expect(first.statusCode,first.body).toBe(201);
  const note=first.json().data.id;
  const again=await call('knowledge.note.jot',{...body,text:'Second'});expect(again.statusCode,again.body).toBe(201);expect(again.json().data.id).toBe(note);
  expect(await rows("SELECT from_object_id,to_object_id FROM note_links")).toEqual([{from_object_id:note,to_object_id:source}]);
  const other=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,name,status,owner_user_id,created_at,updated_at) VALUES($1,$2,'Other','active',$3,now(),now())",[other,space,owner]);
  expect((await call('knowledge.note.jot',{...body,note_id:note,project_id:other})).statusCode).toBe(409);
  expect((await call('knowledge.note.jot',{text:'No anchor'})).statusCode).toBe(422);
  const hidden=await call('knowledge.note.jot',{...body,target_id:randomUUID()});expect(hidden.statusCode).toBe(404);
  const fresh=await seedSourceObject('Fresh');
  const failed=await refuse('note_links',()=>call('knowledge.note.jot',{...body,target_id:fresh}));expect(failed.statusCode,failed.body).toBe(500);expect(failed.body).not.toContain('PRIVATE');
  expect(await rows("SELECT id FROM space_objects WHERE object_type='note' AND title='Note on Fresh'")).toEqual([]);
});

it('rechecks Project writer after waiting on the granting membership and leaves the Note unlinked',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
  const note=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:owner},{title:'Shared',visibility:'space_shared',primary_project_id:project})).id),source=await seedSourceObject();
  const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined;
  try{
    await holder.query('BEGIN');await holder.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 FOR UPDATE',[project,peer]);
    as(peer);pending=call('knowledge.note.link.create',{note_id:note,target_type:'source',target_id:source});await waitForLockWaiter(db.pool);
    await holder.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,peer]);await holder.query('COMMIT');
    const result=await pending;expect(result.statusCode,result.body).toBe(404);expect(await rows('SELECT id FROM note_links')).toEqual([]);
  }finally{await holder.query('ROLLBACK');holder.release();await pending;}
});

it('purges expired trash once per key: replay returns its count and never deletes another batch',async()=>{
  const repository=new PgKnowledgeRepository(db.pool),identity={spaceId:space,userId:owner};
  const expire=async(title:string)=>{const note=await repository.createNote(identity,{title}) as {id:string};await repository.deleteNote(identity,note.id);await db.pool.query("UPDATE space_objects SET deleted_at=now()-interval '31 days' WHERE id=$1",[note.id]);return note.id;};
  const recent=await repository.createNote(identity,{title:'Deleted today'}) as {id:string};await repository.deleteNote(identity,recent.id);
  await expire('Old one');
  const key=randomUUID(),first=await rest('POST','/api/v1/knowledge/notes/deleted/purge',{},key);
  expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toEqual({id:space,space_id:space,deleted:1,retention_days:30,project_ids:[]});
  const later=await expire('Old two');
  expect((await rest('POST','/api/v1/knowledge/notes/deleted/purge',{},key)).json()).toEqual(first.json());
  expect(await rows("SELECT id FROM space_objects WHERE object_type='note' ORDER BY id")).toEqual([{id:recent.id},{id:later}].sort((a,b)=>a.id<b.id?-1:1));
  expect((await rest('POST','/api/v1/knowledge/notes/deleted/purge',{})).json().data.deleted).toBe(1);
  expect((await app.inject({method:'POST',url:'/api/v1/knowledge/notes/deleted/purge'})).statusCode).toBe(422);
  // Another member's request never reaches a private Note it cannot write.
  const other=await expire('Private');await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[other]);const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member,role:'member'});as(member);
  expect((await rest('POST','/api/v1/knowledge/notes/deleted/purge',{})).json().data.deleted).toBe(0);
  expect(await rows('SELECT id FROM space_objects WHERE id=$1',[other])).toHaveLength(1);
});
