import {PgArtifactRepository} from '../src/modules/artifacts/repository.js';
import {buildModuleServer} from './support/moduleServer.js';
import {readerModule} from '../src/modules/reader/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject,seedRun,seedProjectMainlineRoom} from './support/domainSeeds.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {resetTables} from './support/resetTables.js';
import {withDbTransaction} from '../src/modules/routeUtils/common.js';
import {loadConfig} from '../src/config.js';
import {agentReadingDocument,agentReadingMetadata,saveSourceReadingDocument} from '../src/modules/sources/materialProcessing/documents.js';
import {PgReaderRepository,PgAnnotationRepository} from '../src/modules/reader/repository.js';
import {ReaderPositionStore} from '../src/modules/reader/positions.js';
import {projectReadingRecords} from '../src/modules/reader/readingRecords.js';
import {ProjectReadingRecordsSchema} from '@rainver/protocol';

const db=useTestDatabase(import.meta.filename);
afterEach(()=>__setAuthIdentityForTests(null));
const space=randomUUID(),owner=randomUUID(),project=randomUUID(),other=randomUUID();
const identity={spaceId:space,userId:owner};
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const reader=()=>new PgReaderRepository(db.pool,config());
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','source_connectors','source_providers'],{cascade:true});
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await db.pool.query(`INSERT INTO users(id,display_name,status,email,registration_source,created_at,updated_at) VALUES($1,'Other','active',$2,'system',now(),now())`,[other,`${other}@test.invalid`]);
 await db.pool.query(`INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())`,[randomUUID(),space,other]);
 await db.pool.query(`INSERT INTO project_members(id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,$4,'viewer','active',now(),now())`,[randomUUID(),space,project,other]);
});
async function item(){
 const id=randomUUID();await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,'space_shared','external_url','Article',$5,$5,'metadata_only','full_text',now(),now(),now(),now())`,[id,space,project,owner,`https://example.test/${id}`]);return id;
}
async function original(id:string){
 const content=agentReadingDocument({kind:'article',format:'source_text',syntax:'plain',text:'Original A author evidence.',sources:['https://example.test/article']},'https://example.test/article');
 return withDbTransaction(db.pool,tx=>saveSourceReadingDocument(tx,{spaceId:space,itemId:id,document:{...content,extraction_method:'plain_text_v1'}}));
}
async function report(id:string,text:string,runId?:string,format:'agent_summary'|'source_text'='agent_summary'){
 const content={kind:'article' as const,format,syntax:'markdown' as const,text,sources:['https://example.test/article']};
 return withDbTransaction(db.pool,tx=>saveSourceReadingDocument(tx,{spaceId:space,itemId:id,document:agentReadingDocument(content,'https://example.test/article'),agentProvided:true,metadata:{...agentReadingMetadata(content),...(runId?{agent_run_id:runId}:{})}}));
}
async function run(){const id=randomUUID();await seedRun(db.pool,{id,space,owner,agent:randomUUID(),version:randomUUID()});await db.pool.query("UPDATE runs SET runtime_key='codex_cli',instructed_by_user_id=owner_user_id,visibility='private',status='succeeded' WHERE id=$1",[id]);return id;}
async function sourceFor(id:string){
 const connection=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{"retention_policy":"full_text","source_egress_class":"external_provider_allowed"}',consent_json=consent_json||'{"allow_external_model_egress":true}' WHERE id=$1`,[connection]);
 await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[id,connection]);
 return connection;
}
async function expectReportVisible(id:string,d:{snapshotId:string;artifactId:string},visible:boolean){
 const artifacts=new PgArtifactRepository(db.pool,config());
 const actual={
  reader:Boolean(await reader().getDocument(identity,'source_snapshot',d.snapshotId)),
  detail:Boolean(await artifacts.getVisible(space,owner,d.artifactId,true)),
  export:Boolean(await artifacts.exportVisible(space,owner,d.artifactId)),
  list:(await artifacts.listVisible(space,owner,{limit:100,offset:0})).items.some(a=>a.id===d.artifactId),
  records:(await projectReadingRecords(db.pool,identity,id)).items.some(r=>r.snapshot_id===d.snapshotId),
 };
 expect(actual).toEqual({reader:visible,detail:visible,export:visible,list:visible,records:visible});
}
it.each([
 {hasOriginal:false,policy:'capture'}, {hasOriginal:false,policy:'retention'},
 {hasOriginal:true,policy:'capture'}, {hasOriginal:true,policy:'retention'},
])('analysis with original=$hasOriginal follows Source $policy withdrawal and recovery without changing personal reads',async({hasOriginal,policy})=>{
 const id=await item(),connection=await sourceFor(id);
 if(hasOriginal)await original(id);
 const d=await report(id,'Private analysis must follow retention',await run());
 // Existing personal Agent bodies use the ordinary single-document contract.
 const personal=await item();await db.pool.query('UPDATE source_items SET project_id=NULL,connection_id=$2 WHERE id=$1',[personal,connection]);
 const p=await report(personal,'Personal compatibility body');
 await expectReportVisible(id,d,true);
 await db.pool.query(policy==='capture'
  ? "UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1"
  : `UPDATE source_connections SET policy_json=policy_json||'{"retention_policy":"metadata_only"}' WHERE id=$1`,[connection]);
 await expectReportVisible(id,d,false);
 expect((await reader().getDocument(identity,'source_item',personal,{recordOpen:false}))?.artifact_id).toBe(p.artifactId);
 expect(await new PgArtifactRepository(db.pool,config()).exportVisible(space,owner,p.artifactId)).not.toBeNull();
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{"retention_policy":"full_text"}' WHERE id=$1`,[connection]);
 await expectReportVisible(id,d,true);
});

