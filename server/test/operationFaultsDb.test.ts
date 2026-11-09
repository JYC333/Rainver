import {once} from 'node:events';
import {PgRunToolIdentityRepository} from '../src/modules/runs/runToolIdentityRepository.js';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {buildServerDist,until} from './support/briefingWorkerHarness.js';
import {operationFaultProcess,holdCommitAcknowledgement} from './support/operationFaultHarness.js';
import {loadConfig} from '../src/config.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,operation:string,home:string;
const children:ReturnType<typeof operationFaultProcess>[]=[];
beforeAll(async()=>{if(!db.available)return;await buildServerDist();
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url)),'-p',fileURLToPath(new URL('../../packages/agent-cli/tsconfig.build.json',import.meta.url))]);
  home=await mkdtemp(join(tmpdir(),'operation-fault-'));});
afterAll(async()=>{if(home)await rm(home,{recursive:true,force:true});});
afterEach(async()=>{await Promise.all(children.splice(0).map(child=>child.kill()));});
beforeEach(async()=>{
  if(!db.available)return;
  await resetTables(db.pool,['spaces','users'],{cascade:true});
  space=randomUUID();owner=randomUUID();project=randomUUID();operation=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space,owner,project});
  await db.pool.query("INSERT INTO project_operations(id,space_id,project_id,kind,title,status,created_by_user_id,progress_json,version,created_at,updated_at) VALUES($1,$2,$3,'research','Fault pilot','active',$4,'{}'::jsonb,1,now(),now())",[operation,space,project,owner]);
});
function child(options:Record<string,unknown>={}) {
  const instance=operationFaultProcess({url:db.connectionUri,home,identity:{spaceId:space,userId:owner},...options});children.push(instance);return instance;
}
function request(address:string,key:string,legacy=false) {
  return fetch(address+(legacy?`/api/v1/projects/${project}/research/operations/${operation}/cancel`:'/api/v1/actions/research.cancel_acquisition'),{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(legacy?{reason:'fault'}:{operation_id:operation,project_id:project,reason:'fault'})})
    .then(async response=>({status:response.status,body:await response.json()}),()=>({status:0,body:null}));
}
async function retry(key:string) {
  return (await operationRuntime(loadConfig({SERVER_DATABASE_URL:db.connectionUri}))).execute('research.cancel_acquisition',{operation_id:operation,project_id:project,reason:'fault'},sessionActor({spaceId:space,userId:owner}),randomUUID(),key);
}
async function assertCommittedOnce(key:string) {
  const result=await retry(key);expect(result.http_status).toBe(200);
  expect(result.body).toMatchObject({status:'succeeded',data:{already_terminal:false}});
  expect((await db.pool.query('SELECT status,version FROM project_operations WHERE id=$1',[operation])).rows[0]).toMatchObject({status:'cancelled',version:2});
  expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='research_operation_cancel'",[])).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE idempotency_key=$1',[key])).rows).toEqual([{state:'succeeded'}]);
}
async function sleepingBackend(tag:string) {
  return (await until(()=>db.pool.query<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event='PgSleep'",[tag]),r=>r.rows.length>0,'real transaction reached enqueue trigger')).rows[0].pid;
}
async function enqueueBarrier() {
  await db.pool.query("CREATE FUNCTION hold_cancel_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER hold_cancel_enqueue BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION hold_cancel_enqueue()');
}
async function removeBarrier(){await db.pool.query('DROP TRIGGER hold_cancel_enqueue ON jobs');await db.pool.query('DROP FUNCTION hold_cancel_enqueue()');}
describe('operation process/connection failure acceptance (real PG)',()=>{
  it('SIGKILL before COMMIT rolls back status, Job, audit and reservation; same key retries once',async()=>{
    const key=randomUUID(),tag=randomUUID(),url=new URL(db.connectionUri);url.searchParams.set('application_name',tag);
    await enqueueBarrier();const process=child({url:url.toString()});
    try {
      const ready=await process.next('ready'),pending=request(ready.address!,key);
      await sleepingBackend(tag);await process.kill();await pending;
      await until(()=>db.pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[tag]),r=>r.rows.length===0,'killed client backends released');
      expect((await db.pool.query('SELECT status,version FROM project_operations WHERE id=$1',[operation])).rows[0]).toMatchObject({status:'active',version:1});
      expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
      expect((await db.pool.query('SELECT id FROM policy_decision_records WHERE space_id=$1',[space])).rows).toHaveLength(0);
    } finally {await process.kill();await removeBarrier();}
    await assertCommittedOnce(key);
  });
  it('PG backend termination before COMMIT withholds success and leaves a retryable atomic request',async()=>{
    const key=randomUUID(),tag=randomUUID(),url=new URL(db.connectionUri);url.searchParams.set('application_name',tag);
    await enqueueBarrier();const process=child({url:url.toString()});
    try {
      const ready=await process.next('ready'),pending=request(ready.address!,key);
      await db.pool.query('SELECT pg_terminate_backend($1)',[await sleepingBackend(tag)]);
      const result=await pending;expect(result.status,process.errors.join('')).toBe(503);
      expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[operation])).rows[0].status).toBe('active');
      expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(0);
    } finally {await process.kill();await removeBarrier();}
    await assertCommittedOnce(key);
  });
  it('SIGKILL after COMMIT before HTTP response replays the original receipt and leaves a discoverable Job',async()=>{
    const key=randomUUID(),process=child({holdResponse:true});
    const ready=await process.next('ready'),pending=request(ready.address!,key);
    await process.next('responseHeld');await process.kill();expect((await pending).status).toBe(0);
    await assertCommittedOnce(key);
    const queue=new PgJobQueueRepository(db.pool),job=await queue.claimNext('replacement',['research_operation_cancel']);
    expect(job?.payload_json).toMatchObject({operation_id:operation});
  });
  it('lost PostgreSQL COMMIT acknowledgement resolves by the durable key without a second write or audit',async()=>{
    const relay=await holdCommitAcknowledgement(db.connectionUri),key=randomUUID(),process=child({url:relay.url});
    try {
      const ready=await process.next('ready'),pending=request(ready.address!,key);
      let ack=false;void relay.committed.then(()=>{ack=true;});await until(async()=>ack,Boolean,'real COMMIT acknowledgement held');
      await process.kill();expect((await pending).status).toBe(0);
      expect((await db.pool.query('SELECT id FROM policy_decision_records WHERE space_id=$1',[space])).rows).toHaveLength(1);
      await assertCommittedOnce(key);
      // Replay has its own admission decision; no extra failure reconciliation decision exists.
      expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'operation_outcome'='failed'",[space])).rows).toHaveLength(0);
    } finally {await process.kill();await relay.close();}
  });
  it('lost COMMIT connection with a surviving server returns 503 and reconciles the committed audit/key',async()=>{
    const relay=await holdCommitAcknowledgement(db.connectionUri),key=randomUUID(),process=child({url:relay.url});
    try {
      const ready=await process.next('ready'),pending=request(ready.address!,key);
      let ack=false;void relay.committed.then(()=>{ack=true;});await until(async()=>ack,Boolean,'real COMMIT completed before socket drop');
      relay.disconnect();
      const response=await pending;expect(response.status,process.errors.join('')).toBe(503);
      expect(response.body).toMatchObject({error:{code:'operation_temporarily_unavailable',retryable:true}});
      expect(process.child.exitCode).toBeNull();
      expect((await db.pool.query('SELECT id FROM policy_decision_records WHERE space_id=$1',[space])).rows).toHaveLength(1);
      expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'operation_outcome'='failed'",[space])).rows).toHaveLength(0);
      await assertCommittedOnce(key);
    } finally {await process.kill();await relay.close();}
  });
  it('a replacement worker reclaims killed work and does not repeat the completed cancellation effect',async()=>{
    const key=randomUUID();await assertCommittedOnce(key);
    const batch=await new PgJobQueueRepository(db.pool).enqueue({job_type:'source_post_processing_event',space_id:space,user_id:owner,payload:{phase:'research_recovery',recovery_for_operation_id:operation},scheduled_at:new Date(Date.now()+3600000)});
    const first=child({workerLoop:true,holdWorker:true}),effect=await first.next('effect');
    expect(effect.result?.cancelled_batches).toBe(1);await first.kill();
    const queue=new PgJobQueueRepository(db.pool);await queue.reclaimStuckJobs(1,new Date(Date.now()+5000));
    const second=child({workerLoop:true}),done=await second.next('workerDone');expect(done.job).toBe(effect.job);expect(done.result?.cancelled_batches).toBe(0);
    expect((await db.pool.query('SELECT status,attempts FROM jobs WHERE id=$1',[done.job])).rows[0]).toMatchObject({status:'completed',attempts:2});
    expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[batch.id])).rows[0].status).toBe('cancelled');
  });
});


