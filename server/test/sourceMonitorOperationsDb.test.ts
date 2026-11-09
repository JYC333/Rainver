import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {SourceGoalBudgetSchema,SourceGoalPlanSchema} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedCustomSourceWorld} from './support/customSourceWorld.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {SourceRecipeCreateService} from '../src/modules/sources/sourceRecipes/recipeCreateService.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,channel:string,connection:string,app:ReturnType<typeof buildModuleServer>;
const update=(changes:object,key=randomUUID())=>app.inject({method:'PATCH',url:`/api/v1/sources/channels/${channel}`,payload:changes,headers:{'idempotency-key':key}});
const scan=(key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/sources/channels/${channel}/scan`,headers:{'idempotency-key':key}});
const generic=(id:string,input:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
const snapshot=async()=>({channel:(await db.pool.query('SELECT id,name,status,fetch_frequency,schedule_rule_json,query_json,endpoint_url,updated_at FROM source_channels WHERE space_id=$1 ORDER BY id',[space])).rows,connection:(await db.pool.query('SELECT id,name,status,updated_at FROM source_connections WHERE space_id=$1 ORDER BY id',[space])).rows,scheduler:(await db.pool.query('SELECT * FROM scheduler_tasks WHERE space_id=$1 ORDER BY id',[space])).rows,jobs:(await db.pool.query('SELECT * FROM extraction_jobs WHERE space_id=$1 ORDER BY id',[space])).rows});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_provider_connectors','source_providers','source_connectors'],{cascade:true});space=randomUUID();owner=randomUUID();await seedCustomSourceWorld(db.pool,{spaceId:space,userId:owner});const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
 const made=await new SourceRecipeCreateService(db.pool,config).createSource({spaceId:space,userId:owner},{name:'Feed',endpoint_url:'https://fixture.test/rss',source_type:'rss'});channel=made.connection.source_channel_id;connection=made.connection.id;
 app=buildModuleServer(config,[sourcesModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('saves Monitor/Source labels and scheduling atomically, and replays through either entry without rescheduling',async()=>{
 const key=randomUUID(),changes={name:'Morning',source_name:'Renamed feed',status:'active',fetch_frequency:'daily',schedule_rule:{frequency:'daily',hour:9,minute:30}};
 const result=await update(changes,key);expect(result.statusCode,result.body).toBe(200);expect(result.json().data).toMatchObject({id:channel,name:'Morning',source_name:'Renamed feed',status:'active',schedule_rule:changes.schedule_rule});const saved=await snapshot();expect(saved.scheduler[0]?.status).toBe('active');expect(saved.scheduler[0]?.next_run_at).not.toBeNull();
 expect((await generic('source.channel.update',{source_channel_id:channel,changes},key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(saved);expect((await update({...changes,name:'Other'},key)).json().error.code).toBe('idempotency_key_reused');
 expect((await update({status:'paused'})).statusCode).toBe(200);const paused=await snapshot();expect(paused.scheduler[0]?.next_run_at).toBeNull();expect(paused.channel[0]?.schedule_rule_json).toEqual(changes.schedule_rule);
 expect((await update({fetch_frequency:'manual'})).statusCode).toBe(200);expect((await snapshot()).channel[0]?.schedule_rule_json).toBeNull();
});
it('preserves the canonical archived Monitor behavior and scheduler pause',async()=>{
 const result=await update({status:'archived'});expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe('archived');expect((await snapshot()).scheduler[0]?.next_run_at).toBeNull();
});
it('returns a 202 durable enqueue receipt and never repeats external scan work for a replayed key',async()=>{
 const key=randomUUID(),result=await scan(key);expect(result.statusCode,result.body).toBe(202);expect(result.json()).toMatchObject({status:'succeeded',data:{connection_id:connection,job_type:'connection_scan',status:'pending',metadata_json:{source_channel_id:channel,created_by:'manual_scan'}}});
 const saved=await snapshot();expect(saved.jobs).toHaveLength(1);expect(saved.jobs[0]?.started_at).toBeNull();expect((await generic('source.channel.scan',{source_channel_id:channel},key)).json()).toEqual(result.json());expect(await snapshot()).toEqual(saved);
 await db.pool.query("UPDATE extraction_jobs SET status='succeeded',completed_at=now() WHERE id=$1",[result.json().data.id]);expect((await scan(key)).json()).toEqual(result.json());expect((await snapshot()).jobs).toHaveLength(1);
 expect((await scan()).statusCode).toBe(202);expect((await snapshot()).jobs).toHaveLength(2);
});
it('withholds replay receipts after current creator or Space membership is revoked',async()=>{
 const key=randomUUID();expect((await scan(key)).statusCode).toBe(202);const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other,role:'admin'});__setAuthIdentityForTests({spaceId:space,userId:other});expect((await update({name:'Admin override'})).statusCode).toBe(404);expect((await scan(key)).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});await db.pool.query('UPDATE source_channels SET created_by_user_id=$2 WHERE id=$1',[channel,other]);expect((await scan(key)).statusCode).toBe(404);await db.pool.query('UPDATE source_channels SET created_by_user_id=$2 WHERE id=$1',[channel,owner]);await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);expect((await scan(key)).statusCode).toBe(404);
});
it('hides a different Space channel exactly as an unknown target',async()=>{
 const other=randomUUID();await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Other','team',$2,now(),now())",[other,owner]);await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),other,owner]);__setAuthIdentityForTests({spaceId:other,userId:owner});const result=await scan();expect(result.statusCode).toBe(404);expect((await generic('source.channel.scan',{source_channel_id:randomUUID()})).json().error.code).toBe(result.json().error.code);expect((await snapshot()).jobs).toEqual([]);
});
it('rejects hidden authority/unknown changes, empty saves, mismatched path ids and missing keys',async()=>{
 for(const changes of [{},{space_id:space},{created_by_user_id:owner},{source_channel_id:channel},{capture_policy:'archive_original'}])expect((await update(changes)).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:`/api/v1/sources/channels/${channel}/scan`,payload:{source_channel_id:channel},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
 expect((await app.inject({method:'POST',url:`/api/v1/sources/channels/${channel}/scan`})).statusCode).toBe(422);
});
it('preserves versioned search-query refusal while allowing a label-only change',async()=>{
 const now=new Date().toISOString(),target=randomUUID(),conn=randomUUID();await seedArxivSourceChain(db.pool,{connector:randomUUID(),connection:conn,channel:target,space,owner,now});
 await db.pool.query("INSERT INTO source_search_specs(id,space_id,source_channel_id,provider_key,compiled_provider_query_json,query_fingerprint,active_version,activated_at,created_at,updated_at) VALUES($1,$2,$3,'arxiv','{}'::jsonb,'search-v1',1,$4,$4,$4)",[randomUUID(),space,target,now]);channel=target;
 const before=await snapshot(),key=randomUUID();const refused=await update({query:{search:'new query'}},key);expect(refused.statusCode,refused.body).toBe(409);expect(refused.json().error.code).toBe('operation_conflict');expect(await snapshot()).toEqual(before);expect((await update({query:{search:'new query'}},key)).json().error.code).toBe('operation_conflict');expect((await update({name:'Label only'})).statusCode).toBe(200);
});
it('retains Goal scheduling authority rather than overwriting it from a Monitor control',async()=>{
 const goal=randomUUID(),version=randomUUID(),spec={source_connection_id:connection,source_channel_id:channel,reason:'Follow feed',supports_history:false,implementation:{kind:'connector'}};
 const plan=SourceGoalPlanSchema.parse({title:'Feed',summary:'Follow this feed',sources:[spec],limitations:[]});
 await db.pool.query("INSERT INTO source_goals(id,space_id,owner_user_id,intent_json,budget_json,status,current_version_id,active_version_id) VALUES($1,$2,$3,$4,$5,'active',$6,$6)",[goal,space,owner,{intent:'Follow feed',includes:[],excludes:[]},SourceGoalBudgetSchema.parse({}),version]);
 await db.pool.query('INSERT INTO source_goal_versions(id,space_id,goal_id,revision,plan_json,created_by_user_id) VALUES($1,$2,$3,1,$4,$5)',[version,space,goal,plan,owner]);
 await db.pool.query('INSERT INTO source_goal_bindings(id,space_id,goal_id,source_connection_id,spec_json) VALUES($1,$2,$3,$4,$5)',[randomUUID(),space,goal,connection,spec]);
 const before=await snapshot();expect((await update({status:'paused'})).statusCode).toBe(409);expect((await scan()).statusCode).toBe(409);expect(await snapshot()).toEqual(before);
});
it('serializes same-key enqueue admission before the channel lock and creates only one Job',async()=>{
 const hold=await db.pool.connect(),key=randomUUID();let pending:ReturnType<typeof scan>|undefined;
 try{await hold.query('BEGIN');await hold.query('SELECT id FROM source_channels WHERE id=$1 FOR UPDATE',[channel]);pending=scan(key);await waitForLockWaiter(db.pool);const duplicate=await scan(key);expect(duplicate.statusCode).toBe(409);expect(duplicate.json().error.code).toBe('idempotency_in_progress');await hold.query('COMMIT');expect((await pending).statusCode).toBe(202);expect((await snapshot()).jobs).toHaveLength(1);}
 finally{await hold.query('ROLLBACK');hold.release();await pending;}
});
it.each(['scheduler_tasks','source_connections','operation_idempotency','policy_decision_records'])('rolls back Monitor and parent Source edits when %s fails',async table=>{
 const before=await snapshot();await db.pool.query("CREATE FUNCTION refuse_monitor_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'monitor storage refused'; END $$");await db.pool.query(`CREATE TRIGGER refuse_monitor_update BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_monitor_update()`);
 try{const response=await update({name:'Changed',source_name:'Changed Source',status:'active'});expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);expect(await snapshot()).toEqual(before);}
 finally{await db.pool.query(`DROP TRIGGER refuse_monitor_update ON ${table}`);await db.pool.query('DROP FUNCTION refuse_monitor_update()');}
});
it.each(['extraction_jobs','operation_idempotency','policy_decision_records'])('withholds enqueue success if %s persistence fails',async table=>{
 const before=await snapshot();await db.pool.query("CREATE FUNCTION refuse_monitor_scan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'scan storage refused'; END $$");await db.pool.query(`CREATE TRIGGER refuse_monitor_scan BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_monitor_scan()`);
 try{const response=await scan();expect(response.statusCode,response.body).toBe(table==='policy_decision_records'?503:500);expect(await snapshot()).toEqual(before);}
 finally{await db.pool.query(`DROP TRIGGER refuse_monitor_scan ON ${table}`);await db.pool.query('DROP FUNCTION refuse_monitor_scan()');}
});
it('classifies invalid schedules without partial updates or reflecting internal errors',async()=>{
 const before=await snapshot(),key=randomUUID(),body={fetch_frequency:'daily',schedule_rule:{frequency:'daily',hour:99,minute:0}};
 const result=await update(body,key);expect(result.statusCode,result.body).toBe(422);expect(result.json().error.domain).toBe('sources');expect(await snapshot()).toEqual(before);expect((await update(body,key)).json().error.code).toBe('operation_invalid_input');
});

it('rolls back a conflicting parent Source rename and caches only its safe conflict receipt',async()=>{
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});await new SourceRecipeCreateService(db.pool,config).createSource({spaceId:space,userId:owner},{name:'Other feed',endpoint_url:'https://fixture.test/other',source_type:'rss'});
  const before=await snapshot(),key=randomUUID();const response=await update({name:'Changed label',source_name:'Other feed'},key);expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('operation_conflict');expect(await snapshot()).toEqual(before);expect((await update({name:'Changed label',source_name:'Other feed'},key)).json().error.domain).toBe('sources');
});

it('hides deleted parents for new Monitor controls and original-key receipts, without enqueue or edits',async()=>{
 const key=randomUUID(),scanKey=randomUUID();expect((await update({name:'Saved'},key)).statusCode).toBe(200);expect((await scan(scanKey)).statusCode).toBe(202);
 await db.pool.query('UPDATE source_connections SET deleted_at=now() WHERE id=$1',[connection]);const before=await snapshot();
 for(const reply of [await update({name:'Saved'},key),await update({name:'New'}),await scan(scanKey),await scan()])expect(reply.statusCode,reply.body).toBe(404);
 expect(await snapshot()).toEqual(before);
});
it('Project member downgrade concurrent with control is authoritative before the parent/Monitor write',async()=>{
 const member=randomUUID(),project=randomUUID();await seedSpaceMember(db.pool,{space,user:member});
 await db.pool.query("UPDATE spaces SET type='household' WHERE id=$1",[space]);
 await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Project','active',now(),now())",[project,space,member]);
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,owner]);
 await db.pool.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[connection,project]);
 const blocker=await db.pool.connect();let pending:ReturnType<typeof update>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);pending=update({name:'Forbidden'});await waitForLockWaiter(db.pool);
 await blocker.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,owner]);await blocker.query('COMMIT');expect((await pending).statusCode,(await pending).body).toBe(404);
 expect((await db.pool.query('SELECT name FROM source_channels WHERE id=$1',[channel])).rows[0].name).toBe('Feed');expect((await snapshot()).jobs).toHaveLength(0);
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});
it.each(['update','scan'])('parent deletion while %s waits cannot leave partial changes or a Job',async kind=>{
 const holder=await db.pool.connect();let pending:ReturnType<typeof scan>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);
 pending=kind==='scan'?scan():update({name:'Must rollback'});await waitForLockWaiter(db.pool);await holder.query('UPDATE source_connections SET deleted_at=now() WHERE id=$1',[connection]);await holder.query('COMMIT');
 const result=await pending;expect(result.statusCode,result.body).toBe(404);expect((await snapshot()).jobs).toHaveLength(0);expect((await db.pool.query('SELECT name FROM source_channels WHERE id=$1',[channel])).rows[0].name).toBe('Feed');
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
});

it('serializes distinct Monitor updates before child locks when both rename their shared Source',async()=>{
 const second=randomUUID();await db.pool.query(`INSERT INTO source_channels(id,space_id,source_connection_id,created_by_user_id,name,channel_type,endpoint_url,query_json,provider_query_json,query_fingerprint,status,fetch_frequency,schedule_rule_json,created_at,updated_at)
 SELECT $2,space_id,source_connection_id,created_by_user_id,'Second Monitor',channel_type,endpoint_url,query_json,provider_query_json,'second-monitor-fingerprint',status,fetch_frequency,schedule_rule_json,created_at,updated_at FROM source_channels WHERE id=$1`,[channel,second]);
 const holder=await db.pool.connect();let first:ReturnType<typeof update>|undefined,later:ReturnType<typeof generic>|undefined;
 try{await holder.query('BEGIN');await holder.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);
 first=update({name:'First saved',source_name:'First parent name'});later=generic('source.channel.update',{source_channel_id:second,changes:{name:'Second saved',source_name:'Second parent name'}});
 await waitForLockWaiter(db.pool,{waiters:2});await holder.query('COMMIT');
 for(const reply of await Promise.all([first,later]))expect(reply.statusCode,reply.body).toBe(200);
 expect((await db.pool.query('SELECT name FROM source_channels WHERE id=ANY($1::varchar[]) ORDER BY name',[[channel,second]])).rows).toEqual([{name:'First saved'},{name:'Second saved'}]);
 expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'operation_outcome' IS DISTINCT FROM 'failed'",[space])).rows).toHaveLength(2);
 }finally{await holder.query('ROLLBACK');holder.release();await Promise.all([first,later]);}
});
