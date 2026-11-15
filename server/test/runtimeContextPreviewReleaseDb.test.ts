import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {ApplyProposal} from '../src/modules/memory/memoryApplyRepository.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedMainlineRoomsForAllProjects,seedConversationMessages,seedServerHost,seedSpaceMember} from './support/domainSeeds.js';
import {claimJobForHandler} from './support/jobClaim.js';
import {resetTables} from './support/resetTables.js';
import {buildModuleServer} from './support/moduleServer.js';
import {runtimeContextModule} from '../src/modules/runtimeContext/index.js';
import {policyModule} from '../src/modules/policy/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {registerRuntimeContextPreviewJob} from '../src/modules/runtimeContext/previewRequests.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {previewSkillFiles} from '../src/modules/skills/skillImporter.js';
import {PgSkillsRepository,approveSkillImportInTransaction} from '../src/modules/skills/repository.js';
import {applySkillPackageBinding} from '../src/modules/skills/skillBindings.js';
import {withTransaction} from '../src/db/tx.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {loadConfig} from '../src/config.js';
import {artifactsModule} from '../src/modules/artifacts/index.js';
import {contentAccessModule} from '../src/modules/contentAccess/index.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {ResearchAcquisitionService} from '../src/modules/projectResearch/pipeline/researchAcquisitionService.js';
import {ProjectResearchArtifactService} from '../src/modules/projectResearch/artifactService.js';
import {releaseRuntimeContextPreview} from '../src/modules/runtimeContext/previewRequests.js';
import {PgInvocationDeliveryAuthorizer} from '../src/modules/runtimeContext/gateway.js';
import {ExecutionControlSnapshotSchema,RuntimeContextEnvelopeSchema} from '@rainver/protocol';
import {seedArxivSourceChain,seedRelevantCorpusItem} from './support/researchSeeds.js';
import {waitForBlockedBy,waitForLockWaiter} from './support/lockWait.js';
import {seedRun} from './support/domainSeeds.js';
import {resolveAgentActorId} from '../src/db/actorResolver.js';
import {declareRunArtifact,applyRunArtifactDeclarations} from '../src/modules/projectWork/artifactDeclarations.js';
import {roomsModule} from '../src/modules/rooms/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {PgRunSupervisor} from '../src/modules/runs/supervisor.js';
import {SUBSCRIPTION_QUOTA_EXHAUSTED} from '../src/modules/runs/retryPolicy.js';

const db=useTestDatabase(import.meta.filename,{max:8});
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:`/tmp/rainver-rc-preview-${process.pid}`});
let space:string,user:string,other:string,agent:string,version:string,project:string,session:string,message:string,run:string,artifact:string,skillPackage:string,app:ReturnType<typeof buildModuleServer>;
const q=(sql:string,params:unknown[]=[])=>db.pool.query(sql,params);

