// Demotion disclosure titles over real producers and the real content-policy
// writer: a report-derived Proposal and a shared Source analysis named by a
// consuming Run follow their own detail readers at creation, readback and
// confirmation; and a readback holds its whole read closure until the
// response built from it commits.
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedRun,seedServerHost,seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {PgRunSupervisor} from '../src/modules/runs/supervisor.js';
import {SUBSCRIPTION_QUOTA_EXHAUSTED} from '../src/modules/runs/retryPolicy.js';
import {roomsModule} from '../src/modules/rooms/index.js';
import {RoomRosterService} from '../src/modules/rooms/rosterService.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {seedSourceConnection} from './support/reviewPacketDatabase.js';
import {seedArxivSourceChain} from './support/researchSeeds.js';
import {waitForBlockedBy,waitForLockWaiter} from './support/lockWait.js';
import {buildModuleServer} from './support/moduleServer.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {proposalsModule,__setProposalIdentityForTests} from '../src/modules/proposals/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {createClaimCandidatePacketFromArtifacts} from '../src/modules/knowledge/claimCandidatePackets.js';
import {insertArtifactRow} from '../src/modules/artifacts/reviewArtifactWriter.js';
import {PgArtifactRepository} from '../src/modules/artifacts/repository.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {agentReadingDocument,agentReadingMetadata,saveSourceReadingDocument} from '../src/modules/sources/materialProcessing/documents.js';
import {withDbTransaction} from '../src/modules/routeUtils/common.js';
import {loadConfig} from '../src/config.js';

const db=useTestDatabase(import.meta.filename,{max:8});
let space:string,owner:string,member:string,other:string,project:string;
const config=()=>loadConfig({SERVER_DATABASE_URL:db.connectionUri});
const service=()=>new ContentAccessService(db.pool);
const as=(userId:string)=>({spaceId:space,userId});

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','source_connectors','source_providers'],{cascade:true});
 space=randomUUID();owner=randomUUID();member=randomUUID();other=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 for(const user of [member,other])await seedSpaceMember(db.pool,{space,user});
});
afterEach(()=>{__setAuthIdentityForTests(null);__setProposalIdentityForTests(null);});

const grant=(type:string,id:string,level:string,grantee=owner)=>db.pool.query(`INSERT INTO content_access_grants(id,space_id,resource_type,resource_id,grantee_user_id,access_level,granted_by_user_id,created_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,now(),now())`,[randomUUID(),space,type,id,grantee,level,member]);
/** The owner's shared Artifact that Runs consume. */
async function sourceArtifact(){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO artifacts(id,space_id,artifact_type,title,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at)
  VALUES($1,$2,'report','Source','[]'::jsonb,'space_shared','full',$3,now(),now())`,[id,space,owner]);
 return id;
}
/** A Run whose accepted Invocation Snapshot consumed `source`. A colleague's Run is shared with the owner at full. */
async function consumingRun(source:{type:string;id:string},runOwner:string,instruction:string){
 const id=randomUUID(),control=randomUUID(),delivery=randomUUID();
 await seedRun(db.pool,{id,space,owner:runOwner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query("UPDATE runs SET instruction=$2,instructed_by_user_id=owner_user_id,runtime_key='codex_cli',status='succeeded',visibility=$3 WHERE id=$1",[id,instruction,runOwner===owner?'private':'selected_users']);
 if(runOwner!==owner)await grant('run',id,'full');
 await db.pool.query("INSERT INTO execution_control_snapshots(id,space_id,run_id,snapshot_json,created_at) VALUES($1,$2,$3,'{}'::jsonb,now())",[control,space,id]);
 await db.pool.query("INSERT INTO invocation_deliveries(id,space_id,invocation_id,attempt,execution_control_snapshot_id,runtime_key,renderer_version,delivery_metadata_json,created_at) VALUES($1,$2,$3,1,$4,'opencode','test.v1','{}'::jsonb,now())",[delivery,space,id,control]);
 await db.pool.query("INSERT INTO invocation_snapshots(id,space_id,invocation_id,delivery_id,attempt,safe_snapshot_json,status,created_at,updated_at) VALUES($1,$2,$3,$4,1,$5::jsonb,'accepted',now(),now())",[randomUUID(),space,id,delivery,JSON.stringify({source_refs:[source]})]);
 return id;
}
async function runOutput(runId:string,title:string,level:'full'|'summary'){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO artifacts(id,space_id,run_id,artifact_type,title,export_formats_json,visibility,access_level,owner_user_id,created_at,updated_at)
  VALUES($1,$2,$3,'report',$4,'[]'::jsonb,'selected_users','full',$5,now(),now())`,[id,space,runId,title,member]);
 await grant('artifact',id,level);
 return id;
}
const disclose=async(type:string,id:string)=>(await service().discloseDemotion(as(owner),type,id,'private')).confirmation_id;
const readBack=(type:string,id:string,confirmation:string)=>service().readDemotionDisclosure(as(owner),type,id,confirmation);
const confirm=(type:string,id:string,confirmation:string)=>service().updatePolicy(as(owner),type,id,{visibility:'private',access_level:'full',project_id:null,grants:[],demotion_confirmation_id:confirmation});
const stored=async(id:string)=>(await db.pool.query('SELECT exposure_snapshot_json::text AS s FROM content_demotion_disclosures WHERE id=$1',[id])).rows[0].s as string;
type Exposure={consuming_runs:Array<{run_id:string;title:string}>;shared_derived_outputs:Array<{id:string;title:string;link:string}>};
const title=(body:{exposure:Exposure},id:string)=>[...body.exposure.consuming_runs.map(r=>[r.run_id,r.title]),...body.exposure.shared_derived_outputs.map(o=>[o.id,o.title])].find(([k])=>k===id)?.[1];
const refusal=async(p:Promise<unknown>)=>p.then(()=>null,(error:{statusCode?:number;responseBody?:unknown})=>({status:error.statusCode,metadata:error.responseBody}));

