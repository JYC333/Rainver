import {ProjectResearchOrchestrator} from '../src/modules/projectResearch/orchestrator.js';
import {operationTransaction} from '../src/db/operationTransaction.js';
import {AutonomyRecoveryService} from '../src/modules/autonomy/recoveryService.js';
import {createHash} from 'node:crypto';
import {lockRequestKey,canonical} from '../src/modules/systemActions/operations/repository.js';
import {enforce} from '../src/modules/policy/service.js';
import {loadActionRegistry} from '../src/modules/policy/actionRegistry.js';
import {loadConfig} from '../src/config.js';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,describe,it,expect} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedRun} from './support/domainSeeds.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {waitForLockWaiter} from './support/lockWait.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {withRunTerminalOwner} from '../src/modules/systemActions/operations/proposalTransitions.js';
import type {Queryable} from '../src/modules/routeUtils/common.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
const db=useTestDatabase(import.meta.filename);
const space=randomUUID(),owner=randomUUID(),project=randomUUID();
beforeEach(async()=>{if(!db.available)return;await resetTables(db.pool,['spaces','users'],{cascade:true});await seedSpaceOwnerProject(db.pool,{space,owner,project});});
async function fixture(staged=true,context={space,owner,project}){
 const {space,owner}=context;
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET status='running',started_at=now()-interval '2 hours' WHERE id=$1",[run]);
 const proposal=await insertProposalRow(db.pool,{spaceId:space,createdByRunId:run,proposalType:'memory_create',title:'Linked draft',payload:{proposed_content:'Frozen'},rationale:'test',createdByUserId:owner,visibility:'private'});
 const request=await linkProposalOperation(db.pool,{spaceId:space,userId:owner},proposal.id);
 if(staged)await db.pool.query("UPDATE proposals SET status='staged' WHERE id=$1",[proposal.id]);
 const job=await new PgJobQueueRepository(db.pool).enqueue({job_type:'agent_run',space_id:space,user_id:owner,payload:{run_id:run}});
 return {run,proposal:proposal.id,request,job:job.id};
}
async function state(f:Awaited<ReturnType<typeof fixture>>){return (await db.pool.query(`SELECT r.status AS run,p.status AS proposal,i.state AS request,j.status AS job FROM runs r JOIN proposals p ON p.id=$2 JOIN operation_idempotency i ON i.id=$3 JOIN jobs j ON j.id=$4 WHERE r.id=$1`,[f.run,f.proposal,f.request,f.job])).rows[0];}
describe('linked Run backing Job transaction owners',()=>{
 it.each(['cancel','exhaust'] as const)('atomically settles linked staged output with the backing Job (%s)',async kind=>{
  if(!db.available)return;const f=await fixture();const queue=new PgJobQueueRepository(db.pool);
  if(kind==='exhaust')await db.pool.query("UPDATE jobs SET status='running',attempts=max_attempts,updated_at=now()-interval '2 hours' WHERE id=$1",[f.job]);
  if(kind==='cancel')expect(await queue.cancelJob(f.job,null)).toBe(true);else expect((await queue.reclaimStuckJobs()).exhausted_jobs.map(j=>j.id)).toContain(f.job);
  expect(await state(f)).toEqual({run:kind==='cancel'?'cancelled':'failed',proposal:'rejected',request:'rejected',job:kind==='cancel'?'cancelled':'failed'});
 });
 it.each(['cancel','exhaust'] as const)('rolls back Job and Run when linked request storage fails (%s)',async kind=>{
  if(!db.available)return;const f=await fixture();
  if(kind==='exhaust')await db.pool.query("UPDATE jobs SET status='running',attempts=max_attempts,updated_at=now()-interval '2 hours' WHERE id=$1",[f.job]);
  const before=await state(f);
  await db.pool.query("CREATE FUNCTION reject_owner_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owner request refused'; END $$");await db.pool.query('CREATE TRIGGER reject_owner_request BEFORE UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION reject_owner_request()');
  try{const q=new PgJobQueueRepository(db.pool);await expect(kind==='cancel'?q.cancelJob(f.job,null):q.reclaimStuckJobs()).rejects.toThrow('owner request refused');expect(await state(f)).toEqual(before);}
  finally{await db.pool.query('DROP TRIGGER reject_owner_request ON operation_idempotency');await db.pool.query('DROP FUNCTION reject_owner_request()');}
 });
 it('keeps existing pending review semantics when cancelling its linked Run',async()=>{
  if(!db.available)return;const f=await fixture(false);expect(await new PgJobQueueRepository(db.pool).cancelJob(f.job,null)).toBe(true);
  expect(await state(f)).toEqual({run:'cancelled',proposal:'pending',request:'pending_approval',job:'cancelled'});
 });
 it('rejects a changed Job Run reference without taking a late key or committing partial cancellation',async()=>{
  if(!db.available)return;const a=await fixture(),b=await fixture();const blocker=await db.pool.connect();let pending:Promise<unknown>|undefined;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[a.job]);
   pending=new PgJobQueueRepository(db.pool).cancelJob(a.job,null);const result=expect(pending).rejects.toMatchObject({code:'operation_conflict'});
   await waitForLockWaiter(db.pool);await blocker.query("UPDATE jobs SET payload_json=jsonb_set(payload_json,'{run_id}',to_jsonb($2::text)) WHERE id=$1",[a.job,b.run]);await blocker.query('COMMIT');
   await result;expect((await state(a)).job).toBe('pending');expect((await state(a)).run).toBe('running');expect((await state(b)).run).toBe('running');
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined);}
 });
 it('cannot forge or retain a prepared transaction port beyond its owner lifetime',async()=>{
  if(!db.available)return;const f=await fixture(false);let expired:Queryable|undefined;
  await withRunTerminalOwner(db.pool,async()=>[{id:f.run,space_id:space}],async port=>{expired=port;return undefined;});
  await expect(new PgRunRepository(expired!).markRunTerminal({run_id:f.run,space_id:space,status:'cancelled',completed_at:new Date().toISOString()})).rejects.toThrow('expired');
 });
});

