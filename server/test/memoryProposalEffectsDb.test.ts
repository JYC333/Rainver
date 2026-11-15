import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {z} from 'zod';
import {MemoryOutSchema,SYSTEM_ACTION_REGISTRY} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {loadConfig} from '../src/config.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {createDefaultProposalApplierRegistry} from '../src/modules/proposals/applierRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {RETRIEVAL_EMBEDDING_JOB} from '../src/modules/retrieval/embedding/config.js';
import {PgProposalApplyService} from '../src/modules/proposals/applyService.js';
import {operationProposalService} from '../src/modules/systemActions/operations/approvals.js';
import type {OperationRegistration} from '../src/modules/systemActions/operations/types.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,requester:string,project:string;
const identity=()=>({spaceId:space,userId:owner});
const service=()=>PgProposalApplyService.fromConfig(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
async function draft(type='memory_create',extra:Record<string,unknown>={}){
 return (await insertProposalRow(db.pool,{spaceId:space,projectId:project,proposalType:type,title:'Memory effect closure',rationale:'test',createdByUserId:requester,
  requiredApproverRole:'owner',visibility:'space_shared',payload:{proposal_type:type,proposed_content:'Version one',target_scope:'project',target_visibility:'space_shared',owner_user_id:requester,
   provenance_entries:[{source_type:'user_confirmation',source_id:requester,source_trust:'user_confirmed'}],...extra}})).id;
}
/** Only a test mapping. Production Memory submission remains unchanged until
 * the entire public accept surface is qualified, rather than enabling a subset. */
function mappedService(type='memory_create',version=1){
 const base=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='memory.propose_create')!;
 const registration:OperationRegistration={definition:{...base,id:'fixture.proposal',version,output_schema:z.object({memory:MemoryOutSchema})},
  async resolve(){return {authority:`project:${project}`,targets:{project_id:project},resourceType:'space',resourceId:space};},
  async authorize(){},async execute(){throw new Error('Only the canonical typed applier may execute');},
  approval:{mode:'proposal_submission',proposalType:type,gate:{kind:'hard_gate',gate_class:'direction'},atomicStatusWritersVerified:true,
   async create(){throw new Error('Fixture is already linked');},async preconditions(){return {};}}};
 return operationProposalService(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),createDefaultProposalApplierRegistry(),new Map([[registration.definition.id,registration]]));
}
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();requester=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await seedSpaceMember(db.pool,{space,user:requester});
});
afterEach(async()=>{
 if(!db.available)return;
 for(const table of ['jobs','proposals','policy_decision_records'])await db.pool.query(`DROP TRIGGER IF EXISTS memory_effect_fault ON ${table}`);
 await db.pool.query('DROP FUNCTION IF EXISTS memory_effect_fault()');
});
async function fault(table:'jobs'|'proposals'){
 await db.pool.query(`CREATE FUNCTION memory_effect_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'mandatory effect fault'; END $$`);
 await db.pool.query(`CREATE TRIGGER memory_effect_fault BEFORE ${table==='jobs'?'INSERT':'UPDATE OF status'} ON ${table} FOR EACH ROW EXECUTE FUNCTION memory_effect_fault()`);
}
async function expectPending(id:string){
 expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('pending');
 expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(0);
}
describe('canonical Memory typed effect transaction',()=>{
 it('keeps requester and approver distinct through real Memory, provenance, Job and linked receipt',async()=>{
  const id=await draft(),request=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  const result=await mappedService().accept(id,identity());
  expect(result?.result_type).toBe('memory_entry');
  const memory=(await db.pool.query('SELECT * FROM memory_entries WHERE created_from_proposal_id=$1',[id])).rows[0];
  expect(memory).toMatchObject({owner_user_id:requester,created_by:requester,approved_by:owner,status:'active'});
  expect((await db.pool.query('SELECT reviewed_by,status FROM proposals WHERE id=$1',[id])).rows[0]).toEqual({reviewed_by:owner,status:'accepted'});
  expect((await db.pool.query('SELECT user_id FROM jobs')).rows).toEqual([{user_id:requester}]);
  expect((await db.pool.query('SELECT source_id FROM provenance_links WHERE target_id=$1 AND source_type=\'proposal\'',[memory.id])).rows).toEqual([{source_id:id}]);
  expect((await db.pool.query('SELECT state,result_json FROM operation_idempotency WHERE id=$1',[request])).rows[0]).toMatchObject({state:'succeeded',result_json:{status:'succeeded',data:{memory:{id:memory.id}}}});
 });
 it.each(['memory_update','memory_archive'])('accepts linked %s through its canonical typed applier',async type=>{
  const first=await draft();await service().accept(first,identity());
  const old=(await db.pool.query('SELECT id FROM memory_entries WHERE created_from_proposal_id=$1',[first])).rows[0].id;
  const id=await draft(type,{target_memory_id:old,proposed_content:'Version two'});
  const request=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  const result=await mappedService(type).accept(id,identity());
  expect(result?.result_type).toBe('memory_entry');
  expect((await db.pool.query('SELECT status FROM memory_entries WHERE id=$1',[old])).rows[0].status).toBe(type==='memory_update'?'superseded':'archived');
  expect((await db.pool.query('SELECT state,result_json FROM operation_idempotency WHERE id=$1',[request])).rows[0]).toMatchObject({state:'succeeded',result_json:{status:'succeeded',data:{memory:{status:type==='memory_update'?'active':'archived'}}}});
  expect((await db.pool.query("SELECT source_id FROM provenance_links WHERE source_type='proposal' AND source_id=$1",[id])).rows).toEqual([{source_id:id}]);
 });
 it('does not reuse another payer Job and coalesces repeated requests from the original requester',async()=>{
  await new PgJobQueueRepository(db.pool).enqueue({space_id:space,user_id:owner,job_type:RETRIEVAL_EMBEDDING_JOB,payload:{}});
  for(let n=0;n<2;n++){
   const id=await draft();await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
   await mappedService().accept(id,identity());
  }
  expect((await db.pool.query('SELECT user_id FROM jobs ORDER BY user_id')).rows).toEqual([owner,requester].sort().map(user_id=>({user_id})));
 });
 it.each(['jobs','proposals'] as const)('rolls back a real create and linked receipt on required %s failure',async table=>{
  const id=await draft(),request=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  await fault(table);
  await expect(mappedService().accept(id,identity())).rejects.toThrow('mandatory effect fault');
  await expectPending(id);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM provenance_links')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0].state).toBe('pending_approval');
 });
 it('rolls back ordinary unlinked create when its required Job fails',async()=>{
  const id=await draft();await fault('jobs');
  await expect(service().accept(id,identity())).rejects.toThrow('mandatory effect fault');await expectPending(id);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
  // Recovery records failure only; no successful independent approval audit survives.
  const audits=(await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE proposal_id=$1 AND action='proposal.apply'",[id])).rows;
  expect(audits.length).toBeGreaterThan(0);
  expect(audits.every(r=>r.metadata_json.operation_outcome==='failed')).toBe(true);
 });
 it.each(['memory_update','memory_archive'])('rolls back %s versions, relations and provenance when final decision fails',async type=>{
  const first=await draft();await service().accept(first,identity());
  const old=(await db.pool.query('SELECT id FROM memory_entries WHERE created_from_proposal_id=$1',[first])).rows[0].id;
  await db.pool.query('DELETE FROM jobs');
  const before=(await db.pool.query('SELECT * FROM provenance_links ORDER BY id')).rows;
  const id=await draft(type,{target_memory_id:old,proposed_content:'Version two'});await fault('proposals');
  await expect(service().accept(id,identity())).rejects.toThrow('mandatory effect fault');await expectPending(id);
  expect((await db.pool.query('SELECT id,status FROM memory_entries')).rows).toEqual([{id:old,status:'active'}]);
  expect((await db.pool.query('SELECT * FROM provenance_links ORDER BY id')).rows).toEqual(before);
  expect((await db.pool.query('SELECT id FROM memory_relations')).rows).toHaveLength(0);
 });
 it('rolls back typed writes when the mandatory policy audit fails at commit',async()=>{
  const id=await draft(),request=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  await db.pool.query(`CREATE FUNCTION memory_effect_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late audit fault'; END $$`);
  await db.pool.query(`CREATE CONSTRAINT TRIGGER memory_effect_fault AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_effect_fault()`);
  await expect(mappedService().accept(id,identity())).rejects.toThrow('late audit fault');
  await expectPending(id);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM provenance_links')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0].state).toBe('pending_approval');
 });
 it('allows only one concurrent version replacement of the same Memory',async()=>{
  const first=await draft();await service().accept(first,identity());
  const old=(await db.pool.query('SELECT id FROM memory_entries WHERE created_from_proposal_id=$1',[first])).rows[0].id;
  const ids=await Promise.all([draft('memory_update',{target_memory_id:old,proposed_content:'A'}),draft('memory_update',{target_memory_id:old,proposed_content:'B'})]);
  const results=await Promise.allSettled(ids.map(id=>service().accept(id,identity())));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await db.pool.query("SELECT id FROM memory_entries WHERE status='active'")).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT id FROM proposals WHERE id=ANY($1::varchar[]) AND status='pending'",[ids])).rows).toHaveLength(1);
 });
 it('rechecks the distinct approver current membership',async()=>{
  const id=await draft();await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  await expect(mappedService().accept(id,identity())).rejects.toMatchObject({code:'operation_not_found'});
  await expectPending(id);
 });
 it('refuses a revoked original requester even when a distinct current owner approves',async()=>{
  const id=await draft();await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,requester]);
  await expect(mappedService().accept(id,identity())).rejects.toMatchObject({code:'operation_not_found'});
  await expectPending(id);expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 });
 it('supersedes a stale mapping version without applying Memory',async()=>{
  const id=await draft(),request=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},id);
  await mappedService('memory_create',2).accept(id,identity());
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[id])).rows[0].status).toBe('superseded');
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[request])).rows[0].state).toBe('superseded');
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 });
 it('retains B10 source-trust refusal on the same typed applier',async()=>{
  const id=await draft('memory_create',{provenance_entries:[{source_type:'run',source_id:randomUUID(),source_trust:'agent_inferred'}]});
  await expect(service().accept(id,identity())).rejects.toThrow();await expectPending(id);
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 });
});