it('analysis also follows every supporting Source retention policy',async()=>{
 const id=await item();
 const supporting=await item(),connection=await sourceFor(supporting),a=await original(supporting);
 const content={kind:'article' as const,format:'agent_summary' as const,text:'Supported independent report',sources:['https://example.test/article']};
 const d=await saveSourceReadingDocument(db.pool,{spaceId:space,itemId:id,agentProvided:true,document:agentReadingDocument(content,'https://example.test/article'),metadata:{...agentReadingMetadata(content),reading_history_refs:[{item_id:supporting,artifact_id:a.artifactId,snapshot_id:a.snapshotId,content_hash:a.contentHash}]}});
 await expectReportVisible(id,d,true);
 for(const policy of ['capture','retention']){
  await db.pool.query(policy==='capture'?"UPDATE source_connections SET capture_policy='reference_only' WHERE id=$1":`UPDATE source_connections SET policy_json=policy_json||'{"retention_policy":"metadata_only"}' WHERE id=$1`,[connection]);
  await expectReportVisible(id,d,false);
  await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{"retention_policy":"full_text"}' WHERE id=$1`,[connection]);
  await expectReportVisible(id,d,true);
 }
});

it.each(['custom_extract','agent_provided_v1'])('original availability stays unknown across pages with %s extracted history',async(extractor)=>{
 const id=await item(),old=await original(id);
 await db.pool.query("UPDATE artifacts SET metadata_json=jsonb_set(metadata_json,'{extraction_method}',to_jsonb($2::text)) WHERE id=$1",[old.artifactId,extractor]);
 await db.pool.query("UPDATE source_snapshots SET reading_role=NULL,captured_at='2020-01-01' WHERE id=$1",[old.snapshotId]);
 await db.pool.query('UPDATE source_items SET extracted_artifact_id=NULL WHERE id=$1',[id]);
 for(let n=0;n<26;n++)await report(id,`New analysis ${n}`);
 const first=await projectReadingRecords(db.pool,identity,id),last=await projectReadingRecords(db.pool,identity,id,25);
 expect(first.items).toHaveLength(25);expect(first.next_offset).toBe(25);
 expect(first.original).toBeNull();expect(first.original_availability).toBe('unknown');
 expect(last.items.some(r=>r.role===(extractor==='agent_provided_v1'?'legacy_analysis':'unknown'))).toBe(true);expect(last.original_availability).toBe('unknown');
 expect((await projectReadingRecords(db.pool,identity,id,100)).original_availability).toBe('unknown');
});

