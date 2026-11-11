import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {withTransaction} from '../src/db/tx.js';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedSpaceOwnerProject,seedSpaceMember} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {providerTaskRunPreparers} from '../src/modules/runs/providerTaskRunHandler.js';
import {PUBLIC_SUMMARY_DRAFT_CAPABILITY,registerPublicSummaryDraftRuns} from '../src/modules/projects/publicSummaryDraftOperation.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {RoomRosterService} from '../src/modules/rooms/rosterService.js';
import {PgRoomRosterRepository} from '../src/modules/rooms/rosterRepository.js';
import {seedRun} from './support/domainSeeds.js';
import {InquiryThreadService} from '../src/modules/inquiry/threadService.js';
import {createResearchWorkflow} from '../src/modules/projectResearch/workflowOntology.js';
import {createBoundResearchOperation} from '../src/modules/projectResearch/researchProblemCalls.js';
import {seedRelevantCorpusItem} from './support/researchSeeds.js';
import {openSubscriptionWindow} from '../src/modules/sources/channels/subscriptionWindows.js';

// Draft generation is admitted by the core and performed by the provider_task
// worker: the request commits a private queued Run and its Job, never a provider call.
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,project:string,app:ReturnType<typeof buildModuleServer>,config:ReturnType<typeof loadConfig>;
const draft=(payload:object,key=randomUUID())=>app.inject({method:'POST',url:`/api/v1/projects/${project}/public-summary/draft`,payload,headers:{'idempotency-key':key}});
beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team',projectName:'Aster'});
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,RAINVER_HOME:'/tmp/rainver-p5-tests'});
 app=buildModuleServer(config,[projectsModule,systemActionsModule]);__setAuthIdentityForTests({spaceId:space,userId:owner});
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});

it('commits one private queued Run and Job per key, and the worker writes the draft with server-authored provenance',async()=>{
 const key=randomUUID(),first=await draft({model_provider_id:'provider-1'},key);
 expect(first.statusCode,first.body).toBe(202);
 const receipt=first.json().data;expect(receipt).toMatchObject({project_id:project,space_id:space,id:receipt.run_id});
 expect((await draft({model_provider_id:'provider-1'},key)).json()).toEqual(first.json());
 expect((await draft({model_provider_id:'provider-2'},key)).statusCode).toBe(422);
 const runs=(await db.pool.query("SELECT id,status,visibility,capability_id,instruction FROM runs WHERE space_id=$1",[space])).rows;
 expect(runs).toEqual([expect.objectContaining({id:receipt.run_id,status:'queued',visibility:'private',capability_id:PUBLIC_SUMMARY_DRAFT_CAPABILITY})]);
 expect(runs[0].instruction).toContain('Aster');
 expect((await db.pool.query("SELECT job_type FROM jobs WHERE id=$1 AND payload_json->>'run_id'=$2",[receipt.job_id,receipt.run_id])).rows).toEqual([{job_type:'provider_task_run'}]);
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);

 const request=await workerRequest(receipt.run_id);
 expect(request).toMatchObject({providerId:'provider-1',completion:'text',spend:{kind:'person',user_id:owner}});
 await startRun(receipt.run_id);
 await request.finalize!({text:JSON.stringify({summary_text:'Aster explores safe project discovery.',topics:['discovery'],highlights:[],source_refs:[{source_type:'project',source_id:project,label:'Aster'},{source_type:'memory',source_id:'hallucinated'}]}),output:null,providerId:'provider-1',model:'m'},receipt.run_id);
 const saved=(await db.pool.query('SELECT summary_text,generated_by_run_id,source_refs_json,draft_version FROM project_public_summaries WHERE project_id=$1',[project])).rows[0];
 expect(saved).toMatchObject({summary_text:'Aster explores safe project discovery.',generated_by_run_id:receipt.run_id,draft_version:1});
 expect(JSON.stringify(saved.source_refs_json)).not.toContain('hallucinated');
 // The draft and the Run's success committed together.
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows[0].status).toBe('succeeded');
 // A job retry after that commit (worker crashed before reporting) cannot publish over a person's edit.
 await db.pool.query("UPDATE project_public_summaries SET summary_text='Edited by a person' WHERE project_id=$1",[project]);
 await request.finalize!(completion('A second model reply.'),receipt.run_id);
 expect((await db.pool.query('SELECT summary_text,draft_version FROM project_public_summaries WHERE project_id=$1',[project])).rows[0]).toEqual({summary_text:'Edited by a person',draft_version:1});
});

const completion=(summary_text:string)=>({text:JSON.stringify({summary_text,topics:[],highlights:[],source_refs:[{source_type:'project',source_id:project}]}),output:null,providerId:'provider-1',model:'m'});
async function workerRequest(runId:string){
 registerPublicSummaryDraftRuns(config);
 const run=(await new PgRunRepository(db.pool).getRun(space,runId))!;
 return providerTaskRunPreparers.get(PUBLIC_SUMMARY_DRAFT_CAPABILITY)!({db:db.pool,config,run,job:{} as never});
}
async function startRun(runId:string){
 const provider=randomUUID();
 await db.pool.query(`INSERT INTO model_providers (id,space_id,owner_user_id,name,provider_type,default_model,enabled,capabilities_json,config_json,created_at,updated_at)
  VALUES ($1,$2,$3,'Draft provider','openai','m',true,'{}'::jsonb,'{}'::jsonb,now(),now())`,[provider,space,owner]);
 expect(await new PgRunRepository(db.pool).startQueuedProviderTaskRun({run_id:runId,space_id:space,provider_id:provider,control_id:randomUUID(),delivery_id:randomUUID(),invocation_snapshot_id:randomUUID()})).toBe(true);
}
const attempt=(request:Awaited<ReturnType<typeof workerRequest>>)=>withTransaction(db.pool,client=>request.authorizeAttempt!(client,{} as never));

