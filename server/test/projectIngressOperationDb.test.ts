import {randomUUID} from 'node:crypto';
import {afterEach,it,expect} from 'vitest';
import {monitoringFixture} from './support/monitoringFixture.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {seedSpaceMember} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';
const {db,space,owner,project,channel,identity,config,accept,service,limits}=monitoringFixture(import.meta.filename);
let app:ReturnType<typeof buildModuleServer>|undefined;
function start(){__setAuthIdentityForTests(identity);app=buildModuleServer(config(),[projectsModule,systemActionsModule]);return app;}
const call=(id:string,input:object,key=randomUUID())=>app!.inject({method:'POST',url:'/api/v1/actions/'+id,payload:input,headers:{'idempotency-key':key}});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();app=undefined;});
async function backfillInput(){const binding=(await db.pool.query('SELECT id FROM project_source_bindings WHERE space_id=$1 AND project_id=$2 AND source_channel_id=$3',[space,project,channel])).rows[0].id as string;return {project_id:project,binding_id:binding,idempotency_key:randomUUID(),title:'PRIVATE history',strategy:{from:'2026-01-01',to:'2026-02-01',max_items:3}};}
it('commits one reviewed Source history bundle across transports and retains the independent domain key',async()=>{
 start();const body=await backfillInput(),key=randomUUID(),{project_id:_,binding_id,...payload}=body;
 const first=await app!.inject({method:'POST',url:`/api/v1/projects/${project}/sources/bindings/${binding_id}/propose-backfill`,payload,headers:{'idempotency-key':key}});expect(first.statusCode,first.body).toBe(201);expect(first.body).not.toContain('PRIVATE');
 expect((await call('project.source.propose_backfill',body,key)).json()).toEqual(first.json());
 const independent=await call('project.source.propose_backfill',body);expect(independent.statusCode,independent.body).toBe(201);expect(independent.json().data).toEqual(first.json().data);
 expect((await call('project.source.propose_backfill',{...body,strategy:{...body.strategy,max_items:4}},key)).statusCode).toBe(422);
 expect((await call('project.source.propose_backfill',{...body,strategy:{...body.strategy,max_items:4}})).statusCode).toBe(409);
 expect((await db.pool.query("SELECT status,required_approver_role FROM proposals WHERE id=$1",[first.json().data.proposal_id])).rows).toEqual([{status:'pending',required_approver_role:'owner'}]);
 expect((await db.pool.query('SELECT id FROM source_backfill_plans WHERE space_id=$1',[space])).rows).toHaveLength(1);expect((await db.pool.query("SELECT id FROM project_operations WHERE space_id=$1 AND kind='source_backfill'",[space])).rows).toHaveLength(1);expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[space])).rows).toEqual([]);
});
it.each(['source_backfill_segments','proposals','project_operation_links','operation_idempotency','policy_decision_records'])('rolls the whole Source history bundle back on %s failure',async table=>{
 start();const body=await backfillInput();await db.pool.query("CREATE FUNCTION refuse_project_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE history storage'; END $$");await db.pool.query(`CREATE TRIGGER refuse_project_history BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_project_history()`);
 try{const result=await call('project.source.propose_backfill',body);expect(result.statusCode,result.body).toBe(table==='policy_decision_records'?503:500);expect(result.body).not.toContain('PRIVATE');for(const name of ['source_backfill_plans','source_backfill_segments','proposals','project_operations','project_operation_links','operation_idempotency'])expect((await db.pool.query(`SELECT id FROM ${name} WHERE space_id=$1`,[space])).rows).toEqual([]);}
 finally{await db.pool.query(`DROP TRIGGER refuse_project_history ON ${table}`);await db.pool.query('DROP FUNCTION refuse_project_history()');}
});
it('rechecks Source retirement before returning a cached history proposal receipt',async()=>{
 start();const body=await backfillInput(),key=randomUUID();const first=await call('project.source.propose_backfill',body,key);expect(first.statusCode,first.body).toBe(201);await db.pool.query("UPDATE source_channels SET status='archived' WHERE id=$1",[channel]);const replay=await call('project.source.propose_backfill',body,key);expect(replay.statusCode,replay.body).toBe(404);expect(replay.body).not.toContain('PRIVATE');
});
it('refuses cached history receipts when their channel retires while admission waits for the Project',async()=>{
 start();const body=await backfillInput(),key=randomUUID(),first=await call('project.source.propose_backfill',body,key);expect(first.statusCode,first.body).toBe(201);
 const holder=await db.pool.connect();try{
  await holder.query('BEGIN');await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
  const pending=call('project.source.propose_backfill',body,key);await waitForLockWaiter(db.pool);
  await holder.query("UPDATE source_channels SET status='archived' WHERE id=$1",[channel]);await holder.query('COMMIT');
  const result=await pending;expect(result.statusCode,result.body).toBe(404);expect(result.body).not.toContain('PRIVATE');
  expect((await db.pool.query('SELECT id FROM source_backfill_plans WHERE space_id=$1',[space])).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(1);
 }finally{await holder.query('ROLLBACK');holder.release();}
});
it('appends details once, replays the original receipt after later edits and rejects a fresh stale CAS',async()=>{
 const version=await accept();start();const key=randomUUID(),body={expected_version_id:version.id,language:'PRIVATE language',recommendation_count:2};
 const formal=await app!.inject({method:'PATCH',url:`/api/v1/projects/${project}/information-monitoring/details`,payload:body,headers:{'idempotency-key':key}});
 expect(formal.statusCode,formal.body).toBe(200);expect(formal.body).not.toContain('PRIVATE');
 const payload={project_id:project,...body},next=formal.json().data.id;
 expect((await call('project.monitoring.details.update',payload,key)).json()).toEqual(formal.json());
 expect((await call('project.monitoring.details.update',payload)).statusCode).toBe(409);
 expect((await call('project.monitoring.details.update',{...payload,language:'Changed'},key)).statusCode).toBe(422);
 expect((await call('project.monitoring.details.update',{project_id:project,expected_version_id:next,language:'Current'})).statusCode).toBe(200);
 expect((await call('project.monitoring.details.update',payload,key)).json()).toEqual(formal.json());
 expect((await service().state(identity,project)).active?.config.language).toBe('Current');
 expect((await db.pool.query('SELECT id FROM project_information_monitoring_versions WHERE space_id=$1',[space])).rows).toHaveLength(3);
});
it('replays pause intent without resetting a later resume and atomically updates the scheduler state',async()=>{
 const version=await accept();start();const key=randomUUID(),body={project_id:project,expected_version_id:version.id,paused:true};
 const first=await call('project.monitoring.state.update',body,key);expect(first.statusCode,first.body).toBe(200);
 expect((await service().state(identity,project)).paused).toBe(true);
 expect((await call('project.monitoring.state.update',{...body,paused:false})).statusCode).toBe(200);
 const replay=await app!.inject({method:'PATCH',url:`/api/v1/projects/${project}/information-monitoring/state`,payload:{expected_version_id:version.id,paused:true},headers:{'idempotency-key':key}});expect(replay.json()).toEqual(first.json());
 expect((await service().state(identity,project)).paused).toBe(false);
});
it('preserves lower-limit-only details and refuses body authority or scope fields',async()=>{
 const version=await accept();start();const body={project_id:project,expected_version_id:version.id};
 for(const extra of [{objective:'New scope'},{actor_id:owner},{batch:{...limits,candidates:limits.candidates+1}}]){
  const result=await call('project.monitoring.details.update',{...body,...extra});expect(result.statusCode,result.body).toBe(422);
 }
 expect((await service().state(identity,project)).active?.id).toBe(version.id);
});
it('rechecks Project authority for cached monitoring receipts',async()=>{
 const version=await accept();start();const key=randomUUID(),body={project_id:project,expected_version_id:version.id,paused:true};
 expect((await call('project.monitoring.state.update',body,key)).statusCode).toBe(200);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,peer]);await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,owner]);await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
 const replay=await call('project.monitoring.state.update',body,key);expect(replay.statusCode,replay.body).toBe(404);
});
it('rolls back the new version, Project pointer and receipt when the mandatory operation audit cannot persist',async()=>{
 const version=await accept();start();await db.pool.query("CREATE FUNCTION refuse_monitoring_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE audit failure'; END $$");await db.pool.query('CREATE TRIGGER refuse_monitoring_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_monitoring_audit()');
 try{const result=await call('project.monitoring.details.update',{project_id:project,expected_version_id:version.id,language:'PRIVATE changed'});expect(result.statusCode,result.body).toBe(503);expect(result.body).not.toContain('PRIVATE');expect((await db.pool.query('SELECT id FROM project_information_monitoring_versions WHERE space_id=$1',[space])).rows).toHaveLength(1);expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toEqual([]);expect((await db.pool.query('SELECT active_information_monitoring_version_id FROM projects WHERE id=$1',[project])).rows[0].active_information_monitoring_version_id).toBe(version.id);}
 finally{await db.pool.query('DROP TRIGGER refuse_monitoring_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_monitoring_audit()');}
});