it('releases a report-derived Proposal title only while its report closure is releasable, at creation, readback and confirmation',async()=>{
 // The real producer chain: a Source-derived Knowledge item → Brief → Claim
 // Candidate Packet → accepted → claim_create child (packet context nested
 // under payload.metadata), attributed to the Run that consumed the source.
 const sourceOwner=member,connection=randomUUID(),sourceItem=randomUUID(),item=randomUUID();
 const consent=(admins:boolean)=>({schema_version:1,owner_user_id:sourceOwner,allowed_reader_user_ids:[],allowed_agent_ids:[],allow_space_admins:admins});
 await seedSourceConnection(db.pool,{id:connection,space,owner:sourceOwner,consent:consent(true),policy:{schema_version:1,source_egress_class:'internal_only'}});
 await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Source',now(),now(),'excerpt_saved','summary_only',now(),now())",[sourceItem,space,sourceOwner,connection]);
 await insertKnowledgeItem(db.pool,{id:item,spaceId:space,title:'Lattice PRIVATE title',content:'Quantum lattice PRIVATE body',ownerUserId:owner,createdByUserId:owner,projectId:project});
 await db.pool.query("INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'knowledge',$3,'source_item',$4,now())",[randomUUID(),space,item,sourceItem]);
 await new RetrievalProjectionService(db.pool,knowledgeRetrievalRegistry).reindexAll(space);
 const brief=await insertArtifactRow(db.pool,{spaceId:space,ownerUserId:owner,artifactType:'retrieval_brief',title:'Context Brief',content:'Brief',metadata:{query:'lattice',item_refs:[{object_type:'knowledge_item',object_id:item}],citations:[],gap_analysis:{uncited_claims:['Lattice PRIVATE claim holds for the quantum body.'],contradictions:[],missing_topics:[],stale:[],thin:[]}},canonicalFormat:'retrieval_brief.v1',visibility:'private',runId:null,createdAt:new Date().toISOString()});
 const packet=await createClaimCandidatePacketFromArtifacts(db.pool,{spaceId:space,ownerUserId:owner,request:{source_artifact_ids:[brief],max_candidates:10,review_scope:'private',promote_private_sources_to_space_ops:false}});
 const app=buildModuleServer(config(),[knowledgeModule,systemActionsModule,proposalsModule]);
 try{
  __setAuthIdentityForTests(as(owner));__setProposalIdentityForTests(as(owner));
  const accepted=await app.inject({method:'POST',url:`/api/v1/proposals/${packet.proposalId}/accept`,headers:{'idempotency-key':randomUUID()}});expect(accepted.statusCode,accepted.body).toBe(200);
  const childIds=(await db.pool.query('SELECT payload_json FROM proposals WHERE id=$1',[packet.proposalId])).rows[0].payload_json.generated_child_proposal_ids as string[];
  const child=(await db.pool.query<{id:string;title:string;payload_json:Record<string,unknown>}>("SELECT id,title,payload_json FROM proposals WHERE id=ANY($1::varchar[]) AND proposal_type='claim_create'",[childIds])).rows[0]!;
  expect(child.payload_json).toMatchObject({metadata:{source_artifact_ids:[brief],claim_candidate_packet:{source_candidate_packet_artifact_id:packet.artifactId}}});
  expect(child.title).toContain('Lattice PRIVATE claim');
  const source=await sourceArtifact(),run=await consumingRun({type:'artifact',id:source},owner,'OWNER INSTRUCTION');
  // Shared and attributed to the consuming Run; its own ACL stays readable to the owner throughout.
  await db.pool.query("UPDATE proposals SET created_by_run_id=$2,visibility='space_shared' WHERE id=$1",[child.id,run]);
  const detail=async()=>(await app.inject({method:'GET',url:`/api/v1/proposals/${child.id}`})).json().proposed_title as string;

  const before=await disclose('artifact',source);
  expect(title(await readBack('artifact',source,before),child.id)).toBe(child.title);
  const storedBefore=await stored(before);expect(storedBefore).toContain('Lattice PRIVATE claim');

  // Withdraw the report's contributing Source: the normal Proposal reader swaps the title for its type label.
  await db.pool.query('UPDATE source_connections SET consent_json=$2::jsonb WHERE id=$1',[connection,JSON.stringify(consent(false))]);
  expect(await detail()).toBe('Claim create');
  const after=await readBack('artifact',source,before);
  expect(title(after,child.id)).toBe(`Proposal ${child.id.slice(0,8)}`);
  expect(after.exposure.shared_derived_outputs.map(o=>o.link)).toEqual([`/proposals/${child.id}`]);
  expect(title(after,run)).toBe('OWNER INSTRUCTION');
  expect(JSON.stringify(after)).not.toContain('PRIVATE');
  // Readback never rewrites the record; the confirmation recomputes with the same gate and refuses the stale one.
  expect(await stored(before)).toBe(storedBefore);
  expect(await refusal(confirm('artifact',source,before))).toMatchObject({status:409,metadata:{code:'demotion_exposure_changed'}});
  const fresh=await disclose('artifact',source);
  expect(await stored(fresh)).not.toContain('PRIVATE');
  expect(await refusal(confirm('artifact',source,fresh))).toBeNull();
 }finally{await app.close();}
});

