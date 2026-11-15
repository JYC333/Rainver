import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedAgentWithVersion,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {lockAutomationConfiguration,lockAutomationFire} from '../src/modules/automations/configurationAuthority.js';
import {AutomationService} from '../src/modules/automations/service.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {registerRoutes} from '../src/modules/automations/routes.js';
import {registerAutonomousTickAutomationTarget} from '../src/modules/autonomy/automationTarget.js';
import {registerContextOpsReviewCycleAutomationTarget} from '../src/modules/contextOps/automationTarget.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,agent:string,project:string;
let app:ReturnType<typeof buildModuleServer>;
const send=(method:'POST'|'PUT'|'PATCH',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const base=()=>`/api/v1/spaces/${space}/automations`;
const body=()=>({name:'Review',agent_id:agent,config_json:{target_type:'context_ops_review_cycle',review_scope:'private',cron:'0 * * * *'},trigger_type:'schedule'});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();agent=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await seedAgentWithVersion(db.pool,{space,owner,agent,version:randomUUID(),name:'Agent'});
 registerAutonomousTickAutomationTarget();registerContextOpsReviewCycleAutomationTarget();
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[{name:'automations',registerRoutes},systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
describe('Automation configuration formal operations',()=>{
 it('prepares fire under its caller transaction without executing a target or creating work',async()=>{
  const configured=await send('PUT',base()+'/autonomy',{agent_id:agent,observe_only:true});
  expect(configured.statusCode,configured.body).toBe(200);
  const id=configured.json().data.id,tx=await db.pool.connect();
  try{
   await tx.query('BEGIN');
   const authority=await lockAutomationFire(tx,space,owner,{space_id:space,automation_id:id});
   expect(authority.actor_is_owner).toBe(true);
   const prepared=await AutomationService.forFireAdmissionTransaction(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),tx)
    .prepareFire({spaceId:space,automationId:id,actorUserId:owner});
   expect(prepared.responsibility).toEqual({triggerOrigin:'automation',instructedByUserId:owner});
   expect(prepared.preflightSnapshot.executable).toBe(true);
   expect((await tx.query('SELECT id FROM automation_runs')).rows).toHaveLength(0);
   expect((await tx.query('SELECT id FROM jobs')).rows).toHaveLength(0);
  }finally{await tx.query('ROLLBACK');tx.release();}
 });
 it('does not require an unused credential grant for an observe-only tick',async()=>{
  const configured=await send('PUT',base()+'/autonomy',{agent_id:agent,observe_only:true});
  expect(configured.statusCode,configured.body).toBe(200);
  const id=configured.json().data.id,granting=randomUUID();
  await seedSpaceMember(db.pool,{space,user:granting});
  await db.pool.query('UPDATE automation_credential_grants SET granted_by_user_id=$1 WHERE automation_id=$2',[granting,id]);
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[granting]);
  const tx=await db.pool.connect();
  try{
   await tx.query('BEGIN');
   const prepared=await AutomationService.forFireAdmissionTransaction(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),tx)
    .prepareFire({spaceId:space,automationId:id,actorUserId:owner});
   expect(prepared.preflightSnapshot.executable).toBe(true);
  }finally{await tx.query('ROLLBACK');tx.release();}
 });
 it('pins the active granting person and refuses fire after that person is disabled',async()=>{
  const configured=await send('PUT',base()+'/autonomy',{agent_id:agent});
  expect(configured.statusCode,configured.body).toBe(200);
  const id=configured.json().data.id,granting=randomUUID();
  await seedSpaceMember(db.pool,{space,user:granting});
  await db.pool.query("UPDATE automations SET config_json=jsonb_set(config_json,'{observe_only}','false'::jsonb) WHERE id=$1",[id]);
  await db.pool.query('UPDATE automation_credential_grants SET granted_by_user_id=$1 WHERE automation_id=$2',[granting,id]);
  const tx=await db.pool.connect(),revoker=await db.pool.connect();
  let pending:Promise<unknown>|undefined,settled=false;
  try{
   await tx.query('BEGIN');
   const pid=Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   await lockAutomationFire(tx,space,owner,{space_id:space,automation_id:id});
   pending=revoker.query("UPDATE users SET status='disabled' WHERE id=$1",[granting]).finally(()=>{settled=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
   await tx.query('COMMIT');await pending;
   await tx.query('BEGIN');
   await expect(lockAutomationFire(tx,space,owner,{space_id:space,automation_id:id})).rejects.toThrow('Active users');
  }finally{await tx.query('ROLLBACK');await pending;tx.release();revoker.release();}
 });
 it('requires keys and strict DTOs, creates scheduled configuration and replays through the generic core',async()=>{
  expect((await send('POST',base(),body(),null)).statusCode).toBe(422);
  expect((await send('POST',base(),{...body(),owner_user_id:owner})).statusCode).toBe(422);
  const key=randomUUID(),created=await send('POST',base(),body(),key);
  expect(created.statusCode,created.body).toBe(201);
  const id=created.json().data.id;
  expect((await send('POST','/api/v1/actions/automation.create',{...body(),space_id:space},key)).json()).toEqual(created.json());
  expect((await db.pool.query('SELECT id FROM automations')).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT status FROM scheduler_tasks WHERE task_type='automation' AND task_key=$1",[id])).rows[0]?.status).toBe('active');
  expect((await db.pool.query('SELECT status FROM automation_credential_grants WHERE automation_id=$1',[id])).rows[0]?.status).toBe('active');
 });
 it('updates in core, replays unchanged, and rechecks live membership before returning a receipt',async()=>{
  const created=await send('PUT',base()+'/autonomy',{agent_id:agent});expect(created.statusCode,created.body).toBe(200);
  const id=created.json().data.id,key=randomUUID(),url=base()+'/'+id;
  const updated=await send('PATCH',url,{name:'Updated'},key);expect(updated.statusCode,updated.body).toBe(200);
  expect(updated.json().data.name).toBe('Updated');
  expect((await send('PATCH',url,{name:'Updated'},key)).json()).toEqual(updated.json());
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await send('PATCH',url,{name:'Updated'},key)).statusCode).toBe(404);
 });
 it('configures the autonomy singleton, and both formal/generic paths share its keyed receipt',async()=>{
  const key=randomUUID(),payload={agent_id:agent,observe_only:true};
  const first=await send('PUT',base()+'/autonomy',payload,key);expect(first.statusCode,first.body).toBe(200);
  expect((await send('POST','/api/v1/actions/automation.autonomy.configure',{...payload,space_id:space},key)).json()).toEqual(first.json());
  const next=await send('PUT',base()+'/autonomy',{...payload,name:'Again'});
  expect(next.statusCode,next.body).toBe(200);expect(next.json().data.id).toBe(first.json().data.id);
  expect((await db.pool.query('SELECT id FROM automations')).rows).toHaveLength(1);
 });
 it('holds Agent authority until the configuration owner commits',async()=>{
  const ownerTx=await db.pool.connect(),revoker=await db.pool.connect();
  let pending:Promise<unknown>|undefined,settled=false;
  try{
   await ownerTx.query('BEGIN');
   const pid=Number((await ownerTx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   await lockAutomationConfiguration(ownerTx,space,owner,{space_id:space,agent_id:agent},true);
   await AutomationService.forConfigurationTransaction(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),ownerTx).enableAutonomy({spaceId:space,actorUserId:owner,body:{agent_id:agent}});
   pending=revoker.query("UPDATE agents SET visibility='private' WHERE id=$1",[agent]).finally(()=>{settled=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>settled});expect(settled).toBe(false);
   await ownerTx.query('COMMIT');await pending;
   expect((await db.pool.query('SELECT id FROM automations')).rows).toHaveLength(1);
  }finally{await ownerTx.query('ROLLBACK');await pending;ownerTx.release();revoker.release();}
 });
 it.each(['create','autonomy','update'] as const)('rechecks live authority before %s replay',async(kind)=>{
  const initial=await send('PUT',base()+'/autonomy',{agent_id:agent});expect(initial.statusCode,initial.body).toBe(200);
  const method=kind==='create'?'POST':kind==='update'?'PATCH':'PUT';
  const url=kind==='create'?base():kind==='update'?base()+'/'+initial.json().data.id:base()+'/autonomy';
  const payload=kind==='create'?body():kind==='update'?{name:'Receipt'}:{agent_id:agent};
  const key=randomUUID(),first=await send(method,url,payload,key);
  expect(first.statusCode,first.body).toBe(kind==='create'?201:200);
  expect((await send(method,url,payload,key)).json()).toEqual(first.json());
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
  expect((await send(method,url,payload,key)).statusCode).toBe(404);
 });
 it.each(['create','autonomy','update'] as const)('rolls %s configuration, grant, schedule and receipt back when mandatory audit fails at commit',async(kind)=>{
  let id:string|undefined;
  if(kind==='update'){const existing=await send('PUT',base()+'/autonomy',{agent_id:agent});expect(existing.statusCode,existing.body).toBe(200);id=existing.json().data.id;}
  await db.pool.query(`CREATE OR REPLACE FUNCTION refuse_automation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM automations WHERE name='Rollback') THEN RAISE EXCEPTION 'injected automation audit failure'; END IF; RETURN NEW; END $$`);
  await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_automation_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_automation_audit()');
  const key=randomUUID(),payload=kind==='create'?{...body(),name:'Rollback'}:kind==='update'?{name:'Rollback'}:{agent_id:agent,name:'Rollback'};
  const method=kind==='create'?'POST':kind==='update'?'PATCH':'PUT';
  const url=kind==='create'?base():kind==='update'?base()+'/'+id:base()+'/autonomy';
  try{
   const failed=await send(method,url,payload,key);expect(failed.statusCode,failed.body).toBeGreaterThanOrEqual(500);
   expect((await db.pool.query("SELECT id FROM automations WHERE name='Rollback'")).rows).toHaveLength(0);
   expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE idempotency_key=$1',[key])).rows).toHaveLength(0);
   if(!id){
    expect((await db.pool.query('SELECT id FROM automation_credential_grants')).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT id FROM scheduler_tasks WHERE task_type='automation'")).rows).toHaveLength(0);
   }
  }finally{await db.pool.query('DROP TRIGGER refuse_automation_audit ON policy_decision_records');}
  const retried=await send(method,url,payload,key);expect(retried.statusCode,retried.body).toBe(kind==='create'?201:200);
 });
});