beforeEach(async()=>{
 await resetTables(db.pool,['hosts','machines'],{cascade:true});
 space=randomUUID();user=randomUUID();other=randomUUID();agent=randomUUID();version=randomUUID();project=randomUUID();session=randomUUID();message=randomUUID();run=randomUUID();artifact=randomUUID();
 const provider=randomUUID(),profile=randomUUID(),setup=randomUUID(),decision=randomUUID(),control=randomUUID();
 await q("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'S','team',now(),now())",[space]);
 await seedSpaceMember(db.pool,{space,user,role:'owner'});
 await seedSpaceMember(db.pool,{space,user:other,role:'member'});
 await q(`INSERT INTO agents(id,space_id,owner_user_id,name,status,agent_kind,visibility,access_level,created_at,updated_at) VALUES($1,$2,$3,'Agent','active','standard','private','full',now(),now())`,[agent,space,user]);
 await q(`INSERT INTO agent_versions(id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,created_at) VALUES($1,$2,$3,'v1','Agent instruction.','{}','{}','[]','{}',now())`,[version,agent,space]);
 await q('UPDATE agents SET current_version_id=$2 WHERE id=$1',[agent,version]);
 await q(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'P','active',now(),now())`,[project,space,user]);
 await seedMainlineRoomsForAllProjects(db.pool);
 await q(`INSERT INTO artifacts(id,space_id,project_id,artifact_type,title,content,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,'evidence_matrix','Matrix','PRIVATE MATRIX BODY','[]','private','full',$4,now(),now())`,[artifact,space,project,user]);
 // A trusted-local provider keeps egress internal, as in the Delivery fixture.
 await q(`INSERT INTO model_providers(id,space_id,owner_user_id,name,provider_type,base_url,enabled,capabilities_json,config_json,created_at,updated_at) VALUES($1,$2,$3,'Local','ollama','http://localhost:11434',TRUE,'{}','{"deployment":"trusted_local"}',now(),now())`,[provider,space,user]);
 await q(`INSERT INTO model_provider_space_grants(id,provider_id,space_id,owner_user_id,granted_by_user_id,enabled,is_default,created_at,updated_at) VALUES($1,$2,$3,$4,$4,TRUE,FALSE,now(),now())`,[randomUUID(),provider,space,user]);
 const host=randomUUID();
 await seedServerHost(db.pool,{id:host,installations:{opencode:[{id:'managed:1.0.0',version:'1.0.0',logged_in:true,options:null,health_check_protocol:'acp'}]}});
 await q(`INSERT INTO agent_runtime_profiles(id,space_id,agent_id,execution_host_id,workspace_mode,runtime_installation,name,runtime_key,backend_mode,model_provider_id,model_name,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at) VALUES($1,$2,$3,$5,'managed','managed:1.0.0','Default','opencode','model_provider',$4,'gpt-4o','{}','{}',true,true,now(),now())`,[profile,space,agent,provider,host]);
 await q(`INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())`,[session,space,user]);
 // A Skill package the person selected for this turn, bound to the Agent.
 const files=previewSkillFiles({files:[{path:'SKILL.md',content_base64:Buffer.from('---\nname: preview-skill\ndescription: Private skill body.\n---\nPRIVATE SKILL BODY\n').toString('base64')}]});
 const skills=new PgSkillsRepository(db.pool),identity={spaceId:space,userId:user};
 skillPackage=String((await skills.saveImportedSkill(identity,files)).id);
 await approveSkillImportInTransaction({db:db.pool,spaceId:space,userId:user,proposalId:randomUUID(),skillPackageId:skillPackage});
 const binding=await skills.createSkillBindingProposal(identity,skillPackage,{scope_type:'agent',scope_id:agent,enabled:true});
 await withTransaction(db.pool,async client=>{
  const row=(await client.query<ApplyProposal>('SELECT * FROM proposals WHERE id=$1',[binding.id])).rows[0]!;
  await applySkillPackageBinding({db:client,proposal:row,userId:user,config:config()});
  await client.query("UPDATE proposals SET status='accepted' WHERE id=$1",[binding.id]);
 });
 await q(`INSERT INTO policy_decision_records(id,space_id,actor_type,actor_id,action,resource_type,resource_id,decision,risk_level,policy_source,metadata_json,created_at) VALUES($1,$2,'user',$3,'work_context_setup.change','work_context_setup',$4,'allow','medium','test','{}',now())`,[decision,space,user,setup]);
 await q(`INSERT INTO work_context_setups(id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,created_at)
  VALUES($1,$2,$3,'direct_session',1,$4,$5,NULL,$6,NULL,'[]','[]','{"enabled":false}','{}',NULL,NULL,TRUE,'[]','preview-setup',NULL,'{}','test',$7,$4,now())`,[setup,space,session,user,project,agent,decision]);
 await q(`INSERT INTO runs(id,space_id,agent_id,agent_version_id,project_id,session_id,run_type,trigger_origin,status,mode,runtime_profile_id,runtime_profile_selection_source,runtime_key,model_provider_id,runtime_profile_snapshot_json,required_sandbox_level,instructed_by_user_id,owner_user_id,prompt,model_override_json,contract_snapshot_json,created_at,updated_at,execution_kind)
  VALUES($1,$2,$3,$4,$5,$6,'agent','manual','queued','live',$7,'default','opencode',$8,$9::jsonb,'none',$10,$10,'Use the matrix.',$11::jsonb,$12::jsonb,now(),now(),'agent')`,
  [run,space,agent,version,project,session,profile,provider,JSON.stringify({id:profile,runtime_key:'opencode',backend_mode:'model_provider',model_provider_id:provider,model_name:'gpt-4o',runtime_config_json:{},runtime_policy_json:{}}),user,
   JSON.stringify({chat_turn:{schema_version:'chat_turn.v1',session_id:session,user_id:user,user_message_id:message,agent_id:agent,agent_version_id:version,project_id:project}}),
   JSON.stringify({workflow_input_json:{project_research:{evidence_matrix_artifact_id:artifact,operation_id:randomUUID()}}})]);
 await seedConversationMessages(db.pool,{space,session,messages:[{id:message,role:'user',content:'',userId:user,runId:run,metadata:{}}]});
 await q(`INSERT INTO message_input_parts(id,space_id,session_id,message_id,position,kind,skill_package_id,display_name,media_type,byte_size,sha256) VALUES($1,$2,$3,$4,0,'skill',$5,'preview-skill','application/vnd.rainver.skill',0,$6)`,[randomUUID(),space,session,message,skillPackage,files.package_hash]);
 const snapshot={id:control,version:2,space_id:space,actor:{type:'user',user_id:user},project_id:project,project_folder_id:null,agent_id:agent,work_context_scope_id:session,work_context_setup_ref:{type:'work_context_setup',id:setup,version:'1'},project_brief_ref:null,project_instruction_ref:null,
  readable_scope:{space_id:space,allowed_source_types:[],unrestricted_source_categories:[],explicit_reference_types:[],explicit_reference_max:0,pinned_reference_types:[],pinned_reference_max:0,retrieval_enabled:false,retrieval_max_candidates:0,explicit_reference_sensitivity_ceiling:'normal',allowed_source_ids:[],excluded_source_ids:[],sensitivity_ceiling:'highly_restricted'},
  egress:{destination_type:'model_provider',destination_id:provider,sensitivity_ceiling:'highly_restricted',external_egress_allowed:true,allowed_provider_ids:[provider]},
  tool_grant_refs:[],credential_channel_ref:null,sandbox_profile_ref:null,approval_refs:[],
  persistence:{event_capture_allowed:true,checkpoint_allowed:true,memory_proposals_allowed:false,sealed_payload_retention_seconds:0},
  output_contract:{schema_ref:null,unstructured_output_allowed:true,max_output_tokens:1000},
  governing_policy_version_refs:[{type:'runtime_context_policy_version',id:'policy-v1',version:'1'}],policy_decision_refs:[],created_at:new Date().toISOString()};
 await q(`INSERT INTO execution_control_snapshots(id,space_id,run_id,snapshot_json,created_at) VALUES($1,$2,$3,$4::jsonb,now())`,[control,space,run,JSON.stringify(snapshot)]);
 app=buildModuleServer(config(),[runtimeContextModule,policyModule,systemActionsModule,artifactsModule,contentAccessModule]);
 __setAuthIdentityForTests({spaceId:space,userId:user});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

const turn=()=>({work_context_scope_id:session,expected_setup_version:1,current_message_ref:{type:'message',id:message},invocation_purpose:'preview'});
async function producePreview(){
 const admitted=await app.inject({method:'POST',url:'/api/v1/runtime-context/preview',payload:turn(),headers:{'idempotency-key':randomUUID()}});
 expect(admitted.statusCode,admitted.body).toBe(202);
 const id=admitted.json().data.job_id as string,registry=new JobHandlerRegistry();
 registerRuntimeContextPreviewJob(registry,config());
 const result=await registry.dispatch(await claimJobForHandler(db.pool,id));
 await new PgJobQueueRepository(db.pool).completeJob(id,result,'test');
 return id;
}
const read=async(job:string)=>{const res=await app.inject({method:'GET',url:`/api/v1/runtime-context/preview-requests/${job}`});expect(res.statusCode,res.body).toBe(200);return res.json() as {status:string;result:{items:Array<{source_ref:{type:string};payload:Record<string,unknown>}>;source_trace:unknown[]}|null;withheld:number};};
const withheld={status:'completed',result:null,withheld:1};
const gone=(r:{status:string;result:unknown;withheld:number})=>({status:r.status,result:r.result,withheld:r.withheld});

it('releases a completed preview only while every source it carries is still current, and withholds body, structure and provenance otherwise',async()=>{
 const job=await producePreview(),released=await read(job);
 expect(released.withheld).toBe(0);
 const types=released.result!.items.map(item=>item.source_ref.type);
 // The producer's non-retrieval sources reach the reader, not just Setup and retrieval refs.
 expect(types).toEqual(expect.arrayContaining(['message','agent_version','project_research_evidence_matrix','skill_package_binding']));
 expect(JSON.stringify(released.result)).toContain('PRIVATE MATRIX BODY');
 const withdrawals:Array<[string,string,string]>=[
  // [what changes, withdraw, restore]
  ['Artifact read',`UPDATE artifacts SET owner_user_id='${other}' WHERE id='${artifact}'`,`UPDATE artifacts SET owner_user_id='${user}' WHERE id='${artifact}'`],
  ['Artifact body',`UPDATE artifacts SET content='EDITED' WHERE id='${artifact}'`,`UPDATE artifacts SET content='PRIVATE MATRIX BODY' WHERE id='${artifact}'`],
  ['Skill binding',`UPDATE skill_bindings SET enabled=false WHERE skill_package_id='${skillPackage}'`,`UPDATE skill_bindings SET enabled=true WHERE skill_package_id='${skillPackage}'`],
  ['AgentVersion instruction',`UPDATE agent_versions SET system_prompt='Changed.' WHERE id='${version}'`,`UPDATE agent_versions SET system_prompt='Agent instruction.' WHERE id='${version}'`],
  ['Agent',`UPDATE agents SET status='archived' WHERE id='${agent}'`,`UPDATE agents SET status='active' WHERE id='${agent}'`],
  ['Project',`UPDATE projects SET deleted_at=now() WHERE id='${project}'`,`UPDATE projects SET deleted_at=NULL WHERE id='${project}'`],
  ['Session',`UPDATE sessions SET status='archived' WHERE id='${session}'`,`UPDATE sessions SET status='active' WHERE id='${session}'`],
  ['Message',`UPDATE messages SET content='Edited.' WHERE id='${message}'`,`UPDATE messages SET content='' WHERE id='${message}'`],
 ];
 for(const [label,withdraw,restore] of withdrawals){
  await q(withdraw);
  expect(gone(await read(job)),label).toEqual(withheld);
  await q(restore);
  expect((await read(job)).withheld,`${label} restored`).toBe(0);
 }
 // A newer Setup version withholds it too; another person never sees the request.
 __setAuthIdentityForTests({spaceId:space,userId:other});
 expect((await app.inject({method:'GET',url:`/api/v1/runtime-context/preview-requests/${job}`})).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:user});
 await q(`INSERT INTO work_context_setups(id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,created_at)
  SELECT $1,space_id,work_context_scope_id,scope_kind,2,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,'preview-setup-2',1,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,now() FROM work_context_setups WHERE work_context_scope_id=$2 AND version=1`,[randomUUID(),session]);
 expect(gone(await read(job))).toEqual(withheld);
});

it('keeps a pending request empty, and stores no body when a source is withdrawn before the Job runs',async()=>{
 const admitted=await app.inject({method:'POST',url:'/api/v1/runtime-context/preview',payload:turn(),headers:{'idempotency-key':randomUUID()}});
 expect(admitted.statusCode,admitted.body).toBe(202);
 const id=admitted.json().data.job_id as string;
 expect(await read(id)).toEqual({job_id:id,status:'pending',result:null,withheld:0});
 await q(`UPDATE skill_bindings SET enabled=false WHERE skill_package_id=$1`,[skillPackage]);
 const registry=new JobHandlerRegistry();registerRuntimeContextPreviewJob(registry,config());
 await expect(registry.dispatch(await claimJobForHandler(db.pool,id))).rejects.toThrow();
 expect(JSON.stringify((await q('SELECT result_json FROM jobs WHERE id=$1',[id])).rows[0].result_json)).not.toContain('PRIVATE');
});

/**
 * A real Research Operation's Evidence Matrix M that read Input Artifact A
 * (`input_refs`). A belongs to `other` and is shared with the viewer through
 * the content-policy writer. Admission (`startAcquisition`) and the Matrix
 * (`ensureEvidenceMatrix`) are the real producers; the synthesis binding of
 * M to its Operation and the call's `input_refs` edge are written as the
 * synthesis stage and the Problem call admission store them.
 */
async function researchMatrix(){
 const third=randomUUID();await seedSpaceMember(db.pool,{space,user:third,role:'member'});
 const me={spaceId:space,userId:user};
 const thread=String((await new InquiryThreadService(db.pool).createThread(me,project,{kind:'question',statement:'Matrix question'})).id);
 const operation=(await new ResearchAcquisitionService(db.pool).startAcquisition(me,project,{threadId:thread,requestKey:'matrix',originRunId:null,originRoomId:null,originSessionId:null})).operation_id!;
 const workflow=String((await q(`SELECT research_call_json->>'workflow_id' AS id FROM project_operations WHERE id=$1`,[operation])).rows[0].id);
 const input=randomUUID();
 await q(`INSERT INTO artifacts(id,space_id,project_id,artifact_type,title,content,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at) VALUES($1,$2,$3,'document','Input','INPUT BODY','[]','private','full',$4,now(),now())`,[input,space,project,other]);
 await new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:other},'artifact',input,{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:user,access_level:'full'}]});
 const matrix=await new ProjectResearchArtifactService(db.pool).ensureEvidenceMatrix({spaceId:space,projectId:project,workflowId:workflow,operationId:operation,ownerUserId:user});
 await q(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text)),research_call_json=jsonb_set(research_call_json,'{input_refs}',$3::jsonb) WHERE id=$1`,[operation,matrix,JSON.stringify([{type:'artifact',id:input}])]);
 await q(`UPDATE runs SET contract_snapshot_json=$2::jsonb WHERE id=$1`,[run,JSON.stringify({workflow_input_json:{project_research:{evidence_matrix_artifact_id:matrix,operation_id:operation}}})]);
 const body=String((await q('SELECT content FROM artifacts WHERE id=$1',[matrix])).rows[0].content);
 return {matrix,input,operation,third,body};
}
const as=(id:string)=>__setAuthIdentityForTests({spaceId:space,userId:id});
/** The real content-policy command (PUT, operation core), as A's owner. */
async function shareInput(input:string,grantee:string){
 as(other);
 const res=await app.inject({method:'PUT',url:`/api/v1/content-access/artifact/${input}`,headers:{'idempotency-key':randomUUID()},payload:{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:grantee,access_level:'full'}]}});
 as(user);
 expect(res.statusCode,res.body).toBe(200);
}
/** The ordinary Artifact detail reader (REST), for the same person. */
const detailBody=async(id:string)=>{const res=await app.inject({method:'GET',url:`/api/v1/artifacts/${id}`});return res.statusCode===200?(res.json() as {content:string|null}).content:null;};
/** The shared Delivery consumer of the same Matrix item, in a rolled-back transaction. */
async function deliverMatrix(envelope:unknown){
 const parsed=RuntimeContextEnvelopeSchema.parse(envelope);
 const control=ExecutionControlSnapshotSchema.parse((await q('SELECT snapshot_json FROM execution_control_snapshots WHERE id=$1',[parsed.execution_control_snapshot_id])).rows[0].snapshot_json);
 const provider=String((await q('SELECT model_provider_id FROM runs WHERE id=$1',[run])).rows[0].model_provider_id);
 const only={...parsed,items:parsed.items.filter(item=>item.source_ref.type==='project_research_evidence_matrix')};
 const client=await db.pool.connect();
 try{
  await client.query('BEGIN');
  await new PgInvocationDeliveryAuthorizer().authorize(client,{spaceId:space,invocationId:run,envelope:only,control,runtimeKey:'opencode',providerId:provider,model:null,usageSourceId:`test:${run}`,viewerUserId:user},control);
  return 'delivered';
 }catch(error){return (error as {statusCode?:number}).statusCode??'error';}
 finally{await client.query('ROLLBACK');client.release();}
}

