import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {focusAreasModule} from '../src/modules/focusAreas/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {FocusAreaService} from '../src/modules/focusAreas/service.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename,{max:5});
let space:string,owner:string,viewer:string,project:string,object:string,area:string,app:ReturnType<typeof buildModuleServer>;
const person=()=>({spaceId:space,userId:owner});
const write=(method:'POST'|'PATCH'|'PUT',path:string,payload:object,key=randomUUID())=>app.inject({method,url:`/api/v1/${path}`,payload,headers:{'idempotency-key':key}});
const classify=(key=randomUUID())=>write('PUT',`space-objects/${object}/focus-area`,{focus_area_id:area},key);
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();viewer=randomUUID();project=randomUUID();object=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await seedSpaceMember(db.pool,{space,user:viewer});
 area=(await new FocusAreaService(db.pool).create(person(),{name:'Area'})).id;
 await db.pool.query("INSERT INTO space_objects(id,space_id,object_type,title,owner_user_id,primary_project_id,visibility,access_level,created_at,updated_at) VALUES($1,$2,'note','Private object',$3,$4,'private','full',now(),now())",[object,space,owner,project]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[focusAreasModule,systemActionsModule]);__setAuthIdentityForTests(person());
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('creates and updates owned areas atomically with stable replay; classification does not grant visibility',async()=>{
 const key=randomUUID(),first=await write('POST','focus-areas',{name:'Created'},key);expect(first.statusCode,first.body).toBe(201);
 const id=first.json().data.id;expect((await write('PATCH',`focus-areas/${id}`,{name:'Renamed'})).statusCode).toBe(200);
 expect((await write('POST','focus-areas',{name:'Created'},key)).json().data).toEqual(first.json().data);
 expect((await new FocusAreaService(db.pool).get(person(),id)).name).toBe('Renamed');
 expect((await classify()).statusCode).toBe(200);
 __setAuthIdentityForTests({spaceId:space,userId:viewer});expect((await classify()).statusCode).toBe(404);
 expect((await new FocusAreaService(db.pool).contents({spaceId:space,userId:viewer},area)).objects).toEqual([]);
});
it('same-key classification replay never restores a later cleared classification',async()=>{
 const key=randomUUID(),first=await classify(key);expect(first.statusCode,first.body).toBe(200);
 await new FocusAreaService(db.pool).setObjectFocusArea(person(),object,null);
 expect((await classify(key)).json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT focus_area_id FROM space_objects WHERE id=$1',[object])).rows[0].focus_area_id).toBeNull();
});
it.each(['membership','account','object-owner','area-archive'])('rechecks current %s before cached classification success',async kind=>{
 const key=randomUUID();expect((await classify(key)).statusCode).toBe(200);
 if(kind==='membership')await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 if(kind==='account')await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
 if(kind==='object-owner')await db.pool.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[object,viewer]);
 if(kind==='area-archive')await db.pool.query('UPDATE focus_areas SET archived_at=now() WHERE id=$1',[area]);
 expect((await classify(key)).statusCode).toBe(kind==='area-archive'?409:404);
});
it.each(['create','update','classify'])('late audit failure rolls back %s and receipt',async mode=>{
 const key=randomUUID();
 const request=()=>mode==='create'?write('POST','focus-areas',{name:'Never persisted'},key):mode==='update'?write('PATCH',`focus-areas/${area}`,{name:'Never persisted'},key):classify(key);
 await db.pool.query("CREATE FUNCTION refuse_focus_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_focus_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_focus_audit()');
 try{const r=await request();expect(r.statusCode,r.body).toBe(503);expect((await db.pool.query('SELECT name FROM focus_areas')).rows).toEqual([{name:'Area'}]);expect((await db.pool.query('SELECT focus_area_id FROM space_objects WHERE id=$1',[object])).rows[0].focus_area_id).toBeNull();expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);}
 finally{await db.pool.query('DROP TRIGGER refuse_focus_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_focus_audit()');}
 expect((await request()).statusCode).toBe(mode==='create'?201:200);
});
it('the actual classification writer waits on the object barrier and refuses ownership withdrawal',async()=>{
 const hold=await db.pool.connect();let pending:Promise<void>|undefined;
 try{
  await hold.query('BEGIN');const pid=(await hold.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await hold.query('UPDATE space_objects SET owner_user_id=$2 WHERE id=$1',[object,viewer]);
  pending=new FocusAreaService(db.pool).setObjectFocusArea(person(),object,area);const result=pending.then(()=>null,error=>error);await waitForBlockedBy(db.pool,pid);await hold.query('COMMIT');
  expect(await result).toMatchObject({statusCode:404});expect((await db.pool.query('SELECT focus_area_id FROM space_objects WHERE id=$1',[object])).rows[0].focus_area_id).toBeNull();
 }finally{await hold.query('ROLLBACK');hold.release();await pending?.catch(()=>undefined);}
});
