import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {useTestDatabase} from './support/testDatabase.js';
import {resetTables} from './support/resetTables.js';
import {seedAgentWithVersion,seedSpaceMember,seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {agentsModule} from '../src/modules/agents/index.js';
import {agentTemplatesModule} from '../src/modules/agentTemplates/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';

const db=useTestDatabase(import.meta.filename,{max:6});
let personal:string,team:string,user:string,member:string,project:string,app:ReturnType<typeof buildModuleServer>;
const as=(spaceId:string,userId:string)=>__setAuthIdentityForTests({spaceId,userId});
const inject=(method:'POST'|'PATCH'|'PUT',url:string,payload:object,key:string|null=randomUUID())=>app.inject({method,url,payload,headers:key?{'idempotency-key':key}:{}});
const call=(id:string,input:object,key:string=randomUUID())=>inject('POST','/api/v1/actions/'+id,input,key);
const rows=async(sql:string,params:unknown[]=[])=>(await db.pool.query(sql,params)).rows;

beforeEach(async()=>{
 await resetTables(db.pool,['spaces','users'],{cascade:true});
 personal=randomUUID();team=randomUUID();user=randomUUID();member=randomUUID();project=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space:personal,owner:user,project:randomUUID(),spaceType:'personal'});
 await db.pool.query("INSERT INTO spaces(id,name,type,created_by_user_id,created_at,updated_at) VALUES($1,'Team','team',$2,now(),now())",[team,user]);
 await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'owner','active',now(),now())",[randomUUID(),team,user]);
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Team project','active',now(),now())",[project,team,user]);
 await db.pool.query("INSERT INTO project_members(id,space_id,project_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,$4,'owner',now(),now()) ON CONFLICT DO NOTHING",[randomUUID(),team,project,user]).catch(()=>undefined);
 await seedSpaceMember(db.pool,{space:team,user:member});
 app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:db.connectionUri}),[agentsModule,agentTemplatesModule,systemActionsModule]);
 as(team,user);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app.close();});