it('runs the pre-core server code against the additive schema and interleaves old/new cancellation receipts',async()=>{
  // Immutable pre-core source, compiled with installed workspace dependencies. No product database or worktree mutation.
  const root=fileURLToPath(new URL('../../',import.meta.url)),old=await mkdtemp(join(home,'pre-core-'));
  const archive=execFileSync('git',['archive','95d61d90','server/src','server/tsconfig.json','server/package.json'],{cwd:root,maxBuffer:64*1024*1024});
  execFileSync('tar',['-x','-C',old],{input:archive});
  await symlink(join(root,'node_modules'),join(old,'node_modules'),'dir');
  await symlink(join(root,'server/node_modules'),join(old,'server/node_modules'),'dir');
  await promisify(execFile)(process.execPath,[join(root,'server/node_modules/typescript/bin/tsc'),'-p',join(old,'server/tsconfig.json')],{maxBuffer:16*1024*1024});
  const legacy=child({legacy:true,dist:pathToFileURL(join(old,'server/dist/')).href}),ready=await legacy.next('ready');
  const oldResult=await request(ready.address!,randomUUID(),true);expect(oldResult.status).toBe(200);expect(oldResult.body).toMatchObject({already_terminal:false});
  const modern=await retry(randomUUID());expect(modern.body).toMatchObject({data:{already_terminal:true}});
  expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='research_operation_cancel'")).rows).toHaveLength(1);
  // Old code does not touch the new request table, and still reads the new server's terminal result.
  expect((await db.pool.query('SELECT id FROM operation_idempotency')).rows).toHaveLength(1);
  expect((await request(ready.address!,randomUUID(),true)).body).toMatchObject({already_terminal:true});
});