it('releases a shared Source analysis title only through the Artifact detail gates; an ordinary summary output keeps its title',async()=>{
 const item=async(title:string)=>{const id=randomUUID();await db.pool.query(`INSERT INTO source_items(id,space_id,project_id,owner_user_id,created_by_user_id,visibility,item_type,title,canonical_uri,source_uri,content_state,retention_policy,first_seen_at,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,$4,'space_shared','external_url',$5,$6,$6,'metadata_only','full_text',now(),now(),now(),now())`,[id,space,project,owner,title,`https://example.test/${id}`]);return id;};
 const target=await item('ANALYSIS SECRET TITLE'),supporting=await item('Supporting');
 const connection=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query(`UPDATE source_connections SET capture_policy='extract_text',policy_json=policy_json||'{"retention_policy":"full_text","source_egress_class":"external_provider_allowed"}',consent_json=consent_json||'{"allow_external_model_egress":true}' WHERE id=$1`,[connection]);
 await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1',[supporting,connection]);
 const originalContent=agentReadingDocument({kind:'article',format:'source_text',syntax:'plain',text:'Original evidence.',sources:['https://example.test/article']},'https://example.test/article');
 const original=await withDbTransaction(db.pool,tx=>saveSourceReadingDocument(tx,{spaceId:space,itemId:supporting,document:{...originalContent,extraction_method:'plain_text_v1'}}));
 const source=await sourceArtifact(),run=await consumingRun({type:'artifact',id:source},owner,'OWNER INSTRUCTION');
 // The Project analysis writer: artifacts.run_id plus reading_history_refs on the supporting Source.
 const content={kind:'article' as const,format:'agent_summary' as const,syntax:'markdown' as const,text:'Supported analysis',sources:['https://example.test/article']};
 const analysis=await saveSourceReadingDocument(db.pool,{spaceId:space,itemId:target,agentProvided:true,document:agentReadingDocument(content,'https://example.test/article'),metadata:{...agentReadingMetadata(content),agent_run_id:run,reading_history_refs:[{item_id:supporting,artifact_id:original.artifactId,snapshot_id:original.snapshotId,content_hash:original.contentHash}]}});
 const written=(await db.pool.query('SELECT run_id,title,metadata_json FROM artifacts WHERE id=$1',[analysis.artifactId])).rows[0];
 expect(written).toMatchObject({run_id:run,title:'ANALYSIS SECRET TITLE',metadata_json:{reading_role:'analysis',reading_analysis_destination:'external_provider'}});
 await db.pool.query("UPDATE artifacts SET visibility='space_shared' WHERE id=$1",[analysis.artifactId]);
 const summary=await runOutput(run,'SUMMARY OUTPUT TITLE','summary');
 const normal=()=>new PgArtifactRepository(db.pool,config()).getVisible(space,owner,analysis.artifactId);
 expect(await normal()).not.toBeNull();

 const before=await disclose('artifact',source);
 const released=await readBack('artifact',source,before);
 expect(title(released,analysis.artifactId)).toBe('ANALYSIS SECRET TITLE');
 expect(title(released,summary)).toBe('SUMMARY OUTPUT TITLE');

 // Withdraw the supporting Source's consent: the normal Artifact detail now refuses the analysis.
 await db.pool.query(`UPDATE source_connections SET consent_json=consent_json||'{"allow_external_model_egress":false}' WHERE id=$1`,[connection]);
 expect(await normal()).toBeNull();
 const after=await readBack('artifact',source,before);
 expect(title(after,analysis.artifactId)).toBe(`Artifact ${analysis.artifactId.slice(0,8)}`);
 expect(title(after,summary)).toBe('SUMMARY OUTPUT TITLE');
 expect(after.exposure.shared_derived_outputs.map(o=>o.id).sort()).toEqual([analysis.artifactId,summary].sort());
 expect(JSON.stringify(after)).not.toContain('ANALYSIS SECRET TITLE');
 expect(await refusal(confirm('artifact',source,before))).toMatchObject({status:409,metadata:{code:'demotion_exposure_changed'}});
 const fresh=await disclose('artifact',source);
 expect(await stored(fresh)).not.toContain('ANALYSIS SECRET TITLE');
 expect(await stored(fresh)).toContain('SUMMARY OUTPUT TITLE');
 expect(await refusal(confirm('artifact',source,fresh))).toBeNull();
});