it('re-checks the whole frozen source closure without oversight before each provider attempt and before publishing',async()=>{
 const peer=randomUUID(),memory=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query(`INSERT INTO memory_entries (id,space_id,project_id,scope_type,memory_type,status,visibility,access_level,sensitivity_level,confidence,importance,version,access_count,title,content,owner_user_id,created_at,updated_at)
  VALUES ($1,$2,$3,'project','fact','active','space_shared','full','normal',1,0.9,1,0,'Peer finding','PEER_SHARED_FINDING',$4,now(),now())`,[memory,space,project,peer]);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 const run=(await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0];
 expect(run.instruction).toContain('PEER_SHARED_FINDING');
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 // The peer takes the Memory private: the owner (a Space owner with oversight) no longer reaches it as content.
 await db.pool.query("UPDATE memory_entries SET visibility='private' WHERE id=$1",[memory]);
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
 // A reply that already came back is not published either, and the Run is not marked succeeded.
 await startRun(receipt.run_id);
 await expect(request.finalize!(completion('Leaked'),receipt.run_id)).rejects.toMatchObject({code:'public_summary_draft_rejected'});
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows[0].status).toBe('running');
});

it('publishes nothing for a cancelled Run and rolls the draft back when the Run terminal write fails',async()=>{
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 // The person cancels the queued Job; its Run ends cancelled through the queue's own path.
 expect(await new PgJobQueueRepository(db.pool).cancelJob(receipt.job_id,null,new Date(),['pending'])).toBe(true);
 await request.finalize!(completion('Too late'),receipt.run_id);
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
 const second=(await draft({model_provider_id:'provider-1'})).json().data,retry=await workerRequest(second.run_id);
 await startRun(second.run_id);
 const terminal=vi.spyOn(PgRunRepository.prototype,'markRunTerminal').mockRejectedValueOnce(new Error('terminal write lost'));
 try{await expect(retry.finalize!(completion('Half committed'),second.run_id)).rejects.toThrow('terminal write lost');}finally{terminal.mockRestore();}
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[second.run_id])).rows[0].status).toBe('running');
});

it('refuses viewers and archived Projects and caches a missing provider binding as invalid input',async()=>{
 const missing=randomUUID(),refused=await draft({},missing);
 expect(refused.statusCode,refused.body).toBe(422);expect(refused.body).not.toContain('task policy');
 expect((await draft({},missing)).json().error.code).toBe('operation_invalid_input');
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});__setAuthIdentityForTests({spaceId:space,userId:peer});
 expect((await draft({model_provider_id:'provider-1'})).statusCode).toBe(404);
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
 expect((await draft({model_provider_id:'provider-1'})).statusCode).toBe(409);
 expect((await db.pool.query('SELECT id FROM runs WHERE space_id=$1',[space])).rows).toEqual([]);
});

// --- Frozen closure under concurrent revocation, and the level each frozen body needs.

async function seedPeerActivity(peer:string,content:string,visibility='space_shared',access_level='full'){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO activity_records (id,space_id,project_id,user_id,owner_user_id,activity_type,title,content,payload_json,status,visibility,access_level,occurred_at,created_at,updated_at)
  VALUES ($1,$2,$3,$4,$4,'note','Peer note',$5,'{}'::jsonb,'raw',$6,$7,now(),now(),now())`,[id,space,project,peer,content,visibility,access_level]);
 return id;
}
async function seedPeerProposal(peer:string,rationale:string){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO proposals (id,space_id,project_id,proposal_type,status,payload_json,created_by_user_id,owner_user_id,title,rationale,risk_level,urgency,visibility,access_level,created_at,updated_at)
  VALUES ($1,$2,$3,'memory_update','pending','{}'::jsonb,$4,$4,'Peer proposal',$5,'medium','normal','space_shared','full',now(),now())`,[id,space,project,peer,rationale]);
 return id;
}
const policy=(peer:string,resourceType:string,id:string,update:Record<string,unknown>)=>new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:peer},resourceType,id,{project_id:project,grants:[],...update} as never);
/** Holds the canonical policy writer inside its transaction, after it has locked the resource row. */
function holdPolicyWriter(){
 let entered!:()=>void,release!:()=>void;
 const inside=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
 type Members={assertActiveMembers:(...a:unknown[])=>Promise<void>};
 const target=ContentAccessService.prototype as unknown as Members,original=target.assertActiveMembers;
 const spy=vi.spyOn(target,'assertActiveMembers').mockImplementation(async function(this:unknown,...a:unknown[]){await original.apply(this,a);entered();await released;});
 return {inside,release,restore:()=>spy.mockRestore()};
}
/** Resolves once some backend in this database is waiting on a row lock. */
async function someoneWaitsOnALock(){
 for(let i=0;i<200;i++){
  if((await db.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows.length)return;
  await new Promise(r=>setTimeout(r,10));
 }
 throw new Error('no backend ever waited on a lock');
}
const settled=<T,>(p:Promise<T>)=>p.then(v=>({ok:true as const,v}),(e:unknown)=>({ok:false as const,e}));

it('waits for a grant revocation already inside its transaction and then refuses the attempt and the publication',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const activity=await seedPeerActivity(peer,'PEER_SELECTED_BODY','selected_users');
 await policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:owner,access_level:'full'}]});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain('PEER_SELECTED_BODY');
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 // The peer narrows the grant list to someone else; the writer is held after
 // its resource lock, before its grant writes commit.
 const other=randomUUID();await seedSpaceMember(db.pool,{space,user:other});
 const hold=holdPolicyWriter();
 try{
  const revoking=settled(policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:other,access_level:'full'}]}));
  await hold.inside;
  const attempting=settled(attempt(request));
  try{await someoneWaitsOnALock();}finally{hold.release();}
  expect((await revoking).ok).toBe(true);
  expect(await attempting).toMatchObject({ok:false,e:{statusCode:403}});
 }finally{hold.restore();}
 // A reply already in flight is not published either, through the same wait.
 await policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:owner,access_level:'full'}]});
 await startRun(receipt.run_id);
 const again=holdPolicyWriter();
 try{
  const revoking=settled(policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:other,access_level:'full'}]}));
  await again.inside;
  const publishing=settled(request.finalize!(completion('Late leak'),receipt.run_id));
  try{await someoneWaitsOnALock();}finally{again.release();}
  expect((await revoking).ok).toBe(true);
  expect(await publishing).toMatchObject({ok:false,e:{code:'public_summary_draft_rejected'}});
 }finally{again.restore();}
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
 expect((await db.pool.query('SELECT status FROM runs WHERE id=$1',[receipt.run_id])).rows[0].status).toBe('running');
});

