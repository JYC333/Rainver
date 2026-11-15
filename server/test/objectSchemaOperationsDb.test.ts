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
import {waitForLockWaiter} from './support/lockWait.js';
// Formal adapters for Space object-kind governance submissions (owner/admin).
const db=useTestDatabase(import.meta.filename,{max:4});
let space:string,owner:string,project:string,app:ReturnType<typeof buildModuleServer>;
const inject=(method:'POST'|'PATCH'|'DELETE',url:string,payload:object={},key=randomUUID())=>app.inject({method,url,payload,headers:{'idempotency-key':key}});
const proposals=async()=>(await db.pool.query('SELECT proposal_type,status,risk_level,payload_json FROM proposals ORDER BY created_at')).rows;
const profile=async(status:string)=>{const id=randomUUID();await db.pool.query(`INSERT INTO space_object_profiles(id,space_id,key,label,base_object_type,status,created_by_user_id,created_at,updated_at) VALUES($1,$2,'decision','Decision','knowledge_item',$3,$4,now(),now())`,[id,space,status,owner]);return id;};
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[knowledgeModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('lets a Space owner submit an object kind proposal once across REST and generic replay, with no profile write',async()=>{
 const key=randomUUID(),body={key:'decision',label:'Decision',base_object_type:'knowledge_item',field_schema:{fields:[{key:'risk',type:'string'}]}};
 const first=await inject('POST','/api/v1/knowledge/object-schema/profiles/proposals',body,key);expect(first.statusCode,first.body).toBe(202);
 expect((await app.inject({method:'POST',url:'/api/v1/actions/knowledge.object_kind.propose_create',payload:body,headers:{'idempotency-key':key}})).json()).toEqual(first.json());
 expect(await proposals()).toMatchObject([{proposal_type:'object_profile_create',status:'pending',risk_level:'high',payload_json:{operation:'object_profile_create',key:'decision'}}]);
 expect((await db.pool.query('SELECT id FROM space_object_profiles')).rows).toEqual([]);
});
it('hides object kind submission from a non-admin member and leaves no proposal',async()=>{
 const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member});__setAuthIdentityForTests({spaceId:space,userId:member});
 const res=await inject('POST','/api/v1/knowledge/object-schema/profiles/proposals',{key:'decision',label:'Decision',base_object_type:'knowledge_item'});
 expect(res.statusCode,res.body).toBe(404);expect(await proposals()).toEqual([]);
});
it('refuses unsafe config and a non-projectable key at the strict contract, with no proposal',async()=>{
 const unsafe=await inject('POST','/api/v1/knowledge/object-schema/profiles/proposals',{key:'concept',label:'Bad kind',base_object_type:'knowledge_item',field_schema:{command_template:'rm -rf .'}});
 expect(unsafe.statusCode,unsafe.body).toBe(422);expect(unsafe.json().error.code).toBe('operation_invalid_input');
 const key=await inject('POST','/api/v1/knowledge/object-schema/profiles/proposals',{key:'vendor_profile',label:'Vendor',base_object_type:'knowledge_item'});
 expect(key.statusCode,key.body).toBe(422);expect(await proposals()).toEqual([]);
});
it('proposes activating a draft kind and refuses changing an archived kind',async()=>{
 const draft=await profile('draft');
 const res=await inject('PATCH',`/api/v1/knowledge/object-schema/profiles/${draft}/proposals`,{status:'active'});expect(res.statusCode,res.body).toBe(202);
 expect(await proposals()).toMatchObject([{proposal_type:'object_profile_update',payload_json:{target_profile_id:draft,status:'active'}}]);
 await db.pool.query("UPDATE space_object_profiles SET status='archived' WHERE id=$1",[draft]);
 for(const [method,url] of [['POST',`/api/v1/knowledge/object-schema/profiles/${draft}/deprecate-proposals`],['DELETE',`/api/v1/knowledge/object-schema/profiles/${draft}`]] as const){
  const refused=await inject(method,url,{});expect(refused.statusCode,refused.body).toBe(422);expect(refused.json().error.message).toContain('archived object kinds cannot be changed');
 }
 expect(await proposals()).toHaveLength(1);
 expect((await inject('DELETE',`/api/v1/knowledge/object-schema/profiles/${randomUUID()}`,{})).statusCode).toBe(404);
});
it('imports a manifest as draft object kind proposals with a body-free receipt',async()=>{
 const res=await inject('POST','/api/v1/knowledge/object-schema/imports/proposals',{manifest:{format:'rainver.object_schema.v1',exported_at:'2026-06-27T00:00:00.000Z',object_schema_version:1,object_profiles:[{key:'decision',label:'Decision',base_object_type:'knowledge_item',status:'active',field_schema:{fields:[{key:'risk',type:'string'}]},relation_hints:[{endpoint_object_type:'source',link_type:'references'}]}]}});
 expect(res.statusCode,res.body).toBe(202);expect(res.json().data).toMatchObject({created_proposal_count:1,skipped_count:0,space_id:space});
 expect(await proposals()).toMatchObject([{proposal_type:'object_profile_create',status:'pending',payload_json:{operation:'object_profile_create',key:'decision',status:'draft'}}]);
});
it('refuses after a concurrent role demotion commits while the submission waits, with no proposal or success receipt',async()=>{
 const admin=randomUUID();await seedSpaceMember(db.pool,{space,user:admin,role:'admin'});__setAuthIdentityForTests({spaceId:space,userId:admin});
 const holder=await db.pool.connect();let pending:ReturnType<typeof inject>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM space_memberships WHERE space_id=$1 AND user_id=$2 FOR UPDATE',[space,admin]);
  pending=inject('POST','/api/v1/knowledge/object-schema/profiles/proposals',{key:'decision',label:'Decision',base_object_type:'knowledge_item'});
  await waitForLockWaiter(db.pool);await holder.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,admin]);await holder.query('COMMIT');
  const res=await pending;expect(res.statusCode,res.body).toBe(404);expect(await proposals()).toEqual([]);
  expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE state='succeeded'")).rows).toEqual([]);
 }finally{await holder.query('ROLLBACK').catch(()=>undefined);holder.release();await pending;}
});
