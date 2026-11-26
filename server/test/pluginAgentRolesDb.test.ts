import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceMember, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {agentRolesModule} from '../src/modules/agentRoles/index.js';
import {agentsModule} from '../src/modules/agents/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {assertPluginProjectTarget} from '../src/modules/plugins/projectBindings.js';
import {PgSessionRepository} from '../src/modules/sessions/repository.js';
import {seedRun} from './support/domainSeeds.js';
import type {OperationActor} from '@rainver/protocol';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {assertPluginRoleAgentAdmitted} from '../src/modules/plugins/agentRoleAdmission.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import pg from 'pg';
import {unbindPluginProject} from '../src/modules/plugins/projectBindings.js';
import {sessionActor} from '../src/modules/systemActions/operations/actor.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {contentReadSql} from '../src/modules/access/contentAccessSql.js';
import {RoomRosterService} from '../src/modules/rooms/rosterService.js';
import {PgRoomRepository} from '../src/modules/rooms/repository.js';
import {seedAgentWithVersion} from './support/domainSeeds.js';

/**
 * An official plugin's Agent Role (`RainverPlugin.agentRoles`) is loaded by the
 * core into the Role library beside the catalog's, only while the plugin is
 * enabled for the viewer, and instantiates an ordinary Agent with its own prompt.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'phd_application';
const roleId = `${pid}.assistant`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let space: string, owner: string, project: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.agentRoles, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toHaveLength(1);
  await migrateOperationPlugin(db.pool, plugin);
});
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project, spaceType: 'team'});
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, agentsModule, agentRolesModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  __setAuthIdentityForTests({spaceId: space, userId: owner});
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });

const listTool = 'plugin.phd_application.application.list';

/** A plugin companion Agent (created from the plugin's Role) with a running Run in a Room conversation of the bound Project. */
async function companion(grants: string[]) {
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  await db.pool.query(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'bound',$5,now(),now(),now())`, [randomUUID(), pid, space, project, owner]);
  const agent = randomUUID(); const run = randomUUID(); const room = randomUUID();
  await seedRun(db.pool, {id: run, space, owner, agent, version: randomUUID()});
  await db.pool.query(`UPDATE agents SET source_role_id=$2, source_role_version_id=$4, access_project_id=$3 WHERE id=$1`, [agent, roleId, project, `${roleId}:v1`]);
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, project, owner]);
  await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',now(),now())`, [randomUUID(), space, room, owner]);
  await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, agent]);
  const session = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: project, project_folder_id: null, title: 'Applications', metadata: {}});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,session_id=$4,permission_snapshot_json=$5::jsonb WHERE id=$1`,
    [run, owner, project, session.id, JSON.stringify({tool_grants: grants.map(action_id => ({action_id}))})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, run]);
  const actor: OperationActor = {principal: {kind: 'agent', id: agent}, on_behalf_of_user_id: owner, agent_id: agent, run_id: run, origin: 'manual', effective_origin: 'manual', root_run_id: run, continuation_hops: 0, surface: 'agent_tool', space_id: space};
  const current = async () => (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]!;
  return {agent, run, room, session, actor, current};
}

describe('plugin-contributed Agent Roles', () => {
  it('lists and instantiates the plugin Role only from its bound Project while the plugin is enabled', async (ctx) => {
    if (!db.available) return ctx.skip();
    // The plugin's page asks with its Project; the global library (no Project) never lists it.
    const ids = async (query = `?project_id=${project}`) => ((await app.inject({method: 'GET', url: `/api/v1/agent-roles${query}`})).json() as Array<{id: string}>).map(role => role.id);
    await db.pool.query(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'bound',$5,now(),now(),now())`, [randomUUID(), pid, space, project, owner]);
    expect(await ids()).not.toContain(roleId);
    expect((await app.inject({method: 'GET', url: `/api/v1/agent-roles/${roleId}?project_id=${project}`})).statusCode).toBe(404);

    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    expect(await ids()).toContain(roleId);
    expect(await ids('')).not.toContain(roleId);
    const detail = (await app.inject({method: 'GET', url: `/api/v1/agent-roles/${roleId}?project_id=${project}`})).json();
    expect(detail).toMatchObject({id: roleId, name: 'PhD Application Assistant', source_plugin_id: pid});

    // Created from the Role with the Project prefilled, as the plugin page does.
    const created = await app.inject({method: 'POST', url: `/api/v1/agent-roles/${roleId}/agents`, headers: {'idempotency-key': randomUUID()}, payload: {project_id: project}});
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json().data.agent_id as string;
    const row = (await db.pool.query(`SELECT a.source_role_id, a.access_project_id, a.visibility, v.system_prompt
      FROM agents a JOIN agent_versions v ON v.id=a.current_version_id WHERE a.id=$1`, [agentId])).rows[0];
    expect(row).toMatchObject({source_role_id: roleId, access_project_id: project, visibility: 'space_shared'});
    expect((await db.pool.query(`SELECT status FROM project_agent_links WHERE project_id=$1 AND agent_id=$2`, [project, agentId])).rows[0]?.status).toBe('active');
    expect(row.system_prompt).toContain('PhD Application Assistant');
    // The Agents list answers by Role, so a setup page finds this one past any number of other Agents.
    const byRole = async (role: string) => ((await app.inject({method: 'GET', url: `/api/v1/agents?source_role_id=${encodeURIComponent(role)}&limit=1&offset=0`})).json() as Array<{id: string}>).map(agent => agent.id);
    await seedRun(db.pool, {id: randomUUID(), space, owner, agent: randomUUID(), version: randomUUID()});
    expect(await byRole(roleId)).toEqual([agentId]);
    expect(await byRole('research_reader')).toEqual([]);

    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect(await ids()).not.toContain(roleId);
    // The Agent already created is kept.
    expect((await db.pool.query(`SELECT status FROM agents WHERE id=$1`, [agentId])).rows[0]?.status).toBe('active');
  });

  it('lets an Agent from another Project use the plugin only while the Room execution authority holds, at every entry', async (ctx) => {
    if (!db.available) return ctx.skip();
    const home = randomUUID(); const issuer = randomUUID(); const caller = randomUUID(); const successor = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Home','active',now(),now())`, [home, space, owner]);
    for (const user of [issuer, caller, successor]) {
      await seedSpaceMember(db.pool, {space, user});
      await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
    }
    await db.pool.query(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'bound',$5,now(),now(),now())`, [randomUUID(), pid, space, project, owner]);
    const agent = randomUUID(); const run = randomUUID(); const room = randomUUID();
    await seedRun(db.pool, {id: run, space, owner: issuer, agent, version: randomUUID()});
    await db.pool.query(`UPDATE agents SET access_project_id=$2, owner_user_id=$3 WHERE id=$1`, [agent, home, issuer]);
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, project, issuer]);
    const joinRoom = (user: string, role = 'member') => db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, room, user, role]);
    await joinRoom(issuer, 'owner');
    const session = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: project, project_folder_id: null, title: 'Applications', metadata: {}});
    await db.pool.query(`UPDATE runs SET session_id=$2, project_id=$3 WHERE id=$1`, [run, session.id, project]);
    const actor: OperationActor = {principal: {kind: 'agent', id: agent}, on_behalf_of_user_id: caller, agent_id: agent, run_id: run, origin: 'manual', effective_origin: 'manual', root_run_id: run, continuation_hops: 0, surface: 'agent_tool', space_id: space};
    const manifest = plugin.operationManifest!;
    const allowed = async () => {
      await expect(assertPluginProjectTarget(db.pool, manifest, actor, project, 'query')).resolves.toBeUndefined();
      // The result release path: the same gate, with the binding locked.
      await expect(withTransaction(db.pool, tx => assertPluginProjectTarget(tx, manifest, actor, project, 'query', {lockBinding: true}))).resolves.toBeUndefined();
    };
    const refused = async () => {
      await expect(assertPluginProjectTarget(db.pool, manifest, actor, project, 'query')).rejects.toMatchObject({code: 'operation_not_found'});
      await expect(withTransaction(db.pool, tx => assertPluginProjectTarget(tx, manifest, actor, project, 'query', {lockBinding: true}))).rejects.toMatchObject({code: 'operation_not_found'});
    };
    // Its home Project is another: not found until this Project's Room authorizes it.
    await refused();
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, agent]);
    await refused();
    const grant = randomUUID();
    await db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,now())`, [grant, space, room, agent, caller, issuer]);
    // A grant alone does not admit somebody who is not in the Room.
    await refused();
    await joinRoom(caller);
    await allowed();
    // Never another Project than its Run's.
    await expect(assertPluginProjectTarget(db.pool, manifest, actor, home, 'query')).rejects.toMatchObject({code: 'operation_not_found'});

    // Each live condition refuses the next call on its own, and restoring it admits again.
    const cases: Array<[string, string, string]> = [
      ['the caller leaves the Room', `UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id='${caller}'`, `UPDATE room_user_members SET status='active' WHERE room_id=$1 AND user_id='${caller}'`],
      ['the Agent is removed from the Room', `UPDATE room_agent_members SET status='removed' WHERE room_id=$1`, `UPDATE room_agent_members SET status='active' WHERE room_id=$1`],
      ['the Agent changes owner', `UPDATE agents SET owner_user_id='${successor}' WHERE id='${agent}' AND $1::varchar IS NOT NULL`, `UPDATE agents SET owner_user_id='${issuer}' WHERE id='${agent}' AND $1::varchar IS NOT NULL`],
      ['the issuer no longer manages the Project', `UPDATE project_members SET role='viewer' WHERE project_id='${project}' AND user_id='${issuer}' AND $1::varchar IS NOT NULL`, `UPDATE project_members SET role='member' WHERE project_id='${project}' AND user_id='${issuer}' AND $1::varchar IS NOT NULL`],
      ['the issuer leaves the Room', `UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id='${issuer}'`, `UPDATE room_user_members SET status='active' WHERE room_id=$1 AND user_id='${issuer}'`],
      ['the grant is revoked', `UPDATE room_agent_access_grants SET revoked_at=now() WHERE room_id=$1`, `UPDATE room_agent_access_grants SET revoked_at=NULL WHERE room_id=$1`],
      ['the plugin is unbound from the Project', `UPDATE official_plugin_project_bindings SET status='unbound' WHERE project_id='${project}' AND $1::varchar IS NOT NULL`, `UPDATE official_plugin_project_bindings SET status='bound' WHERE project_id='${project}' AND $1::varchar IS NOT NULL`],
    ];
    for (const [label, revoke, restore] of cases) {
      await db.pool.query(revoke, [room]);
      await refused().catch(error => { throw new Error(`${label}: ${String(error)}`); });
      await db.pool.query(restore, [room]);
      await allowed();
    }

    // The Run's conversation was frozen to an audience the caller is not in.
    await db.pool.query(`INSERT INTO room_conversation_audiences (session_id,space_id,room_id,project_id,frozen_by_invitation_id,created_at) VALUES ($1,$2,$3,$4,NULL,now())`, [session.id, space, room, project]);
    await db.pool.query(`INSERT INTO room_conversation_audience_members (space_id,session_id,user_id,created_at) VALUES ($1,$2,$3,now())`, [space, session.id, issuer]);
    await refused();
    await db.pool.query(`INSERT INTO room_conversation_audience_members (space_id,session_id,user_id,created_at) VALUES ($1,$2,$3,now())`, [space, session.id, caller]);
    await allowed();
  });

  it.each(['an ordinary', 'a plugin companion'] as const)('authorizes %s Agent Run by its resolved Room and conversation, with or without a Run Group', async (kind, ctx) => {
    if (!db.available) return ctx.skip();
    const home = randomUUID(); const issuer = randomUUID(); const caller = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Home','active',now(),now())`, [home, space, owner]);
    for (const user of [issuer, caller]) {
      await seedSpaceMember(db.pool, {space, user});
      await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
    }
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    await db.pool.query(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,'bound',$5,now(),now(),now())`, [randomUUID(), pid, space, project, owner]);
    // The issuer's private Agent from another Project: the caller cannot read it, only use it through a Room grant.
    const agent = randomUUID(); const run = randomUUID(); const room = randomUUID();
    await seedRun(db.pool, {id: run, space, owner: issuer, agent, version: randomUUID()});
    await db.pool.query(`UPDATE agents SET access_project_id=$2, visibility='private' WHERE id=$1`, [agent, home]);
    if (kind === 'a plugin companion') await db.pool.query(`UPDATE agents SET source_role_id=$2, source_role_version_id=$3 WHERE id=$1`, [agent, roleId, `${roleId}:v1`]);
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, project, issuer]);
    for (const [user, role] of [[issuer, 'owner'], [caller, 'member']]) {
      await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, room, user, role]);
    }
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, agent]);
    await db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,now())`, [randomUUID(), space, room, agent, caller, issuer]);
    const session = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: project, project_folder_id: null, title: 'Applications', metadata: {}});
    await db.pool.query(`UPDATE runs SET status='queued',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,session_id=$4 WHERE id=$1`, [run, caller, project, session.id]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'queued',now(),now())`, [randomUUID(), space, run]);
    const runs = new PgRunRepository(db.pool, config);
    const current = async () => (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]!;
    // The dispatch check and the locked claim decide alike; a started claim is put back in the queue.
    const decision = async () => {
      const dispatch = await runs.checkRunExecutionAuthorization(await current());
      const claimed = await runs.claimRunExecution({run_id: run, space_id: space, started_at: new Date().toISOString()});
      await db.pool.query(`UPDATE runs SET status='queued', started_at=NULL WHERE id=$1`, [run]);
      await db.pool.query(`UPDATE run_attempts SET status='queued', started_at=NULL WHERE run_id=$1`, [run]);
      return {dispatch: dispatch.allowed, claim: claimed.outcome === 'started'};
    };
    const admitted = {dispatch: true, claim: true};
    const refused = {dispatch: false, claim: false};
    const sql = (text: string) => db.pool.query(text, []);
    const group = randomUUID(); const message = randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Help',0,'/',now())`, [message, space, session.id, caller]);
    await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Turn','Help','active',now(),now())`,
      [group, space, caller, room, session.id, message, project]);

    for (const grouped of [false, true]) {
      const at = grouped ? 'with a Run Group' : 'without a Run Group';
      await db.pool.query(`UPDATE runs SET run_group_id=$2 WHERE id=$1`, [run, grouped ? group : null]);
      // The Room grant alone admits the cross-Project caller.
      expect(await decision(), `grant only, ${at}`).toEqual(admitted);
      const cases: Array<[string, string, string]> = [
        ['the grant is revoked', `UPDATE room_agent_access_grants SET revoked_at=now() WHERE room_id='${room}'`, `UPDATE room_agent_access_grants SET revoked_at=NULL WHERE room_id='${room}'`],
        ['the issuer leaves the Room', `UPDATE room_user_members SET status='removed' WHERE room_id='${room}' AND user_id='${issuer}'`, `UPDATE room_user_members SET status='active' WHERE room_id='${room}' AND user_id='${issuer}'`],
        ['the caller leaves the Room', `UPDATE room_user_members SET status='removed' WHERE room_id='${room}' AND user_id='${caller}'`, `UPDATE room_user_members SET status='active' WHERE room_id='${room}' AND user_id='${caller}'`],
        ['the Agent leaves the Room', `UPDATE room_agent_members SET status='removed' WHERE room_id='${room}'`, `UPDATE room_agent_members SET status='active' WHERE room_id='${room}'`],
      ];
      for (const [label, revoke, restore] of cases) {
        await sql(revoke);
        expect(await decision(), `${label}, ${at}`).toEqual(refused);
        await sql(restore);
        expect(await decision(), `${label} restored, ${at}`).toEqual(admitted);
      }
      // Reading the Agent is not using it in this Room: readable but cross-Project, with the grant revoked;
      // readable in this Project but no longer in the Room; or the Room conversation frozen without the caller.
      await sql(`UPDATE agents SET visibility='space_shared' WHERE id='${agent}'`);
      await sql(`UPDATE room_agent_access_grants SET revoked_at=now() WHERE room_id='${room}'`);
      expect(await decision(), `readable, cross-Project, no grant, ${at}`).toEqual(refused);
      await sql(`UPDATE agents SET access_project_id=NULL WHERE id='${agent}'`);
      expect(await decision(), `readable in this Project, ${at}`).toEqual(admitted);
      await sql(`UPDATE room_agent_members SET status='removed' WHERE room_id='${room}'`);
      expect(await decision(), `readable, not in the Room, ${at}`).toEqual(refused);
      await sql(`UPDATE room_agent_members SET status='active' WHERE room_id='${room}'`);
      await sql(`UPDATE room_user_members SET status='removed' WHERE room_id='${room}' AND user_id='${caller}'`);
      expect(await decision(), `readable, caller not in the Room, ${at}`).toEqual(refused);
      await sql(`UPDATE room_user_members SET status='active' WHERE room_id='${room}' AND user_id='${caller}'`);
      await db.pool.query(`INSERT INTO room_conversation_audiences (session_id,space_id,room_id,project_id,frozen_by_invitation_id,created_at) VALUES ($1,$2,$3,$4,NULL,now())`, [session.id, space, room, project]);
      await db.pool.query(`INSERT INTO room_conversation_audience_members (space_id,session_id,user_id,created_at) VALUES ($1,$2,$3,now())`, [space, session.id, issuer]);
      expect(await decision(), `readable, audience frozen without the caller, ${at}`).toEqual(refused);
      await db.pool.query(`DELETE FROM room_conversation_audience_members WHERE session_id=$1`, [session.id]);
      await db.pool.query(`DELETE FROM room_conversation_audiences WHERE session_id=$1`, [session.id]);
      // Back to the issuer's private cross-Project Agent and its grant.
      await sql(`UPDATE agents SET visibility='private', access_project_id='${home}' WHERE id='${agent}'`);
      await sql(`UPDATE room_agent_access_grants SET revoked_at=NULL WHERE room_id='${room}'`);
    }
    // The Room grant never reads the Agent: its content stays the issuer's.
    expect((await db.pool.query(`SELECT 1 FROM agents agent WHERE agent.id=$1 AND ${contentReadSql('agent', 'agent', '$2')}`, [agent, caller])).rows).toHaveLength(0);
  });

  it('bounds a Run by its own conversation audience, and by its Run Group conversation only when it has none', async (ctx) => {
    if (!db.available) return ctx.skip();
    const other = randomUUID();
    await seedSpaceMember(db.pool, {space, user: other});
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, other]);
    const agent = randomUUID(); const run = randomUUID(); const room = randomUUID();
    await seedRun(db.pool, {id: run, space, owner, agent, version: randomUUID()});
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, project, owner]);
    for (const [user, role] of [[owner, 'owner'], [other, 'member']]) {
      await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, room, user, role]);
    }
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, agent]);
    // Two conversations of the same Room: one for the Run itself, and the one its Run Group was started in.
    const sessions = new PgSessionRepository(db.pool);
    const own = await sessions.createRoomConversation({space_id: space, room_id: room, project_id: project, project_folder_id: null, title: 'Own', metadata: {}});
    const groupSession = await sessions.createRoomConversation({space_id: space, room_id: room, project_id: project, project_folder_id: null, title: 'Group', metadata: {}});
    const message = randomUUID(); const group = randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Help',0,'/',now())`, [message, space, groupSession.id, owner]);
    await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Turn','Help','active',now(),now())`,
      [group, space, owner, room, groupSession.id, message, project]);
    await db.pool.query(`UPDATE runs SET status='queued',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,session_id=NULL,run_group_id=$4 WHERE id=$1`, [run, owner, project, group]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'queued',now(),now())`, [randomUUID(), space, run]);
    // With each of its key columns (Run Group, Space, conversation, Project) set, the composite Run Group
    // foreign key holds a grouped Run to its Run Group's own conversation: another one of the Room is refused.
    await expect(db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [run, own.id])).rejects.toMatchObject({constraint: 'runs_run_group_scope_fkey'});
    const runs = new PgRunRepository(db.pool, config);
    const current = async () => (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]!;
    const decision = async () => {
      const dispatch = await runs.checkRunExecutionAuthorization(await current());
      const claimed = await runs.claimRunExecution({run_id: run, space_id: space, started_at: new Date().toISOString()});
      await db.pool.query(`UPDATE runs SET status='queued', started_at=NULL WHERE id=$1`, [run]);
      await db.pool.query(`UPDATE run_attempts SET status='queued', started_at=NULL WHERE run_id=$1`, [run]);
      return {dispatch: dispatch.allowed, claim: claimed.outcome === 'started'};
    };
    // A proposed Run (not stored) naming its own conversation beside its Run Group's: resolved the same way.
    const proposed = async () => (await runs.checkRunExecutionAuthorization({...await current(), session_id: own.id})).allowed;
    // Freeze a conversation to exactly these people.
    const freeze = async (session: string, members: string[]) => {
      await db.pool.query(`DELETE FROM room_conversation_audience_members WHERE session_id=$1`, [session]);
      await db.pool.query(`DELETE FROM room_conversation_audiences WHERE session_id=$1`, [session]);
      await db.pool.query(`INSERT INTO room_conversation_audiences (session_id,space_id,room_id,project_id,frozen_by_invitation_id,created_at) VALUES ($1,$2,$3,$4,NULL,now())`, [session, space, room, project]);
      for (const user of members) await db.pool.query(`INSERT INTO room_conversation_audience_members (space_id,session_id,user_id,created_at) VALUES ($1,$2,$3,now())`, [space, session, user]);
    };

    // The Run's own conversation decides, whatever its Run Group's says.
    await freeze(own.id, [owner]);
    await freeze(groupSession.id, [other]);
    expect(await proposed(), 'own conversation includes the instructor, the Group one does not').toBe(true);
    await freeze(own.id, [other]);
    await freeze(groupSession.id, [owner]);
    expect(await proposed(), 'own conversation excludes the instructor, the Group one includes them').toBe(false);
    // With no conversation of its own the Run Group's bounds dispatch and claim alike.
    expect(await decision(), 'no own conversation, the Group one includes the instructor').toEqual({dispatch: true, claim: true});
    await freeze(groupSession.id, [other]);
    expect(await decision(), 'no own conversation, the Group one excludes the instructor').toEqual({dispatch: false, claim: false});
  });

  it('admits a plugin companion Agent only in a bound Project Room with the plugin enabled, tool call or not', async (ctx) => {
    if (!db.available) return ctx.skip();
    const {agent, run, room, session, actor, current} = await companion([listTool]);
    const runs = new PgRunRepository(db.pool, config);
    // Dispatch/claim admission, and the same admission at the Agent's next operation, whatever it is.
    const admission = async () => {
      const dispatch = await runs.checkRunExecutionAuthorization(await current());
      const operation = await assertPluginRoleAgentAdmitted(db.pool, config, actor).then(() => null, (error: {details?: () => unknown; toJSON?: unknown} & Record<string, unknown>) => error);
      return {dispatch: dispatch.allowed ? 'allowed' : dispatch.error_code, operation: operation === null ? 'allowed' : JSON.stringify(operation)};
    };
    const expectRefused = async (code: string) => {
      const {dispatch, operation} = await admission();
      expect(dispatch).toBe(code);
      expect(operation).not.toBe('allowed');
    };
    expect(await admission()).toEqual({dispatch: 'allowed', operation: 'allowed'});

    // Outside a Project: a direct chat or Run of its own.
    await db.pool.query(`UPDATE runs SET project_id=NULL, session_id=NULL WHERE id=$1`, [run]);
    await expectRefused('plugin_agent_project_required');
    // In the Project but in no Room of it.
    await db.pool.query(`UPDATE runs SET project_id=$2 WHERE id=$1`, [run, project]);
    await expectRefused('plugin_agent_room_unauthorized');
    await db.pool.query(`UPDATE runs SET session_id=$2 WHERE id=$1`, [run, session.id]);
    expect(await admission()).toEqual({dispatch: 'allowed', operation: 'allowed'});

    const cases: Array<[string, string, string]> = [
      ['plugin_agent_project_unbound', `UPDATE official_plugin_project_bindings SET status='unbound' WHERE project_id=$1`, `UPDATE official_plugin_project_bindings SET status='bound' WHERE project_id=$1`],
      ['plugin_agent_project_unavailable', `UPDATE projects SET status='archived' WHERE id=$1`, `UPDATE projects SET status='active' WHERE id=$1`],
      ['plugin_agent_room_unauthorized', `UPDATE room_agent_members SET status='removed' WHERE agent_id='${agent}' AND $1::varchar IS NOT NULL`, `UPDATE room_agent_members SET status='active' WHERE agent_id='${agent}' AND $1::varchar IS NOT NULL`],
      ['plugin_agent_room_unauthorized', `UPDATE room_user_members SET status='removed' WHERE user_id='${owner}' AND room_id='${room}' AND $1::varchar IS NOT NULL`, `UPDATE room_user_members SET status='active' WHERE user_id='${owner}' AND room_id='${room}' AND $1::varchar IS NOT NULL`],
    ];
    for (const [code, revoke, restore] of cases) {
      await db.pool.query(revoke, [project]);
      await expectRefused(code).catch(error => { throw new Error(`${revoke}: ${String(error)}`); });
      await db.pool.query(restore, [project]);
      expect(await admission()).toEqual({dispatch: 'allowed', operation: 'allowed'});
    }
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    await expectRefused('plugin_agent_plugin_disabled');
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));

    // An Agent's Run that is already going on stops at its next action after an unbind, plugin tool or not.
    const call = async (name: string) => (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(await current(), {id: randomUUID(), name, arguments: {project_id: project}})) as OperationToolResponse;
    expect((await call(listTool)).httpStatus).toBe(200);
    await db.pool.query(`UPDATE official_plugin_project_bindings SET status='unbound' WHERE project_id=$1`, [project]);
    const refused = await call(listTool);
    expect(refused.httpStatus).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('plugin_agent_project_unbound');

    // Any other Agent keeps working outside a Project: only the companion is confined.
    await db.pool.query(`UPDATE agents SET source_role_id=NULL, source_role_version_id=NULL WHERE id=$1`, [agent]);
    await db.pool.query(`UPDATE runs SET project_id=NULL, session_id=NULL WHERE id=$1`, [run]);
    expect(await admission()).toEqual({dispatch: 'allowed', operation: 'allowed'});
  });
  it('claims a companion Run with or without a Run Group, under the plugin scope and binding until it is running', async (ctx) => {
    if (!db.available) return ctx.skip();
    const {run, room, session} = await companion([listTool]);
    const runs = new PgRunRepository(db.pool, config);
    const queue = async () => {
      await db.pool.query(`UPDATE runs SET status='queued', started_at=NULL WHERE id=$1`, [run]);
      await db.pool.query(`UPDATE run_attempts SET status='queued', started_at=NULL WHERE run_id=$1`, [run]);
    };
    const claim = () => runs.claimRunExecution({run_id: run, space_id: space, started_at: new Date().toISOString()})
      .then(claimed => claimed.outcome === 'authorization_rejected' ? claimed.error_code : claimed.outcome);
    const setBinding = (status: 'bound' | 'unbound') => db.pool.query(`UPDATE official_plugin_project_bindings SET status=$2 WHERE project_id=$1`, [project, status]);
    const decided = async () => {
      await queue();
      expect(await claim()).toBe('started');
      await queue();
      await setBinding('unbound');
      expect(await claim()).toBe('plugin_agent_project_unbound');
      await setBinding('bound');
    };
    // No Run Group: the Room is its conversation's.
    await decided();
    // A Room turn's Run Group: the same Room, the same decision.
    const group = randomUUID(); const message = randomUUID();
    await db.pool.query(`INSERT INTO messages(id,space_id,session_id,user_id,role,content,path_depth,branch_path,created_at) VALUES($1,$2,$3,$4,'user','Help',0,'/',now())`, [message, space, session.id, owner]);
    await db.pool.query(`INSERT INTO agent_run_groups(id,space_id,manager_user_id,room_id,session_id,trigger_message_id,project_id,title,goal,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'Turn','Help','active',now(),now())`,
      [group, space, owner, room, session.id, message, project]);
    await db.pool.query(`UPDATE runs SET run_group_id=$2 WHERE id=$1`, [run, group]);
    await decided();

    // An unbind or a disable still open when the claim decides: the claim waits for it, then refuses.
    const owners = sessionActor({spaceId: space, userId: owner});
    const withdrawals: Array<[string, (holder: pg.Client) => Promise<unknown>, () => Promise<unknown>]> = [
      ['plugin_agent_project_unbound', holder => unbindPluginProject(holder, config, owners, pid, project), () => setBinding('bound')],
      ['plugin_agent_plugin_disabled', holder => pluginServiceFor(config).disablePlugin(holder, pid, space, owner),
        () => withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}))],
    ];
    for (const [code, withdraw, restore] of withdrawals) {
      await queue();
      const holder = new pg.Client({connectionString: db.connectionUri});
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await withdraw(holder);
        const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        let settled = false;
        const claiming = claim().finally(() => { settled = true; });
        await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
        expect(settled, `${code}: the claim did not wait for the open withdrawal`).toBe(false);
        await holder.query('COMMIT');
        expect(await claiming).toBe(code);
      } finally { await holder.end(); }
      expect((await db.pool.query<{status: string}>('SELECT status FROM runs WHERE id=$1', [run])).rows[0]?.status).toBe('queued');
      await restore();
    }
    await queue();
    expect(await claim()).toBe('started');
  });

  it('refuses a companion gateway action and command after an unbind, a command racing it included; another Agent keeps both', async (ctx) => {
    if (!db.available) return ctx.skip();
    const {agent, current} = await companion(['conversation.search', 'task.create']);
    const call = async (name: string, args: Record<string, unknown>) =>
      new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(await current(), {id: randomUUID(), name, arguments: args});
    const tasks = async () => (await db.pool.query<{n: number}>('SELECT count(*)::int AS n FROM tasks WHERE project_id=$1', [project])).rows[0]!.n;
    const searched = await call('conversation.search', {query: 'Applications'}) as Record<string, unknown>;
    expect(searched.ok, JSON.stringify(searched)).toBe(true);
    const created = await call('task.create', {title: 'Before'}) as OperationToolResponse;
    expect(created.httpStatus, JSON.stringify(created.body)).toBe(201);
    expect(await tasks()).toBe(1);

    // The unbind is open when the command is admitted: the command waits in its transaction, then refuses.
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await unbindPluginProject(holder, config, sessionActor({spaceId: space, userId: owner}), pid, project);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const creating = call('task.create', {title: 'Raced'}).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
      expect(settled, 'the command did not wait for the open unbind').toBe(false);
      await holder.query('COMMIT');
      const raced = await creating as OperationToolResponse;
      expect(raced.httpStatus, JSON.stringify(raced.body)).toBe(409);
      expect(JSON.stringify(raced.body)).toContain('plugin_agent_project_unbound');
    } finally { await holder.end(); }
    expect(await tasks()).toBe(1);

    // Unbound: a gateway action refuses at the dispatcher, a command before anything runs.
    const gateway = await call('conversation.search', {query: 'Applications'}) as Record<string, unknown>;
    expect(gateway).toMatchObject({ok: false, error_code: 'plugin_agent_project_unbound'});
    expect(JSON.stringify(gateway)).not.toContain('hits');
    const command = await call('task.create', {title: 'After'}) as OperationToolResponse;
    expect(command.httpStatus).toBe(409);
    expect(await tasks()).toBe(1);

    // Any other Agent is not confined by the plugin's setup: both still work.
    await db.pool.query(`UPDATE agents SET source_role_id=NULL, source_role_version_id=NULL WHERE id=$1`, [agent]);
    expect((await call('conversation.search', {query: 'Applications'}) as Record<string, unknown>).ok).toBe(true);
    expect((await call('task.create', {title: 'Ordinary'}) as OperationToolResponse).httpStatus).toBe(201);
    expect(await tasks()).toBe(2);
  });

  it.each(['same-Project', 'cross-Project'] as const)('withholds a %s companion result whose Room authority is withdrawn after the query and before its release', async (kind, ctx) => {
    if (!db.available) return ctx.skip();
    const {agent, room, session, current} = await companion([listTool]);
    if (kind === 'cross-Project') {
      // Its home Project is another: this Room admits it only through its owner's live grant.
      const home = randomUUID();
      await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Home','active',now(),now())`, [home, space, owner]);
      await db.pool.query(`UPDATE agents SET access_project_id=$2 WHERE id=$1`, [agent, home]);
      await db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$5,now())`, [randomUUID(), space, room, agent, owner]);
    }
    // Another Agent of the Room, whose removal leaves this one's authority intact.
    const bystander = randomUUID();
    await seedAgentWithVersion(db.pool, {agent: bystander, version: randomUUID(), space, owner, name: 'Bystander', now: new Date().toISOString()});
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, bystander]);
    const call = async () => (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(await current(), {id: randomUUID(), name: listTool, arguments: {project_id: project}})) as OperationToolResponse;
    expect((await call()).httpStatus, kind).toBe(200);

    const roster = (holder: pg.PoolClient) => new RoomRosterService(holder);
    const identity = {spaceId: space, userId: owner};
    const freeze = async (holder: pg.PoolClient) => {
      // An audience freeze without the instructing person, under the Room writer's lock.
      await new PgRoomRepository(holder).getVisibleRoom(space, owner, room, true);
      await holder.query(`INSERT INTO room_conversation_audiences (session_id,space_id,room_id,project_id,frozen_by_invitation_id,created_at) VALUES ($1,$2,$3,$4,NULL,now())`, [session.id, space, room, project]);
      const other = randomUUID();
      await seedSpaceMember(db.pool, {space, user: other});
      await holder.query(`INSERT INTO room_conversation_audience_members (space_id,session_id,user_id,created_at) VALUES ($1,$2,$3,now())`, [space, session.id, other]);
    };
    const withdrawals: Array<[string, (holder: pg.PoolClient) => Promise<unknown>, number, () => Promise<unknown>]> = [
      ['the Agent is removed from the Room', holder => roster(holder).removeAgent(identity, room, agent), 409,
        () => db.pool.query(`UPDATE room_agent_members SET status='active' WHERE room_id=$1 AND agent_id=$2`, [room, agent])
          .then(() => db.pool.query(`UPDATE room_agent_access_grants SET revoked_at=NULL WHERE room_id=$1`, [room]))],
      ['the conversation is frozen without the person', freeze, 409, async () => {
        await db.pool.query(`DELETE FROM room_conversation_audience_members WHERE session_id=$1`, [session.id]);
        await db.pool.query(`DELETE FROM room_conversation_audiences WHERE session_id=$1`, [session.id]);
      }],
      // Control: a Room write that leaves this Agent authorized is waited for, then the result is released.
      ['another Agent is removed from the Room', holder => roster(holder).removeAgent(identity, room, bystander), 200, async () => {}],
    ];
    for (const [label, withdraw, status, restore] of withdrawals) {
      const at = `${kind}, ${label}`;
      const holder = await db.pool.connect();
      try {
        await holder.query('BEGIN');
        await withdraw(holder);
        const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        let settled = false;
        const calling = call().finally(() => { settled = true; });
        await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
        expect(settled, `${at}: the release did not wait for the open Room write`).toBe(false);
        // The query has run: its transaction is read-only and takes no row lock, so the waiter is the release.
        const waiting = (await db.pool.query<{query: string}>(`SELECT query FROM pg_stat_activity WHERE datname=current_database() AND $1::int = ANY(pg_blocking_pids(pid))`, [holderPid])).rows;
        expect(waiting.map(row => row.query).join('\n'), at).toMatch(/FOR SHARE/);
        await holder.query('COMMIT');
        const result = await calling;
        expect(result.httpStatus, `${at}: ${JSON.stringify(result.body)}`).toBe(status);
        if (status === 409) {
          expect(JSON.stringify(result.body), at).toContain('plugin_agent_room_unauthorized');
          expect(JSON.stringify(result.body), at).not.toContain('items');
        } else expect(JSON.stringify(result.body), at).toContain('items');
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
      }
      await restore();
      expect((await call()).httpStatus, `${at} restored`).toBe(200);
    }
  });
});