it('makes a revocation wait until a checked attempt has committed, and refuses the next attempt',async()=>{
 const peer=randomUUID(),other=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await seedSpaceMember(db.pool,{space,user:other});
 const activity=await seedPeerActivity(peer,'PEER_SELECTED_BODY','selected_users');
 await policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:owner,access_level:'full'}]});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 let checked!:()=>void,commit!:()=>void;
 const afterCheck=new Promise<void>(r=>{checked=r;}),mayCommit=new Promise<void>(r=>{commit=r;});
 // The attempt has re-checked its closure and is about to commit.
 const attempting=settled(withTransaction(db.pool,async client=>{await request.authorizeAttempt!(client,{} as never);checked();await mayCommit;}));
 await afterCheck;
 const revoking=settled(policy(peer,'activity',activity,{visibility:'selected_users',access_level:'full',grants:[{user_id:other,access_level:'full'}]}));
 try{
  await someoneWaitsOnALock();
  const grantStillActive=(await db.pool.query("SELECT 1 FROM content_access_grants WHERE resource_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL",[activity,owner])).rows.length;
  expect(grantStillActive).toBe(1);
 }finally{commit();}
 expect((await attempting).ok).toBe(true);
 expect((await revoking).ok).toBe(true);
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
});

it.each([
 ['Activity excerpt','activity','PEER_ACTIVITY_BODY'],
 ['Proposal rationale','proposal','PEER_PROPOSAL_RATIONALE'],
] as const)('refuses a frozen %s once its owner narrows it from full to summary through the content access policy',async(_label,type,body)=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const id=type==='activity'?await seedPeerActivity(peer,body):await seedPeerProposal(peer,body);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain(body);
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 await policy(peer,type,id,{visibility:'space_shared',access_level:'summary'});
 // Still readable as a summary, but the frozen body is no longer the person's to send.
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403,message:expect.stringContaining('in full')});
 await startRun(receipt.run_id);
 await expect(request.finalize!(completion('Narrowed'),receipt.run_id)).rejects.toMatchObject({code:'public_summary_draft_rejected'});
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
});

it('admits a summary-level Activity and Proposal by title only, and keeps admitting them while they stay summary',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const activity=await seedPeerActivity(peer,'SUMMARY_ONLY_ACTIVITY_BODY','space_shared','summary');
 const proposal=await seedPeerProposal(peer,'SUMMARY_ONLY_RATIONALE');
 await policy(peer,'proposal',proposal,{visibility:'space_shared',access_level:'summary'});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 const instruction=(await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction as string;
 expect(instruction).toContain(`activity:${activity}`);expect(instruction).toContain(`proposal:${proposal}`);
 expect(instruction).not.toContain('SUMMARY_ONLY_ACTIVITY_BODY');expect(instruction).not.toContain('SUMMARY_ONLY_RATIONALE');
 await expect(attempt(await workerRequest(receipt.run_id))).resolves.toBeUndefined();
});

it('waits for a Room removal already inside its roster transaction and then refuses a frozen Room-run Proposal',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
 // A limited Room the peer owns and the person belongs to; a Run in it created the Proposal.
 const room=randomUUID(),session=randomUUID(),run=randomUUID();
 await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Side room','active',now(),now(),false)`,[room,space,project,peer]);
 await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',now(),now()),($5,$2,$3,$6,'member','active',now(),now())`,[randomUUID(),space,room,peer,randomUUID(),owner]);
 await db.pool.query("INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Room conversation','active',now(),now())",[session,space,room,project]);
 await seedRun(db.pool,{id:run,space,owner:peer,agent:randomUUID(),version:randomUUID()});
 await db.pool.query('UPDATE runs SET session_id=$2,project_id=$3 WHERE id=$1',[run,session,project]);
 const proposal=await seedPeerProposal(peer,'ROOM_RUN_RATIONALE');
 await db.pool.query('UPDATE proposals SET created_by_run_id=$2 WHERE id=$1',[proposal,run]);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain('ROOM_RUN_RATIONALE');
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 let entered!:()=>void,release!:()=>void;
 const inside=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
 const original=PgRoomRosterRepository.prototype.revokeUserGrants;
 const spy=vi.spyOn(PgRoomRosterRepository.prototype,'revokeUserGrants').mockImplementation(async function(this:PgRoomRosterRepository,...a){const out=await original.apply(this,a);entered();await released;return out;});
 try{
  const removing=settled(new RoomRosterService(db.pool).removeUser({spaceId:space,userId:peer},room,owner));
  await Promise.race([inside,removing.then(r=>{throw new Error(`removal ended before its hold: ${JSON.stringify(r)} ${String((r as {e?:unknown}).e)}`);})]);
  const attempting=settled(attempt(request));
  try{await someoneWaitsOnALock();}finally{release();}
  expect(await removing).toMatchObject({ok:true});
  expect(await attempting).toMatchObject({ok:false,e:{statusCode:403}});
 }finally{spy.mockRestore();}
});

// --- Research-call output Artifacts: admitted while the person still reads,
// in full, every Source the research read; the whole chain is locked and re-read.

/**
 * A bound research Operation in `projectId` whose output Artifact (titled
 * `title`) read one peer-owned Source item: a loose one by default, or the
 * given item of a real Source chain with the channels it read.
 */
