import {waitForLockWaiter} from './support/lockWait.js';
import {registerRunProposalPublication} from '../src/modules/runs/proposalPublicationJob.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {RunMaterializationService} from '../src/modules/runs/materializationService.js';
import {loadConfig} from '../src/config.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {lockRequestKey} from '../src/modules/systemActions/operations/repository.js';
import {canonicalRunOutput} from '../src/modules/runs/orchestrationResults.js';
import {lockRunProposalAttachment} from '../src/modules/systemActions/operations/proposalTransitions.js';
const db=useTestDatabase(import.meta.filename);
const space=randomUUID(),owner=randomUUID(),project=randomUUID(),run=randomUUID();
const identity={spaceId:space,userId:owner};
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','policy_decision_records'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET status='running',started_at=now()-interval '2 hours',instructed_by_user_id=$2 WHERE id=$1",[run,owner]);
});
async function proposal(runId=run,spaceId=space,userId=owner){
 return insertProposalRow(db.pool,{spaceId,createdByRunId:runId,proposalType:'memory_create',title:'Run proposal',payload:{proposed_content:'Frozen'},rationale:'Run',createdByUserId:userId,visibility:'private'});
}
async function terminal(status:'failed'|'succeeded'){
 return new PgRunRepository(db.pool).markRunTerminal({space_id:space,run_id:run,status,output_json:canonicalRunOutput({success:status==='succeeded',outputText:'Keep output',outputJson:{retained:true}}),completed_at:new Date().toISOString()});
}
describe('Run Proposal lifecycle request closure',()=>{
 it.each([false,true])('recovers each Space Run atomically (rollback=%s)',async fail=>{
  if(!db.available)return;
  const s=randomUUID(),u=randomUUID(),p=randomUUID(),r=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:s,owner:u,project:p});await seedRun(db.pool,{id:r,space:s,owner:u,agent:randomUUID(),version:randomUUID()});
  await db.pool.query("UPDATE runs SET status='cancelling',started_at=now()-interval '2 hours' WHERE id=$1",[r]);
  const a=await proposal(),b=await proposal(r,s,u);
  const requests=[await linkProposalOperation(db.pool,identity,a.id),await linkProposalOperation(db.pool,{spaceId:s,userId:u},b.id)];
  if(fail){await db.pool.query("CREATE FUNCTION refuse_run_requests() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='rejected' THEN RAISE EXCEPTION 'run request refused'; END IF; RETURN NEW; END $$");await db.pool.query('CREATE TRIGGER refuse_run_requests BEFORE UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_run_requests()');}
  try{
   const recover=new PgRunRepository(db.pool).recoverStaleRuns();
   if(fail)await expect(recover).rejects.toThrow('run request refused');else expect(await recover).toBe(2);
   expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=ANY($1::varchar[])',[requests])).rows.map(row=>row.state)).toEqual([fail?'pending_approval':'rejected',fail?'pending_approval':'rejected']);
   expect((await db.pool.query('SELECT status FROM proposals WHERE id=ANY($1::varchar[])',[[a.id,b.id]])).rows.map(row=>row.status)).toEqual([fail?'pending':'rejected',fail?'pending':'rejected']);
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe(fail?'running':'orphaned');
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[r])).rows[0]!.status).toBe(fail?'cancelling':'cancelled');
  }finally{if(fail){await db.pool.query('DROP TRIGGER refuse_run_requests ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_run_requests()');}}
 });
 it.each(['key','row','proposal'] as const)('recovers another Space while one Run is busy (%s)',async busy=>{
  if(!db.available)return;
  const draft=await proposal();const id=await linkProposalOperation(db.pool,identity,draft.id);
  const row=(await db.pool.query('SELECT * FROM operation_idempotency WHERE id=$1',[id])).rows[0]!;
  const s=randomUUID(),u=randomUUID(),p=randomUUID(),r=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:s,owner:u,project:p});await seedRun(db.pool,{id:r,space:s,owner:u,agent:randomUUID(),version:randomUUID()});
  await db.pool.query("UPDATE runs SET status='running',started_at=now()-interval '2 hours' WHERE id=$1",[r]);
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');if(busy==='key')await lockRequestKey(holder,[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key]);else if(busy==='row')await holder.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[run]);else await holder.query('SELECT id FROM proposals WHERE id=$1 FOR UPDATE',[draft.id]);
   expect(await new PgRunRepository(db.pool).recoverStaleRuns()).toBe(1);
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[r])).rows[0]!.status).toBe('orphaned');
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe('running');
   expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[draft.id])).rows[0]!.status).toBe('pending');
  }finally{await holder.query('ROLLBACK');holder.release();}
 });
 it.each(['failed','succeeded'] as const)('settles staged output in the terminal CTE and preserves output (%s)',async status=>{
  if(!db.available)return;
  const draft=await proposal();const request=await linkProposalOperation(db.pool,identity,draft.id);
  // A request can have been linked while pending before a legacy publication stages it.
  await db.pool.query("UPDATE proposals SET status='staged' WHERE id=$1",[draft.id]);
  await terminal(status);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[draft.id])).rows[0]!.status).toBe(status==='failed'?'rejected':'pending');
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0]!.state).toBe(status==='failed'?'rejected':'pending_approval');
  expect((await db.pool.query('SELECT output_json FROM runs WHERE id=$1',[run])).rows[0]!.output_json).toMatchObject({result:{retained:true},summary:'Keep output'});
  const late=await insertProposalRow(db.pool,{spaceId:space,createdByRunId:run,proposalType:'memory_create',title:'Late staged',payload:{},rationale:'test',createdByUserId:owner,visibility:'private',status:'staged'});
  expect(late.status).toBe(status==='failed'?'rejected':'pending');
 });
 it('terminal admission conflicts with unfinished request attachment, without publishing partial state',async()=>{
  if(!db.available)return;
  const client=await db.pool.connect();
  try{
   await client.query('BEGIN');await lockRunProposalAttachment(client,space,run);
   await expect(terminal('failed')).rejects.toMatchObject({code:'idempotency_in_progress'});
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe('running');
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('rolls back terminal output/status with a refused linked transition',async()=>{
  if(!db.available)return;
  const draft=await proposal();const request=await linkProposalOperation(db.pool,identity,draft.id);
  await db.pool.query("UPDATE proposals SET status='staged' WHERE id=$1",[draft.id]);
  await db.pool.query("CREATE FUNCTION refuse_terminal_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'terminal refused'; END $$");await db.pool.query('CREATE TRIGGER refuse_terminal_request BEFORE UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_terminal_request()');
  try{
   await expect(terminal('failed')).rejects.toThrow('terminal refused');
   expect((await db.pool.query('SELECT status,output_json FROM runs WHERE id=$1',[run])).rows[0]).toEqual({status:'running',output_json:null});
   expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0]!.state).toBe('pending_approval');
   expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[draft.id])).rows[0]!.status).toBe('staged');
  }finally{await db.pool.query('DROP TRIGGER refuse_terminal_request ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_terminal_request()');}
 });
});

