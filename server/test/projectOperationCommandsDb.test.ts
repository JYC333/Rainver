import {retainReaderBody} from './support/readingMaterial.js';
import {NO_STORE_CACHE_CONTROL} from '../src/gateway/cacheControl.js';
import {REQUEST_ID_HEADER} from '../src/gateway/requestContext.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {loadConfig} from '../src/config.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {ProjectOperationService} from '../src/modules/projects/projectOperationService.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import {useTestDatabase} from './support/testDatabase.js';
import {buildModuleServer} from './support/moduleServer.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun,seedMainlineRoomsForAllProjects} from './support/domainSeeds.js';
import {waitForLockWaiter} from './support/lockWait.js';

const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,app:ReturnType<typeof buildModuleServer>;
beforeEach(async()=>{
  if(!db.available)return;
  space=randomUUID();owner=randomUUID();project=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
  app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[projectsModule,systemActionsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const body=()=>({kind:'custom',title:'Track work',steps:[{title:'Prepare'}]});
const create=(payload:object=body(),key:string|null=randomUUID(),generic=false)=>app.inject({
  method:'POST',url:generic?'/api/v1/actions/project.operation.create':`/api/v1/projects/${project}/operations`,
  payload:generic?{...payload,project_id:project}:payload,headers:key?{'idempotency-key':key}:{},
});
const cancel=(id:string,key:string=randomUUID(),generic=false)=>app.inject({
  method:'POST',url:generic?'/api/v1/actions/project.operation.cancel':`/api/v1/projects/${project}/operations/${id}/cancel`,
  payload:generic?{project_id:project,operation_id:id}:{},headers:{'idempotency-key':key},
});
async function internal(kind='research',progress:Record<string,unknown>={projection_mode:'managed'}) {
  return new ProjectOperationService(db.pool).create({spaceId:space,userId:owner},project,{kind,title:'Internal operation',progress});
}
const rows=(table:string)=>db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1`,[space]);

it('shares strict normalized create receipts and one domain effect across REST and generic calls',async()=>{
  const key=randomUUID(),one=await create(body(),key);
  expect(one.statusCode,one.body).toBe(201);
  const again=await create({...body(),intent_text:null,initiating_run_id:null,plan_artifact_id:null},key,true);
  expect(again.json()).toEqual(one.json());
  expect(Object.keys(one.json().data).sort()).toEqual(['id','kind','project_id','status','version']);
  expect((await rows('project_operations')).rows).toHaveLength(1);
  expect((await rows('project_operations')).rows[0]).toMatchObject({initiating_run_id:null,plan_artifact_id:null});
  expect((await rows('project_operation_steps')).rows).toHaveLength(1);
  expect((await rows('operation_idempotency')).rows).toHaveLength(1);
  expect((await rows('policy_decision_records')).rows).toHaveLength(2);
  const changed=await create({...body(),title:'Different'},key,true);
  expect(changed.statusCode).toBe(422);expect(changed.json().error.code).toBe('idempotency_key_reused');
});
it('shares cancellation replay while a new key retains terminal conflict and changed targets conflict',async()=>{
  const id=(await create()).json().data.id,key=randomUUID();
  const one=await cancel(id,key);expect(one.statusCode,one.body).toBe(200);
  expect((await cancel(id,key,true)).json()).toEqual(one.json());
  expect((await cancel(id)).statusCode).toBe(409);
  const second=(await create()).json().data.id;
  const changed=await cancel(second,key,true);
  expect(changed.statusCode).toBe(422);expect(changed.json().error.code).toBe('idempotency_key_reused');
  expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[second])).rows[0].status).toBe('draft');
});
it('rejects research creation and managed progress without changing internal writer authority',async()=>{
  for(const payload of [{...body(),kind:'research'},
    {...body(),progress:{projection_mode:'managed'}},{...body(),steps:[{title:'x',status:'done'}]}]) {
    for(const generic of [false,true])expect((await create(payload,randomUUID(),generic)).statusCode).toBe(422);
  }
  expect((await rows('project_operations')).rows).toHaveLength(0);
  for(const kind of ['source_setup','source_backfill','research']) {
    const op=await internal(kind);
    const stored=(await db.pool.query('SELECT kind,progress_json FROM project_operations WHERE id=$1',[op.id])).rows[0];
    expect(stored.kind).toBe(kind);expect(stored.progress_json.projection_mode).toBe('managed');
  }
});
it('returns canonical errors for missing keys, malformed JSON and unknown fields',async()=>{
  expect((await create(body(),null)).json().error.code).toBe('idempotency_key_required');
  for(const url of [`/api/v1/projects/${project}/operations`,'/api/v1/actions/project.operation.create']) {
    for(const payload of ['{','[]','null']) {
      const result=await app.inject({method:'POST',url,payload,headers:{'content-type':'application/json','idempotency-key':randomUUID()}});
      expect(result.statusCode).toBe(422);expect(result.json().error.code).toBe('operation_invalid_input');
    }
  }
  expect((await rows('operation_idempotency')).rows).toHaveLength(0);
});
it('denies replay after current Project membership loses write access',async()=>{
  const member=randomUUID();await seedSpaceMember(db.pool,{space,user:member});
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,member]);
  __setAuthIdentityForTests({spaceId:space,userId:member});
  const createKey=randomUUID(),one=await create(body(),createKey),id=one.json().data.id,cancelKey=randomUUID();
  expect(one.statusCode,one.body).toBe(201);expect((await cancel(id,cancelKey)).statusCode).toBe(200);
  await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,member]);
  expect((await create(body(),createKey,true)).statusCode).toBe(404);
  expect((await cancel(id,cancelKey,true)).statusCode).toBe(404);
});
it('hides foreign Space and missing Project/operation targets identically',async()=>{
  const foreign=randomUUID(),foreignOwner=randomUUID(),foreignProject=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:foreign,owner:foreignOwner,project:foreignProject});
  const op=await new ProjectOperationService(db.pool).create({spaceId:foreign,userId:foreignOwner},foreignProject,{kind:'custom',title:'Private title'});
  for(const target of [op.id,randomUUID()]) {
    for(const generic of [false,true]) {
      const result=await cancel(target,randomUUID(),generic);
      expect(result.statusCode).toBe(404);expect(result.json().error.code).toBe('operation_not_found');
      expect(result.body).not.toContain('Private title');
    }
  }
  for(const target of [foreignProject,randomUUID()]) {
    const result=await app.inject({method:'POST',url:'/api/v1/actions/project.operation.create',payload:{...body(),project_id:target},headers:{'idempotency-key':randomUUID()}});
    expect(result.statusCode).toBe(404);expect(result.json().error.code).toBe('operation_not_found');
  }
});
it('rejects a concurrent same-key create without waiting and replays the committed receipt',async()=>{
  const lock=await db.pool.connect(),key=randomUUID();await lock.query('BEGIN');
  await lock.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[project]);
  const pending=Promise.resolve(create(body(),key));
  try {
    await waitForLockWaiter(db.pool);
    const second=await create(body(),key,true);
    expect(second.statusCode,second.body).toBe(409);expect(second.json().error).toMatchObject({code:'idempotency_in_progress',retryable:true});
  } finally {await lock.query('ROLLBACK');lock.release();}
  const first=await pending;expect(first.statusCode,first.body).toBe(201);
  expect((await create(body(),key,true)).json()).toEqual(first.json());
  expect((await rows('project_operations')).rows).toHaveLength(1);
});
it('withholds all writes if the mandatory admission audit is unavailable',async()=>{
  await db.pool.query("CREATE FUNCTION refuse_operation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='project.operation.manage' THEN RAISE EXCEPTION 'private audit failure'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_operation_audit BEFORE INSERT ON policy_decision_records FOR EACH ROW EXECUTE FUNCTION refuse_operation_audit()');
  try {
    const result=await create();expect(result.statusCode,result.body).toBe(503);
    expect(result.json().error.code).toBe('operation_audit_unavailable');
    expect((await rows('project_operations')).rows).toHaveLength(0);
    expect((await rows('operation_idempotency')).rows).toHaveLength(0);
  } finally {await db.pool.query('DROP TRIGGER refuse_operation_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_operation_audit()');}
});
it('rolls back the operation and steps if the result receipt fails, preserving one failed audit',async()=>{
  await db.pool.query("CREATE FUNCTION refuse_operation_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id='project.operation.create' THEN RAISE EXCEPTION 'private result failure'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_operation_result BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_operation_result()');
  try {
    const result=await create();expect(result.statusCode,result.body).toBe(500);expect(result.body).not.toContain('private result failure');
    for(const table of ['project_operations','project_operation_steps','operation_idempotency'])expect((await rows(table)).rows).toHaveLength(0);
    const audits=(await rows('policy_decision_records')).rows;expect(audits).toHaveLength(1);
    expect(audits[0].metadata_json.operation_outcome).toBe('failed');
  } finally {await db.pool.query('DROP TRIGGER refuse_operation_result ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_operation_result()');}
});
it('retains generic versus research terminal semantics and atomically enqueues one research stop Job',async()=>{
  const research=await internal(),key=randomUUID();
  const one=await cancel(research.id,key);expect(one.statusCode,one.body).toBe(200);
  expect((await cancel(research.id,key,true)).json()).toEqual(one.json());
  expect((await cancel(research.id)).statusCode).toBe(409);
  expect((await rows('jobs')).rows.filter(r=>r.job_type==='research_operation_cancel')).toHaveLength(1);
  const failed=await internal();await db.pool.query("UPDATE project_operations SET status='failed' WHERE id=$1",[failed.id]);
  expect((await cancel(failed.id)).statusCode).toBe(409);
  const pilot=await app.inject({method:'POST',url:'/api/v1/actions/research.cancel_acquisition',payload:{operation_id:failed.id,project_id:project},headers:{'idempotency-key':randomUUID()}});
  expect(pilot.statusCode,pilot.body).toBe(200);expect(pilot.json().data.already_terminal).toBe(true);
  const custom=await internal('custom');await db.pool.query("UPDATE project_operations SET status='failed' WHERE id=$1",[custom.id]);
  expect((await cancel(custom.id)).statusCode).toBe(200);
});
it('rolls back research cancellation when its required Job cannot be written',async()=>{
  const op=await internal();
  await db.pool.query("CREATE FUNCTION refuse_stop_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_type='research_operation_cancel' THEN RAISE EXCEPTION 'private Job failure'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_stop_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_stop_job()');
  try {
    const result=await cancel(op.id);expect(result.statusCode,result.body).toBe(500);expect(result.body).not.toContain('private Job failure');
    expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[op.id])).rows[0].status).toBe('draft');
    expect((await rows('jobs')).rows).toHaveLength(0);expect((await rows('operation_idempotency')).rows).toHaveLength(0);
    const audits=(await rows('policy_decision_records')).rows;expect(audits).toHaveLength(1);expect(audits[0].metadata_json.operation_outcome).toBe('failed');
  } finally {await db.pool.query('DROP TRIGGER refuse_stop_job ON jobs');await db.pool.query('DROP FUNCTION refuse_stop_job()');}
});
it('refuses actual Agent transport calls despite owner instruction and injected grants',async()=>{
  const id=randomUUID(),agent=randomUUID();await seedRun(db.pool,{id,space,owner,agent,version:randomUUID()});
  await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1",[id,owner,JSON.stringify({tool_grants:[{action_id:'project.operation.create'},{action_id:'project.operation.cancel'}]})]);
  const run=(await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1',[id])).rows[0];
  const transport=new CliAgentToolTransport(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const existing=await internal('custom');
  for(const [name,args] of [
    ['project.operation.create',{...body(),project_id:project}],
    ['project.operation.cancel',{project_id:project,operation_id:existing.id}],
  ] as const) {
    const response=await transport.call(run,{id:randomUUID(),name,arguments:args});
    expect(response).toMatchObject({httpStatus:404,body:{error:{code:'operation_not_found'}}});
  }
  expect((await rows('project_operations')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[existing.id])).rows[0].status).toBe('draft');
  expect((await rows('operation_idempotency')).rows).toHaveLength(0);
});

async function draftReferences(refSpace=space,refOwner=owner,refProject=project) {
  const run=randomUUID();
  await seedRun(db.pool,{id:run,space:refSpace,owner:refOwner,agent:randomUUID(),version:randomUUID()});
  await db.pool.query("UPDATE runs SET project_id=$2,visibility='space_shared' WHERE id=$1",[run,refProject]);
  const artifact=await retainReaderBody(db.pool,{space:refSpace,owner:refOwner,item:randomUUID(),text:'Reference body',attach:false});
  await db.pool.query("UPDATE artifacts SET project_id=$2,visibility='space_shared' WHERE id=$1",[artifact,refProject]);
  return {initiating_run_id:run,plan_artifact_id:artifact};
}
it('preserves all nonresearch draft labels and valid scoped references without granting execution authority',async()=>{
  const refs=await draftReferences();
  for(const kind of ['custom','source_setup','source_backfill']) {
    const key=randomUUID(),one=await create({...body(),kind,...refs},key);
    expect(one.statusCode,one.body).toBe(201);
    expect((await create({...body(),kind,...refs},key,true)).json()).toEqual(one.json());
    const row=(await db.pool.query('SELECT kind,status,initiating_run_id,plan_artifact_id,progress_json FROM project_operations WHERE id=$1',[one.json().data.id])).rows[0];
    expect(row).toMatchObject({kind,status:'draft',...refs});
    expect(row.progress_json.projection_mode).toBeUndefined();
  }
  expect((await rows('jobs')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[refs.initiating_run_id])).rows[0].status).toBe('succeeded');
  expect((await rows('project_operation_steps')).rows.every(row=>row.status==='pending')).toBe(true);
});
it('hides foreign and wrong-Project draft references on both public entries',async()=>{
  const foreign=randomUUID(),foreignOwner=randomUUID(),foreignProject=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:foreign,owner:foreignOwner,project:foreignProject});
  const foreignRefs=await draftReferences(foreign,foreignOwner,foreignProject),otherProject=randomUUID();
  await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other Project','active',now(),now())",[otherProject,space,owner]);
  await seedMainlineRoomsForAllProjects(db.pool);
  const otherRefs=await draftReferences(space,owner,otherProject);
  for(const refs of [foreignRefs,otherRefs]) {
    for(const [field,id] of Object.entries(refs))for(const generic of [false,true]) {
      const result=await create({...body(),[field]:id},randomUUID(),generic);
      expect(result.statusCode,result.body).toBe(404);expect(result.json().error.code).toBe('operation_not_found');
    }
  }
  expect((await rows('project_operations')).rows).toHaveLength(0);
});
it('revalidates private reference visibility before fresh writes and same-key replay',async()=>{
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  const refs=await draftReferences(space,peer,project),key=randomUUID();
  const accepted=await create({...body(),...refs},key);expect(accepted.statusCode,accepted.body).toBe(201);
  for(const [field,table] of [['initiating_run_id','runs'],['plan_artifact_id','artifacts']] as const) {
    await db.pool.query(`UPDATE ${table} SET visibility='private' WHERE id=$1`,[refs[field]]);
    for(const generic of [false,true]) {
      expect((await create({...body(),[field]:refs[field]},randomUUID(),generic)).statusCode).toBe(404);
      expect((await create({...body(),...refs},key,generic)).statusCode).toBe(404);
    }
    await db.pool.query(`UPDATE ${table} SET visibility='space_shared' WHERE id=$1`,[refs[field]]);
  }
  expect((await rows('project_operations')).rows).toHaveLength(1);
});
it('returns canonical 409 for archived Project creation, cancellation and success replay',async()=>{
  const key=randomUUID(),created=await create(body(),key),id=created.json().data.id;
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  for(const generic of [false,true]) {
    for(const result of [await create(body(),randomUUID(),generic),await create(body(),key,generic),await cancel(id,randomUUID(),generic)]) {
      expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('operation_conflict');
    }
  }
  expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[id])).rows[0].status).toBe('draft');
  expect((await rows('jobs')).rows).toHaveLength(0);
});
it('aligns formal and generic cache and request-id headers for success and invalid JSON',async()=>{
  for(const generic of [false,true])for(const command of ['create','cancel'] as const) {
    const target=command==='cancel'?(await create()).json().data.id:null;
    const requestId=randomUUID(),url=generic?`/api/v1/actions/project.operation.${command}`
      :command==='create'?`/api/v1/projects/${project}/operations`:`/api/v1/projects/${project}/operations/${target}/cancel`;
    const payload=command==='create'?(generic?{...body(),project_id:project}:body())
      :generic?{project_id:project,operation_id:target}:{};
    const result=await app.inject({method:'POST',url,payload,headers:{'idempotency-key':randomUUID(),[REQUEST_ID_HEADER]:requestId}});
    expect(result.statusCode,result.body).toBe(command==='create'?201:200);
    expect(result.headers['cache-control']).toBe(NO_STORE_CACHE_CONTROL);expect(result.headers[REQUEST_ID_HEADER]).toBe(requestId);
    const invalid=await app.inject({method:'POST',url,payload:'{',headers:{'content-type':'application/json',[REQUEST_ID_HEADER]:requestId}});
    expect(invalid.statusCode).toBe(422);expect(invalid.headers['cache-control']).toBe(NO_STORE_CACHE_CONTROL);
    expect(invalid.headers[REQUEST_ID_HEADER]).toBe(requestId);expect(invalid.json().error.request_id).toBe(requestId);
  }
});

it('preserves large intent/detail and ordered drafts while the shared HTTP body bound applies to both entries',async()=>{
  const text='x'.repeat(100_000);
  const accepted=await create({...body(),intent_text:text,steps:Array.from({length:101},(_,n)=>({title:`Step ${n}`,detail:n===0?{text}:{}}))});
  expect(accepted.statusCode,accepted.body).toBe(201);
  expect((await rows('project_operation_steps')).rows).toHaveLength(101);
  const oversized=' '.repeat(app.initialConfig.bodyLimit!+1);
  for(const generic of [false,true]) {
    const result=await app.inject({method:'POST',url:generic?'/api/v1/actions/project.operation.create':`/api/v1/projects/${project}/operations`,payload:oversized,headers:{'content-type':'application/json','idempotency-key':randomUUID()}});
    expect(result.statusCode).toBe(413);
  }
  expect((await rows('project_operations')).rows).toHaveLength(1);
});