async function seedResearchArtifact(peer:string,title:string,options:{projectId?:string;item?:string;channelIds?:string[];originRunId?:string}={}){
 const projectId=options.projectId??project,identity={spaceId:space,userId:owner};
 const thread=String((await new InquiryThreadService(db.pool).createThread(identity,projectId,{kind:'question',statement:`What changed in ${title}?`})).id);
 const workflow=randomUUID();
 await createResearchWorkflow(db.pool,{id:workflow,spaceId:space,projectId,title:'Evidence workflow',status:'active',state:{},startedByUserId:owner,primaryThreadId:thread,now:new Date().toISOString()});
 const operation=await createBoundResearchOperation(db.pool,identity,projectId,{title:'Bound evidence call',intentText:'Find the cause',status:'active',steps:[],progress:{schema_version:'project_research_operation.v1',workflow_id:workflow,thread_scope:[{thread_id:thread,version:1,kind:'question',statement:`What changed in ${title}?`}],idempotency:{key:randomUUID(),fingerprint:'f'},history:{max_items:20},channel_ids:options.channelIds??[]}});
 const item=options.item??(await seedRelevantCorpusItem(db.pool,{space,project:projectId,owner:peer})).sourceItemId;
 const artifact=randomUUID();
 await db.pool.query(`INSERT INTO artifacts(id,space_id,project_id,owner_user_id,artifact_type,title,content,canonical_format,mime_type,export_formats_json,created_at,updated_at)
  VALUES($1,$2,$3,$4,'research_report',$5,'RESEARCH_BODY_NEVER_IN_PROMPT','markdown','text/markdown','[]',now(),now())`,[artifact,space,projectId,owner,title]);
 await db.pool.query(`UPDATE project_operations SET progress_json=progress_json||jsonb_build_object('artifact_ids',jsonb_build_array($2::text),'source_item_ids',jsonb_build_array($3::text)) WHERE id=$1`,[operation.id,artifact,item]);
 if(options.originRunId)await db.pool.query(`UPDATE project_operations SET research_call_json=jsonb_set(research_call_json,'{requested_by_run_id}',to_jsonb($2::text)) WHERE id=$1`,[operation.id,options.originRunId]);
 return {artifact,item,operation:operation.id,thread};
}
/**
 * A real Source chain owned by `peer` and scoped to `projectId`: provider
 * connector → connection → channel, the person's and the peer's subscriptions
 * and windows, and one item delivered inside them. Shared with the person by
 * grant, so the peer can take it back without a demotion.
 */
