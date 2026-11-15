import {EvolvableAssetRepository} from '../src/modules/evolution/assetRepository.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {insertMemoryEntry} from './support/memoryFixtures.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {bundleDecisionRegistrations} from '../src/modules/evolution/bundleOperations.js';
import {EvolutionAssetRefusal} from '../src/modules/evolution/assetRefusal.js';
import {ProposalApplyHttpError} from '../src/modules/proposals/applyService.js';
import {HttpError} from '../src/modules/routeUtils/common.js';
import {EvolvableAssetEvaluationRepository} from '../src/modules/evolution/assetEvaluationRepository.js';
import {z} from 'zod';
import {SYSTEM_ACTION_REGISTRY} from '@rainver/protocol';
import {linkProposalOperation} from './support/linkedProposalOperation.js';
import {operationProposalService} from '../src/modules/systemActions/operations/approvals.js';
import {createDefaultProposalApplierRegistry} from '../src/modules/proposals/applierRegistry.js';
import {proposalApplyRegistrations} from '../src/modules/proposals/operations.js';
import {OperationExecutor} from '../src/modules/systemActions/operations/executor.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
import type {OperationRegistration} from '../src/modules/systemActions/operations/types.js';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seedServerHost} from './support/domainSeeds.js';
import {executeCodePatchDecision} from '../src/modules/projectFolders/codePatchDecision.js';
import {registerEvolutionBundleRoutes} from '../src/modules/evolution/bundleRoutes.js';
import {EvolutionBundleRepository} from '../src/modules/evolution/bundleRepository.js';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {proposalsModule} from '../src/modules/proposals/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {insertProposalRow} from '../src/modules/proposals/reviewPackets.js';
const db=useTestDatabase(import.meta.filename);
let app:ReturnType<typeof buildModuleServer>,space:string,owner:string,requester:string,project:string,proposal:string;
let root='';
const send=(key:string|null=randomUUID(),body:object={})=>app.inject({method:'POST',url:`/api/v1/proposals/${proposal}/accept`,payload:body,headers:key?{'idempotency-key':key}:{}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();requester=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});await seedSpaceMember(db.pool,{space,user:requester});
 proposal=(await insertProposalRow(db.pool,{spaceId:space,projectId:project,proposalType:'follow_up_task',title:'Accept typed Task',rationale:'test',requiredApproverRole:'owner',createdByUserId:requester,visibility:'space_shared',payload:{task:{title:'Transactional follow-up'}}})).id;
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[proposalsModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});