/** The owner's shared Source item, on a connection, consumed by a colleague's Run that produced a shared output. */
async function colleagueExposure(){
 const connection=randomUUID(),sourceItem=randomUUID();
 await seedArxivSourceChain(db.pool,{space,owner,connection,connector:randomUUID(),channel:randomUUID(),now:new Date().toISOString()});
 await db.pool.query("INSERT INTO source_items(id,space_id,owner_user_id,visibility,access_level,connection_id,item_type,title,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at) VALUES($1,$2,$3,'space_shared','full',$4,'external_url','Owned',now(),now(),'excerpt_saved','summary_only',now(),now())",[sourceItem,space,owner,connection]);
 const run=await consumingRun({type:'source_item',id:sourceItem},member,'COLLEAGUE INSTRUCTION');
 await runOutput(run,'COLLEAGUE OUTPUT','full');
 const confirmation=await disclose('source_item',sourceItem);
 expect(title(await readBack('source_item',sourceItem,confirmation),run)).toBe('COLLEAGUE INSTRUCTION');
 // The colleague's real content-policy write that withdraws the owner's Run grant.
 const revoke=()=>service().updatePolicy(as(member),'run',run,{visibility:'selected_users',access_level:'full',project_id:null,grants:[{user_id:other,access_level:'full'}]});
 return {connection,sourceItem,run,confirmation,revoke};
}