async function seedSourceChain(peer:string,projectId:string){
 const connector=randomUUID(),mapping=randomUUID(),connection=randomUUID(),channel=randomUUID(),item=randomUUID(),key=`feed-${connector.slice(0,8)}`;
 await db.pool.query(`INSERT INTO source_connectors (id,connector_key,display_name,connector_type,ingestion_mode,status,capabilities_json,created_at,updated_at) VALUES ($1,$2,'Feed','external_feed','pull','active','{}'::jsonb,now(),now())`,[connector,key]);
 await db.pool.query(`INSERT INTO source_providers (id,provider_key,display_name,provider_kind,category,status,capabilities_json,created_at,updated_at) VALUES ($1,$2,'Feed','named','general','active','{}'::jsonb,now(),now())`,[connector,key]);
 await db.pool.query(`INSERT INTO source_provider_connectors (id,provider_id,connector_id,status,priority,capabilities_json,created_at,updated_at) VALUES ($1,$2,$2,'active',0,'{}'::jsonb,now(),now())`,[mapping,connector]);
 await db.pool.query(`INSERT INTO source_connections (id,space_id,project_id,provider_connector_id,owner_user_id,name,status,visibility,access_level,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
  VALUES ($1,$2,$3,$4,$5,'Peer feed','active','selected_users','full','reference_only','normal','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,now(),now())`,[connection,space,projectId,mapping,peer]);
 await db.pool.query(`INSERT INTO source_channels (id,space_id,source_connection_id,created_by_user_id,name,channel_type,endpoint_url,query_json,provider_query_json,query_fingerprint,status,fetch_frequency,schedule_rule_json,created_at,updated_at)
  VALUES ($1,$2,$3,$4,'Peer channel','feed','https://example.com/rss','{}'::jsonb,'{}'::jsonb,$1,'active','daily','{"frequency":"daily","hour":0,"minute":0}'::jsonb,now(),now())`,[channel,space,connection,peer]);
 const subscribedAt=new Date(Date.now()-86_400_000).toISOString();
 for(const user of [peer,owner]){
  await db.pool.query(`INSERT INTO source_channel_user_subscriptions (id,space_id,source_channel_id,user_id,status,library_enabled,digest_enabled,created_at,updated_at) VALUES ($1,$2,$3,$4,'subscribed',true,true,$5,$5)`,[randomUUID(),space,channel,user,subscribedAt]);
  await openSubscriptionWindow(db.pool,{spaceId:space,channelId:channel,userId:user,at:subscribedAt});
 }
 await db.pool.query(`INSERT INTO source_items (id,space_id,owner_user_id,visibility,connection_id,item_type,title,excerpt,source_uri,first_seen_at,last_seen_at,content_state,retention_policy,created_at,updated_at)
  VALUES ($1,$2,$3,'space_shared',$4,'feed_entry','Delivered entry','Delivered evidence.',$5,now()-interval '1 hour',now(),'excerpt_saved','summary_only',now(),now())`,[item,space,peer,connection,`https://example.com/${item}`]);
 const share=(grantee:string)=>new ContentAccessService(db.pool).updatePolicy({spaceId:space,userId:peer},'source_connection',connection,{project_id:projectId,visibility:'selected_users',access_level:'full',grants:[{user_id:grantee,access_level:'full'}]} as never);
 await share(owner);
 return {connection,channel,item,share};
}
async function seedProject(name:string){
 const id=randomUUID();
 await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`,[id,space,owner,name]);
 return id;
}
const draftFor=(projectId:string)=>app.inject({method:'POST',url:`/api/v1/projects/${projectId}/public-summary/draft`,payload:{model_provider_id:'provider-1'},headers:{'idempotency-key':randomUUID()}});
/** Resolves once at least `count` backends in this database wait on a lock. */
async function lockWaiters(count:number){
 for(let i=0;i<300;i++){
  if(Number((await db.pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n)>=count)return;
  await new Promise(r=>setTimeout(r,10));
 }
 throw new Error(`fewer than ${count} backends ever waited on a lock`);
}
/** A transaction holding the Space row exclusively until released: every attempt stalls at its share lock of it. */
async function holdSpace(){
 let release!:()=>void,locked!:()=>void;const released=new Promise<void>(r=>{release=r;}),isLocked=new Promise<void>(r=>{locked=r;});
 const held=withTransaction(db.pool,async client=>{await client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE',[space]);locked();await released;});
 await isLocked;
 return {release,held};
}
const narrowItem=(peer:string,item:string,update:Record<string,unknown>)=>policy(peer,'source_item',item,{project_id:null,visibility:'space_shared',access_level:'full',...update});
/** The researched Source shared with the person by grant, so the peer can revoke it without a demotion. */
async function shareItemWithOwner(peer:string,item:string){
 await db.pool.query("UPDATE source_items SET visibility='selected_users' WHERE id=$1",[item]);
 await narrowItem(peer,item,{visibility:'selected_users',grants:[{user_id:owner,access_level:'full'}]});
}

it('admits a readable research-call Artifact by title and refuses it once a researched Source narrows from full to summary',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const research=await seedResearchArtifact(peer,'RESEARCH_SYNTHESIS_TITLE');
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 const instruction=(await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction as string;
 expect(instruction).toContain(`artifact:${research.artifact}`);expect(instruction).toContain('RESEARCH_SYNTHESIS_TITLE');
 expect(instruction).not.toContain('RESEARCH_BODY_NEVER_IN_PROMPT');
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 // The Source is still listed to the person, but no longer in full: the research
 // Artifact built on it stops being theirs to cite.
 await narrowItem(peer,research.item,{access_level:'summary'});
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
 await startRun(receipt.run_id);
 await expect(request.finalize!(completion('Narrowed research'),receipt.run_id)).rejects.toMatchObject({code:'public_summary_draft_rejected'});
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
 // And a fresh draft no longer admits it at all.
 const next=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[next.run_id])).rows[0].instruction).not.toContain(research.artifact);
});

it('waits for a researched Source revocation inside its transaction, then refuses the attempt and the publication',async()=>{
 const peer=randomUUID(),other=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await seedSpaceMember(db.pool,{space,user:other});
 const research=await seedResearchArtifact(peer,'Research synthesis');await shareItemWithOwner(peer,research.item);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 const revoke=()=>narrowItem(peer,research.item,{visibility:'selected_users',grants:[{user_id:other,access_level:'full'}]});
 const hold=holdPolicyWriter();
 try{
  const revoking=settled(revoke());
  await hold.inside;
  const attempting=settled(attempt(request));
  try{await someoneWaitsOnALock();}finally{hold.release();}
  expect((await revoking).ok).toBe(true);
  expect(await attempting).toMatchObject({ok:false,e:{statusCode:403}});
 }finally{hold.restore();}
 // Restore, then race the publication the same way.
 await narrowItem(peer,research.item,{visibility:'selected_users',grants:[{user_id:owner,access_level:'full'}]});
 await expect(attempt(request)).resolves.toBeUndefined();
 await startRun(receipt.run_id);
 const again=holdPolicyWriter();
 try{
  const revoking=settled(revoke());
  await again.inside;
  const publishing=settled(request.finalize!(completion('Late research leak'),receipt.run_id));
  try{await someoneWaitsOnALock();}finally{again.release();}
  expect((await revoking).ok).toBe(true);
  expect(await publishing).toMatchObject({ok:false,e:{code:'public_summary_draft_rejected'}});
 }finally{again.restore();}
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
});

it('makes a researched Source revocation wait for a checked attempt to commit, and refuses the next attempt',async()=>{
 const peer=randomUUID(),other=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});await seedSpaceMember(db.pool,{space,user:other});
 const research=await seedResearchArtifact(peer,'Research synthesis');await shareItemWithOwner(peer,research.item);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 let checked!:()=>void,commit!:()=>void;
 const afterCheck=new Promise<void>(r=>{checked=r;}),mayCommit=new Promise<void>(r=>{commit=r;});
 const attempting=settled(withTransaction(db.pool,async client=>{await request.authorizeAttempt!(client,{} as never);checked();await mayCommit;}));
 await afterCheck;
 const revoking=settled(narrowItem(peer,research.item,{visibility:'selected_users',grants:[{user_id:other,access_level:'full'}]}));
 try{
  await someoneWaitsOnALock();
  expect((await db.pool.query("SELECT 1 FROM content_access_grants WHERE resource_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL",[research.item,owner])).rows.length).toBe(1);
 }finally{commit();}
 expect((await attempting).ok).toBe(true);
 expect((await revoking).ok).toBe(true);
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
});

it('refuses with a rebuild conflict when the research closure grows while the attempt waits for it',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const research=await seedResearchArtifact(peer,'Research synthesis');
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 const extra=(await seedRelevantCorpusItem(db.pool,{space,project,owner:peer})).sourceItemId;
 // A research writer holds the Operation and adds a Source the closure never locked.
 let release!:()=>void;const released=new Promise<void>(r=>{release=r;});let locked!:()=>void;const isLocked=new Promise<void>(r=>{locked=r;});
 const growing=settled(withTransaction(db.pool,async client=>{
  await client.query('SELECT id FROM project_operations WHERE id=$1 FOR UPDATE',[research.operation]);
  await client.query(`UPDATE project_operations SET progress_json=jsonb_set(progress_json,'{source_item_ids}',(progress_json->'source_item_ids')||jsonb_build_array($2::text)) WHERE id=$1`,[research.operation,extra]);
  locked();await released;
 }));
 await isLocked;
 const attempting=settled(attempt(request));
 try{await someoneWaitsOnALock();}finally{release();}
 expect((await growing).ok).toBe(true);
 expect(await attempting).toMatchObject({ok:false,e:{statusCode:409,message:expect.stringContaining('request a new draft')}});
 // Once settled, the grown closure is locked and checked like any other.
 await expect(attempt(request)).resolves.toBeUndefined();
});

it('keeps checking a research Artifact frozen by an older Run that recorded no source levels',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const research=await seedResearchArtifact(peer,'Research synthesis');
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,public_summary_draft,sourceAccess}' WHERE id=$1`,[receipt.run_id]);
 const legacy=(await db.pool.query('SELECT contract_snapshot_json FROM runs WHERE id=$1',[receipt.run_id])).rows[0].contract_snapshot_json;
 expect(legacy.workflow_input_json.public_summary_draft.sourceAccess).toBeUndefined();
 expect(JSON.stringify(legacy.workflow_input_json.public_summary_draft.allowedSourceRefs)).toContain(research.artifact);
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 await narrowItem(peer,research.item,{access_level:'summary'});
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
});

