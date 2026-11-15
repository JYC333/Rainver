import {waitForBlockedBy} from './support/lockWait.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {relationsModule} from '../src/modules/relations/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,personal:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();personal=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[relationsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('creates personal records once across retained REST and generic entry and rejects key conflicts',async()=>{
 const key=randomUUID(),input={title:'Ada'};
 const first=await app.inject({method:'POST',url:'/api/v1/relations/people',payload:input,headers:{'idempotency-key':key}});
 expect(first.statusCode,first.body).toBe(201);expect(first.json().data.space_id).toBe(personal);
 const replay=await call('relation.person.create',input,key);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT id FROM space_objects')).rows).toHaveLength(1);
 const conflict=await call('relation.person.create',{title:'Grace'},key);expect(conflict.statusCode).toBe(422);
 expect(first.json().data).not.toHaveProperty('title');
});
it('keeps affiliation acceptance canonical and writes no active edge when proposing',async()=>{
 const p=await call('relation.person.create',{title:'Ada',project_id:project});expect(p.statusCode,p.body).toBe(201);
 const o=await call('relation.organization.create',{title:'Institute',project_id:project});expect(o.statusCode,o.body).toBe(201);
 const result=await call('relation.affiliation.propose',{person_object_id:p.json().data.id,organization_object_id:o.json().data.id});
 expect(result.statusCode,result.body).toBe(202);
 expect((await db.pool.query('SELECT proposal_type FROM proposals WHERE id=$1',[result.json().data.id])).rows).toEqual([{proposal_type:'object_relation_create'}]);
 expect((await db.pool.query('SELECT id FROM object_relations')).rows).toEqual([]);
});
it('replays deletion through the surviving owned root and hides the receipt after membership revocation',async()=>{
 const p=await call('relation.person.create',{title:'Ada',project_id:project});expect(p.statusCode,p.body).toBe(201);
 const identity=await call('relation.identity.create',{object_id:p.json().data.id,id_type:'email',id_value:'ada@test.invalid'});expect(identity.statusCode,identity.body).toBe(201);
 const key=randomUUID(),input={identity_id:identity.json().data.id};
 const removed=await call('relation.identity.delete',input,key);expect(removed.statusCode,removed.body).toBe(200);
 const replay=await call('relation.identity.delete',input,key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(removed.json().data);
 // Revoke current Space authority, including the caller of a cached receipt.
 await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1",[space]);
 expect((await call('relation.identity.delete',input,key)).statusCode).not.toBe(200);
});
it('rolls back domain creation if mandatory operation audit cannot commit',async()=>{
 await db.pool.query("CREATE FUNCTION refuse_relation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE'; END $$");
 await db.pool.query('CREATE TRIGGER refuse_relation_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_relation_audit()');
 try{const r=await call('relation.person.create',{title:'Ada',project_id:project});expect(r.statusCode,r.body).toBe(503);expect((await db.pool.query('SELECT object_id FROM relation_people')).rows).toEqual([]);expect(r.body).not.toContain('PRIVATE');}
 finally{await db.pool.query('DROP TRIGGER refuse_relation_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_relation_audit()');}
});
it('does not turn a readable relation card into write authority or permit unkeyed requests',async()=>{
 const p=await call('relation.person.create',{title:'Ada',project_id:project});expect(p.statusCode,p.body).toBe(201);
 const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member,role:'member'});
 __setAuthIdentityForTests({spaceId:space,userId:member});
 expect((await call('relation.note.create',{object_id:p.json().data.id,body:'change'})).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 const r=await app.inject({method:'POST',url:'/api/v1/relations/people',payload:{title:'Unkeyed'}});expect(r.statusCode).toBe(422);
 expect((await db.pool.query('SELECT id FROM relation_notes')).rows).toEqual([]);
});

it('serializes the same note key across concurrent entries and rechecks Source citations on replay',async()=>{
 const p=await call('relation.person.create',{title:'Ada',project_id:project});expect(p.statusCode,p.body).toBe(201);
 const key=randomUUID(),input={object_id:p.json().data.id,body:'one note'};
 const responses=await Promise.all([call('relation.note.create',input,key),call('relation.note.create',input,key)]);
 expect(responses.every(r=>[201,409].includes(r.statusCode))).toBe(true);
 expect((await db.pool.query('SELECT id FROM relation_notes')).rows).toHaveLength(1);
 const item=randomUUID();
 await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,item_type,title,excerpt,source_uri,canonical_uri,first_seen_at,last_seen_at,content_state,retention_policy,metadata_json,created_at,updated_at)
 VALUES($1,$2,$3,'private','full','external_url','Private','Excerpt','https://example.test/a','https://example.test/a',now(),now(),'metadata_only','metadata_only','{"created_by":"manual_url"}',now(),now())`,[item,space,owner]);
 const sourceKey=randomUUID(),citation={object_id:p.json().data.id,link_type:'source_item',source_item_id:item};
 const created=await call('relation.source_link.create',citation,sourceKey);expect(created.statusCode,created.body).toBe(201);
 const replay=await call('relation.source_link.create',citation,sourceKey);expect(replay.statusCode,replay.body).toBe(201);expect(replay.json().data).toEqual(created.json().data);
 await db.pool.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[item]);
 expect((await call('relation.source_link.create',citation,sourceKey)).statusCode).toBe(404);
 expect((await db.pool.query('SELECT id FROM relation_source_links')).rows).toHaveLength(1);
});
it('rechecks a Source revoked while citation admission waits and commits no stale reference',async()=>{
 const p=await call('relation.person.create',{title:'Ada',project_id:project});expect(p.statusCode,p.body).toBe(201);
 const item=randomUUID();
 await db.pool.query(`INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,item_type,title,source_uri,canonical_uri,first_seen_at,last_seen_at,content_state,retention_policy,metadata_json,created_at,updated_at)
 VALUES($1,$2,$3,'private','full','external_url','Private','https://example.test/race','https://example.test/race',now(),now(),'metadata_only','metadata_only','{"created_by":"manual_url"}',now(),now())`,[item,space,owner]);
 const blocker=await db.pool.connect();
 try{
  await blocker.query('BEGIN');const {rows:[{pid}]}=await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid');await blocker.query('SELECT id FROM source_items WHERE id=$1 FOR UPDATE',[item]);
  const pending=call('relation.source_link.create',{object_id:p.json().data.id,link_type:'source_item',source_item_id:item});
  const response=Promise.resolve(pending);
  await waitForBlockedBy(db.pool,pid);
  await blocker.query('UPDATE source_items SET deleted_at=now() WHERE id=$1',[item]);await blocker.query('COMMIT');
  const result=await response;expect(result.statusCode,result.body).toBe(404);
  expect((await db.pool.query('SELECT id FROM relation_source_links')).rows).toEqual([]);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
});