describe('Project archive linked Workflow Run owner',()=>{
 it.each([false,true])('rolls Project/Workflow/Run/request together (rollback=%s)',async fail=>{
  if(!db.available)return;const f=await fixture();const asset=randomUUID(),version=randomUUID(),automation=randomUUID(),execution=randomUUID();
  const agent=(await db.pool.query('SELECT agent_id FROM runs WHERE id=$1',[f.run])).rows[0]!.agent_id;
  await db.pool.query("INSERT INTO evolvable_assets(id,space_id,asset_type,asset_key,display_name,owner_scope_type,owner_scope_id,status,metadata_json,created_at,updated_at) VALUES($1,$2,'workflow_template',$1,'Archive workflow','space',$2,'active','{}',now(),now())",[asset,space]);
  await db.pool.query("INSERT INTO evolvable_asset_versions(id,asset_id,space_id,scope_type,scope_id,version,status,source,content_json,created_at,updated_at) VALUES($1,$2,$3,'space',$3,1,'approved','user_authored','{}',now(),now())",[version,asset,space]);
  await db.pool.query("INSERT INTO automations(id,space_id,owner_user_id,agent_id,name,trigger_type,status,config_json,project_id,created_at,updated_at) VALUES($1,$2,$3,$4,'Archive workflow','manual','active','{}',$5,now(),now())",[automation,space,owner,agent,project]);
  await db.pool.query("INSERT INTO workflow_executions(id,space_id,automation_id,workflow_version_id,status,root_run_id,trigger_type,input_json,definition_json,resolution_trace_json,budget_snapshot_json,responsible_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'running',$5,'manual','{}','{}','[]','{}',$6,now(),now())",[execution,space,automation,version,f.run,owner]);
  if(fail){await db.pool.query("CREATE FUNCTION reject_archive_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive request refused'; END $$");await db.pool.query('CREATE TRIGGER reject_archive_request BEFORE UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION reject_archive_request()');}
  try{
   const result=new PgProjectRepository(db.pool).archive({spaceId:space,userId:owner},project);
   if(fail)await expect(result).rejects.toThrow('archive request refused');else await result;
   expect((await db.pool.query('SELECT status FROM projects WHERE id=$1',[project])).rows[0]!.status).toBe(fail?'active':'archived');
   expect((await db.pool.query('SELECT status FROM automations WHERE id=$1',[automation])).rows[0]!.status).toBe(fail?'active':'paused');
   expect((await db.pool.query('SELECT status FROM workflow_executions WHERE id=$1',[execution])).rows[0]!.status).toBe(fail?'running':'cancelled');
   expect(await state(f)).toMatchObject({run:fail?'running':'cancelled',proposal:fail?'staged':'rejected',request:fail?'pending_approval':'rejected',job:fail?'pending':'cancelled'});
  }finally{if(fail){await db.pool.query('DROP TRIGGER reject_archive_request ON operation_idempotency');await db.pool.query('DROP FUNCTION reject_archive_request()');}}
 });
});