// --- Two Projects whose research read each other's Sources, through real
// connection → channel → subscription → window → item chains.

async function crossProjectDrafts(){
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const other=await seedProject('Beacon');
 const sourceA=await seedSourceChain(peer,project),sourceB=await seedSourceChain(peer,other);
 // A's research read B's Source, and B's research read A's Source.
 const researchA=await seedResearchArtifact(peer,'A_READS_B_TITLE',{item:sourceB.item,channelIds:[sourceB.channel]});
 const researchB=await seedResearchArtifact(peer,'B_READS_A_TITLE',{projectId:other,item:sourceA.item,channelIds:[sourceA.channel]});
 const receiptA=(await draftFor(project)).json().data,receiptB=(await draftFor(other)).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receiptA.run_id])).rows[0].instruction).toContain(`artifact:${researchA.artifact}`);
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receiptB.run_id])).rows[0].instruction).toContain(`artifact:${researchB.artifact}`);
 return {peer,other,sourceA,sourceB,researchA,researchB,receiptA,receiptB,requestA:await workerRequest(receiptA.run_id),requestB:await workerRequest(receiptB.run_id)};
}

it('admits both Projects of crossed research closures in one order, so two attempts queue instead of deadlocking',async()=>{
 const x=await crossProjectDrafts();
 await expect(attempt(x.requestA)).resolves.toBeUndefined();
 await expect(attempt(x.requestB)).resolves.toBeUndefined();
 // Both attempts start while the Space row is held, so each has taken its
 // Project locks before either can reach the other Project's closure.
 const space_=await holdSpace();
 const attemptingA=settled(attempt(x.requestA)),attemptingB=settled(attempt(x.requestB));
 try{await lockWaiters(2);}finally{space_.release();}
 await space_.held;
 expect(await attemptingA).toMatchObject({ok:true});
 expect(await attemptingB).toMatchObject({ok:true});
 // Publication takes the same admission inside the draft's transaction.
 await startRun(x.receiptA.run_id);await startRun(x.receiptB.run_id);
 const again=await holdSpace();
 const publishingA=settled(x.requestA.finalize!(completion('Crossed A'),x.receiptA.run_id));
 const publishingB=settled(x.requestB.finalize!({...completion('Crossed B'),text:JSON.stringify({summary_text:'Crossed B',topics:[],highlights:[],source_refs:[{source_type:'project',source_id:x.other}]})},x.receiptB.run_id));
 try{await lockWaiters(2);}finally{again.release();}
 await again.held;
 expect(await publishingA).toMatchObject({ok:true});
 expect(await publishingB).toMatchObject({ok:true});
 expect((await db.pool.query('SELECT project_id,summary_text FROM project_public_summaries WHERE project_id=ANY($1::varchar[]) ORDER BY summary_text',[[project,x.other]])).rows)
  .toEqual([{project_id:project,summary_text:'Crossed A'},{project_id:x.other,summary_text:'Crossed B'}]);
});

it('makes a revocation of the other Project\'s Source connection wait for a checked attempt, then refuses the next one',async()=>{
 const x=await crossProjectDrafts(),bystander=randomUUID();await seedSpaceMember(db.pool,{space,user:bystander});
 let checked!:()=>void,commit!:()=>void;
 const afterCheck=new Promise<void>(r=>{checked=r;}),mayCommit=new Promise<void>(r=>{commit=r;});
 const attempting=settled(withTransaction(db.pool,async client=>{await x.requestA.authorizeAttempt!(client,{} as never);checked();await mayCommit;}));
 await afterCheck;
 const revoking=settled(x.sourceB.share(bystander));
 try{
  await lockWaiters(1);
  expect((await db.pool.query("SELECT 1 FROM content_access_grants WHERE resource_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL",[x.sourceB.connection,owner])).rows.length).toBe(1);
 }finally{commit();}
 expect((await attempting).ok).toBe(true);
 expect((await revoking).ok).toBe(true);
 await expect(attempt(x.requestA)).rejects.toMatchObject({statusCode:403});
 // B's draft read A's Source, which nobody touched.
 await expect(attempt(x.requestB)).resolves.toBeUndefined();
});

it('waits for a connection revocation already inside its transaction, then refuses the attempt and the publication',async()=>{
 const x=await crossProjectDrafts(),bystander=randomUUID();await seedSpaceMember(db.pool,{space,user:bystander});
 for(const finalize of [false,true]){
  if(finalize)await startRun(x.receiptA.run_id);
  const hold=holdPolicyWriter();
  try{
   const revoking=settled(x.sourceB.share(bystander));
   await hold.inside;
   const racing=settled<unknown>(finalize?x.requestA.finalize!(completion("Crossed leak"),x.receiptA.run_id):attempt(x.requestA));
   try{await lockWaiters(1);}finally{hold.release();}
   expect((await revoking).ok).toBe(true);
   expect(await racing).toMatchObject({ok:false,e:finalize?{code:'public_summary_draft_rejected'}:{statusCode:403}});
  }finally{hold.restore();}
  await x.sourceB.share(owner);
 }
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
});