it('withholds a research Matrix preview exactly when the Artifact reader withholds the Matrix for a withdrawn input Artifact or Source, and releases it again on restore',async()=>{
 const m=await researchMatrix();
 const connection=randomUUID(),channel=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner:user,connection,connector:randomUUID(),channel,now:new Date().toISOString()});
 const material=await seedRelevantCorpusItem(db.pool,{space,project,owner:user});
 await q(`UPDATE source_items SET connection_id=$2 WHERE id=$1`,[material.sourceItemId,connection]);
 await q(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('channel_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text)) WHERE id=$1`,[m.operation,channel,material.sourceItemId]);
 const job=await producePreview(),released=await read(job);
 expect(released.withheld).toBe(0);
 expect(released.result!.items.find(item=>item.source_ref.type==='project_research_evidence_matrix')).toBeTruthy();
 expect(JSON.stringify(released.result)).toContain(JSON.stringify(m.body).slice(1,40));
 expect(await detailBody(m.matrix)).toBe(m.body);
 const stored=(await q('SELECT result_json FROM jobs WHERE id=$1',[job])).rows[0].result_json.value;
 expect(await deliverMatrix(stored)).toBe('delivered');
 const cases:Array<[string,()=>Promise<void>,()=>Promise<void>]>=[
  ['input Artifact read',()=>shareInput(m.input,m.third),()=>shareInput(m.input,user)],
  ['Source connection',async()=>{await q(`UPDATE source_connections SET status='archived' WHERE id=$1`,[connection]);},async()=>{await q(`UPDATE source_connections SET status='active' WHERE id=$1`,[connection]);}],
 ];
 for(const [label,withdraw,restore] of cases){
  await withdraw();
  // The Matrix's own row, ACL and Project are unchanged; its producing call's dependency is not.
  expect((await q('SELECT content,owner_user_id,project_id FROM artifacts WHERE id=$1',[m.matrix])).rows[0]).toEqual({content:m.body,owner_user_id:user,project_id:project});
  expect(await detailBody(m.matrix),label).toBeNull();
  expect(gone(await read(job)),label).toEqual(withheld);
  expect(await deliverMatrix(stored),label).not.toBe('delivered');
  await restore();
  expect(await detailBody(m.matrix),`${label} restored`).toBe(m.body);
  expect((await read(job)).withheld,`${label} restored`).toBe(0);
  expect(await deliverMatrix(stored),`${label} restored`).toBe('delivered');
 }
 // A Job planned while the input is withdrawn stores no body.
 await shareInput(m.input,m.third);
 const admitted=await app.inject({method:'POST',url:'/api/v1/runtime-context/preview',payload:turn(),headers:{'idempotency-key':randomUUID()}});
 const id=admitted.json().data.job_id as string,registry=new JobHandlerRegistry();registerRuntimeContextPreviewJob(registry,config());
 await expect(registry.dispatch(await claimJobForHandler(db.pool,id))).rejects.toThrow();
 expect(JSON.stringify((await q('SELECT result_json FROM jobs WHERE id=$1',[id])).rows[0].result_json)).not.toContain('evidence_matrix.v1');
});

