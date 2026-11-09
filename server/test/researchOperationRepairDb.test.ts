import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {assertThreadReadable} from '../src/modules/inquiry/threadAccess.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterAll,describe,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {SystemActionId} from '@rainver/protocol';
import {ResearchOperationMetadataSchema} from '@rainver/protocol';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {seedArxivSourceChain,seedRelevantCorpusItem} from './support/researchSeeds.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {ResearchAcquisitionService} from '../src/modules/projectResearch/pipeline/researchAcquisitionService.js';
import {reconcileResearchCall} from '../src/modules/projectResearch/researchProblemCalls.js';
import {ResearchProblemResultService} from '../src/modules/projectResearch/researchProblemResults.js';
import {ProjectOperationService} from '../src/modules/projects/projectOperationService.js';
import {loadConfig} from '../src/config.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {registerProjectResearchSystemActionExecutors} from '../src/modules/projectResearch/projectResearchSystemActionExecutors.js';
import type {SystemActionExecutor,SystemActionDispatchContext} from '../src/modules/systemActions/gateway.js';
import type {RunRecord} from '../src/modules/runs/repository.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,project:string,thread:string,app:FastifyInstance|undefined;
const identity=()=>({spaceId:space,userId:owner});
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-research-repair-tests'});
const service=()=>new ResearchAcquisitionService(db.pool);
const start=(key:string,extra:Record<string,unknown>={})=>service().startAcquisition(identity(),project,{threadId:thread,requestKey:key,originRoomId:null,originSessionId:null,...extra});
beforeEach(async()=>{
 if(!db.available)return;
 if(app){await app.close();app=undefined;}
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});
 thread=String((await new InquiryThreadService(db.pool).createThread(identity(),project,{kind:'question',statement:'Private problem body'})).id);
 __setAuthIdentityForTests(identity());
});
afterAll(async()=>{if(app)await app.close();__setAuthIdentityForTests(null);});
describe('Research metadata and invocation repair (real PostgreSQL)',()=>{
 it('keeps active and completed HTTP records and Stop after Source withdrawal, without any cached content',async()=>{
  const first=await start('history');await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[first.operation_id]);
  const active=await start('active');
  const connection=randomUUID(),channel=randomUUID();await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel,now:new Date().toISOString()});
  const material=await seedRelevantCorpusItem(db.pool,{space,project,owner});
  await db.pool.query(`UPDATE source_items SET connection_id=$2 WHERE id=$1`,[material.sourceItemId,connection]);
  await db.pool.query(`UPDATE project_operations SET title='WITHDRAWN SECRET TITLE',intent_text='WITHDRAWN SECRET INTENT',research_reconcile_json='{"secret":"WITHDRAWN SECRET DIAGNOSTIC"}',research_call_json=jsonb_set(research_call_json,'{gap}','"WITHDRAWN SECRET GAP"'),progress_json=progress_json||jsonb_build_object('channel_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text),'summary','WITHDRAWN SECRET CACHE','error',jsonb_build_object('message','WITHDRAWN SECRET ERROR')) WHERE id=ANY($1::varchar[])`,[[first.operation_id,active.operation_id],channel,material.sourceItemId]);
  await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);
  await expect(start('after-withdrawal')).rejects.toMatchObject({statusCode:409});
  app=buildModuleServer(config(),[projectsModule,projectResearchModule]);
  const response=await app.inject({method:'GET',url:`/api/v1/projects/${project}/operations`});expect(response.statusCode).toBe(200);
  const items=response.json();expect(items).toHaveLength(2);
  for(const item of items){expect(ResearchOperationMetadataSchema.safeParse(item).success).toBe(true);expect(item.stop_ref.operation_id).toBe(item.id);}
  expect(new Set(items.map((i:{status:string})=>i.status))).toEqual(new Set(['active','completed']));
  expect(response.body).not.toContain('WITHDRAWN');expect(response.body).not.toContain(channel);expect(response.body).not.toContain(material.sourceItemId);
  const detail=await app.inject({method:'GET',url:`/api/v1/projects/${project}/operations/${active.operation_id}`});expect(detail.statusCode).toBe(200);expect(detail.json()).toMatchObject({id:active.operation_id,content_withheld:true,links:[],steps:[]});expect(detail.body).not.toContain('WITHDRAWN');
  await expect(new ResearchProblemResultService(db.pool).read(identity(),project,active.operation_id!)).rejects.toMatchObject({statusCode:404});
  const stopped=await app.inject({method:'POST',url:`/api/v1/projects/${project}/research/operations/${active.operation_id}/cancel`,payload:{reason:'Stop withdrawn source'}});expect(stopped.statusCode).toBe(200);expect(stopped.json().status).toBe('cancelled');
  await db.pool.query(`DELETE FROM project_corpus_item_sources WHERE source_item_id=$1`,[material.sourceItemId]);
  await db.pool.query(`DELETE FROM project_corpus_items WHERE source_item_id=$1`,[material.sourceItemId]);
  await db.pool.query(`DELETE FROM source_items WHERE id=$1`,[material.sourceItemId]);
  expect((await app.inject({method:'GET',url:`/api/v1/projects/${project}/operations/${first.operation_id}`})).statusCode).toBe(200);
 });
 it('preserves full HTTP progress for authorized calls and classifies only content withdrawal as metadata',async()=>{
  const call=await start('full');
  await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||'{"run_kind":"baseline","current_stage":"historical_backfill","partial":false,"history":{"max_items":50}}'::jsonb WHERE id=$1`,[call.operation_id]);
  app=buildModuleServer(config(),[projectsModule]);
  const url=`/api/v1/projects/${project}/operations`;
  const detail=await app.inject({method:'GET',url:`${url}/${call.operation_id}`});expect(detail.statusCode).toBe(200);
  const full=detail.json();expect(full.progress_json).toMatchObject({workflow_id:expect.any(String),run_kind:'baseline',current_stage:'historical_backfill',partial:false,history:{max_items:50}});expect(full.content_withheld).toBeUndefined();
  const list=await app.inject({method:'GET',url});expect(list.statusCode).toBe(200);expect(list.json()[0].progress_json).toEqual(full.progress_json);
  // Binding corruption is a conflict, not a content-withheld fallback.
  await db.pool.query(`UPDATE project_operations SET research_call_json=research_call_json-'gap' WHERE id=$1`,[call.operation_id]);
  expect((await app.inject({method:'GET',url:`${url}/${call.operation_id}`})).statusCode).toBe(409);
 });
 it('does not expose Thread/Run-denied calls or return their identity through active admission',async()=>{
  const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
  const first=await start('run',{originRunId:run});
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
  app=buildModuleServer(config(),[projectsModule]);
  __setAuthIdentityForTests({spaceId:space,userId:peer});
  const url=`/api/v1/projects/${project}/operations`;
  expect((await app.inject({method:'GET',url})).json()).toHaveLength(1);
  await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`,[run]);
  expect((await app.inject({method:'GET',url})).json()).toEqual([]);
  expect((await app.inject({method:'GET',url:`${url}/${first.operation_id}`})).statusCode).toBe(404);
  await expect(service().startAcquisition({spaceId:space,userId:peer},project,{threadId:thread,requestKey:'peer',originRoomId:null,originSessionId:null})).rejects.toMatchObject({statusCode:409,message:'Another research invocation is active'});
  await db.pool.query(`UPDATE runs SET visibility='space_shared' WHERE id=$1`,[run]);
  await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
  expect((await app.inject({method:'GET',url})).json()).toEqual([]);
  expect((await app.inject({method:'GET',url:`${url}/${first.operation_id}`})).statusCode).toBe(404);
 });
 it('refuses generic stop without Run reach or Thread change authority and creates no stop Job',async()=>{
  const run=randomUUID();await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
  const call=await start('stop-gates',{originRunId:run});
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer,role:'admin'});
  const person={spaceId:space,userId:peer};
  await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())",[randomUUID(),space,project,peer]);
  app=buildModuleServer(config(),[projectsModule,systemActionsModule]);
  __setAuthIdentityForTests(person);
  const refused=async()=>{
    for(const generic of [false,true]) {
      const result=await app!.inject({method:'POST',
        url:generic?'/api/v1/actions/project.operation.cancel':`/api/v1/projects/${project}/operations/${call.operation_id}/cancel`,
        payload:generic?{project_id:project,operation_id:call.operation_id}:{},headers:{'idempotency-key':randomUUID()}});
      expect(result.statusCode,result.body).toBe(404);expect(result.json().error.code).toBe('operation_not_found');
      expect(result.body).not.toContain('Private problem body');
    }
    expect((await db.pool.query('SELECT status FROM project_operations WHERE id=$1',[call.operation_id])).rows[0].status).toBe('active');
    expect((await db.pool.query("SELECT id FROM jobs WHERE job_type='research_operation_cancel' AND payload_json->>'operation_id'=$1",[call.operation_id])).rows).toHaveLength(0);
  };
  await db.pool.query("UPDATE runs SET visibility='private' WHERE id=$1",[run]);
  await refused();
  await db.pool.query("UPDATE runs SET visibility='space_shared' WHERE id=$1",[run]);
  await db.pool.query("UPDATE spaces SET oversight_mode='content' WHERE id=$1",[space]);
  await db.pool.query("UPDATE space_objects SET visibility='private' WHERE id=$1",[thread]);
  await expect(assertThreadReadable(db.pool,person,project,thread,'read_content')).resolves.toBeUndefined();
  await expect(assertThreadReadable(db.pool,person,project,thread,'change')).rejects.toMatchObject({statusCode:404});
  await refused();
 });
 it('paginates authorized metadata and preserves the old unbound operation content',async()=>{
  const a=await start('a');await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[a.operation_id]);await start('b');
  const legacy=await new ProjectOperationService(db.pool).create(identity(),project,{kind:'custom',title:'Legacy manual operation',intent_text:'Keep the old read contract'});
  app=buildModuleServer(config(),[projectsModule]);let cursor:string|undefined;const items:Record<string,unknown>[]=[];
  do{const r=await app.inject({method:'GET',url:`/api/v1/projects/${project}/operations?limit=1${cursor?`&after_id=${cursor}`:''}`});expect(r.statusCode).toBe(200);items.push(...r.json());cursor=r.headers['x-next-cursor'] as string|undefined;}while(cursor);
  expect(new Set(items.map(i=>i.id)).size).toBe(3);expect(items.find(i=>i.id===legacy.id)?.title).toBe('Legacy manual operation');
  const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
  await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
  await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
  expect(await new ProjectOperationService(db.pool).list({spaceId:space,userId:peer},project)).toHaveLength(1);
 });
 it('coalesces new action identities only onto an authorized same-scope active call and preserves receipts after completion',async()=>{
  const first=await start('first',{maxItems:20,since:'2026-01-01'});
  const aliases=await Promise.all(['next-run-a','next-run-b','next-run-c'].map(k=>start(k)));
  expect(aliases.every(r=>r.status==='already_starting'&&r.operation_id===first.operation_id)).toBe(true);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_operations WHERE project_id=$1`,[project])).rows[0].n).toBe(1);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE job_type='research_pipeline_start' AND space_id=$1`,[space])).rows[0].n).toBe(1);
  await expect(start('different',{maxItems:100})).rejects.toMatchObject({statusCode:409});
  await expect(start('next-run-a',{maxItems:20})).rejects.toMatchObject({statusCode:409});
  await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[first.operation_id]);
  expect((await start('next-run-a')).operation_id).toBe(first.operation_id);
  expect((await start('fresh-after-complete')).operation_id).not.toBe(first.operation_id);
 });
 it('requires canonical action-call identity instead of deriving it from the Thread',async()=>{
  const map=new Map<SystemActionId,SystemActionExecutor>();registerProjectResearchSystemActionExecutors(map,config(),{id:randomUUID(),space_id:space,project_id:project,instructed_by_user_id:owner} as RunRecord);
  await expect(map.get('research.start_acquisition')!({thread_id:thread},{} as SystemActionDispatchContext)).rejects.toMatchObject({statusCode:422});
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM project_operations WHERE project_id=$1`,[project])).rows[0].n).toBe(0);
 });
 it('rejects cross-Space Step binding and protects a referenced Step from standalone deletion',async()=>{
  const first=await start('local');const otherSpace=randomUUID(),otherOwner=randomUUID(),otherProject=randomUUID();await seedSpaceOwnerProject(db.pool,{space:otherSpace,owner:otherOwner,project:otherProject});
  const otherThread=String((await new InquiryThreadService(db.pool).createThread({spaceId:otherSpace,userId:otherOwner},otherProject,{kind:'question',statement:'Other tenant'})).id);
  const other=await new ResearchAcquisitionService(db.pool).startAcquisition({spaceId:otherSpace,userId:otherOwner},otherProject,{threadId:otherThread,originRoomId:null,originSessionId:null});
  const foreignStep=(await db.pool.query(`SELECT research_step_id FROM project_operations WHERE id=$1`,[other.operation_id])).rows[0].research_step_id;
  await db.pool.query(`UPDATE project_operations SET research_step_id=NULL,research_call_json=NULL,research_call_key=NULL WHERE id=$1`,[other.operation_id]);
  await expect(db.pool.query(`UPDATE project_operations SET research_step_id=$2::varchar,research_call_json=jsonb_set(research_call_json,'{step_id}',to_jsonb($2::varchar)) WHERE id=$1`,[first.operation_id,foreignStep])).rejects.toMatchObject({code:'23503',constraint:'research_problem_step_scope_fkey'});
  await expect(db.pool.query(`DELETE FROM inquiry_thread_steps WHERE id=(SELECT research_step_id FROM project_operations WHERE id=$1)`,[first.operation_id])).rejects.toMatchObject({code:'23503'});
 });
 it('preserves the original SQL exception in an aborted nested transaction and when diagnostic storage also fails',async()=>{
  const first=await start('fault');
  // Reconciliation writes the Step only when its status changes; settle the call so it must.
  await db.pool.query(`UPDATE project_operations SET status='completed' WHERE id=$1`,[first.operation_id]);
  await db.pool.query(`CREATE FUNCTION reject_repair_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'original_step_failure' USING ERRCODE='P0001'; END $$`);
  await db.pool.query(`CREATE TRIGGER reject_repair_step BEFORE UPDATE ON inquiry_thread_steps FOR EACH ROW EXECUTE FUNCTION reject_repair_step()`);
  const client=await db.pool.connect();
  try{await client.query('BEGIN');await expect(reconcileResearchCall(client,space,first.operation_id!)).rejects.toMatchObject({code:'P0001',message:'original_step_failure'});await client.query('ROLLBACK');}finally{await client.query('ROLLBACK');client.release();}
  await db.pool.query(`CREATE FUNCTION reject_repair_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.research_reconcile_json IS DISTINCT FROM OLD.research_reconcile_json THEN RAISE EXCEPTION 'diagnostic_write_failure' USING ERRCODE='P0002'; END IF; RETURN NEW; END $$`);
  await db.pool.query(`CREATE TRIGGER reject_repair_diagnostic BEFORE UPDATE ON project_operations FOR EACH ROW EXECUTE FUNCTION reject_repair_diagnostic()`);
  try{await expect(reconcileResearchCall(db.pool,space,first.operation_id!)).rejects.toMatchObject({code:'P0001',message:'original_step_failure'});}finally{await db.pool.query('DROP TRIGGER reject_repair_step ON inquiry_thread_steps');await db.pool.query('DROP FUNCTION reject_repair_step()');await db.pool.query('DROP TRIGGER reject_repair_diagnostic ON project_operations');await db.pool.query('DROP FUNCTION reject_repair_diagnostic()');}
 });
});
