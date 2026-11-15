import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {loadConfig} from '../src/config.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {authModule} from '../src/modules/auth/index.js';
import {hostsModule,PgHostRepository} from '../src/modules/hosts/index.js';
import {daemonWorkspaceActor} from '../src/modules/hosts/workspaceActor.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
import {PgWorkspaceLocationRepository} from '../src/modules/projectFolders/workspaceLocations.js';
import {buildModuleServer} from './support/moduleServer.js';
import {seedSpaceOwnerProject,seedAgentWithVersion,seedMainlineRoomsForAllProjects} from './support/domainSeeds.js';
import {resetTables} from './support/resetTables.js';
import {useTestDatabase} from './support/testDatabase.js';
import {waitForBlockedBy} from './support/lockWait.js';

const db=useTestDatabase(import.meta.filename,{max:5});
let app:FastifyInstance,space:string,owner:string,project:string,target:string,host:string,token:string;
let config:ReturnType<typeof loadConfig>;
beforeEach(async()=>{
 if(!db.available)return;
 await resetTables(db.pool,['spaces','users','machines'],{cascade:true});
 space=randomUUID();owner=randomUUID();project=randomUUID();target=randomUUID();
 await seedSpaceOwnerProject(db.pool,{space,owner,project});
 await db.pool.query("UPDATE users SET email='admin@test.invalid' WHERE id=$1",[owner]);
 await db.pool.query("INSERT INTO users(id,email,display_name,status,registration_source,created_at,updated_at) VALUES($1,'target@test.invalid','Target','active','system',now(),now())",[target]);
 const repo=new PgHostRepository(db.pool);
 const pairing=await repo.issuePairingCode(owner,'Test Host');
 if('statusCode' in pairing)throw new Error('pairing failed');
 const registered=await repo.registerViaPairingCode(pairing.pairing_code,{});
 if('statusCode' in registered)throw new Error('registration failed');
 host=registered.host_id;token=registered.token;
 config=loadConfig({SERVER_DATABASE_URL:db.connectionUri,INSTANCE_ADMIN_EMAIL:'admin@test.invalid'});
 __setAuthIdentityForTests({spaceId:space,userId:owner});
 app=buildModuleServer(config,[hostsModule,authModule]);
});
afterEach(async()=>{__setAuthIdentityForTests(null);await app?.close();});
const create=(key?:string,extra:Record<string,unknown>={})=>app.inject({method:'POST',url:'/api/v1/hosts/me/workspaces',headers:{authorization:`Bearer ${token}`,...(key?{'idempotency-key':key}:{})},payload:{project_id:project,name:'Repo',...extra}});
const remove=(location:string,key='remove')=>app.inject({method:'DELETE',url:`/api/v1/hosts/me/workspaces/${location}`,headers:{authorization:`Bearer ${token}`,'idempotency-key':key}});
const account=(action:'disable'|'enable',key?:string,user=target,payload:Record<string,unknown>={})=>app.inject({method:'POST',url:`/api/v1/auth/admin/users/${user}/${action}`,headers:key?{'idempotency-key':key}:{},payload});
async function emptyReceipts(){expect((await db.pool.query('SELECT idempotency_key FROM operation_idempotency')).rows).toHaveLength(0);}
async function rejectAudit(work:()=>Promise<void>){
 await db.pool.query("CREATE FUNCTION refuse_account_workspace_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$");
 await db.pool.query('CREATE CONSTRAINT TRIGGER refuse_account_workspace_audit AFTER INSERT ON policy_decision_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_account_workspace_audit()');
 try{await work();}finally{await db.pool.query('DROP TRIGGER refuse_account_workspace_audit ON policy_decision_records');await db.pool.query('DROP FUNCTION refuse_account_workspace_audit()');}
}
async function blockedMutation(sql:string,args:unknown[],work:()=>Promise<{statusCode:number}>,status:number){
 const client=await db.pool.connect();let pending:Promise<{statusCode:number}>|undefined;
 try{
  await client.query('BEGIN');const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await client.query(sql,args);pending=work();await waitForBlockedBy(db.pool,pid);
  await client.query('COMMIT');expect((await pending).statusCode).toBe(status);
 }finally{await client.query('ROLLBACK');client.release();await pending;}
}
async function retainedConsent(){
 const agent=randomUUID(),destination=randomUUID(),grant=randomUUID(),invitation=randomUUID();
 await seedAgentWithVersion(db.pool,{agent,version:randomUUID(),space,owner:target});
 await db.pool.query('UPDATE agents SET access_project_id=$2 WHERE id=$1',[agent,project]);
 await db.pool.query("INSERT INTO projects(id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES($1,$2,$3,'Destination','active',now(),now())",[destination,space,owner]);
 await seedMainlineRoomsForAllProjects(db.pool);
 const room=(await db.pool.query('SELECT id FROM rooms WHERE project_id=$1',[destination])).rows[0].id;
 await db.pool.query('INSERT INTO room_agent_access_grants(id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,now())',[grant,space,room,agent,owner,target]);
 await db.pool.query("INSERT INTO room_user_invitations(id,space_id,room_id,invitee_user_id,invited_by_user_id,status,required_roster_revision,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',0,now()+interval '1 day',now(),now())",[invitation,space,room,owner,target]);
 await db.pool.query("INSERT INTO room_invitation_agent_approvals(id,space_id,invitation_id,agent_id,owner_user_id,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'approved',now(),now())",[randomUUID(),space,invitation,agent,target]);
 await db.pool.query("INSERT INTO user_sessions(id,user_id,token_hash,created_at,updated_at,expires_at) VALUES($1,$2,$3,now(),now(),now()+interval '1 day')",[randomUUID(),target,randomUUID()]);
 return {grant,invitation,destination};
}
describe('four corrected core entries (real PG)',()=>{
 it('requires keys and strict DTOs at both retained REST surfaces',async()=>{
  for(const result of [await create(),await create('strict',{host_id:host}),await account('disable'),await account('disable','strict',target,{user_id:owner})])expect(result.statusCode).toBe(422);
  await emptyReceipts();
 });
 it('creates exactly one Folder and Location for concurrent same-key calls, with audit and receipt',async()=>{
  const results=await Promise.all([create('create'),create('create')]);
  expect(results.some(r=>r.statusCode===201)).toBe(true);
  for(const result of results)if(result.statusCode!==201)expect(result.json()).toMatchObject({error:{code:'idempotency_in_progress'}});
  const replay=await create('create');expect(replay.statusCode,replay.body).toBe(201);
  expect(replay.json()).toEqual(results.find(r=>r.statusCode===201)!.json());
  expect((await db.pool.query('SELECT id FROM project_folders')).rows).toHaveLength(1);
  expect((await db.pool.query('SELECT id FROM workspace_locations')).rows).toHaveLength(1);
  expect((await db.pool.query("SELECT state FROM operation_idempotency WHERE operation_id='host.workspace.create'")).rows).toEqual([{state:'succeeded'}]);
  expect((await db.pool.query("SELECT id FROM policy_decision_records WHERE metadata_json->>'operation_request_id' IS NOT NULL")).rows.length).toBeGreaterThanOrEqual(2);
  expect((await create('create',{name:'Different'})).statusCode).toBe(422);
 });
 it('deletes only one Location of a multi-Location Folder and safely replays its receipt',async()=>{
  const first=await create('create');expect(first.statusCode,first.body).toBe(201);const data=first.json().data;
  const second=await new PgWorkspaceLocationRepository(db.pool).create({spaceId:space,projectFolderId:data.folder_id,executionHostId:host,executionHostKind:'remote',displayPath:'other'});
  expect((await remove(data.id)).statusCode).toBe(200);expect((await remove(data.id)).statusCode).toBe(200);
  expect((await db.pool.query('SELECT id FROM project_folders')).rows).toEqual([{id:data.folder_id}]);
  expect((await db.pool.query('SELECT id FROM workspace_locations')).rows).toEqual([{id:second.id}]);
  await db.pool.query("UPDATE projects SET status='archived' WHERE id=$1",[project]);
  expect((await remove(data.id)).statusCode).toBe(409);
 });
 it('never treats a Folder id as a Location id',async()=>{
  const result=await create('create');expect(result.statusCode,result.body).toBe(201);
  expect((await remove(result.json().data.folder_id)).statusCode).toBe(404);
  expect((await db.pool.query('SELECT id FROM workspace_locations')).rows).toHaveLength(1);
 });
 it('withholds cached output after membership exit, owner change or Host revocation',async()=>{
  expect((await create('create')).statusCode).toBe(201);
  await db.pool.query("UPDATE space_memberships SET status='left' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await create('create')).statusCode).toBe(404);
  await db.pool.query("UPDATE space_memberships SET status='active' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  await db.pool.query('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[host,target]);
  expect((await create('create')).statusCode).toBe(404);
  await db.pool.query("UPDATE hosts SET status='revoked' WHERE id=$1",[host]);
  expect((await create('create')).statusCode).toBe(401);
 });
 it('cannot forge bearer proof by serializing an authenticated actor or using a human actor',async()=>{
  const runtime=await operationRuntime(config),input={project_id:project,name:'Repo'};
  const actor=await daemonWorkspaceActor(db.pool,token,'host.workspace.create',input);
  for(const candidate of [JSON.parse(JSON.stringify(actor)),sessionActor({spaceId:space,userId:owner})])expect((await runtime.execute('host.workspace.create',input,candidate,randomUUID(),'forged')).http_status).toBe(404);
  await emptyReceipts();
 });
 it('rolls back Folder, Location and receipt when mandatory audit fails, then permits same-key recovery',async()=>{
  await rejectAudit(async()=>{expect((await create('rollback')).statusCode).toBe(503);expect((await db.pool.query('SELECT id FROM project_folders')).rows).toHaveLength(0);await emptyReceipts();});
  expect((await create('rollback')).statusCode).toBe(201);
 });
 it('waits for Project archive before rejecting a new Host write',async()=>{
  await blockedMutation("UPDATE projects SET status='archived' WHERE id=$1",[project],()=>create('archive-race'),409);
  expect((await db.pool.query('SELECT id FROM project_folders')).rows).toHaveLength(0);await emptyReceipts();
 });
 it('waits for current Host ownership and refuses an actor authenticated before the change',async()=>{
  await blockedMutation('UPDATE hosts SET owner_user_id=$2 WHERE id=$1',[host,target],()=>create('host-race'),404);
  expect((await db.pool.query('SELECT id FROM project_folders')).rows).toHaveLength(0);
 });
 it('disables/enables with idempotent receipts independent of an arbitrary request Space',async()=>{
  __setAuthIdentityForTests({spaceId:randomUUID(),userId:owner});
  for(const action of ['disable','enable'] as const){
   const first=await account(action,action);expect(first.statusCode,first.body).toBe(200);
   expect((await account(action,action)).json()).toEqual(first.json());
   expect((await db.pool.query('SELECT status FROM users WHERE id=$1',[target])).rows[0].status).toBe(action==='disable'?'disabled':'active');
  }
  expect((await db.pool.query('SELECT state,space_id FROM operation_idempotency ORDER BY operation_id')).rows).toEqual([{state:'succeeded',space_id:space},{state:'succeeded',space_id:space}]);
 });
 it('rejects self-disable and pending registration, and withholds replay after admin demotion',async()=>{
  expect((await account('disable','self',owner)).statusCode).toBe(422);
  await db.pool.query("UPDATE users SET status='pending' WHERE id=$1",[target]);
  for(const action of ['disable','enable'] as const)expect((await account(action,action)).statusCode).toBe(422);
  await emptyReceipts();await db.pool.query("UPDATE users SET status='active' WHERE id=$1",[target]);
  expect((await account('disable','disable')).statusCode).toBe(200);
  await db.pool.query("UPDATE users SET email='demoted@test.invalid' WHERE id=$1",[owner]);
  expect((await account('disable','disable')).statusCode).toBe(404);
 });
 it('rolls back account status and receipt on late audit failure',async()=>{
  await rejectAudit(async()=>{expect((await account('disable','rollback')).statusCode).toBe(503);expect((await db.pool.query('SELECT status FROM users WHERE id=$1',[target])).rows[0].status).toBe('active');await emptyReceipts();});
  expect((await account('disable','rollback')).statusCode).toBe(200);
 });
 it('waits for admin revocation before changing another account',async()=>{
  await blockedMutation("UPDATE users SET email='demoted@test.invalid' WHERE id=$1",[owner],()=>account('disable','admin-race'),404);
  expect((await db.pool.query('SELECT status FROM users WHERE id=$1',[target])).rows[0].status).toBe('active');await emptyReceipts();
 });
 it('atomically revokes retained grants, pending invitations and sessions; enable never restores consent',async()=>{
  const {grant,invitation}=await retainedConsent();
  await rejectAudit(async()=>{
   expect((await account('disable','consent')).statusCode).toBe(503);
   expect((await db.pool.query('SELECT revoked_at FROM room_agent_access_grants WHERE id=$1',[grant])).rows[0].revoked_at).toBeNull();
   expect((await db.pool.query('SELECT status FROM room_user_invitations WHERE id=$1',[invitation])).rows[0].status).toBe('pending');
   expect((await db.pool.query('SELECT id FROM user_sessions WHERE user_id=$1',[target])).rows).toHaveLength(1);
  });
  const results=await Promise.all([account('disable','consent'),account('disable','consent')]);
  expect(results.some(r=>r.statusCode===200)).toBe(true);
  for(const result of results)if(result.statusCode!==200)expect(result.json()).toMatchObject({error:{code:'idempotency_in_progress'}});
  expect((await account('disable','consent')).json()).toEqual(results.find(r=>r.statusCode===200)!.json());
  expect((await db.pool.query('SELECT revoked_at FROM room_agent_access_grants WHERE id=$1',[grant])).rows[0].revoked_at).not.toBeNull();
  expect((await db.pool.query('SELECT status FROM room_user_invitations WHERE id=$1',[invitation])).rows[0].status).toBe('invalidated');
  expect((await db.pool.query('SELECT id FROM user_sessions WHERE user_id=$1',[target])).rows).toHaveLength(0);
  expect((await account('enable','enable')).statusCode).toBe(200);
  expect((await db.pool.query('SELECT revoked_at FROM room_agent_access_grants WHERE id=$1',[grant])).rows[0].revoked_at).not.toBeNull();
  expect((await db.pool.query('SELECT status FROM room_user_invitations WHERE id=$1',[invitation])).rows[0].status).toBe('invalidated');
 });
 it('takes retained destination Project roots before disabling its Agent owner',async()=>{
  const {destination}=await retainedConsent();
  await blockedMutation('SELECT id FROM projects WHERE id=$1 FOR UPDATE',[destination],()=>account('disable','project-lock'),200);
  expect((await db.pool.query('SELECT revoked_at FROM room_agent_access_grants')).rows[0].revoked_at).not.toBeNull();
 });

 it('reauthorizes Project writer, active Folder and account on cached create output',async()=>{
  expect((await create('create')).statusCode).toBe(201);
  await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,target]);
  await db.pool.query("UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2",[space,owner]);
  expect((await create('create')).statusCode).toBe(404);
  await db.pool.query('UPDATE projects SET owner_user_id=$2 WHERE id=$1',[project,owner]);
  await db.pool.query("UPDATE project_folders SET status='archived' WHERE project_id=$1",[project]);
  expect((await create('create')).statusCode).toBe(404);
  await db.pool.query("UPDATE project_folders SET status='active' WHERE project_id=$1",[project]);
  await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1",[owner]);
  expect((await create('create')).statusCode).toBe(404);
 });
 it('rolls back Location removal and its receipt on late audit failure',async()=>{
  const created=await create('create');expect(created.statusCode,created.body).toBe(201);const location=created.json().data.id;
  await rejectAudit(async()=>{
   expect((await remove(location,'rollback-remove')).statusCode).toBe(503);
   expect((await db.pool.query('SELECT id FROM workspace_locations WHERE id=$1',[location])).rows).toHaveLength(1);
   expect((await db.pool.query("SELECT idempotency_key FROM operation_idempotency WHERE operation_id='host.workspace.remove'")).rows).toHaveLength(0);
  });
  expect((await remove(location,'rollback-remove')).statusCode).toBe(200);
 });

});
