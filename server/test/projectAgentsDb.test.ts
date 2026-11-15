import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {ensureDefaultRuntimeProfile,seedAgentWithVersion,seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {agentsModule} from '../src/modules/agents/index.js';
import {projectsModule} from '../src/modules/projects/index.js';
import {roomsModule} from '../src/modules/rooms/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {sessionsModule} from '../src/modules/sessions/index.js';
import {resolveRuntimeProfileScope} from '../src/modules/runs/remoteProviderBinding.js';

/**
 * A Project's Agent list is a reference relation separate from Room rosters:
 * adding to the Project joins no Room, a Room add completes the Project link,
 * leaving a Room keeps it, and no read names a private Agent or a limited Room
 * to someone who could not open it directly.
 */
const db=useTestDatabase(import.meta.filename,{max:6});
let space:string,owner:string,writer:string,reader:string,project:string,shared:string,app:ReturnType<typeof buildModuleServer>;
const as=(userId:string)=>__setAuthIdentityForTests({spaceId:space,userId});
const call=(method:'GET'|'POST'|'DELETE',url:string,payload?:Record<string,unknown>)=>app.inject({method,url,...(payload?{payload}:{}),headers:method==='GET'?{}:{'idempotency-key':randomUUID()}});
const list=async()=>{const r=await call('GET',`/api/v1/projects/${project}/agents`);expect(r.statusCode,r.body).toBe(200);return r.json() as {items:Array<{agent_id:string;private:boolean;rooms:Array<{room_id:string;is_mainline:boolean}>}>;total:number;viewer_can_write:boolean};};
const mainline=async()=>(await db.pool.query<{id:string}>('SELECT id FROM rooms WHERE project_id=$1 AND is_mainline',[project])).rows[0]!.id;
const roomAgents=async(roomId:string)=>(await db.pool.query<{agent_id:string}>("SELECT agent_id FROM room_agent_members WHERE room_id=$1 AND status='active' AND role='member' ORDER BY agent_id",[roomId])).rows.map(r=>r.agent_id);
const link=async(agentId:string)=>(await db.pool.query<{status:string}>('SELECT status FROM project_agent_links WHERE project_id=$1 AND agent_id=$2',[project,agentId])).rows[0]?.status??null;

async function addMember(user:string,role:'member'|'viewer'){
 await seedSpaceMember(db.pool,{space,user});
 await db.pool.query("INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())",[randomUUID(),space,project,user,role]);
}
async function seedPrivateAgent(agentOwner:string,name:string){
 const id=randomUUID();
 await seedAgentWithVersion(db.pool,{space,owner:agentOwner,agent:id,version:randomUUID(),name});
 await db.pool.query("UPDATE agents SET visibility='private' WHERE id=$1",[id]);
 return id;
}

/** The eligible managed Host backend the direct-chat operation test uses, for `agentId`. */
async function managedHostBackend(agentId:string,{personal=false}:{personal?:boolean}={}){
 // A non-Project direct chat is placed in the person's own Space: this one, for the tests that need one.
 if(personal)await db.pool.query("UPDATE spaces SET type='personal' WHERE id=$1",[space]);
 const hostId=randomUUID();
 await db.pool.query("INSERT INTO machines(id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES($1,$2,'Desk','desktop',now(),now())",[hostId,owner]);
 await db.pool.query(`INSERT INTO hosts(id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at)
  VALUES($1,$2,$1,'Desk','remote','linux_native','online',$3::jsonb,now(),now(),now())`,[hostId,owner,JSON.stringify({execution_workspaces:{version:2},runtimes:[],versions:{},installations:{opencode:[{id:'managed:1.0.0',version:'1.0.0',logged_in:true,health_check_protocol:'acp',options:{config_options:[],prompt_capabilities:{image:true,embedded_context:false,resource_link:true}}}]}})]);
 await db.pool.query('DELETE FROM agent_runtime_profiles WHERE agent_id=$1',[agentId]);
 await ensureDefaultRuntimeProfile(db.pool,{agent:agentId,space,runtimeKey:'opencode',executionHostId:hostId,runtimeInstallation:'managed:1.0.0',workspaceMode:'managed'});
 return hostId;
}
/** Lets the conversation take another turn: the queued one finished and released its Host thread. */
async function finishTurns(){
 await db.pool.query("UPDATE runs SET status='failed',ended_at=now() WHERE space_id=$1 AND status='queued'",[space]);
 await db.pool.query("UPDATE jobs SET status='completed' WHERE space_id=$1",[space]);
 await db.pool.query('UPDATE host_threads SET dispatch_lock_id=NULL');
}
const chat=(payload:Record<string,unknown>)=>call('POST',`/api/v1/agents/${shared}/chat`,{message:'Review the brief',...payload});
const accepted=async(response:Awaited<ReturnType<typeof call>>)=>{expect(response.statusCode,response.body).toBe(202);return (response.json() as {data:{session_id:string;run_id:string}}).data;};
type ThreadRow={id:string;container_kind:string;container_user_id:string|null;session_id:string|null;status:string;pending_archive_at:Date|null;archive_include_workspace:boolean|null};
const threadOf=async(runId:string)=>(await db.pool.query<ThreadRow>(
 `SELECT t.id,t.container_kind,t.container_user_id,t.session_id,t.status,t.pending_archive_at,t.archive_include_workspace
    FROM runs r JOIN host_threads t ON t.id=r.host_task_thread_id WHERE r.id=$1`,[runId])).rows[0]!;
const launchContainer=async(runId:string)=>(await db.pool.query<{container:unknown}>("SELECT model_override_json->'workspace'->'container' AS container FROM runs WHERE id=$1",[runId])).rows[0]!.container;
const profileScope=async(runId:string)=>{
 const run=(await db.pool.query<{agent_id:string;host_task_thread_id:string}>('SELECT agent_id,host_task_thread_id FROM runs WHERE id=$1',[runId])).rows[0]!;
 return resolveRuntimeProfileScope(db.pool,run,null);
};
async function secondProject(){
 const id=randomUUID();
 await db.pool.query("INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())",[id,space,owner]);
 return id;
}

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users','jobs'],{cascade:true});
 space=randomUUID();owner=randomUUID();writer=randomUUID();reader=randomUUID();project=randomUUID();shared=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project,spaceType:'team'});
 await addMember(writer,'member');
 await addMember(reader,'viewer');
 await seedAgentWithVersion(db.pool,{space,owner,agent:shared,version:randomUUID(),name:'Reviewer'});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[agentsModule,projectsModule,roomsModule,sessionsModule,systemActionsModule]);
 as(owner);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});