it('an unreadable original is unknown without returning its identity or changing with pagination',async()=>{
 const id=await item();await report(id,'New private analysis');const a=await original(id);
 // The report belongs to owner, but its possible original no longer does.
 await db.pool.query("UPDATE source_snapshots SET visibility='private',owner_user_id=$2 WHERE id=$1",[a.snapshotId,other]);
 await db.pool.query("UPDATE artifacts SET visibility='private',owner_user_id=$2 WHERE id=$1",[a.artifactId,other]);
 for(const offset of [0,25]){
  const records=await projectReadingRecords(db.pool,identity,id,offset);
  expect(records.original).toBeNull();expect(records.original_availability).toBe('unknown');
  expect(JSON.stringify(records)).not.toContain(a.snapshotId);expect(JSON.stringify(records)).not.toContain(a.artifactId);
  if(offset===0)expect(records.items.some(r=>r.role==='analysis')).toBe(true);
 }
});

it('only an analysis-only history proves not retained, independent of page; raw and metadata history stay unknown',async()=>{
 const id=await item();await report(id,'No retained original');
 expect((await projectReadingRecords(db.pool,identity,id,25)).original_availability).toBe('not_retained');
 const old=await original(id);
 for(const snapshotType of ['metadata','raw']){
  await db.pool.query('UPDATE source_snapshots SET snapshot_type=$2,reading_role=NULL WHERE id=$1',[old.snapshotId,snapshotType]);
  await db.pool.query('UPDATE source_items SET extracted_artifact_id=NULL WHERE id=$1',[id]);
  expect((await projectReadingRecords(db.pool,identity,id)).original_availability).toBe('unknown');
 }
});
it('A -> independent D/D2 preserves body hash, annotations and private position; distinct report versions and replay',async()=>{
 const id=await item(),a=await original(id),r1=await run(),r2=await run();
 const doc=await reader().getDocument(identity,'source_item',id,{recordOpen:false});expect(doc?.plain_text).toContain('Original A');expect(doc?.reading_role).toBe('original');
 const ann=await new PgAnnotationRepository(db.pool).createAnnotation(identity,{document_type:'source_item',document_id:id,annotation_type:'highlight',quote_text:'Original A',anchor_json:{schema_version:1,quote_text:'Original A',text_range:{start:0,end:10,unit:'utf16'},before_context:'',after_context:' author evidence.'}});
 await new ReaderPositionStore(db.pool,config()).write(identity,'source_item',id,{content_hash:doc!.content_hash,structure_hash:doc!.structure_hash,current:{anchor:{block_index:0,pm_pos:1,text_offset:0,quote:'Original A',before_context:''},progress:0.5},dwelled:true,client_at:new Date().toISOString()});
 const before=(await db.pool.query('SELECT content_hash,reading_body_hash,reading_body_revision,extracted_artifact_id FROM source_items WHERE id=$1',[id])).rows[0];
 const position=await new ReaderPositionStore(db.pool).get(identity,'source_item',id);
 const d=await report(id,'# Analysis D',r1),d2=await report(id,'# Analysis D2',r2);
 expect(d.artifactId).not.toBe(d2.artifactId);expect(await report(id,'# Analysis D2',r2)).toEqual(d2);
 await expect(report(id,'different content',r2)).rejects.toThrow(/already published/);
 expect((await db.pool.query('SELECT content_hash,reading_body_hash,reading_body_revision,extracted_artifact_id FROM source_items WHERE id=$1',[id])).rows[0]).toEqual(before);
 expect(await new ReaderPositionStore(db.pool).get(identity,'source_item',id)).toEqual(position);
 expect((await new PgAnnotationRepository(db.pool).listAnnotations(identity,'source_item',id)).map(x=>x.id)).toContain(ann.id);
 expect((await reader().getDocument(identity,'source_snapshot',d.snapshotId))?.plain_text).toContain('Analysis D');expect((await reader().getDocument(identity,'source_snapshot',d.snapshotId))?.reading_role).toBe('analysis');
 expect(await reader().getDocument({spaceId:space,userId:other},'source_snapshot',d.snapshotId)).toBeNull();
 const records=ProjectReadingRecordsSchema.parse(await projectReadingRecords(db.pool,identity,id));expect(records.original?.snapshot_id).toBe(a.snapshotId);expect(records.items.filter(v=>v.role==='analysis')).toHaveLength(2);
 expect((await projectReadingRecords(db.pool,{spaceId:space,userId:other},id)).items.map(x=>x.role)).toEqual(['original']);
 await db.pool.query("UPDATE source_items SET visibility='private' WHERE id=$1",[id]);
 await expect(projectReadingRecords(db.pool,{spaceId:space,userId:other},id)).rejects.toThrow();
});
it('Agent source_text and undeclared legacy are never promoted to deterministic original; compatibility links survive',async()=>{
 const id=await item();const d=await report(id,'claimed source text',undefined,'source_text');
 expect((await db.pool.query('SELECT extracted_artifact_id,content_hash FROM source_items WHERE id=$1',[id])).rows[0]).toEqual({extracted_artifact_id:null,content_hash:null});
 let records=await projectReadingRecords(db.pool,identity,id);expect(records.original_availability).toBe('not_retained');expect(records.items[0].role).toBe('analysis');
 // Represent pre-R1 rows; don't rewrite their identity or move annotations.
 await db.pool.query("UPDATE source_snapshots SET reading_role=NULL,snapshot_type='extracted' WHERE id=$1",[d.snapshotId]);
 await db.pool.query("UPDATE artifacts SET metadata_json=metadata_json-'reading_role'-'reading_analysis_destination'-'reading_content_syntax' WHERE id=$1",[d.artifactId]);
 await db.pool.query('UPDATE source_items SET extracted_artifact_id=$2 WHERE id=$1',[id,d.artifactId]);
 records=await projectReadingRecords(db.pool,identity,id);expect(records.items[0]).toMatchObject({role:'legacy_analysis',format:'source_text'});expect(records.original_availability).toBe('unknown');
 expect((await reader().getDocument(identity,'source_item',id,{recordOpen:false}))?.artifact_id).toBe(d.artifactId);
 const {showAgentTextAsMarkdown}=await import('../src/modules/sources/materialProcessing/syntax.js');await expect(showAgentTextAsMarkdown(db.pool,config(),identity,id,{artifact_id:d.artifactId,source_snapshot_id:null})).rejects.toThrow('independent version');
 const a=await original(id);records=await projectReadingRecords(db.pool,identity,id);expect(records.original?.snapshot_id).toBe(a.snapshotId);
 expect((await reader().getDocument(identity,'source_snapshot',d.snapshotId))?.artifact_id).toBe(d.artifactId);
});
it('Source permission/actual external egress revocation withholds derived snapshot and records while original stays under its own gate',async()=>{
 const id=await item(),connection=randomUUID();await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query(`UPDATE source_connections SET project_id=$2,capture_policy='extract_text',policy_json=policy_json||'{"retention_policy":"full_text","source_egress_class":"external_provider_allowed"}',consent_json=consent_json||'{"allow_external_model_egress":true}' WHERE id=$1`,[connection,project]);
 await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[id,connection]);await original(id);const d=await report(id,'Independent report',await run());
 expect(await reader().getDocument(identity,'source_snapshot',d.snapshotId)).not.toBeNull();expect(await new PgArtifactRepository(db.pool,config()).getVisible(space,owner,d.artifactId,true)).not.toBeNull();
 await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false}' WHERE id=$1`,[connection]);
 expect(await reader().getDocument(identity,'source_snapshot',d.snapshotId)).toBeNull();expect(await new PgArtifactRepository(db.pool,config()).getVisible(space,owner,d.artifactId,true)).toBeNull();expect((await new PgArtifactRepository(db.pool,config()).listVisible(space,owner,{limit:25,offset:0})).items.some(a=>a.id===d.artifactId)).toBe(false);expect((await projectReadingRecords(db.pool,identity,id)).items.some(x=>x.role==='analysis')).toBe(false);
 await db.pool.query("UPDATE source_connections SET status='archived' WHERE id=$1",[connection]);await expect(projectReadingRecords(db.pool,identity,id)).rejects.toThrow();
});

