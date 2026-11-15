import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {graphModule} from '../src/modules/graph/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename,{max:5});
let space:string,owner:string,viewer:string,app:ReturnType<typeof buildModuleServer>;
const payload={scope_key:'core:graph',state_json:{zoom:2,pinned:['not-an-authority-reference']}};
const write=(body:object=payload,key=randomUUID())=>app.inject({method:'PUT',url:'/api/v1/graph/view-state',payload:body,headers:{'idempotency-key':key}});
const rows=()=>db.pool.query('SELECT * FROM graph_view_states');
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();viewer=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'team'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[graphModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('saves private navigation state; same-key replay never overwrites a subsequent save',async()=>{
 const key=randomUUID(),first=await write(payload,key);expect(first.statusCode,first.body).toBe(200);
 expect(first.json().data).toMatchObject({space_id:space,user_id:owner,...payload});
 expect((await write({...payload,state_json:{zoom:9}})).statusCode).toBe(200);
 expect((await write(payload,key)).json().data).toEqual(first.json().data);
 expect((await rows()).rows[0].state_json).toEqual({zoom:9});
 __setAuthIdentityForTests({spaceId:space,userId:viewer});
 expect((await app.inject('/api/v1/graph/view-state?scope_key=core%3Agraph')).json().state_json).toEqual({});
});
it.each(['membership','account'])('cached success rechecks current %s',async kind=>{
 const key=randomUUID();expect((await write(payload,key)).statusCode).toBe(200);
 if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 else await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
 expect((await write(payload,key)).statusCode).toBe(404);
});
it('rejects missing keys, authority injection, invalid states and changed payloads',async()=>{
 expect((await app.inject({method:'PUT',url:'/api/v1/graph/view-state',payload})).statusCode).toBe(422);
 for(const body of [{...payload,user_id:viewer},{...payload,space_id:space},{...payload,state_json:[]},{...payload,scope_key:' '}])expect((await write(body)).statusCode).toBe(422);
 const key=randomUUID();expect((await write(payload,key)).statusCode).toBe(200);
 expect((await write({...payload,state_json:{}},key)).statusCode).toBe(422);
});
it('late audit failure rolls back the actual upsert and receipt; explicit retry succeeds',async()=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_graph_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_graph_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_graph_audit()');
 try{const r=await write(payload,key);expect(r.statusCode,r.body).toBe(503);expect((await rows()).rows).toEqual([]);expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_graph_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_graph_audit()');}
 expect((await write(payload,key)).statusCode).toBe(200);
});
it('a membership revocation barrier prevents a queued real writer from saving',async()=>{
 const hold=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await hold.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  pending=write();await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');
  const r=await pending;expect(r.statusCode,r.body).toBe(404);expect((await rows()).rows).toEqual([]);
 }finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