describe('review regression refusals',()=>{
 it('preserves the canonical Memory audience refusal without publishing Memory',async()=>{
  await db.pool.query("UPDATE spaces SET type='team' WHERE id=$1",[space]);
  const memory=randomUUID();
  await insertMemoryEntry(db.pool,space,{id:memory,owner_user_id:requester,subject_user_id:requester,created_by:requester,scope_type:'user',visibility:'private'});
  proposal=(await insertProposalRow(db.pool,{spaceId:space,projectId:project,proposalType:'memory_update',title:'Memory audience',rationale:'test',createdByUserId:requester,visibility:'space_shared',payload:{proposal_type:'memory_update',target_memory_id:memory,proposed_content:'Private fact',target_scope:'project',target_visibility:'space_shared',owner_user_id:requester,provenance_entries:[{source_type:'user_confirmation',source_id:requester,source_trust:'user_confirmed'}]}})).id;
  const result=await send();expect(result.statusCode,result.body).toBe(409);
  expect(result.json().error.metadata.code).toBe('memory_owner_sharing_required');
  expect((await db.pool.query('SELECT id,status FROM memory_entries')).rows).toEqual([{id:memory,status:'active'}]);
 });
 it('classifies only explicit business statuses and preserves their safe detail',()=>{
  const definitions=new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d]));
  const registration=bundleDecisionRegistrations(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),definitions)[0];
  const limited=registration.classifyError!(new EvolutionAssetRefusal(429,'Daily limit'))!;
  expect(limited.httpStatus).toBe(429);expect(limited.body('request').error.code).toBe('operation_limit_exceeded');
  for(const status of [400,422])expect(registration.classifyError!(new HttpError(status,'Invalid'))?.httpStatus).toBe(422);
  for(const e of [new Error('private internal data'),new HttpError(500,'private internal data'),new ProposalApplyHttpError(500,{message:'private internal data'})])expect(registration.classifyError!(e)).toBeUndefined();
  const invalid=registration.classifyError!(new ProposalApplyHttpError(422,{code:'invalid_risk',message:'Invalid risk'}))!;
  expect(invalid.body('request').error).toMatchObject({message:'Invalid risk',metadata:{code:'invalid_risk'}});
 });
 it('caches a pending durable Bundle decision conflict without performing a second decision',async()=>{
  await patchFixture();
  const bundle=await new EvolutionBundleRepository(db.pool).create({spaceId:space,userId:owner},{title:'Busy',proposalIds:[proposal]});
  const request=(action:string,key:string)=>app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/${action}`,payload:{proposal_ids:[proposal]},headers:{'idempotency-key':key}});
  const first=await request('approve',randomUUID());expect(first.statusCode,first.body).toBe(202);
  const key=randomUUID(),refused=await request('reject',key);expect(refused.statusCode,refused.body).toBe(409);
  expect(refused.json().error.code).toBe('operation_conflict');
  expect((await request('reject',key)).statusCode).toBe(409);
  expect((await db.pool.query("SELECT state,http_status FROM operation_idempotency WHERE operation_id='evolution.bundle.reject' AND idempotency_key=$1",[key])).rows).toEqual([{state:'failed',http_status:409}]);
  expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
 });
 it('retains the Bundle id and incomplete patch confirmation details on the formal path',async()=>{
  await patchFixture();
  await db.pool.query('UPDATE proposals SET payload_json=payload_json||$2::jsonb WHERE id=$1',[proposal,JSON.stringify({incomplete_patch:true,skipped_changes:[{path:'ignored.txt',reason:'excluded'}]})]);
  const refused=await send();expect(refused.statusCode,refused.body).toBe(422);
  expect(refused.json().error.metadata).toMatchObject({code:'incomplete_patch_requires_confirmation',skipped_changes:[{path:'ignored.txt',reason:'excluded'}]});
  expect(refused.json().error.message).toContain('confirm_incomplete_patch');
  await db.pool.query('UPDATE proposals SET payload_json=payload_json||$2::jsonb WHERE id=$1',[proposal,JSON.stringify({incomplete_patch:false})]);
  const bundle=await new EvolutionBundleRepository(db.pool).create({spaceId:space,userId:owner},{title:'Owned',proposalIds:[proposal]});
  const bundled=await send();expect(bundled.statusCode,bundled.body).toBe(409);
  expect(bundled.json().error.metadata).toMatchObject({code:'proposal_bundled',bundle_id:bundle.id});
 });
 it('returns a report availability conflict on first use and replay after actual read authority is withdrawn',async()=>{
  const report=randomUUID(),item=randomUUID();
  await db.pool.query("UPDATE spaces SET type='team' WHERE id=$1",[space]);
  await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Private report input',content:'Report input',ownerUserId:requester,createdByUserId:requester,projectId:project});
  await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
  await db.pool.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,export_formats_json,visibility,access_level,owner_user_id,metadata_json,created_at,updated_at) VALUES($1,$2,'retrieval_brief','Private report','[]','space_shared','full',$3,'{"item_refs":[]}',now(),now())`,[report,space,requester]);
  await db.pool.query('UPDATE artifacts SET metadata_json=$2::jsonb WHERE id=$1',[report,JSON.stringify({item_refs:[{object_type:'knowledge_item',object_id:item}]})]);
  await db.pool.query('UPDATE proposals SET payload_json=payload_json||$2::jsonb WHERE id=$1',[proposal,JSON.stringify({provenance_entries:[{source_type:'artifact',source_id:report,source_trust:'derived_review'}]})]);
  const key=randomUUID(),ok=await send(key);expect(ok.statusCode,ok.body).toBe(200);
  await db.pool.query("UPDATE space_objects SET visibility='private',primary_project_id=NULL WHERE id=$1",[item]);
  for(const k of [key,randomUUID()]){
   const refused=await send(k);expect(refused.statusCode,refused.body).toBe(409);
   expect(refused.json().error.code).toBe('operation_conflict');
   expect(refused.body).not.toContain('Private report');
  }
  expect((await db.pool.query('SELECT id FROM tasks WHERE source_proposal_id=$1',[proposal])).rows).toHaveLength(1);
 });
});
afterEach(async()=>{
 __setAuthIdentityForTests(null);await app?.close();if(root){await rm(root,{recursive:true,force:true});root='';}if(!db.available)return;
 for(const table of ['operation_idempotency','policy_decision_records'])await db.pool.query(`DROP TRIGGER IF EXISTS typed_apply_fault ON ${table}`);
 await db.pool.query('DROP FUNCTION IF EXISTS typed_apply_fault()');
});
describe('formal canonical typed Proposal accept',()=>{
 it('commits typed Task, decision, audit and receipt and replays without duplicates',async()=>{
  const key=randomUUID(),first=await send(key);expect(first.statusCode,first.body).toBe(200);
  expect(first.json().data).toMatchObject({proposal:{id:proposal,status:'accepted'},result_type:'follow_up_task'});
  const replay=await send(key);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(first.json().data);
  expect((await db.pool.query('SELECT id FROM tasks WHERE source_proposal_id=$1',[proposal])).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE operation_id='proposal.accept'")).rows).toHaveLength(1);
 });
 it('requires a strict key and rejects injected authority',async()=>{
  expect((await send(null)).statusCode).toBe(422);expect((await send(randomUUID(),{user_id:owner})).statusCode).toBe(422);
 });
 it.each([false,true])('retains frozen requester authority through formal accept (requester revoked=%s)',async revoked=>{
  const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri});
  const linked=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},proposal);
  const base=SYSTEM_ACTION_REGISTRY.find(d=>d.id==='memory.propose_create')!;
  const fixture:OperationRegistration={definition:{...base,id:'fixture.proposal',output_schema:z.object({task:z.object({id:z.string(),space_id:z.string(),title:z.string(),status:z.string()})})},
   async resolve(){return {authority:`project:${project}`,targets:{project_id:project},resourceType:'space',resourceId:space};},async authorize(){},async execute(){throw new Error('canonical typed applier only');},
   approval:{mode:'proposal_submission',proposalType:'follow_up_task',gate:{kind:'hard_gate',gate_class:'direction'},atomicStatusWritersVerified:true,async create(){throw new Error('already linked');},async preconditions(){return {};}}};
  const service=operationProposalService(config,createDefaultProposalApplierRegistry(),new Map([[fixture.definition.id,fixture]]));
  const definitions=new Map(SYSTEM_ACTION_REGISTRY.map(d=>[d.id,d]));
  const executor=new OperationExecutor(db.pool,config,proposalApplyRegistrations(config,definitions,service));
  if(revoked)await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,requester]);
  const key=randomUUID(),actor=sessionActor({spaceId:space,userId:owner});
  const result=await executor.execute('proposal.accept',{proposal_id:proposal},actor,randomUUID(),key);
  expect(result.http_status,JSON.stringify(result.body)).toBe(revoked?404:200);
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[linked])).rows[0].state).toBe(revoked?'pending_approval':'succeeded');
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe(revoked?'pending':'accepted');
  if(!revoked){const replay=await executor.execute('proposal.accept',{proposal_id:proposal},actor,randomUUID(),key);expect(replay.http_status).toBe(200);expect(replay.body).toEqual(result.body);}
 });
 it('rejects malformed input, unknown types and an unauthorized reviewer on the real core path',async()=>{
  const malformed=await app.inject({method:'POST',url:`/api/v1/proposals/${proposal}/accept`,payload:'{"confirm_incomplete_patch":',headers:{'content-type':'application/json','idempotency-key':randomUUID()}});expect(malformed.statusCode).toBe(422);
  const invalid=await send(randomUUID(),{confirm_incomplete_patch:'maybe'});expect(invalid.statusCode).toBe(422);
  await db.pool.query("UPDATE proposals SET proposal_type='unregistered_type' WHERE id=$1",[proposal]);expect((await send()).statusCode).toBe(404);
  await db.pool.query("UPDATE proposals SET proposal_type='follow_up_task' WHERE id=$1",[proposal]);
  __setAuthIdentityForTests({spaceId:space,userId:requester});expect((await send()).statusCode).toBe(404);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
 });
 it('rechecks current reviewer authority on replay',async()=>{
  const key=randomUUID();expect((await send(key)).statusCode).toBe(200);
  await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,owner]);expect((await send(key)).statusCode).toBe(404);
 });
 it.each(['receipt','late_audit'])('rolls back typed writes and decision after %s failure',async kind=>{
  await db.pool.query(`CREATE FUNCTION typed_apply_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'typed effect late fault'; END $$`);
  if(kind==='receipt')await db.pool.query(`CREATE TRIGGER typed_apply_fault BEFORE INSERT ON operation_idempotency FOR EACH ROW EXECUTE FUNCTION typed_apply_fault()`);
  else await db.pool.query(`CREATE CONSTRAINT TRIGGER typed_apply_fault AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION typed_apply_fault()`);
  const response=await send();expect(response.statusCode,response.body).toBe(kind==='late_audit'?503:500);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
  expect((await db.pool.query('SELECT id FROM tasks WHERE source_proposal_id=$1',[proposal])).rows).toHaveLength(0);
  expect((await db.pool.query("SELECT id FROM operation_idempotency WHERE operation_id='proposal.accept'")).rows).toHaveLength(0);
 });
});