it('records GET is read-only, bounded and refuses cross-space/summary callers',async()=>{
 const id=await item();await original(id);await report(id,'private report',await run());
 const before=(await db.pool.query('SELECT * FROM source_item_user_states WHERE source_item_id=$1',[id])).rows;
 __setAuthIdentityForTests({spaceId:space,userId:owner});const app=buildModuleServer(config(),[readerModule]);
 try {
  const response=await app.inject({method:'GET',url:`/api/v1/reader/source-items/${id}/records`});expect(response.statusCode,response.body).toBe(200);expect(ProjectReadingRecordsSchema.parse(response.json()).items).toHaveLength(2);
  expect((await db.pool.query('SELECT * FROM source_item_user_states WHERE source_item_id=$1',[id])).rows).toEqual(before);
  expect((await app.inject({method:'GET',url:`/api/v1/reader/source-items/${id}/records?offset=10001`})).statusCode).toBe(422);
  __setAuthIdentityForTests({spaceId:randomUUID(),userId:owner});expect((await app.inject({method:'GET',url:`/api/v1/reader/source-items/${id}/records`})).statusCode).toBe(404);
  await db.pool.query("UPDATE source_items SET access_level='summary' WHERE id=$1",[id]);
  await expect(projectReadingRecords(db.pool,{spaceId:space,userId:other},id)).rejects.toThrow();
 }finally{__setAuthIdentityForTests(null);await app.close();}
});

