import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedRun,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {runsModule} from '../src/modules/runs/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';

/** Person Run controls through the core: one transaction for the state change and its Job; process and finalization work after commit. */
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,run:string,app:ReturnType<typeof buildModuleServer>;
const call=(method:'POST'|'PATCH',command:string,payload:object={},key:string=randomUUID(),runId=run)=>app.inject({method,url:`/api/v1/runs/${runId}/${command}`,payload,headers:{'idempotency-key':key}});
const state=async()=>(await db.pool.query('SELECT status,error_json FROM runs WHERE id=$1',[run])).rows[0];
const jobs=async()=>(await db.pool.query("SELECT status FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1",[run])).rows;

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','jobs'],{cascade:true});
 space=randomUUID();owner=randomUUID();run=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project:randomUUID(),spaceType:'personal'});
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[runsModule,systemActionsModule]);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});

describe('Run controls through the operation core (real PostgreSQL)',()=>{
 it('queues a queued Run for its Job instead of executing it in the request, once per key',async()=>{
  await db.pool.query("UPDATE runs SET status='queued' WHERE id=$1",[run]);
  const key=randomUUID(),first=await call('POST','execute',{},key);
  expect(first.statusCode,first.body).toBe(202);
  expect(first.json().data).toMatchObject({run_id:run,job_id:expect.any(String)});
  expect((await call('POST','execute',{},key)).json()).toEqual(first.json());
  expect(await jobs()).toEqual([{status:'pending'}]);
  expect((await state()).status).toBe('queued');
  // The historical runtime override stays refused.
  expect((await app.inject({method:'POST',url:`/api/v1/runs/${run}/execute?runtime=codex`,payload:{},headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(422);
  await db.pool.query("UPDATE runs SET status='succeeded' WHERE id=$1",[run]);
  const terminal=await call('POST','execute');
  expect(terminal.statusCode).toBe(409);expect(terminal.json().error.domain).toBe('runs');
 });

 it('stops a queued Run: the cancellation intent commits, then the stop settles it before the reply',async()=>{
  await db.pool.query("UPDATE runs SET status='queued' WHERE id=$1",[run]);
  const stopped=await call('PATCH','stop',{reason:'No longer needed'});
  expect(stopped.statusCode,stopped.body).toBe(200);
  expect(stopped.json().data).toMatchObject({run_id:run,status:'cancelling'});
  expect(await state()).toMatchObject({status:'cancelled',error_json:expect.objectContaining({error_code:'run_cancelled',error_text:'No longer needed'})});
  // Stopping a terminal Run changes nothing and says so.
  expect((await call('PATCH','stop')).json().data).toMatchObject({status:'cancelled'});
 });

 it('abandons a reviewed Run under its terminal owner, retiring linked approval work atomically',async()=>{
  await db.pool.query("UPDATE runs SET status='waiting_for_review',error_json='{\"supervisor_review\":true}'::jsonb WHERE id=$1",[run]);
  const proposal=await insertProposalRow(db.pool,{spaceId:space,createdByRunId:run,proposalType:'memory_create',title:'Staged',payload:{proposed_content:'x'},rationale:'Fixture',createdByUserId:owner,visibility:'private'});
  await linkProposalOperation(db.pool,{spaceId:space,userId:owner},proposal.id);
  const abandoned=await call('POST','abandon',{reason:'Wrong direction'});
  expect(abandoned.statusCode,abandoned.body).toBe(202);
  expect(abandoned.json().data).toMatchObject({run_id:run,status:'cancelled'});
  expect(await state()).toMatchObject({status:'cancelled',error_json:expect.objectContaining({error_code:'run_abandoned',error_text:'Wrong direction'})});
  // Finalization ran after commit.
  expect((await db.pool.query('SELECT count(*)::int AS n FROM run_finalizations WHERE run_id=$1',[run])).rows[0].n).toBeGreaterThan(0);
  const again=await call('POST','abandon');
  expect(again.statusCode).toBe(409);
 });

 it('resumes a supervisor-reviewed Run with its Job in one transaction and finalizes only terminal Runs',async()=>{
  expect((await call('POST','finalize')).statusCode).toBe(200);
  await db.pool.query("UPDATE runs SET status='waiting_for_review',error_json='{\"supervisor_review\":true}'::jsonb WHERE id=$1",[run]);
  expect((await call('POST','finalize')).statusCode).toBe(422);
  const key=randomUUID(),resumed=await call('POST','resume',{},key);
  expect(resumed.statusCode,resumed.body).toBe(202);
  expect(resumed.json().data).toMatchObject({run_id:run,resume_kind:'new_attempt'});
  expect((await state()).status).toBe('queued');
  expect(await jobs()).toEqual([{status:'pending'}]);
  // The committed resume replays its receipt although the Run is no longer waiting; a new resume is refused.
  const replayed=await call('POST','resume',{},key);
  expect(replayed.statusCode,replayed.body).toBe(202);
  expect(replayed.json()).toEqual(resumed.json());
  expect(await jobs()).toEqual([{status:'pending'}]);
  expect((await call('POST','resume')).statusCode).toBe(409);
 });

 it('replays an approval resume only while the person still holds approval authority for its risk',async()=>{
  await db.pool.query(`UPDATE runs SET status='waiting_for_review',error_json='{"error_code":"needs_medium_approval","risk_level":"medium"}'::jsonb WHERE id=$1`,[run]);
  const key=randomUUID(),resumed=await call('POST','resume',{},key);
  expect(resumed.statusCode,resumed.body).toBe(202);
  expect(resumed.json().data).toMatchObject({run_id:run,resume_kind:'same_attempt'});
  expect((await db.pool.query(`SELECT permission_snapshot_json->'policy_grants' AS grants FROM runs WHERE id=$1`,[run])).rows[0].grants)
   .toEqual([expect.objectContaining({approval_code:'needs_medium_approval',risk_level:'medium',granted_by_user_id:owner})]);
  expect((await call('POST','resume',{},key)).json()).toEqual(resumed.json());
  // Approval authority withdrawn: the receipt is no longer released.
  await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`,[space,owner]);
  expect((await call('POST','resume',{},key)).statusCode).toBe(404);
 });
});
