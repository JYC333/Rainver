import {assertResearchArtifactReadable} from '../src/modules/projectResearch/reportAccess.js';
import {ResearchProblemResultService} from '../src/modules/projectResearch/researchProblemResults.js';
import {assertResearchResultRunEgress} from '../src/modules/projectResearch/researchResultEgress.js';
import type {RunRecord} from '../src/modules/runs/repository.js';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember,seedRun} from './support/domainSeeds.js';
import {seedArxivSourceChain,seedRelevantCorpusItem} from './support/researchSeeds.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {ResearchAcquisitionService} from '../src/modules/projectResearch/pipeline/researchAcquisitionService.js';
import {ProjectResearchAreaService} from '../src/modules/projectResearch/areaService.js';
import {ProjectResearchRepository} from '../src/modules/projectResearch/repository.js';
import {ProjectResearchReportRepository} from '../src/modules/projectResearch/reportRepository.js';
import {PgArtifactRepository} from '../src/modules/artifacts/repository.js';
import {assertDocumentReadable} from '../src/modules/reader/repository.js';
import {assertProblemReferences} from '../src/modules/inquiry/problemReferences.js';
import {inquiryModule} from '../src/modules/inquiry/index.js';
import {projectResearchModule} from '../src/modules/projectResearch/index.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {buildModuleServer} from './support/moduleServer.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
const db=useTestDatabase(import.meta.filename);
let space:string,owner:string,peer:string,project:string,thread:string,operation:string,workflow:string,report:string,artifact:string,producer:string,requestRun:string,app:FastifyInstance;
const actor=()=>({spaceId:space,userId:peer}),author=()=>({spaceId:space,userId:owner});
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-p5-repair'});
const area=()=>new ProjectResearchAreaService(db.pool,config());
const artifacts=()=>new PgArtifactRepository(db.pool,config());
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();peer=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'household'});await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
 thread=String((await new InquiryThreadService(db.pool).createThread(author(),project,{kind:'question',statement:'Shared question'})).id);
 requestRun=randomUUID();producer=randomUUID();for(const id of [requestRun,producer]){await seedRun(db.pool,{id,space,owner,agent:randomUUID(),version:randomUUID()});await db.pool.query(`UPDATE runs SET project_id=$2 WHERE id=$1`,[id,project]);}
 const start=await new ResearchAcquisitionService(db.pool).startAcquisition(author(),project,{threadId:thread,requestKey:'report',originRunId:requestRun,originRoomId:null,originSessionId:null});operation=start.operation_id!;
 workflow=(await db.pool.query(`SELECT research_call_json->>'workflow_id' AS id FROM project_operations WHERE id=$1`,[operation])).rows[0].id;
 artifact=randomUUID();report=randomUUID();
 await db.pool.query(`INSERT INTO artifacts(id,space_id,project_id,run_id,artifact_type,surface_role,title,content,exportable,export_formats_json,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,$4,'research_report.archive.v1','system_archive','SECRET ARCHIVE','SECRET CONTENT',true,'[]'::jsonb,$5,'space_shared',now(),now())`,[artifact,space,project,producer,owner]);
 await db.pool.query(`INSERT INTO project_research_reports(id,space_id,project_id,workflow_id,operation_id,synthesis_run_id,run_kind,research_question,research_question_version,content_json,reader_document_json,normalized_text,content_hash,archive_artifact_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'baseline','SECRET TITLE',1,$7::jsonb,'{"type":"doc","content":[]}'::jsonb,'SECRET SUMMARY',$8,$9,now(),now())`,[report,space,project,workflow,operation,producer,JSON.stringify({schema_version:'research_report.v1',summary:'SECRET SUMMARY',findings:[],sources:[],ideas:[{title:'SECRET IDEA'}],limitations:[]}), '0'.repeat(64),artifact]);
 await new ProjectResearchRepository(db.pool).createCheckpoint(author(),project,workflow,{stageKey:'ideas',checkpointType:'idea_review',machineResult:{operation_id:operation,report_id:report,idea_count:1}});
 __setAuthIdentityForTests(actor());app=buildModuleServer(config(),[inquiryModule,projectResearchModule,artifactsModule]);
});
afterEach(async()=>{await app?.close();__setAuthIdentityForTests(null)});
it.each(['thread','source','run'] as const)('blocks Notes, idea checkpoints, archive/read/export/reference after %s withdrawal',async(kind)=>{
 expect(await artifacts().getVisible(space,peer,artifact,true)).toMatchObject({content:'SECRET CONTENT'});
 expect(JSON.stringify(await new ProjectResearchRepository(db.pool).listCheckpoints(actor(),project,workflow))).toContain('SECRET IDEA');
 if(kind==='thread')await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
 if(kind==='run')await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`,[requestRun]);
 if(kind==='source'){const connection=randomUUID(),channel=randomUUID();await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel,now:new Date().toISOString()});const material=await seedRelevantCorpusItem(db.pool,{space,project,owner});await db.pool.query(`UPDATE source_items SET connection_id=$2 WHERE id=$1`,[material.sourceItemId,connection]);await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('channel_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text)) WHERE id=$1`,[operation,channel,material.sourceItemId]);await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);}
 const initialized=await area().initializeArea(actor(),project);expect(JSON.stringify(initialized)).not.toContain('SECRET');
 expect((await db.pool.query(`SELECT plain_text FROM notes WHERE space_id=$1`,[space])).rows.every(r=>!String(r.plain_text).includes('SECRET'))).toBe(true);
 await expect(new ProjectResearchRepository(db.pool).listCheckpoints(actor(),project,workflow)).rejects.toMatchObject({statusCode:404});
 expect(await artifacts().getVisible(space,peer,artifact,true)).toBeNull();expect(await artifacts().exportVisible(space,peer,artifact)).toBeNull();
 const listing=await artifacts().listVisible(space,peer,{projectId:project,includeSystemArchives:true,limit:50,offset:0});expect(listing.total).toBe(0);expect(listing.items).toEqual([]);
 expect((await app.inject({method:'GET',url:`/api/v1/artifacts/${artifact}`})).statusCode).toBe(404);expect((await app.inject({method:'GET',url:`/api/v1/artifacts/${artifact}/export`})).statusCode).toBe(404);
 await expect(assertProblemReferences(db.pool,actor(),project,[{type:'artifact',id:artifact}])).rejects.toMatchObject({statusCode:404});
 await expect(assertDocumentReadable(db.pool,actor(),'research_report',report)).rejects.toMatchObject({statusCode:404});
});
it('never implicitly publishes even an author-readable bound report into shared Notes; legacy unbound seed remains legal',async()=>{
 const initialized=await area().initializeArea(author(),project);expect(JSON.stringify(initialized)).not.toContain('SECRET SUMMARY');expect((await db.pool.query(`SELECT plain_text FROM notes WHERE space_id=$1`,[space])).rows.every(r=>!String(r.plain_text).includes('SECRET'))).toBe(true);
 const legacy=randomUUID();await db.pool.query(`INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'research','Legacy','completed','{}'::jsonb,$4,now(),now())`,[legacy,space,project,owner]);await db.pool.query(`UPDATE project_research_reports SET operation_id=$2 WHERE id=$1`,[report,legacy]);
 await area().seedFromReport({spaceId:space,projectId:project,runId:producer,report:{summary:'Legacy publication'}});
 expect((await db.pool.query(`SELECT plain_text FROM notes WHERE space_id=$1`,[space])).rows.some(r=>String(r.plain_text).includes('Legacy publication'))).toBe(true);
 expect(await artifacts().getVisible(space,peer,artifact,true)).toMatchObject({content:'SECRET CONTENT'});
});
it('rejects unknown, foreign and unreadable cursors, and roundtrips genuine report/operation cursors',async()=>{
 const reports=new ProjectResearchReportRepository(db.pool);const prefix=`/api/v1/projects/${project}`;
 expect((await reports.page(actor(),project,report)).items).toEqual([]);
 expect((await app.inject({method:'GET',url:prefix+`/inquiry/threads/${thread}/research-operations?after_operation_id=${operation}`})).statusCode).toBe(200);
 await expect(reports.page(actor(),project,'not-a-cursor')).rejects.toMatchObject({statusCode:422});
 expect((await app.inject({method:'GET',url:prefix+`/inquiry/threads/${thread}/research-operations?after_operation_id=missing`})).statusCode).toBe(422);
 await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`,[requestRun]);
 await expect(reports.page(actor(),project,report)).rejects.toMatchObject({statusCode:422});
 expect((await app.inject({method:'GET',url:prefix+`/inquiry/threads/${thread}/research-operations?after_operation_id=${operation}`})).statusCode).toBe(422);
});

it('protects producing-run archives before report materialization without relying on mutable artifact metadata',async()=>{
 await db.pool.query(`DELETE FROM project_research_reports WHERE id=$1`,[report]);
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('synthesis_run_id',$2::text) WHERE id=$1`,[operation,producer]);
 expect(await artifacts().getVisible(space,peer,artifact,true)).toMatchObject({content:'SECRET CONTENT'});
 await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`,[requestRun]);
 expect(await artifacts().getVisible(space,peer,artifact,true)).toBeNull();
});

it('roundtrips the returned report page cursor without dropping or duplicating history',async()=>{
 for(let i=0;i<51;i++){const id=randomUUID(),run=randomUUID();await db.pool.query(`INSERT INTO runs SELECT (jsonb_populate_record(null::runs,to_jsonb(r)||jsonb_build_object('id',$2::text))).* FROM runs r WHERE r.id=$1`,[producer,run]);await db.pool.query(`INSERT INTO project_research_reports SELECT (jsonb_populate_record(null::project_research_reports,to_jsonb(r)||jsonb_build_object('id',$2::text,'synthesis_run_id',$3::text))).* FROM project_research_reports r WHERE r.id=$1`,[report,id,run]);}
 const repo=new ProjectResearchReportRepository(db.pool),first=await repo.page(actor(),project);expect(first.items).toHaveLength(50);expect(first.next_cursor).toBeTruthy();
 const next=await repo.page(actor(),project,first.next_cursor);expect(next.items).toHaveLength(2);expect(new Set([...first.items,...next.items].map(r=>r.id)).size).toBe(52);expect(next.next_cursor).toBeNull();
});

it('initializes from an older legal unbound report while the newest bound report is inaccessible',async()=>{
 const legacy=randomUUID(),legacyReport=randomUUID(),legacyRun=randomUUID();await seedRun(db.pool,{id:legacyRun,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query(`INSERT INTO project_operations(id,space_id,project_id,kind,title,status,progress_json,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'research','Legacy','completed','{}'::jsonb,$4,now(),now())`,[legacy,space,project,owner]);
 await db.pool.query(`INSERT INTO project_research_reports SELECT (jsonb_populate_record(null::project_research_reports,to_jsonb(r)||jsonb_build_object('id',$2::text,'operation_id',$3::text,'synthesis_run_id',$4::text,'created_at','2020-01-01T00:00:00Z','research_question','Legacy baseline','content_json',jsonb_build_object('summary','LEGAL LEGACY BASELINE')))).* FROM project_research_reports r WHERE r.id=$1`,[report,legacyReport,legacy,legacyRun]);
 await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[thread]);
 const initialized=await area().initializeArea(actor(),project);expect(JSON.stringify(initialized)).not.toContain('SECRET');
 expect((await db.pool.query(`SELECT plain_text FROM notes WHERE space_id=$1`,[space])).rows.some(r=>String(r.plain_text).includes('LEGAL LEGACY BASELINE'))).toBe(true);
});
it('initializes with an empty report candidate set without inventing shared report text',async()=>{
 await db.pool.query(`DELETE FROM project_research_reports WHERE project_id=$1`,[project]);
 const initialized=await area().initializeArea(actor(),project);expect(JSON.stringify(initialized)).not.toContain('SECRET');
 expect((await db.pool.query(`SELECT count(*)::int AS n FROM note_collections WHERE project_id=$1`,[project])).rows[0].n).toBe(1);
});

it('keeps mixed HTTP lists usable while withholding only private transitive research content',async()=>{
 const dependencyThread=String((await new InquiryThreadService(db.pool).createThread(author(),project,{kind:'question',statement:'Private dependency'})).id);
 const started=await new ResearchAcquisitionService(db.pool).startAcquisition(author(),project,{threadId:dependencyThread,requestKey:'dependency',originRunId:requestRun,originRoomId:null,originSessionId:null});
 const healthyThread=String((await new InquiryThreadService(db.pool).createThread(author(),project,{kind:'question',statement:'Healthy independent report'})).id);
 const healthyCall=await new ResearchAcquisitionService(db.pool).startAcquisition(author(),project,{threadId:healthyThread,requestKey:'healthy',originRunId:requestRun,originRoomId:null,originSessionId:null});
 const healthy=randomUUID();
 await db.pool.query(`INSERT INTO artifacts SELECT (jsonb_populate_record(null::artifacts,to_jsonb(a)||jsonb_build_object('id',$2::text,'run_id',null,'title','Healthy report'))).* FROM artifacts a WHERE id=$1`,[artifact,healthy]);
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text)) WHERE id=$1`,[healthyCall.operation_id,healthy]);
 const dependency=randomUUID(),ordinary=randomUUID();
 await db.pool.query(`INSERT INTO artifacts SELECT (jsonb_populate_record(null::artifacts,to_jsonb(a)||jsonb_build_object('id',$2::text,'run_id',null,'title','PRIVATE DERIVED TITLE'))).* FROM artifacts a WHERE id=$1`,[artifact,dependency]);
 await db.pool.query(`INSERT INTO artifacts SELECT (jsonb_populate_record(null::artifacts,to_jsonb(a)||jsonb_build_object('id',$2::text,'run_id',null,'title','Ordinary output'))).* FROM artifacts a WHERE id=$1`,[artifact,ordinary]);
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text)) WHERE id=$1`,[started.operation_id,dependency]);
 await db.pool.query(`UPDATE project_operations SET research_call_json=jsonb_set(research_call_json,'{input_refs}',$2::jsonb) WHERE id=$1`,[operation,JSON.stringify([{type:'artifact',id:dependency}])]);
 await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`,[dependencyThread]);
 const response=await app.inject({method:'GET',url:`/api/v1/artifacts?project_id=${project}&include_system_archives=true&limit=50`});
 expect(response.statusCode).toBe(200);const page=response.json();expect(page.total).toBe(3);expect(page.items.map((r:{id:string})=>r.id).sort()).toEqual([artifact,ordinary,healthy].sort());
 expect(page.items.find((r:{id:string})=>r.id===healthy)).toMatchObject({title:'Healthy report',access_level:'full'});
 const summary=page.items.find((r:{id:string})=>r.id===artifact);expect(summary).toMatchObject({title:'Research report artifact',access_level:'summary',content:null,owner_user_id:null,run_id:null,metadata_json:null,storage_ref:null,storage_path:null,project_folder_id:null,exportable:false,preview:false});
 expect(JSON.stringify(summary)).not.toMatch(/SECRET|PRIVATE DERIVED/);
 expect((await app.inject({method:'GET',url:`/api/v1/artifacts/${artifact}`})).json()).toMatchObject({access_level:'summary',content:null});
 expect((await app.inject({method:'GET',url:`/api/v1/artifacts/${artifact}/export`})).statusCode).toBe(404);
 await expect(new ProjectResearchReportRepository(db.pool).get(actor(),project,report)).rejects.toMatchObject({statusCode:404});
 await expect(assertDocumentReadable(db.pool,actor(),'research_report',report)).rejects.toMatchObject({statusCode:404});
 await expect(new ResearchProblemResultService(db.pool).read(actor(),project,operation)).rejects.toMatchObject({statusCode:404});
 await expect(assertResearchResultRunEgress(db.pool,{space_id:space,project_id:project,instructed_by_user_id:peer} as RunRecord,operation)).rejects.toMatchObject({statusCode:404});
 // Corrupt bindings cannot be hidden behind an unrelated unreadable input.
 const saved=(await db.pool.query(`SELECT research_call_json FROM project_operations WHERE id=$1`,[operation])).rows[0].research_call_json;
 await db.pool.query(`UPDATE project_operations SET research_call_json=research_call_json||'{"input_refs":"broken"}'::jsonb WHERE id=$1`,[operation]);
 await expect(assertResearchArtifactReadable(db.pool,actor(),artifact)).rejects.toMatchObject({statusCode:409});
 await db.pool.query(`UPDATE project_operations SET research_call_json=$2::jsonb WHERE id=$1`,[operation,JSON.stringify(saved)]);
 // The same origin becoming direct must hide the root, even if also reached
 // through an input edge. No row-order-dependent summary fallback is allowed.
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text,$3::text)) WHERE id=$1`,[started.operation_id,dependency,artifact]);
 const hidden=await app.inject({method:'GET',url:`/api/v1/artifacts?project_id=${project}&include_system_archives=true&limit=50`});expect(hidden.statusCode).toBe(200);expect(hidden.json().total).toBe(2);expect(JSON.stringify(hidden.json())).not.toContain(artifact);
 expect(await artifacts().getVisible(space,peer,artifact,true)).toBeNull();
});

it('propagates genuine PostgreSQL failures instead of treating them as missing content',async()=>{
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  // Transaction-local schema fault in this isolated fixture, always rolled back.
  await client.query('ALTER TABLE project_operations RENAME TO unavailable_operations');
  await expect(new PgArtifactRepository(client,config()).getVisible(space,peer,artifact,true)).rejects.toMatchObject({code:'42P01'});
 }finally{await client.query('ROLLBACK');client.release();}
});