it('orders the input Artifact policy writer against a held Matrix preview release, in both orders',async()=>{
 const m=await researchMatrix();
 const job=await producePreview();
 const stored=(await q('SELECT result_json FROM jobs WHERE id=$1',[job])).rows[0].result_json.value;
 // Release first: the decision holds the input Artifact's closure until it commits.
 const reader=await db.pool.connect();
 try{
  await reader.query('BEGIN');
  const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  expect((await releaseRuntimeContextPreview(reader,{spaceId:space,userId:user},stored)).withheld).toBe(0);
  let settled=false;
  as(other);
  const writer=app.inject({method:'PUT',url:`/api/v1/content-access/artifact/${m.input}`,headers:{'idempotency-key':randomUUID()},payload:{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:m.third,access_level:'full'}]}}).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
  expect(settled).toBe(false);
  await reader.query('COMMIT');
  expect((await writer).statusCode).toBe(200);
  as(user);
 }finally{reader.release();}
 expect(gone(await read(job))).toEqual(withheld);
 // Writer first: the release waits for the uncommitted revocation and withholds.
 await shareInput(m.input,user);
 expect((await read(job)).withheld).toBe(0);
 const writer=await db.pool.connect();
 try{
  await writer.query('BEGIN');
  const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await new ContentAccessService(writer).updatePolicy({spaceId:space,userId:other},'artifact',m.input,{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:m.third,access_level:'full'}]});
  let settled=false;
  const release=releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
  expect(settled).toBe(false);
  await writer.query('COMMIT');
  expect(await release).toEqual({result:null,withheld:1});
 }finally{writer.release();}
});

/**
 * The Task-ownership branch of the research reference gate
 * (`referenceReadableSql`): Matrix M's call reads input Artifact A, which has
 * no Project and is readable to the call's Project only through Task T that
 * owns it. A is written as the host upload writes a Run's output (no Project,
 * because its Run has none) and linked to T by the real declaration applier
 * (`declareRunArtifact` then `applyRunArtifactDeclarations`). T belongs to
 * `other`, who shares it with this person through the content-policy writer;
 * T sits in Folder F.
 */
