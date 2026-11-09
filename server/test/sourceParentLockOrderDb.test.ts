import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {lockSourceChannelReference} from '../src/modules/sources/sourceMonitorParent.js';
const db=useTestDatabase(import.meta.filename,{max:4});
let space:string,owner:string,project:string,sourceProject:string,connection:string,channel:string,app:ReturnType<typeof buildModuleServer>;
const command=(id:string,payload:object,key:string)=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();sourceProject=randomUUID();connection=randomUUID();channel=randomUUID();
 const {now}=await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Source Project B','active',now(),now())",[sourceProject,space,owner]);
 await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection,channel,space,owner,now});
 await db.pool.query("UPDATE source_connections SET project_id=$2,visibility='space_shared' WHERE id=$1",[connection,sourceProject]);
 await db.pool.query("INSERT INTO source_search_specs(id,space_id,source_channel_id,provider_key,compiled_provider_query_json,query_fingerprint,active_version,activated_at,created_at,updated_at) VALUES($1,$2,$3,'arxiv','{}'::jsonb,'lock-fixture-search',1,now(),now(),now())",[randomUUID(),space,channel]);
 await db.pool.query("INSERT INTO source_channel_user_subscriptions(id,space_id,source_channel_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',now(),now())",[randomUUID(),space,channel,owner]);
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectsModule,sourcesModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it.each([
 ['bind','update','project'],['bind','scan','project'],['bind','update','personal'],['bind','scan','personal'],
 ['backfill','update','project'],['recommendation','update','project'],
] as const)('%s waits for parent before child alongside Monitor %s (%s Source)',async(kind,control,placement)=>{
 if(placement==='personal')await db.pool.query("UPDATE source_connections SET project_id=NULL,visibility='private' WHERE id=$1",[connection]);
 const key=randomUUID(),monitorKey=randomUUID();let binding:string|undefined;
 if(kind==='backfill'){const reply=await command('project.source.bind',{project_id:project,source_channel_id:channel},randomUUID());expect(reply.statusCode,reply.body).toBe(201);binding=reply.json().data.id;}
 const refId=kind==='bind'?'project.source.bind':kind==='backfill'?'source.backfill.create_plan':'source.recommendation.decide';
 const refInput=kind==='bind'?{project_id:project,source_channel_id:channel}:kind==='backfill'?{source_channel_id:channel,project_source_binding_id:binding,idempotency_key:randomUUID(),strategy:{from:'2026-01-01',to:'2026-03-01',max_items:5}}:{source_channel_id:channel,decision:'subscribed'};
 const reference=()=>command(refId,refInput,key);
 const monitor=()=>app.inject({method:control==='scan'?'POST':'PATCH',url:`/api/v1/sources/channels/${channel}${control==='scan'?'/scan':''}`,headers:{'idempotency-key':monitorKey},...(control==='scan'?{}:{payload:{name:'Saved Monitor',source_name:'Saved Source'}})});
 const holder=await db.pool.connect(),probe=await db.pool.connect();let pending:ReturnType<typeof reference>|undefined,other:ReturnType<typeof monitor>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);
  pending=reference();await waitForLockWaiter(db.pool);
  // Real row-lock proof: a reference waiting for the parent must not yet hold
  // any child lock. The old JOIN ch,sc rowmarks fail here with 55P03.
  await probe.query('BEGIN');await probe.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE NOWAIT',[channel]);
  other=monitor();await waitForLockWaiter(db.pool,{waiters:2});await probe.query('COMMIT');await holder.query('COMMIT');
  const [ref,changed]=await Promise.all([pending,other]);expect(ref.statusCode,ref.body).toBe(kind==='recommendation'?200:201);expect(changed.statusCode,changed.body).toBe(control==='scan'?202:200);
  expect((await reference()).json()).toEqual(ref.json());expect((await monitor()).json()).toEqual(changed.json());
  expect((await db.pool.query('SELECT source_connection_id FROM source_channels WHERE id=$1',[channel])).rows[0].source_connection_id).toBe(connection);
  if(kind==='bind')expect(ref.json().data).toMatchObject({project_id:project,source_channel_id:channel});
  if(kind==='backfill')expect((await db.pool.query('SELECT project_source_binding_id FROM source_backfill_plans WHERE id=$1',[ref.json().data.plan_id])).rows[0].project_source_binding_id).toBe(binding);
  if(control==='scan')expect((await db.pool.query('SELECT id FROM extraction_jobs WHERE space_id=$1',[space])).rows).toHaveLength(1);
 }finally{await probe.query('ROLLBACK');await holder.query('ROLLBACK');probe.release();holder.release();await Promise.all([pending,other]);}
});

it('refuses a child reparent while waiting rather than locking the new parent late',async()=>{
 const second=randomUUID();await db.pool.query(`INSERT INTO source_connections(id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at) SELECT $2,space_id,provider_connector_id,owner_user_id,'Other Source','paused',capture_policy,trust_level,consent_json,policy_json,config_json,now(),now() FROM source_connections WHERE id=$1`,[connection,second]);
 const child=await db.pool.connect(),reader=await db.pool.connect();let pending:Promise<string|null>|undefined;
 try{await child.query('BEGIN');await child.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE',[channel]);await reader.query('BEGIN');pending=lockSourceChannelReference(reader,space,channel);await waitForLockWaiter(db.pool);await child.query('UPDATE source_channels SET source_connection_id=$2 WHERE id=$1',[channel,second]);await child.query('COMMIT');expect(await pending).toBeNull();await reader.query('ROLLBACK');}
 finally{await child.query('ROLLBACK');await reader.query('ROLLBACK');child.release();reader.release();await pending;}
});

it('negative control: the old JOIN rowmarks retain a child lock while waiting for the parent',async()=>{
 const parent=await db.pool.connect(),legacy=await db.pool.connect(),probe=await db.pool.connect();let pending:Promise<unknown>|undefined;
 try{await parent.query('BEGIN');await parent.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);await legacy.query('BEGIN');
 pending=legacy.query(`SELECT ch.id FROM source_channels ch JOIN source_connections sc ON sc.id=ch.source_connection_id AND sc.space_id=ch.space_id WHERE ch.id=$1 AND ch.space_id=$2 AND ch.status<>'archived' AND sc.deleted_at IS NULL FOR SHARE OF ch,sc`,[channel,space]);await waitForLockWaiter(db.pool);
 await probe.query('BEGIN');await expect(probe.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE NOWAIT',[channel])).rejects.toMatchObject({code:'55P03'});await probe.query('ROLLBACK');
 await parent.query('COMMIT');await pending;await legacy.query('ROLLBACK');
 }finally{await parent.query('ROLLBACK');await legacy.query('ROLLBACK');await probe.query('ROLLBACK');parent.release();legacy.release();probe.release();await pending;}
});