it('sees a Run grant revocation that commits after the Run check while a later output query of the same readback waits',async()=>{
 const {sourceItem,run,confirmation,revoke}=await colleagueExposure();
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // Every later Artifact query of the readback waits here; the Run grant writer does not touch Artifacts.
  await holder.query('LOCK TABLE artifacts IN ACCESS EXCLUSIVE MODE');
  let done=false;const reading=readBack('source_item',sourceItem,confirmation).finally(()=>{done=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>done});
  expect(done,'the readback waits on its Artifact query').toBe(false);
  await revoke();
  await holder.query('COMMIT');
  const body=await reading;
  expect(title(body,run)).toBe(`Run ${run.slice(0,8)}`);
  expect(JSON.stringify(body)).not.toContain('COLLEAGUE INSTRUCTION');
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});

it('holds the read closure until the readback commits, so a concurrent Run grant revocation waits for it',async()=>{
 const {connection,sourceItem,run,confirmation,revoke}=await colleagueExposure();
 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // An uncommitted Source connection write: the readback has share-locked the Run and its grants and waits here, later in its order.
  await holder.query('SELECT id FROM source_connections WHERE id=$1 FOR UPDATE',[connection]);
  let read=false;const reading=readBack('source_item',sourceItem,confirmation).finally(()=>{read=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>read});
  expect(read,'the readback waits inside its closure lock').toBe(false);
  let revoked=false;const revoking=revoke().finally(()=>{revoked=true;});
  await waitForLockWaiter(db.pool,{waiters:2,settled:()=>revoked});
  expect(revoked,'the revocation waits for the in-flight readback').toBe(false);
  await holder.query('ROLLBACK');
  const body=await reading;
  // The readback was serialized before the revocation: its title rests on rows nobody changed until it committed.
  expect(title(body,run)).toBe('COLLEAGUE INSTRUCTION');
  await revoking;
  expect(title(await readBack('source_item',sourceItem,confirmation),run)).toBe(`Run ${run.slice(0,8)}`);
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});

it('a readback and a concurrent Room context reset on the Run\'s Room conversation both complete: both take the Room before its conversation',async()=>{
 // The demoting owner's Room conversation, where a Host-bound Agent the owner's machine runs holds an active thread.
 const room=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND project_id=$2 AND is_mainline',[space,project])).rows[0]!.id;
 const session=randomUUID(),host=randomUUID(),agent=randomUUID(),thread=randomUUID();
 await db.pool.query("INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Room talk','active',now(),now())",[session,space,room,project]);
 await db.pool.query("INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'Desk','desktop',now(),now())",[host,owner]);
 await db.pool.query("INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at) VALUES($1,$2,$1,'Desk','remote','linux_native','online','{}'::jsonb,now(),now(),now())",[host,owner]);
 await seedAgentWithVersion(db.pool,{space,owner,agent,version:randomUUID(),name:'Host Agent'});
 await db.pool.query(`INSERT INTO host_threads(id,space_id,execution_host_id,workspace_mode,session_id,agent_id,container_kind,runtime_key,runtime_installation,vendor_session_id,status,created_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,'managed',$4,$5,'conversation','claude_code','managed:1.0.0','vendor-before-reset','active',$6,now(),now())`,[thread,space,host,session,agent,owner]);
 // A Run of that conversation consumed the Artifact being demoted.
 const source=await sourceArtifact(),run=await consumingRun({type:'artifact',id:source},owner,'ROOM INSTRUCTION');
 await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1',[run,session]);
 const confirmation=await disclose('artifact',source);
 expect(title(await readBack('artifact',source,confirmation),run)).toBe('ROOM INSTRUCTION');

 const holder=await db.pool.connect();
 try{
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // The real reset takes the Room, then waits here on the owner's Room membership row, before its thread and conversation locks.
  await holder.query('SELECT id FROM room_user_members WHERE room_id=$1 AND user_id=$2 FOR UPDATE',[room,owner]);
  let resetDone=false;const resetting=new RoomRosterService(db.pool).resetAgentContext(as(owner),room,agent,session).finally(()=>{resetDone=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>resetDone});
  expect(resetDone,'the reset holds the Room and waits on the membership row').toBe(false);
  // The readback runs into the reset's Room lock. Taking the conversation first would leave it holding what the reset needs next.
  let readDone=false;const reading=readBack('artifact',source,confirmation).finally(()=>{readDone=true;});
  await waitForLockWaiter(db.pool,{waiters:2,settled:()=>readDone});
  expect(readDone,'the readback waits on the reset').toBe(false);
  await holder.query('ROLLBACK');
  const [reset,read]=await Promise.allSettled([resetting,reading]);
  expect(reset.status,reset.status==='rejected'?String(reset.reason):'').toBe('fulfilled');
  expect(read.status,read.status==='rejected'?String((read.reason as Error).message):'').toBe('fulfilled');
  // The reset contract is unchanged: the targeted thread is reset and the conversation records it.
  expect((await db.pool.query('SELECT status,vendor_session_id FROM host_threads WHERE id=$1',[thread])).rows[0]).toEqual({status:'session_reset',vendor_session_id:null});
  expect((await db.pool.query("SELECT content FROM messages WHERE session_id=$1 AND role='system'",[session])).rows.map(r=>r.content)).toEqual(["Host Agent's context was reset"]);
  // The readback, serialized after the reset, still releases the Run title through the unchanged Room audience.
  expect(title((read as PromiseFulfilledResult<{exposure:Exposure}>).value,run)).toBe('ROOM INSTRUCTION');
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();}
});