describe('Agent definition operations (real PostgreSQL)',()=>{
 it('creates in the Personal Space through formal and generic entries with one key, and keeps the definition policies it was sent',async()=>{
  const key=randomUUID(),body={name:'  Writer  ',description:'Drafts',system_prompt:'Write plainly.',tool_policy_json:{domains:['notes']},schedule_config_json:{cron:null}};
  const formal=await inject('POST','/api/v1/agents',body,key);
  expect(formal.statusCode,formal.body).toBe(201);
  const receipt=formal.json().data as {id:string;space_id:string;agent_id:string};
  expect(receipt.space_id).toBe(personal);
  expect((await call('agent.create',body,key)).json()).toEqual(formal.json());
  expect((await call('agent.create',{...body,name:'Other'},key)).json().error.code).toBe('idempotency_key_reused');
  expect(await rows('SELECT name,visibility,space_id FROM agents WHERE id=$1',[receipt.id])).toEqual([{name:'Writer',visibility:'private',space_id:personal}]);
  expect((await rows('SELECT av.tool_policy_json FROM agents a JOIN agent_versions av ON av.id=a.current_version_id WHERE a.id=$1',[receipt.id]))[0].tool_policy_json).toEqual({domains:['notes']});
  // Retired deployment fields and unknown keys never reach the writer.
  expect((await call('agent.create',{name:'X',runtime_key:'codex'})).statusCode).toBe(422);
  expect((await call('agent.create',{name:'   '})).json().error.code).toBe('operation_invalid_input');
  expect((await rows('SELECT count(*)::int AS n FROM agents WHERE owner_user_id=$1',[user]))[0].n).toBe(1);
 });

 it('places Project creation in its Space for writers only',async()=>{
  const created=await call('agent.create',{name:'Project agent',project_id:project});
  expect(created.statusCode,created.body).toBe(201);
  expect(await rows('SELECT space_id,project_id,visibility FROM agents WHERE id=$1',[created.json().data.id])).toEqual([{space_id:team,project_id:project,visibility:'space_shared'}]);
  as(team,member);
  expect((await call('agent.create',{name:'Intruder',project_id:project})).statusCode).toBe(404);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);as(team,user);
  expect((await call('agent.create',{name:'Late',project_id:project})).statusCode).toBe(404);
 });

 it('applies identity and configuration in one transaction and hides another person\'s Agent',async()=>{
  const agent=randomUUID(),version=randomUUID();
  await seedAgentWithVersion(db.pool,{agent,version,space:team,owner:user});
  const bad=await inject('PATCH',`/api/v1/agents/${agent}`,{name:'Renamed',execution_constraints:{max_run_time_seconds:0}});
  expect(bad.statusCode,bad.body).toBe(422);
  expect(await rows('SELECT name,current_version_id FROM agents WHERE id=$1',[agent])).toEqual([{name:'Research Agent',current_version_id:version}]);
  const ok=await inject('PATCH',`/api/v1/agents/${agent}`,{name:'Renamed',system_prompt:'New prompt'});
  expect(ok.statusCode,ok.body).toBe(200);
  const [after]=await rows('SELECT a.name,av.system_prompt,a.current_version_id FROM agents a JOIN agent_versions av ON av.id=a.current_version_id WHERE a.id=$1',[agent]);
  expect(after).toMatchObject({name:'Renamed',system_prompt:'New prompt'});expect(after.current_version_id).not.toBe(version);
  const restored=await inject("POST",`/api/v1/agents/${agent}/versions/${version}/restore`,{});
  expect(restored.statusCode,restored.body).toBe(200);
  expect((await rows('SELECT av.system_prompt FROM agents a JOIN agent_versions av ON av.id=a.current_version_id WHERE a.id=$1',[agent]))[0].system_prompt).toBe('Test research agent.');
  const jobsBefore=(await rows('SELECT count(*)::int AS n FROM jobs WHERE space_id=$1',[team]))[0].n;
  const config=await inject('POST',`/api/v1/agents/${agent}/config`,{output_schema_json:{type:'object'}});
  expect(config.statusCode,config.body).toBe(200);
  // Config reaches a Run through its immutable AgentVersion: no derived-context refresh Job.
  expect((await rows('SELECT count(*)::int AS n FROM jobs WHERE space_id=$1',[team]))[0].n).toBe(jobsBefore);
  // The config route keeps its config-only body.
  expect((await inject('POST',`/api/v1/agents/${agent}/config`,{role_instruction:'x'})).statusCode).toBe(422);
  // A Space member may read the shared Agent but not change it.
  as(team,member);
  expect((await inject('PATCH',`/api/v1/agents/${agent}`,{name:'Hijack'})).statusCode).toBe(404);
  expect((await inject('POST',`/api/v1/agents/${agent}/config`,{system_prompt:'Hijack'})).statusCode).toBe(404);
  expect((await rows('SELECT name FROM agents WHERE id=$1',[agent]))[0].name).toBe('Renamed');
 });

 it('owns Runtime Profiles under the Agent lock and refuses credentials and egress',async()=>{
  const agent=randomUUID();
  await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space:team,owner:user});
  const url=`/api/v1/agents/${agent}/runtime-profiles`;
  expect((await inject('POST',url,{name:'Cred',runtime_key:'opencode',runtime_config_json:{credential_profile_id:'secret'}})).statusCode).toBe(422);
  expect((await inject('POST',url,{name:'Cred',runtime_key:'opencode',egress_profile:'open'})).statusCode).toBe(422);
  const created=await inject('POST',url,{name:'Second',runtime_key:'opencode'});
  expect(created.statusCode,created.body).toBe(201);
  const profile=created.json().data.profile_id as string;
  const patched=await inject('PATCH',`${url}/${profile}`,{enabled:false});
  expect(patched.statusCode,patched.body).toBe(200);
  expect(await rows('SELECT name,enabled,is_default FROM agent_runtime_profiles WHERE id=$1',[profile])).toEqual([{name:'Second',enabled:false,is_default:false}]);
  // Switching a native Profile to model_provider needs a Provider and model; an explicit null clears only the named field.
  expect((await inject('PATCH',`${url}/${profile}`,{backend_mode:'model_provider'})).statusCode).toBe(422);
  expect((await inject('PATCH',`${url}/${profile}`,{runtime_policy_json:null})).statusCode).toBe(200);
  expect(await rows('SELECT name,backend_mode,enabled FROM agent_runtime_profiles WHERE id=$1',[profile])).toEqual([{name:'Second',backend_mode:'runtime_native',enabled:false}]);
  // Unsetting the only default is a deterministic conflict, rolled back and cached.
  const [current]=await rows('SELECT id FROM agent_runtime_profiles WHERE agent_id=$1 AND is_default',[agent]);
  const key=randomUUID();
  const conflict=await inject('PATCH',`${url}/${current.id}`,{is_default:false},key);
  expect(conflict.statusCode,conflict.body).toBe(409);
  const replay=await inject('PATCH',`${url}/${current.id}`,{is_default:false},key);
  expect(replay.statusCode).toBe(409);expect(replay.json().error.code).toBe(conflict.json().error.code);
  as(team,member);
  expect((await inject('POST',url,{name:'Member',runtime_key:'opencode'})).statusCode).toBe(404);
  expect((await inject('POST',`${url}/resolve-host-target`,{execution_host_id:randomUUID(),workspace_mode:'managed',runtime_key:'codex',runtime_installation:'default'})).statusCode).toBe(404);
 });

 it('keeps Space defaults with owners/admins and Assistant preferences with their configurer',async()=>{
  const write={runtime_key:'opencode',backend_mode:'runtime_native'};
  as(team,member);
  expect((await inject('PUT','/api/v1/agents/runtime-default',write)).statusCode).toBe(404);
  as(team,user);
  expect((await inject('PUT','/api/v1/agents/runtime-default',{...write,model_name:'x'})).statusCode).toBe(422);
  const set=await inject('PUT','/api/v1/agents/runtime-default',write);
  expect(set.statusCode,set.body).toBe(200);expect(set.json().data).toEqual({id:team,space_id:team});
  const settings=await inject('PATCH','/api/v1/agents/default-assistant/settings',{verbosity:'concise'});
  expect(settings.statusCode,settings.body).toBe(200);
  expect((await inject('PATCH','/api/v1/agents/default-assistant/settings',{default_project_id:randomUUID()})).statusCode).toBe(422);
  as(team,member);
  expect((await inject('PATCH','/api/v1/agents/default-assistant/settings',{verbosity:'detailed'})).statusCode).toBe(404);
  expect((await inject('PATCH',`/api/v1/agents/default-assistant/settings?project_id=${project}`,{verbosity:'detailed'})).statusCode).toBe(404);
 });

 it('queues a person-started Run with the server-owned origin and creates from a template',async()=>{
  const agent=randomUUID();
  await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space:team,owner:user});
  expect((await inject('POST',`/api/v1/agents/${agent}/runs`,{prompt:'x',trigger_origin:'automation'})).statusCode).toBe(422);
  expect((await inject('POST',`/api/v1/agents/${agent}/run`,{prompt:'x',run_type:'system',project_id:project})).statusCode).toBe(422);
  // Without a Project the access owner places the Run in the Personal Space, where this team Agent is absent.
  expect((await inject('POST',`/api/v1/agents/${agent}/run`,{prompt:'x'})).statusCode).toBe(404);
  const run=await inject('POST',`/api/v1/agents/${agent}/runs`,{prompt:'Summarize',project_id:project});
  expect(run.statusCode,run.body).toBe(201);
  expect(await rows('SELECT trigger_origin,status,project_id,space_id FROM runs WHERE id=$1',[run.json().data.run_id])).toEqual([{trigger_origin:'manual',status:'queued',project_id:project,space_id:team}]);
  const template=await inject('POST','/api/v1/agent-templates/research_reader/agents',{name:'Reader',system_prompt:'Read carefully.'});
  expect(template.statusCode,template.body).toBe(201);
  expect(await rows('SELECT name,space_id,source_template_id FROM agents WHERE id=$1',[template.json().data.id])).toEqual([{name:'Reader',space_id:personal,source_template_id:'research_reader'}]);
  expect((await inject('POST','/api/v1/agent-templates/absent/agents',{name:'None'})).statusCode).toBe(404);
 });

 it('resets a direct context only for its person and refuses during a dispatch',async()=>{
  const agent=randomUUID();
  await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space:personal,owner:user});
  as(personal,user);
  expect((await inject('POST',`/api/v1/agents/${agent}/chat/reset-context`,{})).statusCode).toBe(404);
  const thread=randomUUID();
  await db.pool.query("INSERT INTO host_threads(id,space_id,agent_id,container_kind,container_user_id,workspace_mode,status,dispatch_lock_id,created_by_user_id,created_at,updated_at,runtime_key,runtime_installation) VALUES($1,$2,$3,'direct',$4,'managed','active',$5,$4,now(),now(),'codex','default')",[thread,personal,agent,user,randomUUID()]);
  expect((await inject('POST',`/api/v1/agents/${agent}/chat/reset-context`,{})).statusCode).toBe(409);
  await db.pool.query('UPDATE host_threads SET dispatch_lock_id=NULL WHERE id=$1',[thread]);
  const reset=await inject('POST',`/api/v1/agents/${agent}/chat/reset-context`,{});
  expect(reset.statusCode,reset.body).toBe(200);
  expect(reset.json().data).toMatchObject({agent_id:agent,session_reset:true,thread_id:thread,workspace_mode:'managed'});
 });
});
