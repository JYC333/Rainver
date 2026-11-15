import {randomUUID} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject} from './support/domainSeeds.js';
import {insertArtifactRow} from '../src/modules/artifacts/reviewArtifactWriter.js';
import {pinReportReleaseBatch} from '../src/modules/retrieval/reportReleaseBatch.js';
import {lockContextOpsInputs} from '../src/modules/contextOps/inputLocks.js';
import {retrievalArtifactWithheld} from '../src/modules/retrieval/artifactRelease.js';
import {buildRetrievalEvalDiagnosticsReportWithSources} from '../src/modules/retrieval/evalDiagnostics.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {withheldReleaseRefs} from '../src/modules/retrieval/releaseClosure.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {ResearchAcquisitionService} from '../src/modules/projectResearch/pipeline/researchAcquisitionService.js';
import {seedRelevantCorpusItem} from './support/researchSeeds.js';
import {seedSourceConnection} from './support/reviewPacketDatabase.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string;
const identity=()=>({spaceId:space,userId:owner});
const artifact=(type='retrieval_brief',metadata:unknown={})=>insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:type,title:'Boundary',content:'{}',metadata,canonicalFormat:'json',visibility:'private'});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});space=randomUUID();owner=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
});
it('accepts legal limit 200 with more than 200 aggregate roots including nested reports',async()=>{
 const nested=await artifact('retrieval_eval_report');
 const report=await artifact('retrieval_maintenance_report',{findings:[],source_artifact_ids:[nested]});
 for(let n=0;n<200;n++)await artifact();
 await withQueryableTransaction(db.pool,async tx=>{
  await lockContextOpsInputs(tx,identity(),'context_ops.review_cycle.run',{artifact_limit:200});
  expect(await retrievalArtifactWithheld(tx,identity(),{id:report,artifact_type:'retrieval_maintenance_report',metadata_json:{findings:[],source_artifact_ids:[nested]}},null)).toBe(false);
 });
});
it('refuses actual owner overflow instead of lifting the 200-id research bound',async()=>{
 const roots:string[]=[];for(let n=0;n<201;n++)roots.push(await artifact());
 const thread=String((await new InquiryThreadService(db.pool).createThread(identity(),project,{kind:'question',statement:'Bounded research'})).id);
 const started=await new ResearchAcquisitionService(db.pool).startAcquisition(identity(),project,{threadId:thread,requestKey:'overflow',originRoomId:null,originSessionId:null});
 await db.pool.query("UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text)),research_call_json=jsonb_set(research_call_json,'{input_refs}',$3::jsonb) WHERE id=$1",[started.operation_id,roots[0],JSON.stringify(roots.slice(1).map(id=>({type:'artifact',id})))]);
 await expect(withQueryableTransaction(db.pool,tx=>pinReportReleaseBatch(tx,identity(),[{artifact_id:roots[0]}],true))).rejects.toMatchObject({statusCode:409});
});
it('refuses a Brief committed on a second connection after sealing',async()=>{
 await artifact();
 const sourceProject=randomUUID();await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Late Source Project','active',now(),now())",[sourceProject,space,owner]);
 const connection=randomUUID();await seedSourceConnection(db.pool,{id:connection,space,owner});await db.pool.query('UPDATE source_connections SET project_id=$2 WHERE id=$1',[connection,sourceProject]);
 const item=randomUUID();await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Late',content:'Late body',ownerUserId:owner,createdByUserId:owner,projectId:project});
 const material=await seedRelevantCorpusItem(db.pool,{space,project:sourceProject,owner});await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[material.sourceItemId,connection]);
 await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,material.sourceItemId]);
 await withQueryableTransaction(db.pool,async tx=>{
  await pinReportReleaseBatch(tx,identity(),[],true);
  const late=await artifact('retrieval_brief',{item_refs:[{object_type:'knowledge_item',object_id:item}]});
  const reads=vi.spyOn(tx,'query');
  await expect(buildRetrievalEvalDiagnosticsReportWithSources(tx,{spaceId:space,ownerUserId:owner,windowDays:7,limit:200})).rejects.toMatchObject({statusCode:409});
  await expect(withheldReleaseRefs(tx,identity(),[{registry:knowledgeRetrievalRegistry,refs:[{object_type:'knowledge_item',object_id:item}]}],null)).rejects.toMatchObject({statusCode:409});
  await expect(retrievalArtifactWithheld(tx,identity(),{id:late,artifact_type:'retrieval_brief',metadata_json:{}},null)).rejects.toMatchObject({statusCode:409});
  expect(reads.mock.calls.some(([sql])=>/FOR (SHARE|UPDATE|NO KEY UPDATE)/i.test(sql))).toBe(false);
  reads.mockRestore();
 });
});
it('registers only canonical new output rows and refuses their unknown dependencies',async()=>{
 await withQueryableTransaction(db.pool,async tx=>{
  await pinReportReleaseBatch(tx,identity(),[],true);
  const id=await insertArtifactRow(tx,{spaceId:space,ownerUserId:owner,artifactType:'retrieval_brief',title:'Own output',content:'{}',metadata:{},canonicalFormat:'json',visibility:'private'});
  expect(await retrievalArtifactWithheld(tx,identity(),{id,artifact_type:'retrieval_brief',metadata_json:{}},null)).toBe(false);
  await expect(retrievalArtifactWithheld(tx,identity(),{id,artifact_type:'retrieval_brief',metadata_json:{item_refs:[{object_type:'knowledge_item',object_id:randomUUID()}]}},null)).rejects.toMatchObject({statusCode:409});
 });
});