it('a disclosure and "Continue anyway" on a conversation whose consuming Run is held for quota recovery both complete: both take the Room before the Run',async()=>{
 // The owner's Room conversation and the server host's managed thread a quota-interrupted Run ran on.
 const room=(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE space_id=$1 AND project_id=$2 AND is_mainline',[space,project])).rows[0]!.id;
 const session=randomUUID(),host=randomUUID(),thread=randomUUID(),task=randomUUID();
 await seedServerHost(db.pool,{id:host});
 await db.pool.query("INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Room talk','active',now(),now())",[session,space,room,project]);
 await db.pool.query("INSERT INTO tasks(id,space_id,project_id,title,status,owner_user_id,visibility,created_at,updated_at) VALUES($1,$2,$3,'Continue work','in_progress',$4,'space_shared',now(),now())",[task,space,project,owner]);
 // A Run whose accepted Invocation Snapshot consumed the Artifact being demoted.
 const source=await sourceArtifact(),run=await consumingRun({type:'artifact',id:source},owner,'ROOM INSTRUCTION');
 const agent=(await db.pool.query<{agent_id:string}>('SELECT agent_id FROM runs WHERE id=$1',[run])).rows[0]!.agent_id;
 await db.pool.query(`INSERT INTO host_threads(id,space_id,execution_host_id,workspace_mode,session_id,agent_id,container_kind,runtime_key,runtime_installation,dispatch_lock_id,created_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,'managed',$4,$5,'conversation','claude_code','managed:1.0.0',$6,$7,now(),now())`,[thread,space,host,session,agent,run,owner]);
 await db.pool.query("UPDATE agent_runtime_profiles SET runtime_key='claude_code',backend_mode='runtime_native',model_provider_id=NULL WHERE agent_id=$1",[agent]);
 // The Run's attempt is refused by the subscription quota; the real supervisor requeues the same Run and holds it for recovery.
 const reset=Math.floor((Date.now()+3600_000)/1000);
 await db.pool.query(`UPDATE runs SET status='failed',runtime_key='claude_code',model_provider_id=NULL,project_id=$2,session_id=$3,host_task_thread_id=$4,
   runtime_profile_snapshot_json=runtime_profile_snapshot_json||'{"runtime_key":"claude_code","backend_mode":"runtime_native","model_provider_id":null}'::jsonb,
   contract_snapshot_json=$5::jsonb,error_json=$6::jsonb,error_message=$7,started_at=now(),ended_at=now() WHERE id=$1`,
  [run,project,session,thread,JSON.stringify({source:{kind:'task',id:task},max_attempts:2}),JSON.stringify({error_code:SUBSCRIPTION_QUOTA_EXHAUSTED}),`Claude AI usage limit reached|${reset}`]);
 await db.pool.query("INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,error_code,started_at,ended_at,created_at,updated_at) VALUES($1,$2,$3,1,'failed',$4,now(),now(),now(),now())",[randomUUID(),space,run,SUBSCRIPTION_QUOTA_EXHAUSTED]);
 const runs=new PgRunRepository(db.pool);
 await new PgRunSupervisor(db.pool).supervise({run:(await runs.getRun(space,run))!,attempt_number:1,evaluation:{outcome_status:'failed',failure_reason_code:SUBSCRIPTION_QUOTA_EXHAUSTED}});
 const state=async()=>({
  run:(await db.pool.query("SELECT status,output_json->'waiting_for_quota' AS marker FROM runs WHERE id=$1",[run])).rows[0],
  snapshots:Number((await db.pool.query("SELECT count(*) AS n FROM invocation_snapshots WHERE invocation_id=$1 AND status='accepted'",[run])).rows[0].n),
  jobs:Number((await db.pool.query("SELECT count(*) AS n FROM jobs WHERE job_type='agent_run' AND payload_json->>'run_id'=$1",[run])).rows[0].n),
  notices:(await db.pool.query("SELECT role,content FROM messages WHERE session_id=$1 ORDER BY created_at,id",[session])).rows,
  claim:(await db.pool.query('SELECT dispatch_lock_id FROM host_threads WHERE id=$1',[thread])).rows[0].dispatch_lock_id,
 });
 const held=await state();
 expect(held.run).toMatchObject({status:'queued',marker:{recovery:{auto_continue:true}}});
 expect(held.snapshots,'the requeue reuses the Run and keeps its accepted Invocation Snapshot').toBe(1);
 expect(held.jobs,'a recovery hold waits for its scheduler, not a job').toBe(0);

 const app=buildModuleServer(config(),[roomsModule]);
 const holder=await db.pool.connect();
 try{
  __setAuthIdentityForTests(as(owner));
  await holder.query('BEGIN');const pid=Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  // A Run status writer is mid-update on the held Run.
  await holder.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[run]);
  let discloseDone=false;const disclosing=disclose('artifact',source).finally(()=>{discloseDone=true;});
  await waitForBlockedBy(db.pool,pid,{settled:()=>discloseDone});
  expect(discloseDone,'the disclosure waits on the Run').toBe(false);
  // "Continue anyway" takes the Room, then every held Run of the conversation FOR UPDATE, recovery holds included.
  let continueDone=false;const continuing=app.inject({method:'POST',url:`/api/v1/rooms/${room}/conversations/${session}/quota/continue`,payload:{},headers:{'idempotency-key':randomUUID()}}).finally(()=>{continueDone=true;});
  await waitForLockWaiter(db.pool,{waiters:2,settled:()=>continueDone});
  expect(continueDone,'Continue anyway waits behind the disclosure').toBe(false);
  await holder.query('ROLLBACK');
  const [disclosed,continued]=await Promise.allSettled([disclosing,continuing]);
  expect(disclosed.status,disclosed.status==='rejected'?String((disclosed.reason as Error).message):'').toBe('fulfilled');
  expect(continued.status).toBe('fulfilled');
  const response=(continued as PromiseFulfilledResult<{statusCode:number;body:string}>).value;
  expect(response.statusCode,response.body).toBe(200);
  // The disclosure names the held Run; its readback still releases the title.
  const confirmation=(disclosed as PromiseFulfilledResult<string>).value;
  expect(title(await readBack('artifact',source,confirmation),run)).toBe('ROOM INSTRUCTION');
  // Continue anyway leaves a recovery hold to its own scheduler: marker, snapshot, job, notices and Host claim unchanged.
  expect(await state()).toEqual(held);
 }finally{await holder.query('ROLLBACK').catch(()=>{});holder.release();__setAuthIdentityForTests(null);await app.close();}
});