it('refuses, without waiting for it, a Project the research closure reaches only after the attempt admitted its Projects',async()=>{
 const x=await crossProjectDrafts(),third=await seedProject('Cinder');
 const sourceC=await seedSourceChain(x.peer,third);
 // A research writer holds A's Operation and adds a third Project's Source to it.
 let release!:()=>void,locked!:()=>void;const released=new Promise<void>(r=>{release=r;}),isLocked=new Promise<void>(r=>{locked=r;});
 const growing=settled(withTransaction(db.pool,async client=>{
  await client.query('SELECT id FROM project_operations WHERE id=$1 FOR UPDATE',[x.researchA.operation]);
  await client.query(`UPDATE project_operations SET progress_json=jsonb_set(progress_json,'{source_item_ids}',(progress_json->'source_item_ids')||jsonb_build_array($2::text)) WHERE id=$1`,[x.researchA.operation,sourceC.item]);
  locked();await released;
 }));
 await isLocked;
 // Someone else holds the third Project: the attempt must not queue behind it.
 const blocker=await withTransactionHold(third);
 const attempting=settled(attempt(x.requestA));
 try{await lockWaiters(1);}finally{release();}
 expect((await growing).ok).toBe(true);
 expect(await attempting).toMatchObject({ok:false,e:{statusCode:409,message:expect.stringContaining('request a new draft')}});
 blocker.release();await blocker.held;
 // Rebuilt from scratch, the grown closure (now three Projects) is admitted and checked.
 await expect(attempt(x.requestA)).resolves.toBeUndefined();
});

async function withTransactionHold(projectId:string){
 let release!:()=>void,locked!:()=>void;const released=new Promise<void>(r=>{release=r;}),isLocked=new Promise<void>(r=>{locked=r;});
 const held=withTransaction(db.pool,async client=>{await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[projectId]);locked();await released;});
 await isLocked;
 return {release,held};
}

it('waits for a Room removal of the research request\'s Room and then refuses the frozen research Artifact',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,project,peer]);
 const chain=await seedSourceChain(peer,project);
 // The research call was requested by a Run in a limited Room the peer owns and the person belongs to.
 const room=randomUUID(),session=randomUUID(),run=randomUUID();
 await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Research room','active',now(),now(),false)`,[room,space,project,peer]);
 await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',now(),now()),($5,$2,$3,$6,'member','active',now(),now())`,[randomUUID(),space,room,peer,randomUUID(),owner]);
 await db.pool.query("INSERT INTO sessions(id,space_id,room_id,project_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'Room conversation','active',now(),now())",[session,space,room,project]);
 await seedRun(db.pool,{id:run,space,owner:peer,agent:randomUUID(),version:randomUUID()});
 await db.pool.query('UPDATE runs SET session_id=$2,project_id=$3 WHERE id=$1',[run,session,project]);
 const research=await seedResearchArtifact(peer,'ROOM_RESEARCH_TITLE',{item:chain.item,channelIds:[chain.channel],originRunId:run});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain(`artifact:${research.artifact}`);
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 let entered!:()=>void,release!:()=>void;
 const inside=new Promise<void>(r=>{entered=r;}),released=new Promise<void>(r=>{release=r;});
 const original=PgRoomRosterRepository.prototype.revokeUserGrants;
 const spy=vi.spyOn(PgRoomRosterRepository.prototype,'revokeUserGrants').mockImplementation(async function(this:PgRoomRosterRepository,...a){const out=await original.apply(this,a);entered();await released;return out;});
 try{
  const removing=settled(new RoomRosterService(db.pool).removeUser({spaceId:space,userId:peer},room,owner));
  await Promise.race([inside,removing.then(r=>{throw new Error(`removal ended before its hold: ${String((r as {e?:unknown}).e)}`);})]);
  const attempting=settled(attempt(request));
  try{await lockWaiters(1);}finally{release();}
  expect(await removing).toMatchObject({ok:true});
  expect(await attempting).toMatchObject({ok:false,e:{statusCode:403}});
 }finally{spy.mockRestore();}
});

// --- The requesting Run's own scope (`runInheritedReadSql` → `runReadSql`):
// its Project, the Project owning its Folder, and the Thread's Project shares.

/** A Project the peer owns, with the person as an ordinary member, and one Folder in it. */
async function seedPeerProjectWithFolder(peer:string,name:string){
 const id=randomUUID(),folder=randomUUID();
 await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`,[id,space,peer,name]);
 await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`,[randomUUID(),space,id,owner]);
 await db.pool.query("INSERT INTO project_folders(id,space_id,project_id,name,status,kind,protected,system_managed,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'Third folder','active','code',false,false,$4,now(),now())",[folder,space,id,peer]);
 return {id,folder};
}
/** A Run of the person's in this Project, filed in `folder`, with no Room. */
async function seedFolderRun(folder:string){
 const run=randomUUID();
 await seedRun(db.pool,{id:run,space,owner,agent:randomUUID(),version:randomUUID()});
 await db.pool.query('UPDATE runs SET project_id=$2,project_folder_id=$3 WHERE id=$1',[run,project,folder]);
 return run;
}
const removeFromProject=(peer:string,projectId:string)=>new PgProjectRepository(db.pool).removeMember({spaceId:space,userId:peer},projectId,owner);
/** An attempt that has passed its check and holds its locks until told to commit. */
function heldAttempt(request:Awaited<ReturnType<typeof workerRequest>>){
 let checked!:()=>void,commit!:()=>void;
 const afterCheck=new Promise<void>(r=>{checked=r;}),mayCommit=new Promise<void>(r=>{commit=r;});
 const done=settled(withTransaction(db.pool,async client=>{await request.authorizeAttempt!(client,{} as never);checked();await mayCommit;}));
 return {afterCheck,commit,done};
}

