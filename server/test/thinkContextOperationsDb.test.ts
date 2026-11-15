import {seedArxivSourceChain,seedRelevantCorpusItem} from "./support/researchSeeds.js";
import {insertArtifactRow} from "../src/modules/artifacts/reviewArtifactWriter.js";
import {waitForBlockedBy} from "./support/lockWait.js";
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {CONTENT_RETRIEVAL_JOB,AskSpaceRequestResultSchema} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {askSpaceModule} from '../src/modules/askSpace/index.js';
import {contextOpsModule} from '../src/modules/contextOps/index.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/index.js';
import {registerContentRetrievalJob} from '../src/modules/retrieval/contentRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {jobToOut} from '../src/modules/jobs/routes.js';
const db=useTestDatabase(import.meta.url,{max:6});
let space:string,user:string,project:string,item:string,app:ReturnType<typeof buildModuleServer>;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const call=(path:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/'+path,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_providers','source_connectors'],{cascade:true});space=randomUUID();user=randomUUID();project=randomUUID();item=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner:user,project,spaceType:'team'});
 app=buildModuleServer(config(),[askSpaceModule,contextOpsModule]);__setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
it('formal Think queues one intent, executes outside admission, and withholds its whole answer after contributor demotion',async()=>{
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Quantum PRIVATE lattice',content:'Quantum lattice private body',ownerUserId:user,createdByUserId:user,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 const key=randomUUID(),body={query:'Quantum',domains:['knowledge'],mode:'lexical',persist:true},first=await call('ask-space/think',body,key);
 expect(first.statusCode,first.body).toBe(202);expect((await call('ask-space/think',body,key)).json()).toEqual(first.json());
 const id=first.json().data.job_id,registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
 const envelope=await claimJobForHandler(db.pool,id),result=await registry.dispatch(envelope);expect(await new PgJobQueueRepository(db.pool).confirmCompletedJob(id,result,envelope.worker_id,envelope.attempts)).toBe(true);
 await expect(registry.dispatch(envelope)).rejects.toBeDefined();
 const view=await app.inject({method:'GET',url:'/api/v1/ask-space/requests/'+id});expect(view.statusCode,view.body).toBe(200);
 expect(AskSpaceRequestResultSchema.parse(view.json())).toMatchObject({status:'completed',result:{query:'Quantum',domains:[{domain:'knowledge'}]}});expect(view.body).toContain('PRIVATE');
 expect(jobToOut((await new PgJobQueueRepository(db.pool).getJob(id))!).result).toBeNull();
 expect((await db.pool.query('SELECT max_attempts FROM jobs WHERE job_type=$1',[CONTENT_RETRIEVAL_JOB])).rows).toEqual([{max_attempts:1}]);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await db.pool.query("UPDATE space_objects SET access_level='summary',owner_user_id=$2,created_by_user_id=$2 WHERE id=$1",[item,peer]);
 const denied=await app.inject({method:'GET',url:'/api/v1/ask-space/requests/'+id});expect(denied.json()).toMatchObject({status:'completed',result:null,withheld:1});expect(denied.body).not.toContain('PRIVATE');
});
it('formal Think late audit failure leaves no Job intent or receipt',async()=>{
 await rejectAudits();try{
  const response=await call('ask-space/think',{query:'Quantum'});expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(0);
 }finally{await restoreAudits();}
});
it('formal ContextOps commands preserve defaults, replay once and refuse after scanner withdrawal',async()=>{
 for(const [path,body] of [['context-ops/review-cycle/run',{create_packets:false,include_memory_maintenance:false}],['context-ops/context-observations/scan',{}]] as const){
  const key=randomUUID(),first=await call(path,body,key);expect(first.statusCode,first.body).toBe(201);expect(first.json().data.canonical_write_performed).toBe(false);
  const count=(await db.pool.query('SELECT id FROM artifacts')).rowCount;expect((await call(path,body,key)).json()).toEqual(first.json());expect((await db.pool.query('SELECT id FROM artifacts')).rowCount).toBe(count);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,user]);
  expect((await call(path,body,key)).statusCode).toBe(404);await db.pool.query("UPDATE space_memberships SET role='owner' WHERE space_id=$1 AND user_id=$2",[space,user]);
 }
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
});
it('formal ContextOps audit failure rolls back every report Artifact',async()=>{
 await rejectAudits();try{
  for(const [path,body] of [['context-ops/review-cycle/run',{create_packets:false,include_memory_maintenance:false}],['context-ops/context-observations/scan',{}]] as const){
   const response=await call(path,body);expect(response.statusCode,response.body).toBe(503);expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
  }
 }finally{await restoreAudits();}
});
it('formal ContextOps refuses Space-wide review without opt-in and unknown identity fields',async()=>{
 expect((await call('context-ops/review-cycle/run',{review_scope:'space_ops'})).statusCode).toBe(404);
 expect((await call('context-ops/context-observations/scan',{user_id:user})).statusCode).toBe(422);
 expect((await call('ask-space/think',{query:'x',user_id:user})).statusCode).toBe(422);
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
async function rejectAudits(){
 await db.pool.query("CREATE FUNCTION reject_think_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER reject_think_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_think_audit()');
}
async function restoreAudits(){await db.pool.query('DROP TRIGGER reject_think_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION reject_think_audit()');}
it('formal ContextOps default packet cycle stays proposal-only and replay loses withdrawn contributors',async()=>{
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Quantum private lattice',content:'thin',ownerUserId:user,createdByUserId:user,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 const key=randomUUID(),first=await call('context-ops/review-cycle/run',{},key);
 expect(first.statusCode,first.body).toBe(201);expect(first.json().data.retrieval_maintenance.finding_count).toBeGreaterThan(0);
 expect(first.json().data.retrieval_maintenance.proposal_id).not.toBeNull();
 const next=await call('context-ops/review-cycle/run',{});expect(next.statusCode,next.body).toBe(201);
 expect(next.json().data.retrieval_maintenance.proposal_id).toBe(first.json().data.retrieval_maintenance.proposal_id);
 expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(0);
 expect((await db.pool.query('SELECT object_id FROM claims')).rows).toHaveLength(0);
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query("UPDATE space_objects SET owner_user_id=$2,created_by_user_id=$2,visibility='private',access_level='summary' WHERE id=$1",[item,peer]);
 expect((await call('context-ops/review-cycle/run',{},key)).statusCode).toBe(404);
});
it('formal Think rejects a stale worker before it can publish a receipt or Artifact',async()=>{
 const first=await call('ask-space/think',{query:'Quantum',domains:['knowledge'],mode:'lexical',persist:true});
 expect(first.statusCode,first.body).toBe(202);
 const id=first.json().data.job_id,envelope=await claimJobForHandler(db.pool,id),registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
 await db.pool.query('UPDATE jobs SET attempts=attempts+1 WHERE id=$1',[id]);
 await expect(registry.dispatch(envelope)).rejects.toBeDefined();
 expect((await new PgJobQueueRepository(db.pool).getJob(id))?.status).toBe('running');
 expect((await db.pool.query('SELECT id FROM artifacts')).rows).toHaveLength(0);
});
it('formal ContextOps contains an optional packet SQL failure inside its core savepoint',async()=>{
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Quantum',content:'thin',ownerUserId:user,createdByUserId:user,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 await db.pool.query("CREATE FUNCTION reject_optional_packet() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.proposal_type='retrieval_maintenance_packet' THEN RAISE EXCEPTION 'packet unavailable'; END IF; RETURN NEW; END $$");
 await db.pool.query('CREATE TRIGGER reject_optional_packet BEFORE INSERT ON proposals FOR EACH ROW EXECUTE FUNCTION reject_optional_packet()');
 try{
  const response=await call('context-ops/review-cycle/run',{});expect(response.statusCode,response.body).toBe(201);
  expect(response.json().data).toMatchObject({degraded:true,retrieval_maintenance:{proposal_id:null},warnings:[{stage:'retrieval_maintenance_packet'}]});
  expect((await db.pool.query('SELECT id FROM artifacts WHERE artifact_type=\'context_review_cycle_report\'')).rowCount).toBe(1);
 }finally{await db.pool.query('DROP TRIGGER reject_optional_packet ON proposals');await db.pool.query('DROP FUNCTION reject_optional_packet()');}
});
it('formal Think final B11 failure rolls back its terminal receipt and can recover without repeating I/O',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Quantum shared lattice',content:'Quantum shared body',ownerUserId:peer,createdByUserId:peer,projectId:project});
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 const first=await call('ask-space/think',{query:'Quantum',domains:['knowledge'],mode:'lexical',persist:false});expect(first.statusCode,first.body).toBe(202);
 const id=first.json().data.job_id,envelope=await claimJobForHandler(db.pool,id),registry=new JobHandlerRegistry();registerContentRetrievalJob(registry,config());
 await db.pool.query("CREATE FUNCTION reject_think_read() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='Think result read' THEN RAISE EXCEPTION 'read evidence unavailable'; END IF; RETURN NEW; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER reject_think_read AFTER INSERT ON content_access_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_think_read()');
 try{
  await expect(registry.dispatch(envelope)).rejects.toBeDefined();
  expect((await new PgJobQueueRepository(db.pool).getJob(id))?.status).toBe('running');
  expect((await db.pool.query("SELECT id FROM content_access_logs WHERE reason='Think result read'")).rows).toHaveLength(0);
 }finally{await db.pool.query('DROP TRIGGER reject_think_read ON content_access_logs');await db.pool.query('DROP FUNCTION reject_think_read()');}
 // executeSourceDispatch reuses its durable computed result, not the provider work.
 const result=await registry.dispatch(envelope);
 expect(await new PgJobQueueRepository(db.pool).confirmCompletedJob(id,result,envelope.worker_id,envelope.attempts)).toBe(true);
 expect((await db.pool.query("SELECT id FROM content_access_logs WHERE reason='Think result read'")).rowCount).toBeGreaterThan(0);
});

it.each(['context-ops/review-cycle/run','context-ops/context-observations/scan'])('pins indirect Projects before any report at %s',async path=>{
 const [low,high]=[randomUUID(),randomUUID()].sort(),lowItem=randomUUID(),highItem=randomUUID();
 for(const id of [low,high])await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,$1,'active',now(),now())",[id,space,user]);
 for(const [id,p] of [[lowItem,low],[highItem,high]])await insertKnowledgeItem(db.pool,{id,spaceId:space,title:'Barrier body',content:'Body',ownerUserId:user,createdByUserId:user,projectId:p});
 const run=randomUUID();await seedRun(db.pool,{id:run,space,owner:user,agent:randomUUID(),version:randomUUID()});await db.pool.query('UPDATE runs SET project_id=$2 WHERE id=$1',[run,low]);
 const artifact=async(type:string,metadata:object,createdAt?:string)=>insertArtifactRow(db.pool,{spaceId:space,ownerUserId:user,artifactType:type,title:'Barrier report',content:JSON.stringify(metadata),metadata,canonicalFormat:type+'.v1',visibility:'private',createdAt,runId:type==='retrieval_brief'?run:null});
 const leaf=await artifact('retrieval_brief',{item_refs:[{object_type:'knowledge_item',object_id:lowItem}]},new Date(Date.now()-90*86400000).toISOString());
 const middle=await artifact('retrieval_eval_report',{source:'product_diagnostic',suite:'retrieval_quality_feedback_loop',dependency_closure:{version:1},source_artifact_ids:[leaf],diagnostic_codes:[],counts:{}});
 await artifact('retrieval_maintenance_report',{findings:[{kind:'thin',objects:[{object_type:'knowledge_item',object_id:highItem}]}],counts:{thin:1},scanned:1});
 const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined;let done=false;
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[low]);
  pending=call(path,path.includes('review-cycle')?{create_packets:false,include_memory_maintenance:false}:{});const running=Promise.resolve(pending).finally(()=>{done=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>done});expect(done,'reader waits at the lowest indirect Project').toBe(false);
  // A writer following Project order can still take the later Project and
  // report roots. A reader holding either while waiting on low is inverted.
  await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT',[high]);
  await holder.query('SELECT id FROM artifacts WHERE id=$1 FOR UPDATE NOWAIT',[middle]);
  await holder.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE NOWAIT',[run]);
  await holder.query('COMMIT');const response=await running;expect(response.statusCode,response.body).toBe(201);
 }finally{await holder.query('ROLLBACK');holder.release();if(pending)await pending;}
});