describe('Project Agents (real PostgreSQL)',()=>{
 it('links an existing Agent once, without putting it on any Room roster',async()=>{
  const key=randomUUID();
  const first=await app.inject({method:'POST',url:`/api/v1/projects/${project}/agents`,payload:{agent_id:shared},headers:{'idempotency-key':key}});
  expect(first.statusCode,first.body).toBe(201);
  const replay=await app.inject({method:'POST',url:'/api/v1/actions/project.agent.add',payload:{project_id:project,agent_id:shared},headers:{'idempotency-key':key}});
  expect(replay.json()).toEqual(first.json());
  // A second, independent add is state-idempotent: still one link, one Agent definition.
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM project_agent_links WHERE project_id=$1',[project])).rows[0].n).toBe(1);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM agents WHERE space_id=$1',[space])).rows[0].n).toBe(1);
  expect(await roomAgents(await mainline())).toEqual([]);
  const page=await list();
  expect(page).toMatchObject({total:1,viewer_can_write:true});
  expect(page.items[0]).toMatchObject({agent_id:shared,private:false,rooms:[]});
  const candidates=(await call('GET',`/api/v1/projects/${project}/agent-candidates?q=revi`)).json() as {items:Array<{agent_id:string;linked:boolean}>};
  expect(candidates.items).toEqual([expect.objectContaining({agent_id:shared,linked:true})]);
  expect(((await call('GET',`/api/v1/projects/${project}/agent-candidates?q=zzz`)).json() as {total:number}).total).toBe(0);
 });

 it('never widens a private Agent: only its owner may link it, and only its readers see it listed',async()=>{
  const writersOwn=await seedPrivateAgent(writer,'Writer private');
  const ownersOwn=await seedPrivateAgent(owner,'Owner private');
  // The Project owner can neither see nor link another person's private Agent.
  const candidates=(await call('GET',`/api/v1/projects/${project}/agent-candidates`)).json() as {items:Array<{agent_id:string}>};
  expect(candidates.items.map(c=>c.agent_id)).not.toContain(writersOwn);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:writersOwn})).statusCode).toBe(404);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:ownersOwn})).statusCode).toBe(201);
  as(writer);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:writersOwn})).statusCode).toBe(201);
  expect((await list()).items.map(i=>i.agent_id)).toEqual([writersOwn]);
  as(owner);
  expect((await list()).items.map(i=>i.agent_id)).toEqual([ownersOwn]);
  // A viewer may read the list but not change it.
  as(reader);
  expect((await list()).viewer_can_write).toBe(false);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).not.toBe(201);
  expect(await link(shared)).toBeNull();
 });

 it('answers one link directly, however long the list is, under the same viewer gates',async()=>{
  // 205 earlier links: the Agent added last lies past any first page a client might read.
  await db.pool.query(
   `WITH seeded AS (
      INSERT INTO agents (id,space_id,owner_user_id,name,status,created_at,updated_at,visibility)
      SELECT gen_random_uuid()::text,$1,$2,'Filler '||n,'active',now(),now(),'space_shared' FROM generate_series(1,205) n
      RETURNING id)
    INSERT INTO project_agent_links (id,space_id,project_id,agent_id,status,added_by_user_id,created_at,updated_at)
    SELECT gen_random_uuid()::text,$1,$3,id,'active',$2,now()-interval '1 day',now() FROM seeded`,[space,owner,project]);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const one=(agentId:string)=>call('GET',`/api/v1/projects/${project}/agents/${agentId}`);
  const found=await one(shared);
  expect(found.statusCode,found.body).toBe(200);
  expect(found.json()).toMatchObject({agent_id:shared,name:'Reviewer',rooms:[]});
  const firstPage=(await call('GET',`/api/v1/projects/${project}/agents?limit=200`)).json() as {items:Array<{agent_id:string}>;total:number};
  expect(firstPage.total).toBe(206);
  expect(firstPage.items.map(i=>i.agent_id)).not.toContain(shared);
  // Not on the list (never linked, or removed) and not readable by this viewer are the same 404.
  const unlinked=randomUUID();
  await seedAgentWithVersion(db.pool,{space,owner,agent:unlinked,version:randomUUID(),name:'Unlinked'});
  expect((await one(unlinked)).statusCode).toBe(404);
  const privateOwn=await seedPrivateAgent(writer,'Writer private');
  as(writer);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:privateOwn})).statusCode).toBe(201);
  expect((await one(privateOwn)).statusCode).toBe(200);
  as(owner);
  expect((await one(privateOwn)).statusCode).toBe(404);
  expect((await call('DELETE',`/api/v1/projects/${project}/agents/${shared}`)).statusCode).toBe(200);
  expect((await one(shared)).statusCode).toBe(404);
 });

 it('refuses an Agent of another Space and an Agent bound to another Project',async()=>{
  const otherSpace=randomUUID(),otherProject=randomUUID(),foreign=randomUUID();
  await seedSpaceOwnerProject(db.pool,{space:otherSpace,owner:randomUUID(),project:otherProject,spaceType:'team'});
  await seedAgentWithVersion(db.pool,{space:otherSpace,owner,agent:foreign,version:randomUUID()});
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:foreign})).statusCode).toBe(404);
  const sibling=randomUUID(),bound=randomUUID();
  await db.pool.query("INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Sibling','active',now(),now())",[sibling,space,owner]);
  await seedAgentWithVersion(db.pool,{space,owner,agent:bound,version:randomUUID()});
  await db.pool.query('UPDATE agents SET project_id=$2 WHERE id=$1',[bound,sibling]);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:bound})).statusCode).toBe(404);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM project_agent_links',[])).rows[0].n).toBe(0);
 });

 it('completes the Project link from a Room add, keeps it after leaving the Room, and lists Project Agents first',async()=>{
  const room=await mainline(),later=randomUUID();
  await seedAgentWithVersion(db.pool,{space,owner,agent:later,version:randomUUID(),name:'Analyst'});
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:later})).statusCode).toBe(201);
  const candidates=(await call('GET',`/api/v1/rooms/${room}/agent-candidates`)).json() as {agents:Array<{agent_id:string;in_project:boolean}>};
  expect(candidates.agents.map(c=>[c.agent_id,c.in_project])).toEqual([[later,true],[shared,false]]);
  const added=await call('POST',`/api/v1/rooms/${room}/agents`,{agent_id:shared});
  expect(added.statusCode,added.body).toBe(201);
  expect(await link(shared)).toBe('active');
  expect((await list()).items.find(i=>i.agent_id===shared)?.rooms).toEqual([expect.objectContaining({room_id:room,is_mainline:true})]);
  expect((await call('DELETE',`/api/v1/rooms/${room}/agents/${shared}`)).statusCode).toBe(200);
  expect(await roomAgents(room)).toEqual([]);
  expect(await link(shared)).toBe('active');
  // And the reverse: leaving the Project list does not take an Agent out of a Room.
  expect((await call('POST',`/api/v1/rooms/${room}/agents`,{agent_id:later})).statusCode).toBe(201);
  expect((await call('DELETE',`/api/v1/projects/${project}/agents/${later}`)).statusCode).toBe(200);
  expect(await link(later)).toBe('removed');
  expect(await roomAgents(room)).toEqual([later]);
 });

 it('names a limited Room only to its members, in the Rooms index and in Agent placements',async()=>{
  const created=await call('POST','/api/v1/rooms',{project_id:project,title:'Owners only'});
  expect(created.statusCode,created.body).toBe(201);
  const limited=(created.json() as {data:{room_id:string}}).data.room_id;
  expect((await call('POST',`/api/v1/rooms/${limited}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const index=(await call('GET',`/api/v1/projects/${project}/rooms`)).json() as {items:Array<{room:{id:string;is_mainline:boolean};person_count:number;agent_count:number}>;total:number};
  expect(index.total).toBe(2);
  expect(index.items[0]!.room.is_mainline).toBe(true);
  expect(index.items[1]).toMatchObject({room:{id:limited,is_mainline:false},person_count:1,agent_count:1});
  expect((await list()).items[0]!.rooms.map(r=>r.room_id)).toEqual([limited]);
  as(writer);
  const theirs=(await call('GET',`/api/v1/projects/${project}/rooms`)).json() as {items:Array<{room:{id:string}}>;total:number};
  // Not listed, not counted.
  expect(theirs.total).toBe(1);
  expect(theirs.items.map(i=>i.room.id)).toEqual([await mainline()]);
  // The Agent is on the Project's list, but nothing says where else it is.
  expect((await list()).items).toEqual([expect.objectContaining({agent_id:shared,rooms:[]})]);
 });

 it('starts independent work in Project context only with a Project Agent',async()=>{
  await managedHostBackend(shared);
  const send=()=>call('POST',`/api/v1/agents/${shared}/chat`,{message:'Review the brief',project_id:project});
  const refused=await send();
  expect(refused.statusCode,refused.body).toBe(409);
  expect(refused.json().error.message).toBe('Add this Agent to the Project before using it in the Project');
  expect((await db.pool.query('SELECT count(*)::int AS n FROM sessions WHERE space_id=$1 AND room_id IS NULL',[space])).rows[0].n).toBe(0);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const accepted=await send();
  expect(accepted.statusCode,accepted.body).toBe(202);
  const session=(await db.pool.query<{project_id:string;room_id:string|null}>('SELECT project_id,room_id FROM sessions WHERE id=$1',[(accepted.json() as {data:{session_id:string}}).data.session_id])).rows[0];
  // A direct conversation placed in the Project, not a Room conversation.
  expect(session).toEqual({project_id:project,room_id:null});
 });
 it('isolates managed Host state per Project conversation: thread, cwd container, profile and archive keys',async()=>{
  await managedHostBackend(shared,{personal:true});
  const other=await secondProject();
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  expect((await call('POST',`/api/v1/projects/${other}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const inA=await accepted(await chat({project_id:project}));
  const inB=await accepted(await chat({project_id:other}));
  const direct=await accepted(await chat({}));
  const [a,b,d]=[await threadOf(inA.run_id),await threadOf(inB.run_id),await threadOf(direct.run_id)];
  // Each Project conversation is its own Conversation container; the person's own direct one is unchanged.
  expect(a).toMatchObject({container_kind:'conversation',session_id:inA.session_id,container_user_id:null});
  expect(b).toMatchObject({container_kind:'conversation',session_id:inB.session_id,container_user_id:null});
  expect(d).toMatchObject({container_kind:'direct',container_user_id:owner,session_id:null});
  expect(new Set([a.id,b.id,d.id]).size).toBe(3);
  // The daemon derives the managed cwd from the launch container, and the profile from the thread.
  expect(await launchContainer(inA.run_id)).toEqual({kind:'conversation',conversation_id:inA.session_id});
  expect(await launchContainer(inB.run_id)).toEqual({kind:'conversation',conversation_id:inB.session_id});
  expect(await launchContainer(direct.run_id)).toEqual({kind:'direct',user_id:owner});
  expect(await profileScope(inA.run_id)).toEqual({agent_id:shared,container_kind:'conversation',container_id:inA.session_id});
  expect(await profileScope(inB.run_id)).toEqual({agent_id:shared,container_kind:'conversation',container_id:inB.session_id});
  expect(await profileScope(direct.run_id)).toEqual({agent_id:shared,container_kind:'direct',container_id:owner});
  await finishTurns();
  // Non-Project history keeps its container: another direct chat reuses the person's own thread.
  const directAgain=await accepted(await chat({}));
  expect((await threadOf(directAgain.run_id)).id).toBe(d.id);
  // Another conversation in Project A is a new container, not Project A's first one.
  const secondInA=await accepted(await chat({project_id:project}));
  expect((await threadOf(secondInA.run_id)).id).not.toBe(a.id);
  // A Project conversation has no earlier workspace to restore, and never borrows the person's direct archive.
  await finishTurns();
  const restore=await chat({project_id:project,session_id:inA.session_id,restore_workspace:true});
  expect(restore.statusCode,restore.body).toBe(422);
  // Deleting Project A's conversation archives only its own container, cwd included, keyed by that Session.
  expect((await call('DELETE',`/api/v1/sessions/${inA.session_id}`)).statusCode).toBe(200);
  const closedA=(await db.pool.query<ThreadRow>('SELECT * FROM host_threads WHERE id=$1',[a.id])).rows[0]!;
  expect(closedA).toMatchObject({status:'closed',archive_include_workspace:true});
  expect(closedA.pending_archive_at).not.toBeNull();
  const untouched=await db.pool.query<{id:string;status:string;pending_archive_at:Date|null}>('SELECT id,status,pending_archive_at FROM host_threads WHERE id = ANY($1::varchar[]) ORDER BY id',[[b.id,d.id]]);
  expect(untouched.rows.every(row=>row.status==='active'&&row.pending_archive_at===null)).toBe(true);
  // Deleting the person's last non-Project direct chat closes the direct container; Project B's stays.
  expect((await call('DELETE',`/api/v1/sessions/${direct.session_id}`)).statusCode).toBe(200);
  expect((await db.pool.query('SELECT status FROM host_threads WHERE id=$1',[d.id])).rows[0].status).toBe('active');
  expect((await call('DELETE',`/api/v1/sessions/${directAgain.session_id}`)).statusCode).toBe(200);
  expect((await db.pool.query('SELECT status FROM host_threads WHERE id=$1',[d.id])).rows[0].status).toBe('closed');
  expect((await db.pool.query('SELECT status FROM host_threads WHERE id=$1',[b.id])).rows[0].status).toBe('active');
 });

 it('resets only the addressed Project conversation\'s Host session',async()=>{
  await managedHostBackend(shared,{personal:true});
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const inA=await accepted(await chat({project_id:project}));
  const direct=await accepted(await chat({}));
  const [a,d]=[await threadOf(inA.run_id),await threadOf(direct.run_id)];
  await db.pool.query("UPDATE host_threads SET vendor_session_id='vendor-'||id");
  const reset=(sessionId?:string)=>call('POST','/api/v1/actions/agent.chat.reset_context',{agent_id:shared,...(sessionId?{session_id:sessionId}:{})});
  // A dispatch in flight owns the thread.
  expect((await reset(inA.session_id)).statusCode).toBe(409);
  await finishTurns();
  const done=await reset(inA.session_id);
  expect(done.statusCode,done.body).toBe(200);
  expect((done.json() as {data:{thread_id:string}}).data.thread_id).toBe(a.id);
  const rows=await db.pool.query<{id:string;status:string;vendor_session_id:string|null}>('SELECT id,status,vendor_session_id FROM host_threads');
  expect(rows.rows.find(r=>r.id===a.id)).toMatchObject({status:'session_reset',vendor_session_id:null});
  expect(rows.rows.find(r=>r.id===d.id)).toMatchObject({status:'active',vendor_session_id:`vendor-${d.id}`});
  // A conversation that is not the person's own Project conversation is answered like a missing one.
  as(writer);
  expect((await reset(inA.session_id)).statusCode).toBe(404);
 });

 it('admits an Agent\'s first turn in a pre-created Project session only with a Project link, and keeps an admitted conversation going',async()=>{
  await managedHostBackend(shared);
  const created=await call('POST','/api/v1/sessions',{project_id:project,title:'Empty first'});
  expect(created.statusCode,created.body).toBe(201);
  const sessionId=(created.json() as {data:{session_id:string}}).data.session_id;
  const bypass=await chat({project_id:project,session_id:sessionId});
  expect(bypass.statusCode,bypass.body).toBe(409);
  expect(bypass.json().error.message).toBe('Add this Agent to the Project before using it in the Project');
  expect((await db.pool.query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1',[sessionId])).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT count(*)::int AS n FROM runs WHERE session_id=$1',[sessionId])).rows[0].n).toBe(0);
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  await accepted(await chat({project_id:project,session_id:sessionId}));
  // Leaving the Project list stops new conversations, not the admitted one.
  expect((await call('DELETE',`/api/v1/projects/${project}/agents/${shared}`)).statusCode).toBe(200);
  await finishTurns();
  await accepted(await chat({project_id:project,session_id:sessionId}));
  expect((await chat({project_id:project})).statusCode).toBe(409);
  // Another Agent in that same admitted conversation is still a first turn there.
  const second=randomUUID();
  await seedAgentWithVersion(db.pool,{space,owner,agent:second,version:randomUUID(),name:'Second'});
  await finishTurns();
  const other=await call('POST',`/api/v1/agents/${second}/chat`,{message:'Hi',project_id:project,session_id:sessionId});
  expect(other.statusCode,other.body).toBe(409);
 });

 it('replays a successful removal with its receipt while a fresh removal of nothing is refused',async()=>{
  expect((await call('POST',`/api/v1/projects/${project}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const key=randomUUID();
  const remove=()=>app.inject({method:'POST',url:'/api/v1/actions/project.agent.remove',payload:{project_id:project,agent_id:shared},headers:{'idempotency-key':key}});
  const first=await remove();
  expect(first.statusCode,first.body).toBe(200);
  expect(await link(shared)).toBe('removed');
  const replay=await remove();
  expect(replay.statusCode,replay.body).toBe(200);
  expect(replay.json()).toEqual(first.json());
  expect((await call('DELETE',`/api/v1/projects/${project}/agents/${shared}`)).statusCode).toBe(404);
  // Live authority still applies to a replay: a person who lost Project write cannot read it back.
  await db.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2",[project,writer]);
  as(writer);
  const theirs=await app.inject({method:'POST',url:'/api/v1/actions/project.agent.remove',payload:{project_id:project,agent_id:shared},headers:{'idempotency-key':key}});
  expect(theirs.statusCode).not.toBe(200);
 });

 it('completes a missing Project link when an active Room member is added again, without a roster change',async()=>{
  const created=await call('POST','/api/v1/rooms',{project_id:project,title:'Owners only'});
  const limited=(created.json() as {data:{room_id:string}}).data.room_id;
  expect((await call('POST',`/api/v1/rooms/${limited}/agents`,{agent_id:shared})).statusCode).toBe(201);
  const revision=async()=>Number((await db.pool.query('SELECT roster_revision FROM rooms WHERE id=$1',[limited])).rows[0].roster_revision);
  const before=await revision();
  // Taken off the Project's list, and — like a roster from before links — with no link row at all.
  expect((await call('DELETE',`/api/v1/projects/${project}/agents/${shared}`)).statusCode).toBe(200);
  expect(await link(shared)).toBe('removed');
  const again=await call('POST',`/api/v1/rooms/${limited}/agents`,{agent_id:shared});
  expect(again.statusCode,again.body).toBe(201);
  expect(await link(shared)).toBe('active');
  expect(await revision()).toBe(before);
  await db.pool.query('DELETE FROM project_agent_links WHERE project_id=$1',[project]);
  expect((await call('POST',`/api/v1/rooms/${limited}/agents`,{agent_id:shared})).statusCode).toBe(201);
  expect(await link(shared)).toBe('active');
  expect(await revision()).toBe(before);
  expect(await roomAgents(limited)).toEqual([shared]);
  // A person outside the limited Room still cannot reach it to repair anything.
  await db.pool.query('DELETE FROM project_agent_links WHERE project_id=$1',[project]);
  as(writer);
  expect((await call('POST',`/api/v1/rooms/${limited}/agents`,{agent_id:shared})).statusCode).toBe(404);
  expect(await link(shared)).toBeNull();
 });
});