describe('owner required Job and policy audit recovery',()=>{
 it('recovers one failed audit after a required Job rejects the whole linked owner',async()=>{
  if(!db.available)return;const f=await fixture();const before=await state(f);
  await db.pool.query("CREATE FUNCTION refuse_required_owner_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.job_type='fixture.required_owner' THEN RAISE EXCEPTION 'required owner job refused'; END IF; RETURN NEW; END $$");await db.pool.query('CREATE TRIGGER refuse_required_owner_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION refuse_required_owner_job()');
  try{
   await expect(withRunTerminalOwner(db.pool,async()=>[{id:f.run,space_id:space}],async port=>{
    const decision=await enforce({...loadConfig({SERVER_DATABASE_URL:db.connectionUri}),auditTransaction:port},await loadActionRegistry(),{action:'proposal.create',actor_type:'user',actor_id:owner,space_id:space,run_id:f.run,resource_type:'proposal',force_record:true});
    expect(decision.status).toBe('allow');
    await new PgJobQueueRepository(port).cancelJob(f.job,null);
    await new PgJobQueueRepository(port).enqueue({job_type:'fixture.required_owner',space_id:space,user_id:owner,payload:{run_id:f.run}});
   })).rejects.toThrow('required owner job refused');
   expect(await state(f)).toEqual(before);
   const audits=(await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE run_id=$1 AND action='proposal.create'",[f.run])).rows;
   expect(audits).toHaveLength(1);expect(audits[0]!.metadata_json.operation_outcome).toBe('failed');
  }finally{await db.pool.query('DROP TRIGGER refuse_required_owner_job ON jobs');await db.pool.query('DROP FUNCTION refuse_required_owner_job()');}
 });
});

describe('multi-Run admission ordering',()=>{
 it('takes each independent Job complete sorted key set before its domain writes',async()=>{
  if(!db.available)return;const a=await fixture(false),b=await fixture(false);
  await db.pool.query("UPDATE jobs SET status='running',attempts=max_attempts,updated_at=now()-interval '2 hours' WHERE id=ANY($1::varchar[])",[[a.job,b.job]]);
  const proposals=[a.proposal,b.proposal];
  for(const f of [a,b]){const draft=await insertProposalRow(db.pool,{spaceId:space,createdByRunId:f.run,proposalType:'memory_create',title:'Second linked review',payload:{proposed_content:'Another frozen draft'},rationale:'test',createdByUserId:owner,visibility:'private'});await linkProposalOperation(db.pool,{spaceId:space,userId:owner},draft.id);proposals.push(draft.id);}
  await db.pool.query("UPDATE proposals SET status='staged' WHERE id=ANY($1::varchar[])",[proposals]);
  const rows=(await db.pool.query('SELECT * FROM operation_idempotency WHERE proposal_id=ANY($1::varchar[])',[proposals])).rows;
  const ordered=rows.map(row=>[row.space_id,row.principal_kind,row.principal_id,row.on_behalf,row.authority_scope_id,row.operation_id,row.idempotency_key]).sort((a,b)=>canonical(a)<canonical(b)?-1:1);
  const expected=ordered.map(scope=>{const hash=createHash('sha256').update(canonical(scope)).digest();return [hash.readInt32BE(0),hash.readInt32BE(4)];});
  const keys:unknown[][]=[];const groups:unknown[][][]=[];let current:unknown[][]=[];
  const traced={options:db.pool.options,query:db.pool.query.bind(db.pool),async connect(){
    const raw=await db.pool.connect();
    const port:Queryable={async query<Row>(sql:string,params?:readonly unknown[]){
      if(sql==='BEGIN'){current=[];groups.push(current);}
      if(sql.startsWith('SELECT pg_try_advisory_xact_lock($1::integer')){const key=[...(params??[])];keys.push(key);current.push(key);}
      if(/UPDATE jobs/.test(sql))expect(current).toHaveLength(2);
      const result=await raw.query(sql,[...(params??[])]);return {rows:result.rows as Row[],rowCount:result.rowCount};
    }};
    return {...port,release:()=>raw.release()};
  }};
  expect((await new PgJobQueueRepository(traced).reclaimStuckJobs()).exhausted_jobs).toHaveLength(2);
  expect([...keys].sort()).toEqual([...expected].sort());expect(groups).toHaveLength(2);
  for(const group of groups)expect(group).toEqual(expected.filter(key=>group.some(g=>canonical(g)===canonical(key))));
  expect((await state(a)).request).toBe('rejected');expect((await state(b)).request).toBe('rejected');
 });
});

describe('unprepared owner rejection before domain writes',()=>{
 it('refuses an autocommit checked-out client without partially cancelling its Job',async()=>{
  if(!db.available)return;const f=await fixture(false),before=await state(f),client=await db.pool.connect();
  try{await expect(new PgJobQueueRepository(client).cancelJob(f.job,null)).rejects.toMatchObject({code:'operation_approval_state_inconsistent'});expect(await state(f)).toEqual(before);}
  finally{client.release();}
 });
});


describe('independent maintenance progress',()=>{
 it.each(['key','fence','row'] as const)('skips a busy %s and settles another Space without waiting',async busy=>{
  if(!db.available)return;
  const a=await fixture();const other={space:randomUUID(),owner:randomUUID(),project:randomUUID()};
  await seedSpaceOwnerProject(db.pool,other);const b=await fixture(true,other);
  await db.pool.query("UPDATE jobs SET status='running',attempts=max_attempts,updated_at=now()-interval '2 hours' WHERE id=ANY($1::varchar[])",[[a.job,b.job]]);
  const blocker=await db.pool.connect();
  try{
   await blocker.query('BEGIN');
   if(busy==='row')await blocker.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[a.run]);
   else if(busy==='fence')await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`proposal-run:${space}:${a.run}`]);
   else {const r=(await blocker.query('SELECT * FROM operation_idempotency WHERE id=$1',[a.request])).rows[0]!;await lockRequestKey(blocker,[r.space_id,r.principal_kind,r.principal_id,r.on_behalf,r.authority_scope_id,r.operation_id,r.idempotency_key]);}
   const result=await new PgJobQueueRepository(db.pool).reclaimStuckJobs();
   expect(result.exhausted_jobs.map(j=>j.id)).toEqual([b.job]);expect(result.reclaimed_count).toBe(1);
   expect((await state(a)).run).toBe('running');expect((await state(a)).job).toBe('running');expect((await state(b)).request).toBe('rejected');
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  expect((await new PgJobQueueRepository(db.pool).reclaimStuckJobs()).exhausted_jobs.map(j=>j.id)).toEqual([a.job]);
 });
});