// Default public composition: no operationProposalService or test registration.
async function ordinaryMemoryFixture(){
 proposal=(await insertProposalRow(db.pool,{spaceId:space,projectId:project,proposalType:'memory_create',title:'Ordinary Memory',rationale:'test',createdByUserId:requester,requiredApproverRole:'owner',visibility:'space_shared',payload:{proposal_type:'memory_create',proposed_content:'Ordinary approved fact',target_scope:'project',target_visibility:'space_shared',owner_user_id:requester,provenance_entries:[{source_type:'user_confirmation',source_id:requester,source_trust:'user_confirmed'}]}})).id;
}
describe('default public typed Memory without core approval mappings',()=>{
 it('accepts ordinary Memory with provenance and required Job and replays once',async()=>{
  await ordinaryMemoryFixture();
  const key=randomUUID(),response=await send(key);expect(response.statusCode,response.body).toBe(200);
  expect(response.json().data).toMatchObject({proposal:{id:proposal,status:'accepted'},result_type:'memory_entry'});
  expect((await send(key)).json().data).toEqual(response.json().data);
  const memories=(await db.pool.query('SELECT id,owner_user_id,created_by,approved_by FROM memory_entries WHERE created_from_proposal_id=$1',[proposal])).rows;
  expect(memories).toHaveLength(1);expect(memories[0]).toMatchObject({owner_user_id:requester,created_by:requester,approved_by:owner});
  expect((await db.pool.query("SELECT source_id FROM provenance_links WHERE target_id=$1 AND source_type='proposal'",[memories[0].id])).rows).toEqual([{source_id:proposal}]);
  // Unlinked approval has no frozen operation requester; preserve canonical payer.
  expect((await db.pool.query('SELECT user_id FROM jobs')).rows).toEqual([{user_id:owner}]);
 });
 it('rechecks ordinary Memory reviewer authority on first use and successful replay',async()=>{
  await ordinaryMemoryFixture();const key=randomUUID();expect((await send(key)).statusCode).toBe(200);
  const accepted=proposal;await ordinaryMemoryFixture();const pending=proposal;
  await db.pool.query("UPDATE space_memberships SET status='revoked' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  proposal=accepted;expect((await send(key)).statusCode).toBe(404);
  proposal=pending;expect((await send()).statusCode).toBe(404);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
  expect((await db.pool.query('SELECT id FROM memory_entries')).rows).toHaveLength(1);
 });
 it('rolls back ordinary Memory, provenance, Job and receipt on late mandatory audit failure',async()=>{
  await ordinaryMemoryFixture();
  await db.pool.query(`CREATE FUNCTION typed_apply_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ordinary Memory late audit fault'; END $$`);
  await db.pool.query(`CREATE CONSTRAINT TRIGGER typed_apply_fault AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION typed_apply_fault()`);
  const response=await send();expect(response.statusCode,response.body).toBe(503);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
  for(const table of ['memory_entries','provenance_links','jobs','operation_idempotency'])expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
 });
 it('refuses artificial linked core Memory with 503 and no effects without a test mapping',async()=>{
  await ordinaryMemoryFixture();const linked=await linkProposalOperation(db.pool,{spaceId:space,userId:requester},proposal);
  const activities=(await db.pool.query('SELECT id FROM activity_records ORDER BY id')).rows;
  const response=await send();expect(response.statusCode,response.body).toBe(503);
  expect(response.json().error.code).toBe('operation_approval_mapping_unavailable');
  expect((await db.pool.query('SELECT status,reviewed_by FROM proposals WHERE id=$1',[proposal])).rows[0]).toEqual({status:'pending',reviewed_by:null});
  expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE id=$1',[linked])).rows[0].state).toBe('pending_approval');
  for(const table of ['memory_entries','provenance_links','jobs','action_approval_grants','proposal_approvals'])expect((await db.pool.query(`SELECT id FROM ${table}`)).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM activity_records ORDER BY id')).rows).toEqual(activities);
 });
});

async function patchFixture(){
 const folder=randomUUID(),host=randomUUID();root=await mkdtemp(join(tmpdir(),'formal-proposal-'));
 await seedServerHost(db.pool,{id:host});
 await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,protected,system_managed,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Effects','active','code',false,false,$4,now(),now())",[folder,space,project,owner]);
 await db.pool.query("INSERT INTO workspace_locations(id,space_id,project_folder_id,execution_host_id,execution_host_kind,root_path,execution_ready,status,created_at,updated_at) VALUES($1,$2,$3,$4,'server',$5,true,'active',now(),now())",[randomUUID(),space,folder,host,root]);
 await writeFile(join(root,'one.txt'),'before');
 proposal=(await insertProposalRow(db.pool,{spaceId:space,projectId:project,projectFolderId:folder,proposalType:'code_patch',title:'Patch',rationale:'test',createdByUserId:requester,visibility:'space_shared',riskLevel:'high',requiredApproverRole:'owner',payload:{patch:{operations:[{type:'replace_file',path:'one.txt',content:'after',preimage_exists:true,preimage_sha256:createHash('sha256').update('before').digest('hex')}]},incomplete_patch:false}})).id;
 await app.close();
 const config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,SERVER_WORKSPACE_ROOT:root});
 app=buildModuleServer(config,[proposalsModule,systemActionsModule,{name:'bundle-test',registerRoutes(app,ctx){registerEvolutionBundleRoutes(app,ctx);}}]);
 return config;
}
describe('formal external effect and Bundle intents',()=>{
 it.each(['approve','decide','reject'])('decides a typed Bundle through formal %s and same-key replay',async action=>{
  await app.close();app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[proposalsModule,systemActionsModule,{name:'bundle-test',registerRoutes:registerEvolutionBundleRoutes}]);
  const bundle=await new EvolutionBundleRepository(db.pool).create({spaceId:space,userId:owner},{title:'Typed bundle',proposalIds:[proposal]});
  const key=randomUUID(),request=()=>app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/${action}`,payload:action==='decide'?{decisions:[{proposal_id:proposal,decision:'approve'}]}:{proposal_ids:[proposal]},headers:{'idempotency-key':key}});
  const res=await request();expect(res.statusCode,res.body).toBe(200);
  const replay=await request();expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().data).toEqual(res.json().data);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe(action==='reject'?'rejected':'accepted');
  expect((await db.pool.query('SELECT id FROM tasks WHERE source_proposal_id=$1',[proposal])).rows).toHaveLength(action==='reject'?0:1);
 });
 it('approves and rolls back a versioned asset Bundle through canonical owners and replays both keys',async()=>{
  const identity={spaceId:space,userId:owner},assets=new EvolvableAssetRepository(db.pool),evaluations=new EvolvableAssetEvaluationRepository(db.pool);
  const asset=await assets.createAsset(identity,{asset_type:'prompt_template',asset_key:`bundle.${randomUUID()}`,display_name:'Formal rollback'});
  const version=await assets.createVersion(identity,asset.id as string,{scope_type:'space',scope_id:space,content_json:{value:'candidate'}});
  await assets.transitionVersionStatus(identity,asset.id as string,version.id as string,{status:'candidate'});
  const promotion=await evaluations.createPromotionProposal(identity,asset.id as string,version.id as string,{target_scope_type:'space',target_scope_id:space,pin_after_approval:true});
  const bundle=await new EvolutionBundleRepository(db.pool).create(identity,{title:'Version rollback',proposalIds:[promotion.proposal_id as string]});
  await app.close();app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[proposalsModule,systemActionsModule,{name:'bundle-test',registerRoutes:registerEvolutionBundleRoutes}]);
  const approve=await app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/approve`,payload:{proposal_ids:[promotion.proposal_id]},headers:{'idempotency-key':randomUUID()}});expect(approve.statusCode,approve.body).toBe(200);
  expect((await db.pool.query('SELECT status FROM evolvable_asset_versions WHERE id=$1',[version.id])).rows[0].status).toBe('approved');
  // Member approval is owner-only, but the legacy rollback's high-risk gate
  // permits an admin; a plain member must still be refused.
  await db.pool.query("UPDATE proposals SET required_approver_role='owner' WHERE id=$1",[promotion.proposal_id]);
  __setAuthIdentityForTests({spaceId:space,userId:requester});
  const denied=await app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/rollback`,payload:{},headers:{'idempotency-key':randomUUID()}});
  expect(denied.statusCode,denied.body).toBe(404);
  await db.pool.query("UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2",[space,requester]);
  const key=randomUUID(),rollback=()=>app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/rollback`,payload:{},headers:{'idempotency-key':key}});
  const result=await rollback();expect(result.statusCode,result.body).toBe(200);expect((await rollback()).json().data).toEqual(result.json().data);
  expect((await db.pool.query('SELECT status FROM evolvable_asset_versions WHERE id=$1',[version.id])).rows[0].status).toBe('candidate');
  expect((await db.pool.query('SELECT status FROM evolution_bundles WHERE id=$1',[bundle.id])).rows[0].status).toBe('rolled_back');
  expect((await db.pool.query("SELECT id FROM evolvable_asset_pins WHERE asset_id=$1 AND status='active'",[asset.id])).rows).toHaveLength(0);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,requester]);
  expect((await rollback()).statusCode).toBe(404);
 });
 it('queues apply and rollback on core receipts, executes via the existing Job owner and replays each key',async()=>{
  const config=await patchFixture(),key=randomUUID();
  const accepted=await send(key);expect(accepted.statusCode,accepted.body).toBe(202);
  expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');
  const intent=accepted.json().data.result;
  expect((await send(key)).json().data).toEqual(accepted.json().data);
  await executeCodePatchDecision(config,intent.id,space);
  expect(await readFile(join(root,'one.txt'),'utf8')).toBe('after');
  const rollbackKey=randomUUID(),rollback=()=>app.inject({method:'POST',url:`/api/v1/proposals/${proposal}/rollback`,payload:{},headers:{'idempotency-key':rollbackKey}});
  const result=await rollback();expect(result.statusCode,result.body).toBe(202);
  expect((await rollback()).json().data).toEqual(result.json().data);
  await executeCodePatchDecision(config,result.json().data.id,space);
  expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('rolled_back');
 });
 it('rolls back Bundle Job intent and receipt when late audit fails',async()=>{
  await patchFixture();const bundle=await new EvolutionBundleRepository(db.pool).create({spaceId:space,userId:owner},{title:'Atomic intent',proposalIds:[proposal]});
  await db.pool.query(`CREATE FUNCTION typed_apply_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late bundle audit fault'; END $$`);
  await db.pool.query(`CREATE CONSTRAINT TRIGGER typed_apply_fault AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION typed_apply_fault()`);
  const res=await app.inject({method:'POST',url:`/api/v1/evolution/bundles/${bundle.id}/approve`,payload:{proposal_ids:[proposal]},headers:{'idempotency-key':randomUUID()}});
  expect(res.statusCode,res.body).toBe(503);
  expect((await db.pool.query('SELECT id FROM evolution_bundle_decisions')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT id FROM jobs')).rows).toHaveLength(0);
  expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1',[proposal])).rows[0].status).toBe('pending');
  expect(await readFile(join(root,'one.txt'),'utf8')).toBe('before');
 });
});