describe('Run composition and materialization audit boundary',()=>{
 it('refuses linked terminalization by an unprepared outer transaction before trying any key',async()=>{
  if(!db.available)return;
  const draft=await proposal();const id=await linkProposalOperation(db.pool,identity,draft.id);
  const row=(await db.pool.query('SELECT * FROM operation_idempotency WHERE id=$1',[id])).rows[0]!;
  const holder=await db.pool.connect(),client=await db.pool.connect();
  try{
   await holder.query('BEGIN');await lockRequestKey(holder,[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key]);
   await client.query('BEGIN');await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[run]);
   await expect(new PgRunRepository(client).markRunTerminal({space_id:space,run_id:run,status:'failed',completed_at:new Date().toISOString()})).rejects.toMatchObject({code:'operation_approval_mapping_unavailable',httpStatus:503,retryable:false});
   await client.query('ROLLBACK');
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe('running');
   expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[id])).rows[0]!.state).toBe('pending_approval');
  }finally{await client.query('ROLLBACK');client.release();await holder.query('ROLLBACK');holder.release();}
 });
 it.each(['success','proposalFailure','auditFailure'] as const)('materializes the Proposal and mandatory audit together (%s)',async mode=>{
  if(!db.available)return;
  const current=(await new PgRunRepository(db.pool).getRun(space,run))!;
  if(mode!=='success'){
   const table=mode==='auditFailure'?'policy_decision_records':'proposals';
   await db.pool.query("CREATE FUNCTION refuse_materialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'materialization refused'; END $$");
   await db.pool.query(`CREATE TRIGGER refuse_materialization BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_materialization()`);
  }
  try{
   const result=await new RunMaterializationService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),db.pool).materializeAdapterResult({run:current,adapterResult:{runtime_key:current.runtime_key!,adapter_kind:'local_cli',success:true,output_text:'Draft',output_json:{proposed_changes:[{proposal_type:'memory_create',payload_json:{proposed_content:'Draft memory'}}]},exit_code:0}},{proposal_status:'staged'});
   expect(result.items).toMatchObject([{kind:'proposal',status:mode==='success'?'succeeded':'failed'}]);
   expect((await db.pool.query('SELECT id FROM proposals')).rows).toHaveLength(mode==='success'?1:0);
   const audits=(await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE run_id=$1 AND action='proposal.create'",[run])).rows;
   expect(audits).toHaveLength(mode==='auditFailure'?0:1);
   if(mode==='proposalFailure')expect(audits[0]!.metadata_json.operation_outcome).toBe('failed');
  }finally{if(mode!=='success'){await db.pool.query(`DROP TRIGGER refuse_materialization ON ${mode==='auditFailure'?'policy_decision_records':'proposals'}`);await db.pool.query('DROP FUNCTION refuse_materialization()');}}
 });
});