it('refuses a Pool-shaped owner without audit recovery configuration before writing',async()=>{
 if(!db.available)return;const f=await fixture(),before=await state(f);
 const missingConfig={query:db.pool.query.bind(db.pool),connect:db.pool.connect.bind(db.pool)};
 await expect(new PgJobQueueRepository(missingConfig).cancelJob(f.job,null)).rejects.toMatchObject({code:'operation_approval_state_inconsistent'});
 expect(await state(f)).toEqual(before);
});

describe('maintenance requires independent Pool ownership',()=>{
 it.each(['checkout','transaction','branded'] as const)('rejects %s without damaging a caller transaction',async kind=>{
  if(!db.available)return;const f=await fixture(),before=await state(f),client=await db.pool.connect();
  if(kind!=='checkout')await client.query('BEGIN');
  const port=kind==='branded'?operationTransaction(client):null;
  try{
   const dbPort=port?.db??client;
   await expect(new PgJobQueueRepository(dbPort).reclaimStuckJobs()).rejects.toMatchObject({statusCode:503});
   await expect(new AutonomyRecoveryService(dbPort).cancelStaleWaitingForReview({maxAgeSeconds:3600})).rejects.toMatchObject({statusCode:503});
   expect((await client.query('SELECT 1 AS alive')).rows[0]!.alive).toBe(1);expect(await state(f)).toEqual(before);
  }finally{port?.close();if(kind!=='checkout')await client.query('ROLLBACK');client.release();}
 });
 it('reclaims an exhausted Run-backed Job with JSON null run_id once',async()=>{
  if(!db.available)return;const q=new PgJobQueueRepository(db.pool);
  const job=await q.enqueue({job_type:'agent_run',space_id:space,user_id:owner,payload:{run_id:null}});
  await db.pool.query("UPDATE jobs SET status='running',attempts=max_attempts,updated_at=now()-interval '2 hours' WHERE id=$1",[job.id]);
  expect((await q.reclaimStuckJobs()).exhausted_jobs.map(j=>j.id)).toEqual([job.id]);
  expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0]!.status).toBe('failed');
  expect((await q.reclaimStuckJobs()).reclaimed_count).toBe(0);
 });
});