it.each(['http','file-bridge'])('real CLI explicit-key replay after %s response loss keeps old Run grants and one Job',async transport=>{
  const run=randomUUID(),agent=randomUUID(),key=randomUUID();
  await seedRun(db.pool,{id:run,space,owner,agent,version:randomUUID()});
  await db.pool.query("UPDATE runs SET status='running',project_id=$2,instructed_by_user_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1",[run,project,owner,JSON.stringify({tool_grants:[{action_id:'research.cancel_acquisition'}]})]);
  const identities=new PgRunToolIdentityRepository(db.pool),token=await identities.issue({id:run,space_id:space},60000);
  const server=child({tools:true,holdResponse:transport==='http'}),ready=await server.next('ready');
  const identity={apiUrl:ready.address!,runId:run,token};
  const launch=(environment:Record<string,string>)=>{
    const cli=spawn(process.execPath,[fileURLToPath(new URL('../../packages/agent-cli/dist/rainver.js',import.meta.url)),'call','research.cancel_acquisition','--idempotency-key',key,JSON.stringify({operation_id:operation,reason:'fault'})],{env:{PATH:process.env.PATH,...environment},stdio:['ignore','pipe','pipe']});
    let output='';cli.stdout.on('data',data=>{output+=String(data);});
    return {cli,done:once(cli,'exit').then(([code])=>({code,output}))};
  };
  let bridge:ReturnType<typeof child>|undefined;
  if(transport==='file-bridge')bridge=child({bridge:true,toolIdentity:identity,holdBridge:true});
  const first=launch(bridge?{RAINVER_TOOL_BRIDGE:(await bridge.next('ready')).address!}:{RAINVER_API_URL:identity.apiUrl,RAINVER_RUN_ID:run,RAINVER_TOOL_TOKEN:token});
  try {
    await (bridge??server).next(bridge?'bridgeResponseHeld':'responseHeld');
    await (bridge??server).kill();
    // A Host killed before publishing its response leaves the CLI uncertain; it never resends the write.
    if(bridge)first.cli.kill('SIGKILL');
    expect((await first.done).code).not.toBe(0);
    expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='research_operation_cancel'",[space])).rows).toHaveLength(1);
    const replacement=transport==='http'?child({tools:true}):server;
    const api=(await replacement.next('ready')).address!;
    const retryBridge=transport==='file-bridge'?child({bridge:true,toolIdentity:{...identity,apiUrl:api}}):undefined;
    const repeated=launch(retryBridge?{RAINVER_TOOL_BRIDGE:(await retryBridge.next('ready')).address!}:{RAINVER_API_URL:api,RAINVER_RUN_ID:run,RAINVER_TOOL_TOKEN:token});
    const receipt=await repeated.done;expect(receipt.code,receipt.output).toBe(0);expect(JSON.parse(receipt.output)).toMatchObject({operation_id:operation,already_terminal:false});
    expect((await db.pool.query("SELECT id FROM jobs WHERE space_id=$1 AND job_type='research_operation_cancel'",[space])).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE idempotency_key=$1',[key])).rows).toHaveLength(1);
    // The restarted server still enforces expiry/revocation, rather than treating its replay as authority.
    await db.pool.query("UPDATE run_tool_identities SET expires_at=now()-interval '1 second' WHERE run_id=$1",[run]);
    const expired=launch({RAINVER_API_URL:api,RAINVER_RUN_ID:run,RAINVER_TOOL_TOKEN:token});
    expect((await expired.done).code).not.toBe(0);
  } finally {if(first.cli.exitCode===null&&first.cli.signalCode===null)first.cli.kill('SIGKILL');await first.done;}
});