describe('unlinked production termination progress',()=>{
 it('cancels the Job Run while staged insertion is uncommitted; required publication intent later converges',async()=>{
  if(!db.available)return;
  const queue=new PgJobQueueRepository(db.pool);
  const job=await queue.enqueue({job_type:'agent_run',space_id:space,user_id:owner,payload:{run_id:run}});
  const client=await db.pool.connect();
  try{
   await client.query('BEGIN');
   const draft=await insertProposalRow(client,{spaceId:space,createdByRunId:run,proposalType:'memory_create',title:'Concurrent output',payload:{},rationale:'test',createdByUserId:owner,visibility:'private',status:'staged'});
   const cancelled=queue.cancelJob(job.id,null);
   await waitForLockWaiter(db.pool);
   await client.query('COMMIT');
   expect(await cancelled).toBe(true);
   expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe('cancelled');
   const intent=(await db.pool.query("SELECT * FROM jobs WHERE job_type='run_proposal_publication' AND payload_json->>'proposal_id'=$1",[draft.id])).rows[0]!;
   expect(intent).toBeDefined();
   const handlers=new JobHandlerRegistry();registerRunProposalPublication(handlers,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
   await handlers.dispatch({job_id:intent.id,space_id:space,user_id:owner,job_type:intent.job_type,attempts:1,max_attempts:3,worker_id:'test',payload:intent.payload_json});
   expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[draft.id])).rows[0]!.status).toBe('rejected');
  }finally{await client.query('ROLLBACK');client.release();}
 });
});

describe('publication intent atomicity',()=>{
 it('rolls back staged insertion when its required Job cannot be written',async()=>{
  if(!db.available)return;
  await db.pool.query("CREATE FUNCTION refuse_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_type='run_proposal_publication' THEN RAISE EXCEPTION 'intent refused'; END IF; RETURN NEW; END $$");
  await db.pool.query('CREATE TRIGGER refuse_publication_intent BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_publication_intent()');
  try{
   await expect(insertProposalRow(db.pool,{spaceId:space,createdByRunId:run,proposalType:'memory_create',title:'Intent',payload:{},rationale:'test',createdByUserId:owner,visibility:'private',status:'staged'})).rejects.toThrow('intent refused');
   expect((await db.pool.query('SELECT id FROM proposals')).rows).toEqual([]);
  }finally{await db.pool.query('DROP TRIGGER refuse_publication_intent ON jobs');await db.pool.query('DROP FUNCTION refuse_publication_intent()');}
 });
});


