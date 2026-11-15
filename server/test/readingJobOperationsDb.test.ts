import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {briefingWorld,SPACE,PROJECT,OWNER,MEMBER,AGENT,PROFILE,CONNECTION} from './support/briefingFixture.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {startDeepReading} from '../src/modules/sources/deepReading/service.js';
import {registerDeepReadingRoutes} from '../src/modules/sources/deepReading/routes.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {waitForBlockedBy} from './support/lockWait.js';
const db=useTestDatabase(import.meta.filename,{max:6}),world=briefingWorld(db);
let root='',operation:string,run:string,app:ReturnType<typeof buildModuleServer>;
const write=(key=randomUUID(),extra:object={})=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading/deep-reads/${operation}/cancel`,headers:{'idempotency-key':key},payload:extra});
beforeEach(async()=>{
 if(!db.available)return;
 root=await mkdtemp(join(tmpdir(),'deep-cancel-operation-'));await world.seed();
 const config={...world.config(),rainverHome:root,artifactStorageRoot:join(root,'artifacts'),sandboxRoot:join(root,'sandbox')};
 await syncBuiltinPrompts(db.pool,config.catalogRoot,['reading.project_investigation']);
 await db.pool.query("UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{\"retention_policy\":\"full_text\"}'::jsonb WHERE id=$1",[CONNECTION]);
 const item=await world.material('Deep reading material',{uri:'https://news.test/cancel-operation'});
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,PROJECT]);
 const started=await startDeepReading(db.pool,config,{spaceId:SPACE,userId:OWNER},PROJECT,item,{agent_id:AGENT,runtime_profile_id:PROFILE});
 operation=started.processing_id!;run=started.run_id!;
 app=buildModuleServer(config,[{name:'deep-reading-test',registerRoutes:registerDeepReadingRoutes},systemActionsModule]);
 __setAuthIdentityForTests({spaceId:SPACE,userId:OWNER});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();if(root)await rm(root,{recursive:true,force:true});});
it('records cancellation intent once; replay reauthorizes ownership and never creates another Job',async()=>{
 const key=randomUUID(),before=(await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows;
 const first=await write(key);expect(first.statusCode,first.body).toBe(200);
 expect(first.json().data).toMatchObject({operation_id:operation,run_id:run,status:'cancelling'});
 const replay=await write(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
 expect((await db.pool.query('SELECT id FROM jobs ORDER BY id')).rows).toEqual(before);
 expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toHaveLength(1);
 __setAuthIdentityForTests({spaceId:SPACE,userId:MEMBER});expect((await write(key)).statusCode).toBe(404);
});
it('owner may stop after Source and Project access are withdrawn',async()=>{
 await db.pool.query("UPDATE source_connections SET capture_policy='reference_only',status='archived' WHERE id=$1",[CONNECTION]);
 await db.pool.query("UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2",[PROJECT,OWNER]);
 expect((await write()).statusCode).toBe(200);
});
it('a late audit failure rolls back Run and attempt intent and receipt; same-key recovery succeeds',async()=>{
 const key=randomUUID();
 await db.pool.query("CREATE FUNCTION refuse_deep_cancel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_deep_cancel_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_deep_cancel_audit()');
 try{
  const response=await write(key);expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0].status).toBe('queued');
  expect((await db.pool.query('SELECT status FROM extraction_jobs WHERE id=$1',[operation])).rows[0].status).toBe('pending');
  expect((await db.pool.query('SELECT * FROM operation_idempotency')).rows).toEqual([]);
 }finally{await db.pool.query('DROP TRIGGER refuse_deep_cancel_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_deep_cancel_audit()');}
 expect((await write(key)).statusCode).toBe(200);
});
it('terminal settlement wins a concurrent cancellation without rewriting the terminal result',async()=>{
 const holder=await db.pool.connect();let pending:ReturnType<typeof write>|undefined;
 try{
  await holder.query('BEGIN');const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await holder.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1",[run]);
  await holder.query("UPDATE extraction_jobs SET status='failed',error_code='source_material_run_failed' WHERE id=$1",[operation]);
  pending=write();await waitForBlockedBy(db.pool,pid);await holder.query('COMMIT');
  const result=await pending;expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe('failed');
 }finally{await holder.query('ROLLBACK');holder.release();await pending;}
 expect((await db.pool.query('SELECT status,error_code FROM extraction_jobs WHERE id=$1',[operation])).rows[0]).toEqual({status:'failed',error_code:'source_material_run_failed'});
});
it('strict targets refuse substitutions; replay refuses a disabled account',async()=>{
 expect((await write(randomUUID(),{run_id:randomUUID()})).statusCode).toBe(422);
 const key=randomUUID();expect((await write(key)).statusCode).toBe(200);
 await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[OWNER]);expect((await write(key)).statusCode).toBe(404);
});

it('core start retries frozen terminal inputs once and reauthorizes its receipt after execution revocation',async()=>{
 await db.pool.query("UPDATE runs SET status='failed',ended_at=now() WHERE id=$1",[run]);
 await db.pool.query("UPDATE extraction_jobs SET status='failed',error_code='source_material_run_failed' WHERE id=$1",[operation]);
 const item=(await db.pool.query('SELECT source_item_id FROM extraction_jobs WHERE id=$1',[operation])).rows[0].source_item_id;
 const key=randomUUID();
 const start=()=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading/items/${item}/deep-reads`,headers:{'idempotency-key':key},payload:{agent_id:AGENT,runtime_profile_id:PROFILE,retry_of:operation}});
 const before=Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n);
 const first=await start();expect(first.statusCode,first.body).toBe(200);expect(first.json().data.run_id).not.toBe(run);
 const replay=await start();expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
 expect(Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n)).toBe(before+1);
 await db.pool.query('UPDATE agent_runtime_profiles SET enabled=false,is_default=false WHERE id=$1',[PROFILE]);
 expect((await start()).statusCode).toBe(409);
});
it('annotation retry reopens only the responsible episode with one mandatory Job; audit rollback is recoverable',async()=>{
 const {PgSourceAnnotationRepository}=await import('../src/modules/sourceAnnotation/repository.js');
 const {informationDigestModule}=await import('../src/modules/informationDigest/index.js');
 const item=await world.material('Failed annotation',{uri:'https://news.test/annotation-retry',analysed:false}),episode=randomUUID();
 await new PgSourceAnnotationRepository(db.pool).enqueueItems(SPACE,[item],null);
 await db.pool.query("UPDATE source_item_annotations SET status='failed',wait_reason='budget_exhausted',attempt_count=3,episode_id=$2 WHERE source_item_id=$1",[item,episode]);
 const config={...world.config(),rainverHome:root,artifactStorageRoot:join(root,'artifacts'),sandboxRoot:join(root,'sandbox')};
 await app.close();app=buildModuleServer(config,[informationDigestModule,systemActionsModule]);
 const key=randomUUID(),writeRetry=()=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/source-annotation/retry`,headers:{'idempotency-key':key},payload:{episode_id:episode}});
 const jobs=Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n);
 await db.pool.query("CREATE FUNCTION refuse_annotation_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_annotation_retry_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_annotation_retry_audit()');
 try{
  const response=await writeRetry();expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT status,wait_reason,attempt_count FROM source_item_annotations WHERE source_item_id=$1',[item])).rows[0]).toEqual({status:'failed',wait_reason:'budget_exhausted',attempt_count:3});
  expect(Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n)).toBe(jobs);
 }finally{await db.pool.query('DROP TRIGGER refuse_annotation_retry_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_annotation_retry_audit()');}
 const first=await writeRetry();expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({reopened:1,item_ids:[item]});
 expect((await writeRetry()).json().data).toEqual(first.json().data);expect(Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n)).toBe(jobs+1);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[CONNECTION]);expect((await writeRetry()).statusCode).toBe(404);
});
it('stale annotation and composition worker claims cannot create Runs or publish results',async()=>{
 const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
 const {registerSourceAnnotationHandler}=await import('../src/modules/sourceAnnotation/job.js');
 const {JobHandlerRegistry}=await import('../src/modules/jobs/handlerRegistry.js');
 const {withJobEffectAuthority}=await import('../src/modules/jobs/effectAuthority.js');
 const {composeProjectReading}=await import('../src/modules/informationDigest/composition/service.js');
 const queue=new PgJobQueueRepository(db.pool),handlers=new JobHandlerRegistry();
 registerSourceAnnotationHandler(handlers,world.config());
 for(const type of ['source_annotation_event','project_reading_compose']){
  const job=await queue.enqueue({job_type:type,space_id:SPACE,user_id:OWNER,payload:{project_id:PROJECT,round_id:randomUUID()},max_attempts:3});
  await db.pool.query("UPDATE jobs SET status='running',claimed_by='current-worker',attempts=2 WHERE id=$1",[job.id]);
  const stale={job_id:job.id,space_id:SPACE,user_id:OWNER,job_type:type,worker_id:'old-worker',attempts:1,max_attempts:3,payload:job.payload_json};
  const before=Number((await db.pool.query('SELECT count(*) AS n FROM runs')).rows[0].n);
  if(type==='source_annotation_event')await expect(handlers.dispatch(stale)).rejects.toMatchObject({name:'JobEffectLeaseLost'});
  else await expect(withJobEffectAuthority(db.pool,stale,()=>composeProjectReading(db.pool,SPACE,PROJECT,String(stale.payload.round_id)))).rejects.toMatchObject({name:'JobEffectLeaseLost'});
  expect(Number((await db.pool.query('SELECT count(*) AS n FROM runs')).rows[0].n)).toBe(before);
  expect((await db.pool.query('SELECT * FROM project_reading_compositions')).rows).toEqual([]);
 }
});
it('fresh core start rolls back Run, operation and Job on deferred audit failure, then recovers the same key',async()=>{
 const item=await world.material('Fresh deep reading',{uri:'https://news.test/new-deep-start'}),key=randomUUID();
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,PROJECT]);
 const writeStart=()=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading/items/${item}/deep-reads`,headers:{'idempotency-key':key},payload:{agent_id:AGENT,runtime_profile_id:PROFILE}});
 const counts=async()=>Promise.all(['runs','jobs','extraction_jobs'].map(async table=>Number((await db.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)));
 const before=await counts();
 await db.pool.query("CREATE FUNCTION refuse_deep_start_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_deep_start_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_deep_start_audit()');
 try{const result=await writeStart();expect(result.statusCode,result.body).toBe(503);expect(await counts()).toEqual(before);}
 finally{await db.pool.query('DROP TRIGGER refuse_deep_start_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_deep_start_audit()');}
 const first=await writeStart();expect(first.statusCode,first.body).toBe(200);expect(first.json().data).toMatchObject({status:'queued',item_id:item});
 expect((await writeStart()).json().data).toEqual(first.json().data);expect(await counts()).toEqual(before.map(n=>n+1));
});
it.each(['source','input','claim'] as const)('annotation dispatch and result release refuse %s drift under the real owner locks',async drift=>{
 const {PgSourceAnnotationRepository}=await import('../src/modules/sourceAnnotation/repository.js');
 const {annotationPromptItem,freezeAnnotationInputs,lockAnnotationRunAuthority,assertAnnotationRunDispatch}=await import('../src/modules/sourceAnnotation/dispatch.js');
 const {PgRunRepository}=await import('../src/modules/runs/repository.js');
 const {PgJobQueueRepository}=await import('../src/modules/jobs/repository.js');
 const {withDbTransaction}=await import('../src/modules/routeUtils/common.js');
 const item=await world.material('Annotation input',{uri:'https://news.test/frozen-annotation',analysed:false}),repository=new PgSourceAnnotationRepository(db.pool);
 await repository.enqueueItems(SPACE,[item],null);
 const prompts=(await repository.loadPendingBatch(SPACE,10,[item])).map(annotationPromptItem),inputs=await freezeAnnotationInputs(db.pool,SPACE,prompts);
 expect(inputs).toHaveLength(1);
 const job=await new PgJobQueueRepository(db.pool).enqueue({job_type:'source_annotation_event',space_id:SPACE,user_id:OWNER,payload:{trigger:'manual_retry'},max_attempts:3});
 await db.pool.query("UPDATE jobs SET status='running',claimed_by='annotation-owner',attempts=1 WHERE id=$1",[job.id]);
 const claim={job_id:job.id,space_id:SPACE,user_id:OWNER,job_type:'source_annotation_event',worker_id:'annotation-owner',attempts:1,max_attempts:3,payload:{trigger:'manual_retry'}};
 const base=(await new PgRunRepository(db.pool).getRun(SPACE,run))!;
 const bound={...base,contract_snapshot_json:{...(base.contract_snapshot_json as Record<string,unknown>),workflow_input_json:{source_annotation:{items:inputs,claim}}}};
 const check=()=>withDbTransaction(db.pool,async tx=>{await lockAnnotationRunAuthority(tx,bound);await assertAnnotationRunDispatch(tx,bound);});
 await check();
 if(drift==='source')await db.pool.query("UPDATE source_connections SET consent_json=consent_json||'{\"allow_external_model_egress\":false}'::jsonb WHERE id=$1",[CONNECTION]);
 if(drift==='input')await db.pool.query("UPDATE source_items SET title='Changed prompt input' WHERE id=$1",[item]);
 if(drift==='claim')await db.pool.query("UPDATE jobs SET claimed_by='replacement',attempts=2 WHERE id=$1",[job.id]);
 await expect(check()).rejects.toMatchObject(drift==='claim'?{name:'JobEffectLeaseLost'}:{statusCode:403});
 expect((await repository.getByItemId(SPACE,item))?.status).toBe('pending');
});
it('concurrent starts under distinct keys serialize before item write locks and reuse one canonical Run and Job',async()=>{
 const item=await world.material('Concurrent deep reading',{uri:'https://news.test/concurrent-deep-start'});
 await db.pool.query('UPDATE source_items SET project_id=$2 WHERE id=$1',[item,PROJECT]);
 const counts=async()=>Number((await db.pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n),before=await counts();
 const start=()=>app.inject({method:'POST',url:`/api/v1/spaces/${SPACE}/projects/${PROJECT}/reading/items/${item}/deep-reads`,headers:{'idempotency-key':randomUUID()},payload:{agent_id:AGENT,runtime_profile_id:PROFILE}});
 const results=await Promise.all([start(),start()]);for(const result of results)expect(result.statusCode,result.body).toBe(200);
 expect(results[0].json().data.processing_id).toBe(results[1].json().data.processing_id);
 expect(results[0].json().data.run_id).toBe(results[1].json().data.run_id);expect(await counts()).toBe(before+1);
});