it('a Project Following may reference a global original without modifying it or mixing another Project analysis',async()=>{
 const id=await item();await db.pool.query('UPDATE source_items SET project_id=NULL WHERE id=$1',[id]);await original(id);
 const before=(await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[id])).rows[0];
 const content={kind:'article' as const,format:'agent_summary' as const,text:'Project-scoped global material analysis',sources:['https://example.test/article']};
 const d=await saveSourceReadingDocument(db.pool,{spaceId:space,itemId:id,analysisProjectId:project,agentProvided:true,document:agentReadingDocument(content,'https://example.test/article'),metadata:agentReadingMetadata(content)});
 expect((await db.pool.query('SELECT project_id,visibility FROM artifacts WHERE id=$1',[d.artifactId])).rows[0]).toEqual({project_id:project,visibility:'private'});
 expect((await db.pool.query('SELECT content_hash,extracted_artifact_id FROM source_items WHERE id=$1',[id])).rows[0]).toEqual(before);
 expect((await projectReadingRecords(db.pool,identity,id,0,project)).items.some(r=>r.snapshot_id===d.snapshotId)).toBe(true);
 const second=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Other Project','active',now(),now())",[second,space,owner]);await seedProjectMainlineRoom(db.pool,{space,project:second,owner});
 expect((await projectReadingRecords(db.pool,identity,id,0,second)).items.some(r=>r.snapshot_id===d.snapshotId)).toBe(false);
});