async function taskOwnedMatrix(){
 const third=randomUUID();await seedSpaceMember(db.pool,{space,user:third,role:'member'});
 const me={spaceId:space,userId:user};
 const thread=String((await new InquiryThreadService(db.pool).createThread(me,project,{kind:'question',statement:'Task-owned input'})).id);
 const operation=(await new ResearchAcquisitionService(db.pool).startAcquisition(me,project,{threadId:thread,requestKey:'task-owned',originRunId:null,originRoomId:null,originSessionId:null})).operation_id!;
 const workflow=String((await q(`SELECT research_call_json->>'workflow_id' AS id FROM project_operations WHERE id=$1`,[operation])).rows[0].id);
 const folder=randomUUID(),task=randomUUID(),producer=randomUUID(),input=randomUUID();
 await q(`INSERT INTO project_folders(id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES($1,$2,$3,'work','docs','active',false,false,now(),now())`,[folder,space,project]);
 await q(`INSERT INTO tasks(id,space_id,project_id,project_folder_id,title,status,created_by_user_id,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,$4,'Owning Task','in_progress',$5,$5,'private',now(),now())`,[task,space,project,folder,other]);
 await new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:other},'task',task,{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:user,access_level:'full'}]});
 await seedRun(db.pool,{id:producer,space,owner:other,agent:randomUUID(),version:randomUUID()});
 expect((await q('SELECT project_id FROM runs WHERE id=$1',[producer])).rows[0].project_id).toBeNull();
 const producerAgent=await resolveAgentActorId(db.pool,space,String((await q('SELECT agent_id FROM runs WHERE id=$1',[producer])).rows[0].agent_id));
 const declare=(taskId:string)=>declareRunArtifact(db.pool,{spaceId:space,actorId:producerAgent,agentId:producerAgent,runId:producer,instructedByUserId:other,projectId:project,idempotencyKey:randomUUID()},{id:taskId,project_id:project},{path:'out/input.md',artifact_type:'document'});
 await declare(task);
 await q(`INSERT INTO artifacts(id,space_id,run_id,artifact_type,title,content,mime_type,exportable,export_formats_json,preview,created_at,updated_at,metadata_json,visibility,owner_user_id,trust_level,project_id,project_folder_id)
  VALUES($1,$2,$3,'remote_output','out/input.md','TASK INPUT BODY','text/markdown',true,'["text/plain"]',false,now(),now(),'{}','space_shared',$4,'unknown',NULL,NULL)`,[input,space,producer,other]);
 await applyRunArtifactDeclarations(db.pool,{id:producer,space_id:space},[{artifact_id:input,name:'out/input.md'}]);
 expect((await q('SELECT task_id FROM task_artifacts WHERE artifact_id=$1',[input])).rows).toEqual([{task_id:task}]);
 const matrix=await new ProjectResearchArtifactService(db.pool).ensureEvidenceMatrix({spaceId:space,projectId:project,workflowId:workflow,operationId:operation,ownerUserId:user});
 await q(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text)),research_call_json=jsonb_set(research_call_json,'{input_refs}',$3::jsonb) WHERE id=$1`,[operation,matrix,JSON.stringify([{type:'artifact',id:input}])]);
 await q(`UPDATE runs SET contract_snapshot_json=$2::jsonb WHERE id=$1`,[run,JSON.stringify({workflow_input_json:{project_research:{evidence_matrix_artifact_id:matrix,operation_id:operation}}})]);
 const body=String((await q('SELECT content FROM artifacts WHERE id=$1',[matrix])).rows[0].content);
 /** A second Task of the Project, readable to this person, that the producer's output is declared for. */
 const secondTask=async()=>{const id=randomUUID();await q(`INSERT INTO tasks(id,space_id,project_id,title,status,created_by_user_id,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,'Second Task','in_progress',$4,$4,'space_shared',now(),now())`,[id,space,project,user]);return id;};
 const link=async(taskId:string)=>{await declare(taskId);await applyRunArtifactDeclarations(db.pool,{id:producer,space_id:space},[{artifact_id:input,name:'out/input.md'}]);};
 return {matrix,input,operation,task,folder,third,body,secondTask,link};
}
/** The real content-policy command (PUT, operation core) on T, as T's owner. */
async function shareTask(task:string,grantee:string){
 as(other);
 const res=await app.inject({method:'PUT',url:`/api/v1/content-access/task/${task}`,headers:{'idempotency-key':randomUUID()},payload:{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:grantee,access_level:'full'}]}});
 as(user);
 expect(res.statusCode,res.body).toBe(200);
}
const storedPreview=async(job:string)=>(await q('SELECT result_json FROM jobs WHERE id=$1',[job])).rows[0].result_json.value;

it('withholds a Matrix whose Project-less input passes only through its owning Task when that Task is withdrawn, exactly as the Artifact reader does, and releases it on restore',async()=>{
 const m=await taskOwnedMatrix();
 const job=await producePreview(),stored=await storedPreview(job);
 expect((await read(job)).withheld).toBe(0);
 expect(await detailBody(m.matrix)).toBe(m.body);
 expect(await deliverMatrix(stored)).toBe('delivered');
 // T's owner hands T to someone else: A's own row, ACL and link are unchanged.
 await shareTask(m.task,m.third);
 expect((await q('SELECT project_id,visibility FROM artifacts WHERE id=$1',[m.input])).rows[0]).toEqual({project_id:null,visibility:'space_shared'});
 expect(await detailBody(m.matrix)).toBeNull();
 expect(gone(await read(job))).toEqual(withheld);
 expect(await deliverMatrix(stored)).not.toBe('delivered');
 await shareTask(m.task,user);
 expect(await detailBody(m.matrix)).toBe(m.body);
 expect((await read(job)).withheld).toBe(0);
 expect(await deliverMatrix(stored)).toBe('delivered');
});

it('orders the owning Task policy writer against a held Matrix preview release and Delivery, in both orders',async()=>{
 const m=await taskOwnedMatrix();
 const job=await producePreview(),stored=await storedPreview(job);
 // Release first: the decision holds T, its grants and its link until it commits.
 const reader=await db.pool.connect();
 try{
  await reader.query('BEGIN');
  const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  expect((await releaseRuntimeContextPreview(reader,{spaceId:space,userId:user},stored)).withheld).toBe(0);
  let settled=false;
  as(other);
  const writer=app.inject({method:'PUT',url:`/api/v1/content-access/task/${m.task}`,headers:{'idempotency-key':randomUUID()},payload:{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:m.third,access_level:'full'}]}}).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
  expect(settled,'the Task policy writer waits for the release to commit').toBe(false);
  await reader.query('COMMIT');
  expect((await writer).statusCode).toBe(200);
  as(user);
 }finally{reader.release();}
 // After the revocation the ordinary detail reader and the envelope agree.
 expect(await detailBody(m.matrix)).toBeNull();
 expect(gone(await read(job))).toEqual(withheld);
 // Writer first: the release and Delivery wait for the uncommitted revocation and withhold.
 await shareTask(m.task,user);
 expect((await read(job)).withheld).toBe(0);
 for(const consumer of ['preview','delivery'] as const){
  const writer=await db.pool.connect();
  try{
   await writer.query('BEGIN');
   const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await new ContentAccessService(writer).updatePolicy({spaceId:space,userId:other},'task',m.task,{visibility:'selected_users',access_level:'full',project_id:project,grants:[{user_id:m.third,access_level:'full'}]});
   let settled=false;
   const decision=(consumer==='preview'?releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored):deliverMatrix(stored)).finally(()=>{settled=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
   expect(settled,consumer).toBe(false);
   await writer.query('COMMIT');
   if(consumer==='preview')expect(await decision).toEqual({result:null,withheld:1});
   else expect(await decision).not.toBe('delivered');
  }finally{writer.release();}
  await shareTask(m.task,user);
 }
 expect(await deliverMatrix(stored)).toBe('delivered');
});

it('refuses a Matrix release whose Task-ownership closure changed while it waited for its locks, and releases the unchanged state on the next read',async()=>{
 const m=await taskOwnedMatrix();
 const job=await producePreview(),stored=await storedPreview(job);
 const second=await m.secondTask();
 const other2=randomUUID();
 await q(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'P2','active',now(),now())`,[other2,space,user]);
 const changes:Array<[string,()=>Promise<void>]>=[
  // The real declaration applier links A to a second Task of the Project.
  ['link added',()=>m.link(second)],
  // No product writer moves a Task across Projects; the row changes directly.
  ['owning Task moved to another Project',async()=>{await q('UPDATE tasks SET project_id=$2 WHERE id=$1',[second,other2]);}],
 ];
 for(const [label,change] of changes){
  // A Folder writer holds T's Folder, which the release takes after discovering its closure.
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');
   const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   await holder.query('SELECT id FROM project_folders WHERE id=$1 FOR UPDATE',[m.folder]);
   let settled=false;
   const release=releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored).finally(()=>{settled=true;});
   await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
   expect(settled,label).toBe(false);
   await change();
   await holder.query('COMMIT');
   expect(await release,label).toEqual({result:null,withheld:1});
  }finally{holder.release();}
  // The Matrix is still releasable through T: only the in-flight decision was refused.
  expect(await detailBody(m.matrix),label).toBe(m.body);
  expect((await read(job)).withheld,label).toBe(0);
 }
});

