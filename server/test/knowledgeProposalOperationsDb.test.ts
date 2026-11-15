import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {PgKnowledgeRepository} from '../src/modules/knowledge/repository.js';
import {waitForLockWaiter} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,personal:string,app:ReturnType<typeof buildModuleServer>;
const call=(id:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();personal=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Personal','personal',now(),now())",[personal]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),personal,owner]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[knowledgeModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('submits a personal Knowledge proposal once across retained REST/generic replay, with no canonical write',async()=>{
 const key=randomUUID(),body={title:'A concept',content:'PRIVATE selected text'};
 const first=await app.inject({method:'POST',url:'/api/v1/knowledge/items/proposals',payload:body,headers:{'idempotency-key':key}});
 expect(first.statusCode,first.body).toBe(202);expect(first.body).not.toContain(body.content);expect(first.json().data.space_id).toBe(personal);
 expect((await call('knowledge.item.propose_create',body,key)).json()).toEqual(first.json());
 expect((await call('knowledge.item.propose_create',{...body,content:'Other'},key)).statusCode).toBe(422);
 expect((await db.pool.query('SELECT proposal_type,visibility,status,payload_json FROM proposals')).rows).toMatchObject([{proposal_type:'knowledge_create',visibility:'private',status:'pending',payload_json:{content:body.content,visibility:'private'}}]);
 expect((await db.pool.query('SELECT object_id FROM knowledge_items')).rows).toEqual([]);
});
it('submits Claim creation and update/archive intents with body-free receipts and immutable target binding',async()=>{
 const created=await call('knowledge.claim.propose_create',{project_id:project,subject_text:'A person',claim_text:'A fact'});expect(created.statusCode,created.body).toBe(202);
 expect((await db.pool.query('SELECT proposal_type,payload_json FROM proposals WHERE id=$1',[created.json().data.id])).rows).toMatchObject([{proposal_type:'claim_create',payload_json:{claim_text:'A fact',project_id:project}}]);
 const item=randomUUID();await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Current',content:'Current',ownerUserId:owner,createdByUserId:owner,projectId:project});
 const key=randomUUID(),input={item_id:item,title:'Next',content:'New version'};
 const updated=await app.inject({method:'PATCH',url:`/api/v1/knowledge/items/${item}/proposals`,payload:{title:input.title,content:input.content},headers:{'idempotency-key':key}});expect(updated.statusCode,updated.body).toBe(202);
 expect((await call('knowledge.item.propose_update',input,key)).json()).toEqual(updated.json());
 const payload=(await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[updated.json().data.id])).rows[0]!.payload_json;
 expect(payload.target_item_id).toBe(item);expect(payload).not.toHaveProperty('item_id');
 expect((await call('knowledge.item.propose_archive',{item_id:item})).statusCode).toBe(202);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query('UPDATE space_objects SET owner_user_id=$2,created_by_user_id=$2 WHERE id=$1',[item,peer]);
 expect((await call('knowledge.item.propose_update',input,key)).statusCode).toBe(404);
});
it.each(['proposals','operation_idempotency','policy_decision_records'])('rolls back proposal and request if %s fails',async table=>{
 await db.pool.query("CREATE FUNCTION refuse_knowledge_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE failure'; END $$");await db.pool.query(`CREATE TRIGGER refuse_knowledge_proposal BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_knowledge_proposal()`);
 try{const result=await call('knowledge.item.propose_create',{project_id:project,title:'No partial',content:'Body'});expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toEqual([]);}finally{await db.pool.query(`DROP TRIGGER refuse_knowledge_proposal ON ${table}`);await db.pool.query('DROP FUNCTION refuse_knowledge_proposal()');}
});
it('rechecks source visibility after a real row wait and leaves no proposal or success receipt',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});const source=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:owner},{title:'Reference',primary_project_id:project})).id);
 const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE',[source]);pending=call('knowledge.item.propose_create',{title:'Derived',content:'Body',project_id:project,source_refs:[{source_type:'note',source_id:source}]});await waitForLockWaiter(db.pool);await holder.query("UPDATE space_objects SET visibility='private',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[source,peer]);await holder.query('COMMIT');const result=await pending;expect(result.statusCode,result.body).toBe(404);expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);}finally{await holder.query('ROLLBACK');holder.release();await pending;}
});
it('replays the proposer\'s current source authority when the proposal is approved',async()=>{
 const {PgProposalApplyService}=await import('../src/modules/proposals/applyService.js');
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const source=String((await new PgKnowledgeRepository(db.pool).createNote({spaceId:space,userId:owner},{title:'Reference',primary_project_id:project})).id);
 const submit=async(title:string)=>{const r=await call('knowledge.item.propose_create',{title,content:'Body',project_id:project,source_refs:[{source_type:'note',source_id:source}]});expect(r.statusCode,r.body).toBe(202);return String(r.json().data.id);};
 const service=PgProposalApplyService.fromConfig(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
 const allowed=await submit('Allowed');
 expect((await service.accept(allowed,{spaceId:space,userId:owner}))?.proposal).toMatchObject({status:'accepted'});
 const refused=await submit('Refused');
 await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[source,peer]);
 await expect(service.accept(refused,{spaceId:space,userId:owner})).rejects.toThrow();
 expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[refused])).rows).toEqual([{status:'pending'}]);
 expect((await db.pool.query("SELECT so.title FROM knowledge_items k JOIN space_objects so ON so.id=k.object_id ORDER BY so.title")).rows).toEqual([{title:'Allowed'}]);
});
it('refuses a strict active object kind proposal missing a required field, with no proposal or receipt',async()=>{
 await db.pool.query(`INSERT INTO space_object_profiles(id,space_id,key,label,base_object_type,status,field_schema_json,created_at,updated_at) VALUES($1,$2,'decision','Decision','knowledge_item','active',$3::jsonb,now(),now())`,[randomUUID(),space,JSON.stringify({enforcement:'strict',fields:[{key:'risk',type:'string',required:true}]})]);
 const result=await call('knowledge.item.propose_create',{project_id:project,title:'Decision without risk',content:'We chose the narrower path.',knowledge_kind:'decision'});
 expect(result.statusCode,result.body).toBe(422);expect(result.json().error.message).toContain('risk is required');
 expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);expect((await db.pool.query('SELECT state,http_status FROM operation_idempotency')).rows).toEqual([{state:'failed',http_status:422}]);
});
it('returns the writer\'s deterministic refusal for an endpoint-incompatible relation type, with no proposal',async()=>{
 const repo=new PgKnowledgeRepository(db.pool),identity={spaceId:space,userId:owner};
 const from=String((await repo.createNote(identity,{title:'From',primary_project_id:project})).id),to=String((await repo.createNote(identity,{title:'To',primary_project_id:project})).id);
 const result=await call('knowledge.relation.propose_create',{from_object_id:from,to_object_id:to,link_type:'affiliated_with'});
 expect(result.statusCode,result.body).toBe(422);expect(result.json().error.message).toContain('affiliated_with does not accept');
 expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);
});