describe('Research existing-pass transaction owner',()=>{
 it.each([false,true])('settles linked Workflow output with the Research root transaction (failure=%s)',async fail=>{
  if(!db.available)return;const f=await fixture();const operation=randomUUID(),asset=randomUUID(),version=randomUUID(),automation=randomUUID(),execution=randomUUID();
  const agent=(await db.pool.query('SELECT agent_id FROM runs WHERE id=$1',[f.run])).rows[0]!.agent_id;
  await db.pool.query("INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_at,updated_at) VALUES($1,$2,$3,'research','Nested research','active',$4::jsonb,now(),now())",[operation,space,project,JSON.stringify({workflow_id:randomUUID(),run_kind:'baseline',current_stage:'screening'})]);
  await db.pool.query("INSERT INTO evolvable_assets(id,space_id,asset_type,asset_key,display_name,owner_scope_type,owner_scope_id,status,metadata_json,created_at,updated_at) VALUES($1,$2,'workflow_template',$1,'Research workflow','space',$2,'active','{}',now(),now())",[asset,space]);
  await db.pool.query("INSERT INTO evolvable_asset_versions(id,asset_id,space_id,scope_type,scope_id,version,status,source,content_json,created_at,updated_at) VALUES($1,$2,$3,'space',$3,1,'approved','user_authored','{}',now(),now())",[version,asset,space]);
  await db.pool.query("INSERT INTO automations(id,space_id,owner_user_id,agent_id,name,trigger_type,status,config_json,project_id,created_at,updated_at) VALUES($1,$2,$3,$4,'Nested workflow','manual','active','{}',$5,now(),now())",[automation,space,owner,agent,project]);
  await db.pool.query("INSERT INTO workflow_executions(id,space_id,automation_id,workflow_version_id,status,root_run_id,trigger_type,input_json,definition_json,resolution_trace_json,budget_snapshot_json,responsible_user_id,research_operation_id,created_at,updated_at) VALUES($1,$2,$3,$4,'running',$5,'manual','{}','{}','[]','{}',$6,$7,now(),now())",[execution,space,automation,version,f.run,owner,operation]);
  await db.pool.query("INSERT INTO workflow_execution_nodes(id,space_id,execution_id,node_key,node_kind,title,status,created_at,updated_at) VALUES($1,$2,$3,'source','agent','Failed source','failed',now(),now())",[randomUUID(),space,execution]);
  if(fail){await db.pool.query("CREATE FUNCTION refuse_research_nested() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'research nested refused'; END $$");await db.pool.query('CREATE TRIGGER refuse_research_nested BEFORE UPDATE ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION refuse_research_nested()');}
  try{
   const result=new ProjectResearchOrchestrator(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri})).reconcileOperation(space,operation);
   if(fail)await expect(result).rejects.toThrow('research nested refused');else await result;
   expect((await db.pool.query('SELECT status FROM workflow_executions WHERE id=$1',[execution])).rows[0]!.status).toBe(fail?'running':'failed');
   expect(await state(f)).toMatchObject({run:fail?'running':'failed',proposal:fail?'staged':'rejected',request:fail?'pending_approval':'rejected'});
  }finally{if(fail){await db.pool.query('DROP TRIGGER refuse_research_nested ON operation_idempotency');await db.pool.query('DROP FUNCTION refuse_research_nested()');}}
 });
});