/**
 * "Continue anyway" on the Room conversation of a Run held for quota
 * recovery, against that Run's Matrix release: the research call that
 * produced M was requested by this Run, so M's release closure reads the
 * Run's Room. The writer takes the Room, then every held Run of the
 * conversation FOR UPDATE; the release must take the Room before the Run.
 */
it('a Matrix Delivery of a Run held for quota recovery and "Continue anyway" on its Room conversation both complete',async()=>{
 const m=await researchMatrix();
 const job=await producePreview(),envelope=RuntimeContextEnvelopeSchema.parse(await storedPreview(job));
 const only={...envelope,items:envelope.items.filter(item=>item.source_ref.type==='project_research_evidence_matrix')};
 expect(only.items).toHaveLength(1);
 const room=(await q('SELECT id FROM rooms WHERE space_id=$1 AND project_id=$2 AND is_mainline',[space,project])).rows[0].id as string;
 // The Run's conversation, with its turn's message, is the Project mainline Room's.
 const roomSession=session,thread=randomUUID(),task=randomUUID();
 // The server host the fixture registered.
 const host=String((await q('SELECT id FROM hosts LIMIT 1')).rows[0].id);
 await q("UPDATE sessions SET room_id=$2,project_id=$3,user_id=NULL,title='Room talk' WHERE id=$1",[roomSession,room,project]);
 await q("INSERT INTO tasks(id,space_id,project_id,title,status,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,'Continue work','in_progress',$4,'space_shared',now(),now())",[task,space,project,user]);
 await q(`INSERT INTO host_threads(id,space_id,execution_host_id,workspace_mode,session_id,agent_id,container_kind,runtime_key,runtime_installation,dispatch_lock_id,created_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,'managed',$4,$5,'conversation','claude_code','managed:1.0.0',$6,$7,now(),now())`,[thread,space,host,roomSession,agent,run,user]);
 await q("UPDATE agent_runtime_profiles SET runtime_key='claude_code',backend_mode='runtime_native',model_provider_id=NULL,model_name=NULL WHERE agent_id=$1",[agent]);
 // The Run requested the research that produced M, from its Room conversation.
 await q(`UPDATE project_operations SET research_call_json=jsonb_set(research_call_json,'{requested_by_run_id}',to_jsonb($2::text)) WHERE id=$1`,[m.operation,run]);
 // An accepted Invocation Snapshot of the Run's attempt, kept across the requeue.
 const delivery=randomUUID(),control=envelope.execution_control_snapshot_id;
 await q("INSERT INTO invocation_deliveries(id,space_id,invocation_id,attempt,execution_control_snapshot_id,runtime_key,renderer_version,delivery_metadata_json,created_at) VALUES($1,$2,$3,1,$4,'claude_code','test.v1','{}'::jsonb,now())",[delivery,space,run,control]);
 await q("INSERT INTO invocation_snapshots(id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at) VALUES($1,$2,$3,$4,1,'{}'::jsonb,'accepted',now(),now())",[randomUUID(),space,run,delivery]);
 // The attempt is refused by the subscription quota; the real supervisor requeues the same Run and holds it for recovery.
 const reset=Math.floor((Date.now()+3600_000)/1000);
 await q(`UPDATE runs SET status='failed',runtime_key='claude_code',model_provider_id=NULL,session_id=$2,host_task_thread_id=$3,
   runtime_profile_snapshot_json=runtime_profile_snapshot_json||'{"runtime_key":"claude_code","backend_mode":"runtime_native","model_provider_id":null}'::jsonb,
   contract_snapshot_json=contract_snapshot_json||$4::jsonb,error_json=$5::jsonb,error_message=$6,started_at=now(),ended_at=now() WHERE id=$1`,
  [run,roomSession,thread,JSON.stringify({source:{kind:'task',id:task},max_attempts:2}),JSON.stringify({error_code:SUBSCRIPTION_QUOTA_EXHAUSTED}),`Claude AI usage limit reached|${reset}`]);
 await q("INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,error_code,started_at,ended_at,created_at,updated_at) VALUES($1,$2,$3,1,'failed',$4,now(),now(),now(),now())",[randomUUID(),space,run,SUBSCRIPTION_QUOTA_EXHAUSTED]);
 await new PgRunSupervisor(db.pool).supervise({run:(await new PgRunRepository(db.pool).getRun(space,run))!,attempt_number:1,evaluation:{outcome_status:'failed',failure_reason_code:SUBSCRIPTION_QUOTA_EXHAUSTED}});
 // The Run's execution authority now names its CLI egress, as a native attempt's does.
 await q(`UPDATE execution_control_snapshots SET snapshot_json=jsonb_set(snapshot_json,'{egress}',$2::jsonb) WHERE id=$1`,[control,JSON.stringify({destination_type:'local_cli',destination_id:'claude_code',sensitivity_ceiling:'highly_restricted',external_egress_allowed:true,allowed_provider_ids:[]})]);
 const state=async()=>({
  run:(await q("SELECT status,output_json->'waiting_for_quota' AS marker FROM runs WHERE id=$1",[run])).rows[0],
  snapshots:Number((await q("SELECT count(*) AS n FROM invocation_snapshots WHERE invocation_id=$1 AND status='accepted'",[run])).rows[0].n),
  jobs:Number((await q("SELECT count(*) AS n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1",[run])).rows[0].n),
  claim:(await q('SELECT dispatch_lock_id FROM host_threads WHERE id=$1',[thread])).rows[0].dispatch_lock_id,
 });
 const held=await state();
 expect(held.run).toMatchObject({status:'queued',marker:{recovery:{auto_continue:true}}});
 expect(held.snapshots).toBe(1);
 // The shared Delivery gate (`authorizeEnvelope`, also the preview release's), carrying the Matrix item.
 const decide=async()=>{
  const control2=ExecutionControlSnapshotSchema.parse((await q('SELECT snapshot_json FROM execution_control_snapshots WHERE id=$1',[control])).rows[0].snapshot_json);
  return withTransaction(db.pool,async client=>{
   await new PgInvocationDeliveryAuthorizer().authorize(client,{spaceId:space,invocationId:run,envelope:only,control:control2,runtimeKey:'claude_code',providerId:null,model:null,usageSourceId:`test:${run}`,viewerUserId:user},control2);
   return 'released';
  });
 };
 // The gate releases M for the held Run while nothing contends.
 expect(await decide()).toBe('released');
 const rooms=buildModuleServer(config(),[roomsModule]);
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');
  const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // A Run status writer holds the Run: the release has taken the Room (and,
  // before it, every Project) and waits here, at the Run.
  await holder.query('SELECT id FROM runs WHERE id=$1 FOR NO KEY UPDATE',[run]);
  let decided=false;const deciding=decide().finally(()=>{decided=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>decided});
  expect(decided,'the release waits on the Run').toBe(false);
  let continued=false;
  const continuing=rooms.inject({method:'POST',url:`/api/v1/rooms/${room}/conversations/${roomSession}/quota/continue`,payload:{},headers:{'idempotency-key':randomUUID()}}).finally(()=>{continued=true;});
  await waitForLockWaiter(db.pool,{waiters:2,settled:()=>continued});
  expect(continued,'Continue anyway waits behind the release, on the Room').toBe(false);
  await holder.query('COMMIT');
  const [decision,continuation]=await Promise.allSettled([deciding,continuing]);
  expect(decision.status,decision.status==='rejected'?String((decision.reason as Error).message):'').toBe('fulfilled');
  expect((decision as PromiseFulfilledResult<string>).value).toBe('released');
  expect(continuation.status).toBe('fulfilled');
  const response=(continuation as PromiseFulfilledResult<{statusCode:number;body:string}>).value;
  expect(response.statusCode,response.body).toBe(200);
  // A recovery hold stays with its own scheduler: marker, snapshot, Job and Host claim unchanged.
  expect(await state()).toEqual(held);
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await rooms.close();}
});

