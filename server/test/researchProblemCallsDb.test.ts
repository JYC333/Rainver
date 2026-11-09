import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
import {PgProposalApplyService} from '../src/modules/proposals/applyService.js';
import { ProjectResearchRepository } from "../src/modules/projectResearch/repository.js";
import { assertResearchResultRunEgress } from "../src/modules/projectResearch/researchResultEgress.js";
import type { RunRecord } from "../src/modules/runs/repository.js";
import { ResearchContextRepository } from "../src/modules/projectResearch/question/researchContextRepository.js";
import { ProjectResearchOrchestrator } from "../src/modules/projectResearch/orchestrator.js";
import { ResearchAcquisitionService } from "../src/modules/projectResearch/pipeline/researchAcquisitionService.js";
import { loadConfig } from "../src/config.js";
import { seedArxivSourceChain,seedRelevantCorpusItem } from "./support/researchSeeds.js";
import { retainReaderBody } from "./support/readingMaterial.js";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./support/testDatabase.js";
import { seedSpaceOwnerProject } from "./support/domainSeeds.js";
import { resetTables } from "./support/resetTables.js";
import { InquiryThreadService } from "../src/modules/inquiry/threadService.js";
import { InquiryIterationService } from "../src/modules/inquiry/iterationService.js";
import { InquiryProblemEngineService } from "../src/modules/inquiry/problemEngineService.js";
import { createBoundResearchOperation,reconcileResearchCall } from "../src/modules/projectResearch/researchProblemCalls.js";
import { ResearchProblemResultService } from "../src/modules/projectResearch/researchProblemResults.js";
import { ResearchOperationCancelService } from "../src/modules/projectResearch/researchOperationCancel.js";
import { ProjectOperationService } from "../src/modules/projects/projectOperationService.js";
import { acceptedThreadContext,assertAcceptedThreadContext } from "../src/modules/projectResearch/acceptedThreadContext.js";
import { createResearchWorkflow } from "../src/modules/projectResearch/workflowOntology.js";
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,thread:string,workflow:string;
const identity=()=>({spaceId:space,userId:owner});
const engine=()=>new InquiryProblemEngineService(db.pool);
async function token(){const p=await engine().projection(identity(),project,thread);return {method_version:'problem_solving.v1',expected_version:p.version,expected_revision:p.revision,idempotency_key:randomUUID()};}
async function start(key=randomUUID(),workflowId=workflow){
 return createBoundResearchOperation(db.pool,identity(),project,{title:'Bound evidence call',intentText:'Find the cause',status:'active',steps:[],progress:{schema_version:'project_research_operation.v1',workflow_id:workflowId,thread_scope:[{thread_id:thread,version:1,kind:'question',statement:'Why fail?'}],idempotency:{key,fingerprint:key},history:{max_items:20},channel_ids:[]}});
}
async function op(id:string){return (await db.pool.query(`SELECT * FROM project_operations WHERE id=$1`,[id])).rows[0];}
async function step(id:string){return (await db.pool.query(`SELECT * FROM inquiry_thread_steps WHERE id=$1`,[(await op(id)).research_step_id])).rows[0];}
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','source_connectors','source_providers'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();workflow=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 thread=String((await new InquiryThreadService(db.pool).createThread(identity(),project,{kind:'question',statement:'Why fail?'})).id);
 await createResearchWorkflow(db.pool,{id:workflow,spaceId:space,projectId:project,title:'Evidence workflow',status:'active',state:{},startedByUserId:owner,primaryThreadId:thread,now:new Date().toISOString()});
});
describe('Research call identity and evidence boundary',()=>{
 it('atomically binds each logical invocation and replays only the same request identity',async()=>{
  const key=randomUUID();const [a,b]=await Promise.all([start(key),start(key)]);expect(a.id).toBe(b.id);
  await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);
  const c=await start();expect(c.id).not.toBe(a.id);
  const call=(await op(a.id)).research_call_json;
  expect(call).toMatchObject({schema_version:'research_call.v1',operation_id:a.id,thread_id:thread,thread_version:1,round_number:1});
  expect((await step(a.id)).target_ref_id).toBe(a.id);expect((await step(c.id)).id).not.toBe(call.step_id);
  expect((await engine().projection(identity(),project,thread)).current_focus).toBeNull();
 });
 it('late completion settles only its bound Step and preserves the initiating round',async()=>{
  const a=await start();await engine().closeRound(identity(),project,thread,{...(await token()),summary:'No new judgment'});await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);const b=await start();
  await reconcileResearchCall(db.pool,space,a.id);await reconcileResearchCall(db.pool,space,a.id);
  expect(await step(a.id)).toMatchObject({status:'done',round_number:1});expect(await step(b.id)).toMatchObject({status:'in_progress',round_number:2});
  const result=await new ResearchProblemResultService(db.pool).read(identity(),project,a.id);expect(result.applicability).toBe('requires_assessment');
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM inquiry_iterations WHERE thread_id=$1`,[thread])).rows[0].n).toBe(0);
  const input={...(await token()),applicability:'limited',reason:'Old-snapshot evidence remains useful'};delete (input as Record<string,unknown>).method_version;
  await new ResearchProblemResultService(db.pool).adopt(identity(),project,a.id,input);
  const p=await engine().projection(identity(),project,thread);expect(p.current_focus).toMatchObject({stage:'verify',work_kind:'assess_result'});expect(p.round_number).toBe(2);
 });
 it('cancels only one invocation and a late terminal notification cannot reverse it',async()=>{
  const a=await start();await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);const b=await start();
  await new ResearchOperationCancelService(db.pool).cancelOperation(identity(),project,b.id,'Stop this call');
  await reconcileResearchCall(db.pool,space,a.id);await reconcileResearchCall(db.pool,space,b.id);
  expect(await step(b.id)).toMatchObject({status:'abandoned',ended_reason:'cancelled'});expect((await step(a.id)).status).toBe('done');
  expect((await op(b.id)).status).toBe('cancelled');
 });
 it('keeps retry attempts on the original call and reconciles the current attempt idempotently',async()=>{
  const a=await start();await db.pool.query(`UPDATE project_operations SET status='failed' WHERE id=$1`,[a.id]);await reconcileResearchCall(db.pool,space,a.id);
  const initial=await step(a.id);await db.pool.query(`UPDATE project_operations SET status='active',research_attempt=research_attempt+1 WHERE id=$1`,[a.id]);
  await Promise.all([reconcileResearchCall(db.pool,space,a.id),reconcileResearchCall(db.pool,space,a.id)]);
  expect(await step(a.id)).toMatchObject({id:initial.id,round_number:1,status:'in_progress'});expect((await op(a.id)).research_reconcile_json).toMatchObject({attempt:2,operation_status:'active'});
 });
 it('returns current-snapshot evidence after execution bookkeeping but flags position-only changes',async()=>{
  const a=await start();await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);await reconcileResearchCall(db.pool,space,a.id);
  expect((await new ResearchProblemResultService(db.pool).read(identity(),project,a.id)).applicability).toBe('current_snapshot');
  await new InquiryIterationService(db.pool).recordIteration(identity(),project,thread,{...(await token()),round_intent:'position_only',change_summary:'New contrary input',answer_state:'partial'});
  expect((await new ResearchProblemResultService(db.pool).read(identity(),project,a.id)).applicability).toBe('requires_assessment');
 });
 it('keeps the problem revision across execution bookkeeping and settles a call after its Project is archived',async()=>{
  const revision=async()=>(await db.pool.query(`SELECT problem_revision FROM inquiry_threads WHERE object_id=$1`,[thread])).rows[0].problem_revision as number;
  const a=await start();await reconcileResearchCall(db.pool,space,a.id);const before=await revision();
  await db.pool.query(`UPDATE project_operations SET research_attempt=research_attempt+1 WHERE id=$1`,[a.id]);await reconcileResearchCall(db.pool,space,a.id);
  await db.pool.query(`UPDATE project_operations SET status='waiting_review' WHERE id=$1`,[a.id]);await reconcileResearchCall(db.pool,space,a.id);
  expect(await revision()).toBe(before);expect((await op(a.id)).research_reconcile_json).toMatchObject({operation_status:'waiting_review',attempt:2});
  await db.pool.query(`UPDATE projects SET status='archived' WHERE id=$1`,[project]);
  await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);
  await expect(reconcileResearchCall(db.pool,space,a.id)).resolves.toEqual({status:'reconciled'});
  expect((await step(a.id)).status).toBe('done');expect(await revision()).toBe(before+1);
 });
 it('stops a bound call through the generic Operation cancel with its process stop and Step settlement',async()=>{
  const a=await start();
  await expect(new ProjectOperationService(db.pool).cancel(identity(),project,a.id)).resolves.toMatchObject({id:a.id,status:'cancelled'});
  expect(await step(a.id)).toMatchObject({status:'abandoned',ended_reason:'cancelled'});
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='research_operation_cancel' AND payload_json->>'operation_id'=$1`,[a.id])).rows[0].n).toBe(1);
  await expect(new ProjectOperationService(db.pool).cancel(identity(),project,a.id)).rejects.toMatchObject({statusCode:409});
 });
 it('starts a new call instead of replaying a failed history extension',async()=>{
  await db.pool.query(`UPDATE project_research_workflows SET state_json=$2::jsonb WHERE object_id=$1`,[workflow,JSON.stringify({research_question:'Why fail?',thread_scope:[{thread_id:thread,version:1,kind:'question',statement:'Why fail?'}],channel_ids:['channel-1'],project_source_binding_ids:['binding-1'],source_post_processing_rule_ids:['rule-1'],report_depth:'quick',monitoring:{active:true},initial_intake:{from:'2025-06-01T00:00:00.000Z'}})]);
  const prior=await createBoundResearchOperation(db.pool,identity(),project,{title:'Earlier extension',intentText:'Import earlier history',status:'active',steps:[],progress:{schema_version:'project_research_operation.v1',run_kind:'historical_backfill',workflow_id:workflow,thread_scope:[{thread_id:thread,version:1,kind:'question',statement:'Why fail?'}],idempotency:{key:'extend-history',fingerprint:'earlier-attempt'}}});
  await db.pool.query(`UPDATE project_operations SET status='failed' WHERE id=$1`,[prior.id]);
  const extend=new ProjectResearchOrchestrator(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri})).startHistoricalBackfill(identity(),project,workflow,{from:'2025-01-01',to:'2025-02-01',idempotency_key:'extend-history'});
  // Replaying the ended call's key conflicts with its recorded input; a new call reaches Source planning.
  await expect(extend).rejects.toThrow('Source connection not found');
  expect((await op(prior.id)).status).toBe('failed');
 });
 it.each([false,true])('accepts history-extension with null graph roots atomically, including its required Job (fail=%s)',async fail=>{
  if(!db.available)return;
  const channel=randomUUID(),binding=randomUUID();
  await seedArxivSourceChain(db.pool,{space,owner,connection:randomUUID(),connector:randomUUID(),channel,now:new Date().toISOString()});
  await db.pool.query("INSERT INTO project_source_bindings(id,space_id,project_id,source_channel_id,binding_key,status,priority,delivery_scope,collection_notifications_enabled,filters_json,routing_policy_json,extraction_policy_json,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'history','active',0,'project_members',true,'{}','{}','{}',$5,now(),now())",[binding,space,project,channel,owner]);
  await db.pool.query('UPDATE project_research_workflows SET state_json=$2::jsonb WHERE object_id=$1',[workflow,JSON.stringify({research_question:'Why fail?',thread_scope:[{thread_id:thread,version:1,kind:'question',statement:'Why fail?'}],channel_ids:[channel],project_source_binding_ids:[binding],source_post_processing_rule_ids:[randomUUID()],report_depth:'quick',monitoring:{active:true},initial_intake:{from:'2025-06-01T00:00:00.000Z'}})]);
  // Real offer payload with no project column: canonical payload fallback and
  // owner preflight must agree with the actual applier's Project gate.
  const proposal=await insertProposalRow(db.pool,{spaceId:space,proposalType:'research_history_extend',title:'Earlier range',payload:{proposal_type:'research_history_extend',project_id:project,workflow_id:workflow,from:'2025-01-01',to:'2025-02-01',max_items:20},rationale:'separate bounded decision',createdByUserId:owner,visibility:'private',riskLevel:'low'});
  const apply=PgProposalApplyService.fromConfig(loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  const before=(await db.pool.query('SELECT state_json FROM project_research_workflows WHERE object_id=$1',[workflow])).rows[0].state_json;
  if(fail){await db.pool.query("CREATE FUNCTION refuse_history_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history job refused'; END $$");await db.pool.query('CREATE TRIGGER refuse_history_job BEFORE INSERT ON extraction_jobs FOR EACH ROW EXECUTE FUNCTION refuse_history_job()');}
  try{
   const action=apply.accept(proposal.id,identity());
   if(fail){
    await expect(action).rejects.toThrow('history job refused');
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal.id])).rows[0].status).toBe('pending');
    expect((await db.pool.query('SELECT id FROM project_operations WHERE project_id=$1',[project])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT id FROM source_backfill_plans WHERE space_id=$1',[space])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT state_json FROM project_research_workflows WHERE object_id=$1',[workflow])).rows[0].state_json).toEqual(before);
    const audit=(await db.pool.query("SELECT metadata_json FROM policy_decision_records WHERE proposal_id=$1 AND action='proposal.apply'",[proposal.id])).rows;
    expect(audit).toHaveLength(1);expect(audit[0].metadata_json.operation_outcome).toBe('failed');
   }else{
    expect((await action)?.proposal.status).toBe('accepted');
    expect((await db.pool.query('SELECT id FROM source_backfill_plans WHERE space_id=$1',[space])).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT id FROM extraction_jobs WHERE space_id=$1',[space])).rows.length).toBeGreaterThan(0);
   }
  }finally{if(fail){await db.pool.query('DROP TRIGGER refuse_history_job ON extraction_jobs');await db.pool.query('DROP FUNCTION refuse_history_job()');}}
 });
 it('adopts a result whose evidence exceeds the references one problem fact can cite',async()=>{
  const ids:string[]=[];
  for(let n=0;n<25;n++){const id=await retainReaderBody(db.pool,{space,owner,item:randomUUID(),text:`Evidence ${n}`,attach:false});await db.pool.query(`UPDATE artifacts SET project_id=$2 WHERE id=$1`,[id,project]);ids.push(id);}
  const a=await start();await db.pool.query(`UPDATE project_operations SET status='completed',progress_json=progress_json||jsonb_build_object('artifact_ids',$2::jsonb) WHERE id=$1`,[a.id,JSON.stringify(ids)]);
  await reconcileResearchCall(db.pool,space,a.id);
  expect((await new ResearchProblemResultService(db.pool).read(identity(),project,a.id)).evidence_refs).toHaveLength(25);
  const input={...(await token()),applicability:'limited',reason:'Covers the failure'};delete (input as Record<string,unknown>).method_version;
  await new ResearchProblemResultService(db.pool).adopt(identity(),project,a.id,input);
  const p=await engine().projection(identity(),project,thread);expect(p.current_focus).toMatchObject({stage:'verify',work_kind:'assess_result'});
 });
 it('rolls back admission on a mismatched immutable Thread version',async()=>{
  await db.pool.query(`UPDATE inquiry_threads SET version=2 WHERE object_id=$1`,[thread]);
  await expect(start()).rejects.toThrow('revision');
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_operations WHERE project_id=$1`,[project])).rows[0].n).toBe(0);
 });
 it('retains legal partial artifacts and cancellation diagnostics, and rechecks Source permissions',async()=>{
  const material=await seedRelevantCorpusItem(db.pool,{space,project,owner});
  const artifact=await retainReaderBody(db.pool,{space,owner,item:material.sourceItemId,text:'Useful partial evidence'});
  await db.pool.query(`UPDATE artifacts SET project_id=$2 WHERE id=$1`,[artifact,project]);
  const a=await start();
  await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text),'partial',true,'error',jsonb_build_object('code','provider_timeout')) WHERE id=$1`,[a.id,artifact,material.sourceItemId]);
  await new ResearchOperationCancelService(db.pool).cancelOperation(identity(),project,a.id,'Enough material for now');
  const result=await new ResearchProblemResultService(db.pool).read(identity(),project,a.id);
  expect(result).toMatchObject({status:'cancelled',partial:true,evidence_refs:[{type:'artifact',id:artifact}],diagnostics:{error:{code:'provider_timeout'}}});
  const other=randomUUID();await db.pool.query(`INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'Other','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`,[other]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),space,other]);
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,other]);
  await db.pool.query(`UPDATE source_items SET visibility='private' WHERE id=$1`,[material.sourceItemId]);
  await expect(new ResearchProblemResultService(db.pool).read({spaceId:space,userId:other},project,a.id)).rejects.toThrow('not found');
 });
 it('recovers dead preparation Jobs and serializes explicit retries on the original invocation',async()=>{
  const admitted=await new ResearchAcquisitionService(db.pool).startAcquisition(identity(),project,{threadId:thread,requestKey:'preparation-call',originRoomId:null,originSessionId:null});
  const id=admitted.operation_id!;const original=await op(id);
  await db.pool.query(`UPDATE jobs SET status='failed',attempts=max_attempts,error='preparation retries exhausted' WHERE id=$1`,[original.progress_json.acquisition_job_id]);
  await reconcileResearchCall(db.pool,space,id);expect((await op(id)).status).toBe('failed');
  const orchestrator=new ProjectResearchOrchestrator(db.pool,loadConfig({SERVER_DATABASE_URL:db.connectionUri}));
  await Promise.all([orchestrator.retryFailedOperation(identity(),project,id),orchestrator.retryFailedOperation(identity(),project,id)]);
  const retried=await op(id);expect(retried).toMatchObject({status:'active',research_attempt:2,research_step_id:original.research_step_id,research_call_json:original.research_call_json});
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='research_pipeline_start' AND payload_json->>'operation_id'=$1`,[id])).rows[0].n).toBe(2);
  expect((await step(id)).status).toBe('in_progress');
 });
 it('does not cancel admitted execution when the Thread is archived',async()=>{
  const a=await start();const service=new InquiryIterationService(db.pool);
  await service.transitionLifecycle(identity(),project,thread,{lifecycle_status:'archived'});expect((await step(a.id)).status).toBe('in_progress');
  await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.id]);await reconcileResearchCall(db.pool,space,a.id);expect((await step(a.id)).status).toBe('done');
 });
 it('separates a human result read from Source-authorized egress into a CLI model',async()=>{
  const connection=randomUUID();await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:[],now:new Date().toISOString()});
  const material=await seedRelevantCorpusItem(db.pool,{space,project,owner});await db.pool.query(`UPDATE source_items SET connection_id=$2 WHERE id=$1`,[material.sourceItemId,connection]);
  const a=await start();await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('source_item_ids',jsonb_build_array($2::text)) WHERE id=$1`,[a.id,material.sourceItemId]);
  const caller={space_id:space,project_id:project,runtime_key:'codex_cli',contract_snapshot_json:{},instructed_by_user_id:owner} as RunRecord;
  await assertResearchResultRunEgress(db.pool,caller,a.id);
  await db.pool.query(`UPDATE source_connections SET policy_json=jsonb_build_object('schema_version',1,'source_egress_class','internal_only','source_egress_configured',true) WHERE id=$1`,[connection]);
  expect((await new ResearchProblemResultService(db.pool).read(identity(),project,a.id)).status).toBe('active');
  await expect(assertResearchResultRunEgress(db.pool,caller,a.id)).rejects.toMatchObject({statusCode:403});
  await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);
  await expect(new ResearchOperationCancelService(db.pool).cancelOperation(identity(),project,a.id,'Source withdrawn')).resolves.toMatchObject({status:'cancelled'});
  await expect(new ResearchProblemResultService(db.pool).read(identity(),project,a.id)).rejects.toThrow();
 });
 it('does not call an unresolved history or broken binding reconciled',async()=>{
  const a=await start();await reconcileResearchCall(db.pool,space,a.id);await db.pool.query(`UPDATE inquiry_thread_steps SET target_ref_id=$2 WHERE id=$1`,[(await op(a.id)).research_step_id,randomUUID()]);
  await expect(reconcileResearchCall(db.pool,space,a.id)).rejects.toThrow('could not be reconciled');expect((await op(a.id)).research_reconcile_json.status).toBe('pending');
 });
 it('rechecks Thread permissions for reading results, cancelling, and adoption',async()=>{
  const a=await start(),other=randomUUID();await db.pool.query(`INSERT INTO users(id,display_name,status,created_at,updated_at,email,registration_source) VALUES($1,'Other','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`,[other]);
  await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),space,other]);
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,other]);
  await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
  const outsider={spaceId:space,userId:other};
  await expect(new ResearchProblemResultService(db.pool).read(outsider,project,a.id)).rejects.toThrow();
  await expect(new ProjectOperationService(db.pool).get(outsider,project,a.id)).rejects.toThrow();
  expect(await new ProjectResearchRepository(db.pool).listWorkflows(outsider,project)).toEqual([]);
  await expect(new ResearchOperationCancelService(db.pool).cancelOperation(outsider,project,a.id)).rejects.toThrow();
  expect((await op(a.id)).status).toBe('active');
 });
 it('plans accepted problems without manufacturing FINER scores and rejects changed contexts',async()=>{
  const context=await acceptedThreadContext(db.pool,identity(),project,thread);await assertAcceptedThreadContext(db.pool,identity(),project,thread,context);
  const row=(await db.pool.query(`SELECT assessment_json FROM project_research_context_versions WHERE id=$1`,[context])).rows[0];expect(row.assessment_json).toEqual({method:'accepted_thread_frame',finer_evaluated:false});
  const contexts=new ResearchContextRepository(db.pool);const original=(await contexts.get(space,project,context))!;
  const confirmed=await contexts.create(identity(),project,{...original.context,in_scope:['Only import failures'],out_of_scope:['No unrelated architecture'],must_have:['Reproduction']},{assessment:{finer:{feasible:2}},provenance:{source:'question_assessment_confirmation',thread_id:thread}});
  const inherited=await contexts.get(space,project,await acceptedThreadContext(db.pool,identity(),project,thread));
  expect(inherited?.context).toMatchObject({in_scope:['Only import failures'],out_of_scope:['No unrelated architecture'],must_have:['Reproduction']});
  expect((await contexts.get(space,project,confirmed.id))?.assessment).toEqual({finer:{feasible:2}});
  await db.pool.query(`UPDATE inquiry_threads SET version=version+1 WHERE object_id=$1`,[thread]);await expect(assertAcceptedThreadContext(db.pool,identity(),project,thread,context)).rejects.toThrow('changed');
 });
});