it('deterministic fetch failures remain gaps, PDF and Markdown retain their own identity, and supplement B never replaces homepage A',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {SourceExtractionWorker}=await import('../src/modules/sources/extractionWorker.js');
 const {publicAddressGuard}=await import('./support/outboundGuard.js');const {simplePdfBytes}=await import('./fixtures/simplePdf.js');
 const root=await mkdtemp(join(tmpdir(),'reading-capture-'));
 const safeConfig={...config(),rainverHome:root,artifactStorageRoot:join(root,'artifacts')};
 const fetch=vi.spyOn(globalThis,'fetch');
 async function extract(id:string,response:Response|Error){
  const job=randomUUID();await db.pool.query("INSERT INTO extraction_jobs(id,space_id,source_item_id,job_type,status,metadata_json,created_at) VALUES($1,$2,$3,'extract_text','pending','{}',now())",[job,space,id]);
  if(response instanceof Error)fetch.mockRejectedValueOnce(response);else fetch.mockResolvedValueOnce(response);
  return new SourceExtractionWorker(db.pool,safeConfig,publicAddressGuard).runPendingJob(job,space);
 }
 try{
  for(const response of [new Response('Forbidden',{status:403}),new Error('Synthetic transport unavailable')]){
   const id=await item();expect((await extract(id,response)).status).toBe('failed');
   expect((await db.pool.query('SELECT content_state,extracted_artifact_id FROM source_items WHERE id=$1',[id])).rows[0]).toMatchObject({content_state:'extraction_failed',extracted_artifact_id:null});
   const records=await projectReadingRecords(db.pool,identity,id);expect(records.original).toBeNull();expect(records.items).toEqual([]);
  }
  for(const [body,type,expected] of [[simplePdfBytes('Synthetic PDF evidence'),'application/pdf','Synthetic PDF evidence'],['# Mechanism\n\nA bounded Markdown example.','text/markdown','A bounded Markdown example.']] as const){
   const id=await item();expect((await extract(id,new Response(body,{headers:{'content-type':type}}))).status).toBe('succeeded');
   const record=(await projectReadingRecords(db.pool,identity,id)).original!;expect(record).not.toBeNull();
   expect((await new PgReaderRepository(db.pool,safeConfig).getDocument(identity,'source_snapshot',record.snapshot_id,{recordOpen:false}))?.plain_text).toContain(expected);
  }
  const a=await item(),b=await item();
  expect((await extract(a,new Response('<html><body><h1>Homepage only</h1><p>Product overview. No API or mechanism evidence is provided here.</p></body></html>',{headers:{'content-type':'text/html'}}))).status).toBe('succeeded');
  const before=(await db.pool.query('SELECT content_hash,extracted_artifact_id,source_uri FROM source_items WHERE id=$1',[a])).rows[0];
  expect((await extract(b,new Response('# Supplement B\n\nMechanism documentation on a distinct URL.',{headers:{'content-type':'text/markdown'}}))).status).toBe('succeeded');
  expect((await db.pool.query('SELECT content_hash,extracted_artifact_id,source_uri FROM source_items WHERE id=$1',[a])).rows[0]).toEqual(before);
  const rb=(await projectReadingRecords(db.pool,identity,b)).original!,ra=(await projectReadingRecords(db.pool,identity,a)).original!;
  expect(ra.snapshot_id).not.toBe(rb.snapshot_id);expect((await db.pool.query('SELECT source_uri FROM source_snapshots WHERE id=$1',[rb.snapshot_id])).rows[0].source_uri).not.toBe(before.source_uri);
  const d=await report(a,'SYNTHETIC analysis cites supplement B; does not claim homepage contains its mechanism.',await run());
  expect((await db.pool.query('SELECT content_hash,extracted_artifact_id,source_uri FROM source_items WHERE id=$1',[a])).rows[0]).toEqual(before);
  expect((await db.pool.query('SELECT reading_role FROM source_snapshots WHERE id=$1',[d.snapshotId])).rows[0].reading_role).toBe('analysis');
  expect((await projectReadingRecords(db.pool,identity,a)).original?.snapshot_id).toBe(ra.snapshot_id);
 }finally{fetch.mockRestore();await rm(root,{recursive:true,force:true});}
});