/**
 * Project archive (the real `project.archive` operation) against the shared
 * gate on the same workflow Run. Archive takes the Project FOR UPDATE, then
 * pauses its automations, cancels its workflow executions, Jobs and Runs;
 * the Run has no execution lock, so `markRunTerminal` takes it FOR UPDATE.
 * The gate must take the Project before the Run. Both orders are staged
 * with a third transaction that holds a row only one side needs next:
 * archive first — the workflow execution row (archive waits on it holding
 * the Project, before any Run); gate first — the Setup row (the gate waits
 * on it after its Run). No sleep: each step waits on PostgreSQL lock waits.
 */
async function workflowRun(){
 const automation=randomUUID(),execution=randomUUID(),asset=randomUUID(),workflowVersion=randomUUID();
 await q(`INSERT INTO evolvable_assets(id,space_id,asset_type,asset_key,display_name,description,owner_scope_type,status,metadata_json,created_at,updated_at)
  VALUES($1,NULL,'workflow_template',$2,'Archive workflow','Archive workflow','system','active','{}'::jsonb,now(),now())`,[asset,`workflow.archive-${asset}`]);
 await q(`INSERT INTO evolvable_asset_versions(id,asset_id,space_id,scope_type,version,status,source,content_hash,content_json,created_at,updated_at)
  VALUES($1,$2,NULL,'system',1,'approved','built_in','archive-test','{}'::jsonb,now(),now())`,[workflowVersion,asset]);
 await q(`INSERT INTO automations(id,space_id,owner_user_id,agent_id,project_id,name,trigger_type,status,preflight_snapshot_json,config_json,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'Workflow','manual','active','{}','{"target_type":"workflow"}',now(),now())`,[automation,space,user,agent,project]);
 // The rows `WorkflowExecutionService.start` writes: a running execution whose coordinator is this Run.
 await q(`INSERT INTO workflow_executions(id,space_id,automation_id,workflow_version_id,root_run_id,status,trigger_type,definition_json,responsible_user_id,created_at,started_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'running','manual','{}',$6,now(),now(),now())`,[execution,space,automation,workflowVersion,run,user]);
 await q("UPDATE runs SET run_type='workflow',status='waiting_for_dependency' WHERE id=$1",[run]);
 const job=await new PgJobQueueRepository(db.pool).enqueue({job_type:'agent_run',space_id:space,user_id:user,agent_id:agent,payload:{run_id:run,agent_id:agent}});
 expect((await q('SELECT count(*)::int AS n FROM run_execution_locks WHERE run_id=$1',[run])).rows[0].n).toBe(0);
 return {automation,execution,job:job.id};
}
for(const consumer of ['delivery','preview'] as const)for(const first of ['archive','gate'] as const){
 it(`Project archive and the ${consumer} gate on its workflow Run both complete, ${first} first`,async()=>{
  const job=await producePreview(),stored=RuntimeContextEnvelopeSchema.parse(await storedPreview(job));
  const wf=await workflowRun();
  const projects=buildModuleServer(config(),[projectsModule,policyModule,systemActionsModule]);
  const gate=async()=>{
   if(consumer==='preview')return (await releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored)).withheld===0?'released':'withheld';
   const control=ExecutionControlSnapshotSchema.parse((await q('SELECT snapshot_json FROM execution_control_snapshots WHERE id=$1',[stored.execution_control_snapshot_id])).rows[0].snapshot_json);
   const provider=String((await q('SELECT model_provider_id FROM runs WHERE id=$1',[run])).rows[0].model_provider_id);
   const only={...stored,items:stored.items.filter(item=>item.source_ref.type==='project_research_evidence_matrix')};
   return withTransaction(db.pool,async client=>{
    await new PgInvocationDeliveryAuthorizer().authorize(client,{spaceId:space,invocationId:run,envelope:only,control,runtimeKey:'opencode',providerId:provider,model:null,usageSourceId:`test:${run}`,viewerUserId:user},control);
    return 'released';
   });
  };
  const holder=await db.pool.connect();
  try{
   await holder.query('BEGIN');
   const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   let archived=false,gated=false;
   const archive=()=>projects.inject({method:'POST',url:`/api/v1/projects/${project}/archive`,payload:{},headers:{'idempotency-key':randomUUID()}}).finally(()=>{archived=true;});
   const gating=()=>gate().finally(()=>{gated=true;});
   let archiving:ReturnType<typeof archive>,deciding:ReturnType<typeof gating>;
   if(first==='archive'){
    await holder.query('SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE',[wf.execution]);
    archiving=archive();
    await waitForBlockedBy(db.pool,pid,{settled:()=>archived});
    expect(archived,'archive holds the Project and waits on the execution').toBe(false);
    deciding=gating();
   }else{
    await holder.query('SELECT id FROM work_context_setups WHERE work_context_scope_id=$1 FOR UPDATE',[session]);
    deciding=gating();
    await waitForBlockedBy(db.pool,pid,{settled:()=>gated});
    expect(gated,'the gate waits on the Setup').toBe(false);
    archiving=archive();
   }
   await waitForLockWaiter(db.pool,{waiters:2,settled:()=>archived||gated});
   expect(archived||gated,'both wait').toBe(false);
   await holder.query('COMMIT');
   const [decision,archival]=await Promise.allSettled([deciding,archiving]);
   expect(decision.status,decision.status==='rejected'?String((decision.reason as Error).message):'').toBe('fulfilled');
   expect(archival.status).toBe('fulfilled');
   const response=(archival as PromiseFulfilledResult<{statusCode:number;body:string}>).value;
   expect(response.statusCode,response.body).toBe(200);
   // Archive's own semantics hold: the Project, automation, execution, Job and Run.
   expect((await q('SELECT status FROM projects WHERE id=$1',[project])).rows[0].status).toBe('archived');
   expect((await q('SELECT status FROM automations WHERE id=$1',[wf.automation])).rows[0].status).toBe('paused');
   expect((await q('SELECT status FROM workflow_executions WHERE id=$1',[wf.execution])).rows[0].status).toBe('cancelled');
   expect((await q('SELECT status FROM jobs WHERE id=$1',[wf.job])).rows[0].status).toBe('cancelled');
   expect((await q("SELECT status,error_json->>'error_code' AS code FROM runs WHERE id=$1",[run])).rows[0]).toMatchObject({status:'cancelled',code:'project_archived'});
  }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await projects.close();}
 });
}