it.each(['context-ops/review-cycle/run','context-ops/context-observations/scan'])('pins indirect Source consent before later object roots at %s',async path=>{
 const connection=randomUUID();await seedArxivSourceChain(db.pool,{space,owner:user,connector:randomUUID(),connection,channel:randomUUID(),now:new Date().toISOString()});
 const {sourceItemId}=await seedRelevantCorpusItem(db.pool,{space,owner:user,project});await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[sourceItemId,connection]);
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'High root',content:'Body',ownerUserId:user,createdByUserId:user,projectId:project});
 const artifact=async(type:string,metadata:object,createdAt?:string)=>insertArtifactRow(db.pool,{spaceId:space,ownerUserId:user,artifactType:type,title:'Source barrier report',content:JSON.stringify(metadata),metadata,canonicalFormat:type+'.v1',visibility:'private',createdAt});
 const leaf=await artifact('retrieval_brief',{item_refs:[{object_type:'source_item',object_id:sourceItemId}]},new Date(Date.now()-90*86400000).toISOString());
 await artifact('retrieval_eval_report',{source:'product_diagnostic',suite:'retrieval_quality_feedback_loop',dependency_closure:{version:1},source_artifact_ids:[leaf],diagnostic_codes:[],counts:{}});
 await artifact('retrieval_maintenance_report',{findings:[{kind:'thin',objects:[{object_type:'knowledge_item',object_id:item}]}],counts:{thin:1},scanned:1});
 const holder=await db.pool.connect();let pending:ReturnType<typeof call>|undefined,done=false;
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await holder.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);
  pending=call(path,path.includes('review-cycle')?{create_packets:false,include_memory_maintenance:false}:{});const running=Promise.resolve(pending).finally(()=>{done=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>done});expect(done).toBe(false);
  await holder.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE NOWAIT',[item]);
  await holder.query('COMMIT');const response=await running;expect(response.statusCode,response.body).toBe(201);
 }finally{await holder.query('ROLLBACK');holder.release();if(pending)await pending;}
});
