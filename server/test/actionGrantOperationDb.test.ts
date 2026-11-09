import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject,seedAgentWithVersion,seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {policyModule} from '../src/modules/policy/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,agent:string,app:ReturnType<typeof buildModuleServer>;
beforeEach(async()=>{
  if(!db.available)return;
  space=randomUUID();owner=randomUUID();agent=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID()});
  await seedAgentWithVersion(db.pool,{space,owner,agent,version:randomUUID()});
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[policyModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const payload=()=>({agent_id:agent,action_id:'project.source.propose_bind',max_uses:1});
const create=(body:unknown=payload(),key:string|null=randomUUID(),url='/api/v1/policy/action-grants')=>app.inject({method:'POST',url,payload:body as object,headers:key?{'idempotency-key':key}:{}});
it('shares one grant and one admission audit across REST and generic replay',async()=>{
  const key=randomUUID(),one=await create(payload(),key);
  expect(one.statusCode,one.body).toBe(201);
  const again=await create(payload(),key,'/api/v1/actions/policy.action_grant.create');
  expect(again.statusCode,again.body).toBe(201);
  expect(again.json()).toEqual(one.json());
  expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(1);
  // One final operation decision per invocation, never a second service/route enforce.
  expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND action='policy.action_grant.create'",[space])).rows).toHaveLength(2);
  const changed = await create({...payload(),max_uses:2},key);
  expect(changed.statusCode).toBe(422);
  expect(changed.json().error.code).toBe('idempotency_key_reused');
});
it('validates commands before writing and rejects duplicate active grants atomically',async()=>{
  expect((await create(payload(),null)).statusCode).toBe(422);
  expect((await create({...payload(),unknown:true})).statusCode).toBe(422);
  expect((await create({...payload(),max_uses:'2'})).statusCode).toBe(422);
  expect((await create({...payload(),action_id:'policy.action_grant.create'})).statusCode).toBe(422);
  expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(0);
  expect((await create()).statusCode).toBe(201);
  expect((await create()).statusCode).toBe(409);
  await db.pool.query("UPDATE action_approval_grants SET use_count=max_uses WHERE space_id=$1",[space]);
  expect((await create()).statusCode).toBe(201);
  expect((await db.pool.query('SELECT status FROM action_approval_grants WHERE space_id=$1 ORDER BY created_at',[space])).rows.map(r=>r.status)).toEqual(['expired','active']);
});
it('replays revocation only for the original key and refuses a downgraded owner',async()=>{
  const createKey=randomUUID(),granted=await create(payload(),createKey),id=granted.json().data.id,key=randomUUID();
  const revoke=(k:string)=>app.inject({method:'POST',url:`/api/v1/policy/action-grants/${id}/revoke`,headers:{'idempotency-key':k},payload:{}});
  const one=await revoke(key);expect(one.statusCode,one.body).toBe(200);
  expect((await revoke(key)).json()).toEqual(one.json());
  const generic=await create({grant_id:id},key,'/api/v1/actions/policy.action_grant.revoke');
  expect(generic.json()).toEqual(one.json());
  expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND action='policy.action_grant.revoke'",[space])).rows).toHaveLength(3);
  expect((await revoke(randomUUID())).statusCode).toBe(404);
  await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await revoke(key)).statusCode).toBe(404);
  expect((await create()).statusCode).toBe(404);
  expect((await create(payload(),createKey)).statusCode).toBe(404);
});
it('hides foreign targets equally through both transports',async()=>{
  const foreign=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:foreign,owner:randomUUID(),project:randomUUID()});
  const otherAgent=randomUUID(),otherOwner=(await db.pool.query('SELECT user_id FROM space_memberships WHERE space_id=$1',[foreign])).rows[0].user_id;
  await seedAgentWithVersion(db.pool,{space:foreign,owner:otherOwner,agent:otherAgent,version:randomUUID()});
  for(const url of ['/api/v1/policy/action-grants','/api/v1/actions/policy.action_grant.create']){
    expect((await create({...payload(),agent_id:otherAgent},randomUUID(),url)).statusCode).toBe(404);
  }
  const catalog=await app.inject({method:'GET',url:'/api/v1/queries/system.actions.list'});
  expect(catalog.json().data.actions.map((a:{id:string})=>a.id)).toContain('policy.action_grant.create');
});
it('withholds grant writes when mandatory admission audit fails',async()=>{
  await db.pool.query("CREATE FUNCTION public.reject_action_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='policy.action_grant.create' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER reject_action_grant_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION public.reject_action_grant_audit()');
  try{
    expect((await create()).statusCode).toBe(503);
    expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
  }finally{
    await db.pool.query('DROP TRIGGER reject_action_grant_audit ON policy_decision_records');
    await db.pool.query('DROP FUNCTION public.reject_action_grant_audit()');
  }
});

it('normalizes omitted nullable fields for cross-entry replay and returns a strict DTO', async()=>{
  const key=randomUUID(),one=await create(payload(),key);
  expect(one.statusCode,one.body).toBe(201);
  const again=await create({...payload(),project_id:null,target_run_id:null,resource_kind:null,resource_id:null,expires_at:null},key,'/api/v1/actions/policy.action_grant.create');
  expect(again.json()).toEqual(one.json());
  expect(one.json().data).toMatchObject({project_id:null,target_run_id:null,resource_kind:null,resource_id:null,expires_at:null,last_used_at:null,revoked_at:null});
});
it('returns canonical invalid input for malformed JSON and nonobject bodies on both entries', async()=>{
  const grant=await create();
  for(const url of ['/api/v1/policy/action-grants','/api/v1/actions/policy.action_grant.create',`/api/v1/policy/action-grants/${grant.json().data.id}/revoke`,'/api/v1/actions/policy.action_grant.revoke']) {
    for(const body of ['{','[]','null','42']) {
      const result=await app.inject({method:'POST',url,payload:body,headers:{'content-type':'application/json','idempotency-key':randomUUID()}});
      expect(result.statusCode,result.body).toBe(422);
      expect(result.json()).toMatchObject({error:{code:'operation_invalid_input',domain:'operations',retryable:false,request_id:expect.any(String)}});
      expect(result.body).not.toContain('Invalid JSON');
    }
  }
  expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it('refuses actual Agent tool calls even with owner instruction and injected immutable grants', async()=>{
  const runId=randomUUID(),version=(await db.pool.query('SELECT current_version_id FROM agents WHERE id=$1',[agent])).rows[0].current_version_id;
  await seedRun(db.pool,{id:runId,space,owner,agent,version,existingAgent:true});
  await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[runId,owner,JSON.stringify({tool_grants:[{action_id:'policy.action_grant.create'},{action_id:'policy.action_grant.revoke'}]})]);
  const run=(await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1',[runId])).rows[0];
  const transport=new CliAgentToolTransport(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  for(const [name,args] of [['policy.action_grant.create',payload()],['policy.action_grant.revoke',{grant_id:randomUUID()}]] as const) {
    const result=await transport.call(run,{id:randomUUID(),name,arguments:args});
    expect(result).toMatchObject({httpStatus:404,body:{error:{code:'operation_not_found'}}});
  }
  expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
});
it('rejects the same key concurrently and replays once after the first transaction commits', async()=>{
  const lock=await db.pool.connect(),key=randomUUID();
  await lock.query('BEGIN');
  await lock.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE',[agent]);
  const first=create(payload(),key);
  // inject starts lazily; attach the observer before waiting for the real PG lock.
  const pending=Promise.resolve(first);
  try {
    await waitForLockWaiter(db.pool);
    const second=await create(payload(),key,'/api/v1/actions/policy.action_grant.create');
    expect(second.statusCode,second.body).toBe(409);
    expect(second.json()).toMatchObject({error:{code:'idempotency_in_progress',retryable:true}});
  } finally {
    await lock.query('ROLLBACK');lock.release();
  }
  const one=await pending;expect(one.statusCode,one.body).toBe(201);
  expect((await create(payload(),key)).json()).toEqual(one.json());
  expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(1);
});
it('rolls back domain effects when recording the outcome fails and retains one final decision', async()=>{
  await db.pool.query("CREATE FUNCTION public.reject_grant_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id LIKE 'policy.action_grant.%' THEN RAISE EXCEPTION 'private outcome failure'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER reject_grant_outcome BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION public.reject_grant_outcome()');
  try {
    const result=await create();expect(result.statusCode,result.body).toBe(500);
    expect(result.json().error.code).toBe('operation_internal_error');
    expect(result.body).not.toContain('private outcome failure');
    expect((await db.pool.query('SELECT id FROM action_approval_grants WHERE space_id=$1',[space])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE space_id=$1',[space])).rows).toHaveLength(0);
    expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND action='policy.action_grant.create'",[space])).rows).toHaveLength(1);
  } finally {
    await db.pool.query('DROP TRIGGER reject_grant_outcome ON operation_idempotency');
    await db.pool.query('DROP FUNCTION public.reject_grant_outcome()');
  }
});
it('hides foreign Project, Run and grant targets without exposing existence', async()=>{
  const foreign=randomUUID(),foreignOwner=randomUUID(),project=randomUUID(),runId=randomUUID(),otherAgent=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:foreign,owner:foreignOwner,project});
  await seedRun(db.pool,{id:runId,space:foreign,owner:foreignOwner,agent:otherAgent,version:randomUUID()});
  for(const field of ['project_id','target_run_id'] as const) {
    for(const value of [field==='project_id'?project:runId,randomUUID()]) {
      const result=await create({...payload(),[field]:value});
      expect(result.statusCode,result.body).toBe(404);
      expect(result.json().error.code).toBe('operation_not_found');
    }
  }
  __setAuthIdentityForTests({spaceId:foreign,userId:foreignOwner});
  const foreignGrant=await create({agent_id:otherAgent,action_id:'project.source.propose_bind'});
  expect(foreignGrant.statusCode,foreignGrant.body).toBe(201);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
  for(const grant_id of [foreignGrant.json().data.id,randomUUID()]) {
    const result=await create({grant_id},randomUUID(),'/api/v1/actions/policy.action_grant.revoke');
    expect(result.statusCode,result.body).toBe(404);
    expect(result.json().error.code).toBe('operation_not_found');
  }
});
it('rolls back revocation when its mandatory policy audit is unavailable', async()=>{
  const grant=await create(),id=grant.json().data.id;
  await db.pool.query("CREATE FUNCTION public.reject_grant_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='policy.action_grant.revoke' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER reject_grant_revoke_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION public.reject_grant_revoke_audit()');
  try {
    const result=await create({grant_id:id},randomUUID(),'/api/v1/actions/policy.action_grant.revoke');
    expect(result.statusCode,result.body).toBe(503);
    expect(result.json().error.code).toBe('operation_audit_unavailable');
    expect((await db.pool.query('SELECT status,revoked_at FROM action_approval_grants WHERE id=$1',[id])).rows[0]).toEqual({status:'active',revoked_at:null});
    expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE space_id=$1 AND operation_id='policy.action_grant.revoke'",[space])).rows).toHaveLength(0);
  } finally {
    await db.pool.query('DROP TRIGGER reject_grant_revoke_audit ON policy_decision_records');
    await db.pool.query('DROP FUNCTION public.reject_grant_revoke_audit()');
  }
});