it('holds a research request\'s Run filed in a third Project\'s Folder: member removal there waits for a checked attempt, then refuses',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const third=await seedPeerProjectWithFolder(peer,'Cinder'),run=await seedFolderRun(third.folder);
 const research=await seedResearchArtifact(peer,'FOLDER_RUN_RESEARCH',{originRunId:run});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain(`artifact:${research.artifact}`);
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 const held=heldAttempt(request);
 await held.afterCheck;
 const removing=settled(removeFromProject(peer,third.id));
 try{
  await lockWaiters(1);
  expect((await db.pool.query('SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2',[third.id,owner])).rows.length).toBe(1);
 }finally{held.commit();}
 expect(await held.done).toMatchObject({ok:true});
 expect(await removing).toMatchObject({ok:true});
 // The Run's Folder is no longer the person's to read, so neither is the research it requested.
 await expect(attempt(request)).rejects.toMatchObject({statusCode:403});
 await startRun(receipt.run_id);
 await expect(request.finalize!(completion('Folder run leak'),receipt.run_id)).rejects.toMatchObject({code:'public_summary_draft_rejected'});
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
});

it('waits for a member removal already inside the requesting Run\'s Folder Project, then refuses the attempt and the publication',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 for(const finalize of [false,true]){
  const third=await seedPeerProjectWithFolder(peer,`Cinder ${finalize}`),run=await seedFolderRun(third.folder);
  const research=await seedResearchArtifact(peer,`FOLDER_RUN_${finalize}`,{originRunId:run});
  const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
  expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain(`artifact:${research.artifact}`);
  const request=await workerRequest(receipt.run_id);
  await expect(attempt(request)).resolves.toBeUndefined();
  if(finalize)await startRun(receipt.run_id);
  // The membership writer's own order: the Project (audience lock), then the member row.
  let release!:()=>void,locked!:()=>void;const released=new Promise<void>(r=>{release=r;}),isLocked=new Promise<void>(r=>{locked=r;});
  const removing=settled(withTransaction(db.pool,async client=>{
   await client.query('SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE',[third.id]);
   await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',[third.id,owner]);
   locked();await released;
  }));
  await isLocked;
  const racing=settled<unknown>(finalize?request.finalize!(completion('Folder run leak'),receipt.run_id):attempt(request));
  try{await lockWaiters(1);}finally{release();}
  expect(await removing).toMatchObject({ok:true});
  expect(await racing).toMatchObject({ok:false,e:finalize?{code:'public_summary_draft_rejected'}:{statusCode:403}});
 }
 expect((await db.pool.query('SELECT id FROM project_public_summaries WHERE project_id=$1',[project])).rows).toEqual([]);
});

it('refuses with a rebuild conflict when the requesting Run moves to another Project\'s Folder while the attempt waits',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const third=await seedPeerProjectWithFolder(peer,'Cinder'),fourth=await seedPeerProjectWithFolder(peer,'Dune'),run=await seedFolderRun(third.folder);
 await seedResearchArtifact(peer,'MOVING_RUN_RESEARCH',{originRunId:run});
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 let release!:()=>void,locked!:()=>void;const released=new Promise<void>(r=>{release=r;}),isLocked=new Promise<void>(r=>{locked=r;});
 const moving=settled(withTransaction(db.pool,async client=>{
  await client.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE',[run]);
  await client.query('UPDATE runs SET project_folder_id=$2 WHERE id=$1',[run,fourth.folder]);
  locked();await released;
 }));
 await isLocked;
 const attempting=settled(attempt(request));
 try{await lockWaiters(1);}finally{release();}
 expect(await moving).toMatchObject({ok:true});
 expect(await attempting).toMatchObject({ok:false,e:{statusCode:409,message:expect.stringContaining('request a new draft')}});
 // Rebuilt, the new Folder's Project is admitted and checked.
 await expect(attempt(request)).resolves.toBeUndefined();
});

it('holds the Projects a research Thread is shared into: member removal there waits for a checked attempt',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const shared=await seedPeerProjectWithFolder(peer,'Shared into');
 const research=await seedResearchArtifact(peer,'SHARED_THREAD_RESEARCH');
 await db.pool.query(`INSERT INTO space_object_project_shares (id,space_id,object_id,project_id,shared_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,now(),now())`,[randomUUID(),space,research.thread,shared.id,owner]);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data,request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 const held=heldAttempt(request);
 await held.afterCheck;
 const removing=settled(removeFromProject(peer,shared.id));
 try{await lockWaiters(1);}finally{held.commit();}
 expect(await held.done).toMatchObject({ok:true});
 expect(await removing).toMatchObject({ok:true});
 // The Thread's own Project still admits the person, so the next attempt stands.
 await expect(attempt(request)).resolves.toBeUndefined();
});

it('keeps an ordinary Artifact whose Run sits in a third Project\'s Folder to its Room gate only',async()=>{
 const peer=randomUUID();await seedSpaceMember(db.pool,{space,user:peer});
 const third=await seedPeerProjectWithFolder(peer,'Cinder'),run=await seedFolderRun(third.folder),artifact=randomUUID();
 await db.pool.query(`INSERT INTO artifacts(id,space_id,project_id,owner_user_id,run_id,artifact_type,title,content,canonical_format,mime_type,export_formats_json,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'report','ORDINARY_RUN_ARTIFACT','Body','markdown','text/markdown','[]',now(),now())`,[artifact,space,project,owner,run]);
 const receipt=(await draft({model_provider_id:'provider-1'})).json().data;
 expect((await db.pool.query('SELECT instruction FROM runs WHERE id=$1',[receipt.run_id])).rows[0].instruction).toContain(`artifact:${artifact}`);
 const request=await workerRequest(receipt.run_id);
 await expect(attempt(request)).resolves.toBeUndefined();
 // Its Run's Folder Project is not part of an ordinary Artifact's gate: removal neither waits nor refuses.
 await removeFromProject(peer,third.id);
 await expect(attempt(request)).resolves.toBeUndefined();
});