/**
 * The preview release of a workflow Work Context: its readable check takes
 * the execution and its root Run. Archive first, held after its Project at
 * the automation row (the next row it updates); the release must wait at the
 * Project, not hold the execution and Run while archive waits on them.
 */
it('Project archive and the preview release of its workflow Work Context both complete, archive first',async()=>{
 const job=await producePreview(),stored=RuntimeContextEnvelopeSchema.parse(await storedPreview(job));
 const wf=await workflowRun();
 const setup=randomUUID();
 await q(`INSERT INTO work_context_setups(id,space_id,work_context_scope_id,scope_kind,version,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,setup_fingerprint,base_version,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,created_at)
  SELECT $1,space_id,$2,'workflow_execution',1,user_id,project_id,project_folder_id,agent_id,runtime_ref_json,pinned_refs_json,excluded_refs_json,retrieval_preferences_json,continuity_preferences_json,project_brief_version_id,project_instruction_version_id,project_instruction_enabled,governing_policy_refs_json,'workflow-setup',NULL,typed_diff_json,reason,policy_decision_record_id,created_by_user_id,now() FROM work_context_setups WHERE work_context_scope_id=$3 AND version=1`,[setup,wf.execution,session]);
 const setupRef={type:'work_context_setup',id:setup,version:'1'};
 await q(`UPDATE execution_control_snapshots SET snapshot_json=snapshot_json||jsonb_build_object('work_context_scope_id',$2::text,'work_context_setup_ref',$3::jsonb) WHERE id=$1`,[stored.execution_control_snapshot_id,wf.execution,JSON.stringify(setupRef)]);
 const envelope={...stored,turn_request:{...stored.turn_request,work_context_scope_id:wf.execution},setup_ref:{...stored.setup_ref!,...setupRef}};
 const release=()=>releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},envelope);
 expect((await release()).withheld,'released while nothing contends').toBe(0);
 const projects=buildModuleServer(config(),[projectsModule,policyModule,systemActionsModule]);
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');
  const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await holder.query('SELECT id FROM automations WHERE id=$1 FOR UPDATE',[wf.automation]);
  let archived=false,released=false;
  const archiving=projects.inject({method:'POST',url:`/api/v1/projects/${project}/archive`,payload:{},headers:{'idempotency-key':randomUUID()}}).finally(()=>{archived=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>archived});
  expect(archived,'archive holds the Project and waits on the automation').toBe(false);
  const releasing=release().finally(()=>{released=true;});
  await waitForLockWaiter(db.pool,{waiters:2,settled:()=>released});
  expect(released,'the release waits').toBe(false);
  await holder.query('COMMIT');
  const [decision,archival]=await Promise.allSettled([releasing,archiving]);
  expect(decision.status,decision.status==='rejected'?String((decision.reason as Error).message):'').toBe('fulfilled');
  const response=(archival as PromiseFulfilledResult<{statusCode:number;body:string}>).value;
  expect(archival.status).toBe('fulfilled');
  expect(response.statusCode,response.body).toBe(200);
  expect((await q('SELECT status FROM workflow_executions WHERE id=$1',[wf.execution])).rows[0].status).toBe('cancelled');
  expect((await q("SELECT status,error_json->>'error_code' AS code FROM runs WHERE id=$1",[run])).rows[0]).toMatchObject({status:'cancelled',code:'project_archived'});
  expect((await q('SELECT status FROM jobs WHERE id=$1',[wf.job])).rows[0].status).toBe('cancelled');
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();await projects.close();}
});

/**
 * A Project the gate reaches after its Run must be one it took before the
 * Run. The Agent's content row moves into another Project (written directly)
 * while the release waits after its Run, at the Setup row: the Agent's
 * content check then reads a Project outside the held set and refuses (409,
 * withheld) instead of locking it late; the next read takes it first and
 * releases.
 */
it('refuses a Project reached after the Run that the gate did not take before it, and releases on the next read',async()=>{
 const job=await producePreview(),stored=await storedPreview(job);
 const moved=randomUUID();
 await q(`INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Q','active',now(),now())`,[moved,space,user]);
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');
  const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  await holder.query('SELECT id FROM work_context_setups WHERE work_context_scope_id=$1 FOR UPDATE',[session]);
  let settled=false;
  const releasing=releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored).finally(()=>{settled=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>settled});
  expect(settled,'the release waits after its Run').toBe(false);
  await q('UPDATE agents SET project_id=$2 WHERE id=$1',[agent,moved]);
  await holder.query('COMMIT');
  expect(await releasing).toEqual({result:null,withheld:1});
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
 expect((await releaseRuntimeContextPreview(db.pool,{spaceId:space,userId:user},stored)).withheld).toBe(0);
});