describe('R1 concurrent unlinked terminal admission',()=>{
 const terminalInput=(status:'succeeded'|'failed')=>({space_id:space,run_id:run,status,completed_at:new Date().toISOString(),
  output_json:canonicalRunOutput({success:status==='succeeded',outputText:status,outputJson:{writer:status}})});
 it.each([
  ['markRunTerminal','markRunTerminal'],['publishRunTerminal','publishRunTerminal'],
  ['markRunTerminal','publishRunTerminal'],['publishRunTerminal','markRunTerminal'],
 ] as const)('%s and %s serialize; the later terminal is a real noop',async(firstMethod,secondMethod)=>{
  if(!db.available)return;
  const client=await db.pool.connect();
  let raced:Promise<unknown>|undefined;
  try{
   await client.query('BEGIN');
   const first=await new PgRunRepository(client)[firstMethod](terminalInput('succeeded'));
   expect(first?.status).toBe('succeeded');
   const snapshot=(await client.query('SELECT status,output_json,ended_at,updated_at FROM runs WHERE id=$1',[run])).rows[0];
   raced=new PgRunRepository(db.pool)[secondMethod](terminalInput('failed'));
   // Attach both handlers immediately; an unexpected early 409 cannot become
   // an unhandled rejection or masquerade as a successful contention check.
   const outcome=raced.then(value=>({value,error:null}),error=>({value:undefined,error}));
   await waitForLockWaiter(db.pool);
   await client.query('COMMIT');
   expect(await outcome).toEqual({value:null,error:null});
   expect((await db.pool.query('SELECT status,output_json,ended_at,updated_at FROM runs WHERE id=$1',[run])).rows[0]).toEqual(snapshot);
  }finally{await client.query('ROLLBACK');client.release();await raced?.catch(()=>undefined);}
 });
 it.each(['cancel-first','background-first'] as const)('real Job cancel owner races with background terminal (%s)',async order=>{
  if(!db.available)return;
  const job=await new PgJobQueueRepository(db.pool).enqueue({job_type:'agent_run',space_id:space,user_id:owner,payload:{run_id:run}});
  const client=await db.pool.connect();let raced:Promise<unknown>|undefined;
  try{
   await client.query('BEGIN');
   if(order==='cancel-first')expect(await new PgJobQueueRepository(client).cancelJob(job.id,null)).toBe(true);
   else expect((await new PgRunRepository(client).publishRunTerminal(terminalInput('succeeded')))?.status).toBe('succeeded');
   const snapshot=(await client.query('SELECT status,output_json,ended_at,updated_at FROM runs WHERE id=$1',[run])).rows[0];
   raced=order==='cancel-first'?new PgRunRepository(db.pool).publishRunTerminal(terminalInput('failed')):new PgJobQueueRepository(db.pool).cancelJob(job.id,null);
   const outcome=raced.then(value=>({value,error:null}),error=>({value:undefined,error}));
   await waitForLockWaiter(db.pool);await client.query('COMMIT');
   expect(await outcome).toEqual({value:order==='cancel-first'?null:true,error:null});
   expect((await db.pool.query('SELECT status,output_json,ended_at,updated_at FROM runs WHERE id=$1',[run])).rows[0]).toEqual(snapshot);
   expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0]!.status).toBe('cancelled');
  }finally{await client.query('ROLLBACK');client.release();await raced?.catch(()=>undefined);}
 });
 it.each(['terminal-first','attachment-first'] as const)('attachment fence preserves frozen evidence (%s)',async order=>{
  if(!db.available)return;
  const draft=await proposal();const client=await db.pool.connect();
  const before=(await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[draft.id])).rows[0]!.payload_json;
  try{
   await client.query('BEGIN');
   if(order==='terminal-first'){
    await new PgRunRepository(client).markRunTerminal(terminalInput('failed'));
    await expect(linkProposalOperation(db.pool,identity,draft.id)).rejects.toMatchObject({code:'idempotency_in_progress'});
    expect((await db.pool.query('SELECT id FROM operation_idempotency WHERE proposal_id=$1',[draft.id])).rows).toEqual([]);
   }else{
    await linkProposalOperation(client,identity,draft.id);
    await expect(terminal('failed')).rejects.toMatchObject({code:'idempotency_in_progress'});
    expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[run])).rows[0]!.status).toBe('running');
    expect((await client.query('SELECT state,frozen_json FROM operation_idempotency WHERE proposal_id=$1',[draft.id])).rows[0]).toMatchObject({state:'pending_approval',frozen_json:{payload:before}});
   }
   await client.query('COMMIT');
   expect((await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[draft.id])).rows[0]!.payload_json).toEqual(before);
  }finally{await client.query('ROLLBACK');client.release();}
 });
});
