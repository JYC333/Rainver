import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {learningModule} from '../src/modules/learning/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {LearningService} from '../src/modules/learning/service.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename,{max:5});
let space:string,owner:string,viewer:string,project:string,knowledge:string,item:string,app:ReturnType<typeof buildModuleServer>;
const person=()=>({spaceId:space,userId:owner});
const objectiveBody=()=>({project_id:project,title:'Learn the invariant'});
const itemBody=()=>({project_id:project,knowledge_item_id:knowledge,prompt:'What survives?',answer:'The invariant'});
const write=(path:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/learning/${path}`,payload,headers:{'idempotency-key':key}});
const request=(kind:string,key=randomUUID())=>kind==='objective'?write('objectives',objectiveBody(),key):kind==='item'?write('items',itemBody(),key):write(`items/${item}/review`,{outcome:'correct'},key);
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();viewer=randomUUID();project=randomUUID();knowledge=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});await seedSpaceMember(db.pool,{space,user:viewer});
 await insertKnowledgeItem(db.pool,{id:knowledge,spaceId:space,title:'Invariant',content:'Stable',projectId:project,ownerUserId:owner});
 item=String((await new LearningService(db.pool).createItem(person(),itemBody())).id);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[learningModule,systemActionsModule]);__setAuthIdentityForTests(person());
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it.each(['objective','item','review'])('executes %s with stable same-key replay and canonical state',async kind=>{
 const key=randomUUID(),first=await request(kind,key);expect(first.statusCode,first.body).toBe(kind==='review'?200:201);
 expect((await request(kind,key)).json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT * FROM learning_objectives')).rows).toHaveLength(kind==='objective'?1:0);
 expect((await db.pool.query('SELECT * FROM learning_items')).rows).toHaveLength(kind==='item'?2:1);
 if(kind==='review')expect((await db.pool.query('SELECT correct_streak,user_id FROM learning_item_mastery')).rows).toEqual([{correct_streak:1,user_id:owner}]);
 __setAuthIdentityForTests({spaceId:space,userId:viewer});expect((await request(kind)).statusCode).toBe(404);
});
it.each(['objective','item','review'])('replay of %s rechecks current account',async kind=>{
 const key=randomUUID();expect((await request(kind,key)).statusCode).toBe(kind==='review'?200:201);
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);expect((await request(kind,key)).statusCode).toBe(404);
});
it('item replay rechecks the current Knowledge read gate',async()=>{
 const key=randomUUID();expect((await request('item',key)).statusCode).toBe(201);
 await db.pool.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[knowledge,viewer]);
 expect((await request('item',key)).statusCode).toBe(404);
});
it.each(['objective','item','review'])('late audit failure rolls back %s and receipt, leaving explicit retry available',async kind=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_learning_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_learning_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_learning_audit()');
 try{const r=await request(kind,key);expect(r.statusCode,r.body).toBe(503);expect((await db.pool.query('SELECT * FROM learning_objectives')).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM learning_items')).rows).toHaveLength(1);expect((await db.pool.query('SELECT * FROM learning_item_mastery')).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_learning_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_learning_audit()');}
 expect((await request(kind,key)).statusCode).toBe(kind==='review'?200:201);
});
it('a real Knowledge writer barrier prevents creating an item after read withdrawal',async()=>{
 const hold=await db.pool.connect();let pending:Promise<Record<string,unknown>>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await hold.query("UPDATE space_objects SET visibility='private',owner_user_id=$2 WHERE id=$1",[knowledge,viewer]);
  pending=new LearningService(db.pool).createItem(person(),itemBody());const result=pending.then(()=>null,error=>error);
  await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');expect(await result).toMatchObject({statusCode:404});expect((await db.pool.query('SELECT * FROM learning_items')).rows).toHaveLength(1);
 }finally{await hold.query('ROLLBACK');hold.release();await pending?.catch(()=>undefined);}
});
