import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {MyAgent, MyAgentsPage, RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedAgentWithVersion, seedSpaceMember, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {agentRolesModule} from '../src/modules/agentRoles/index.js';
import {agentsModule} from '../src/modules/agents/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgAgentChatRepository} from '../src/modules/agents/repository.js';
import {PgRunRepository} from '../src/modules/runs/repository.js';
import {roomAgentUseSql} from '../src/modules/rooms/agentUsageSql.js';
import {applyOperationPluginEnabledIn} from '../src/modules/plugins/lifecycle.js';
import {sessionCookieName} from '../src/modules/auth/identity.js';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {PgProjectRepository} from '../src/modules/projects/repository.js';
import {canReadProject} from '../src/modules/projects/access.js';

/**
 * My Agents (`GET /api/v1/me/agents`): one person's Agents across Spaces,
 * through each Space's own Agent, Project and Room gates; the Project-only
 * creation of a plugin's assistant; and a recoverable stop.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'phd_application';
const roleId = `${pid}.assistant`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
let me: string, other: string, team: string, home: string, project: string, hidden: string;

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.agentRoles, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toHaveLength(1);
  await migrateOperationPlugin(db.pool, plugin);
});
beforeEach(async () => {
  if (!db.available) return;
  me = randomUUID(); other = randomUUID(); team = randomUUID(); home = randomUUID(); project = randomUUID(); hidden = randomUUID();
  // My personal Space, and a team Space `other` owns where I am a member of `project` but not of `hidden`.
  await seedSpaceOwnerProject(db.pool, {space: home, owner: me, project: randomUUID(), spaceName: 'Personal', projectName: 'Mine'});
  await seedSpaceOwnerProject(db.pool, {space: team, owner: other, project, spaceName: 'Team', spaceType: 'team', projectName: 'Applications'});
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), team, me]);
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), team, project, me]);
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Secret plans','active',now(),now())`, [hidden, team, other]);
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, agentsModule, agentRolesModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  __setAuthIdentityForTests({spaceId: home, userId: me});
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });

const as = (spaceId: string, userId: string) => __setAuthIdentityForTests({spaceId, userId});
async function mine(query = ''): Promise<MyAgentsPage> {
  const response = await app.inject({method: 'GET', url: `/api/v1/me/agents${query}`});
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as MyAgentsPage;
}
const byName = (page: MyAgentsPage) => Object.fromEntries(page.items.map(item => [item.name, item])) as Record<string, MyAgent>;

async function agent(space: string, owner: string, name: string, patch: {visibility?: string; access_project_id?: string; source_role_id?: string} = {}) {
  const id = randomUUID();
  await seedAgentWithVersion(db.pool, {agent: id, version: randomUUID(), space, owner, name});
  if (patch.visibility) await db.pool.query(`UPDATE agents SET visibility=$2 WHERE id=$1`, [id, patch.visibility]);
  if (patch.access_project_id) await db.pool.query(`UPDATE agents SET access_project_id=$2 WHERE id=$1`, [id, patch.access_project_id]);
  if (patch.source_role_id) await db.pool.query(`UPDATE agents SET source_role_id=$2, source_role_version_id=$3 WHERE id=$1`, [id, patch.source_role_id, `${patch.source_role_id}:v1`]);
  return id;
}
async function room(space: string, projectId: string, title: string, people: string[]) {
  const id = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [id, space, projectId, people[0], title]);
  for (const user of people) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, id, user]);
  return id;
}
async function seat(space: string, roomId: string, agentId: string, grant?: {to: string; by: string}) {
  await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, roomId, agentId]);
  if (grant) await db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,now())`, [randomUUID(), space, roomId, agentId, grant.to, grant.by]);
}
const bind = (projectId: string, status = 'bound') => db.pool.query(`INSERT INTO official_plugin_project_bindings (id,plugin_id,space_id,project_id,status,bound_by_user_id,bound_at,created_at,updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,now(),now(),now())`, [randomUUID(), pid, team, projectId, status, other]);

describe('My Agents across Spaces', () => {
  it('lists every Agent the person reads or a Room lets them use, and names only what they can open', async (ctx) => {
    if (!db.available) return ctx.skip();
    const own = await agent(home, me, 'Own helper');
    const shared = await agent(team, other, 'Team helper');
    const privateOther = await agent(team, other, 'Private helper', {visibility: 'private', access_project_id: project});
    const elsewhere = await agent(team, other, 'Hidden helper', {visibility: 'private', access_project_id: hidden});
    const main = await room(team, project, 'Mainline', [other, me]);
    const second = await room(team, project, 'Drafts', [other, me]);
    const secret = await room(team, hidden, 'Secret room', [other]);
    await seat(team, main, shared);
    await seat(team, second, shared);
    await seat(team, secret, shared);
    // A private Agent of someone else: used only through the Room grant its owner gave me.
    await seat(team, main, privateOther, {to: me, by: other});
    await seat(team, secret, elsewhere);

    const page = await mine();
    const items = byName(page);
    expect(Object.keys(items).sort()).toEqual(['Own helper', 'Private helper', 'Team helper']);
    expect(page.total).toBe(3);
    expect(items['Own helper']).toMatchObject({agent_id: own, space_id: home, space_name: 'Personal', access: 'owner', management: 'manage',
      can_open_detail: true, can_direct_chat: true, usable_room_count: 0, locations: []});
    // Shared with me in another Space: two Rooms of the one Project I read; the Room in a Project I do not read is not named.
    expect(items['Team helper']).toMatchObject({space_name: 'Team', access: 'shared', management: 'owner_only', can_open_detail: true, usable_room_count: 2});
    expect(items['Team helper']!.locations).toEqual([{project_id: project, project_name: 'Applications', plugin_state: null,
      rooms: [{room_id: main, title: 'Mainline', is_mainline: false}, {room_id: second, title: 'Drafts', is_mainline: false}]}]);
    // Room-only: its name and my Room, nothing of its definition or home.
    expect(items['Private helper']).toMatchObject({access: 'room_only', management: 'room_only', description: null, home_project: null,
      can_open_detail: false, can_direct_chat: false, usable_room_count: 1});
    expect(JSON.stringify(page)).not.toContain('Secret');

    expect((await mine('?manage=manageable')).items.map(item => item.name)).toEqual(['Own helper']);
    expect((await mine('?source=mine')).items.map(item => item.name)).toEqual(['Own helper']);
    expect((await mine('?source=shared')).items.map(item => item.name)).toEqual(['Team helper']);
    expect((await mine('?source=room_only')).items.map(item => item.name)).toEqual(['Private helper']);
    expect((await app.inject({method: 'GET', url: '/api/v1/me/agents?source=everything'})).statusCode).toBe(422);

    // The grant's owner withdraws it: the Room-only entry disappears with it.
    await db.pool.query(`UPDATE room_agent_access_grants SET revoked_at=now() WHERE agent_id=$1`, [privateOther]);
    expect(byName(await mine())['Private helper']).toBeUndefined();
    // Leaving the Space ends every entry from it.
    await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [team, me]);
    expect((await mine()).items.map(item => item.name)).toEqual(['Own helper']);
  });

  it('answers whether the viewer manages an Agent the way every mutation decides it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const shared = await agent(team, other, 'Team helper');
    as(team, me);
    expect((await app.inject({method: 'GET', url: `/api/v1/agents/${shared}`})).json()).toMatchObject({can_manage: false});
    const refused = await app.inject({method: 'PATCH', url: `/api/v1/agents/${shared}`, headers: {'idempotency-key': randomUUID()}, payload: {status: 'disabled'}});
    expect(refused.statusCode).toBe(404);
    as(team, other);
    expect((await app.inject({method: 'GET', url: `/api/v1/agents/${shared}`})).json()).toMatchObject({can_manage: true});
    // An unowned, system-managed Agent is the Space owner/admin's.
    await db.pool.query(`UPDATE agents SET owner_user_id=NULL WHERE id=$1`, [shared]);
    expect((await app.inject({method: 'GET', url: `/api/v1/agents/${shared}`})).json()).toMatchObject({can_manage: true});
    as(home, me);
    expect(byName(await mine())['Team helper']).toMatchObject({management: 'space_admin_only'});
  });

  it('stops an Agent everywhere and restores it under current authority, keeping its configuration and places', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, helper);
    await db.pool.query(`INSERT INTO project_agent_links (id,space_id,project_id,agent_id,status,added_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',$5,now(),now())`, [randomUUID(), team, project, helper, other]);
    const version = (await db.pool.query<{current_version_id: string}>(`SELECT current_version_id FROM agents WHERE id=$1`, [helper])).rows[0]!.current_version_id;
    const usable = async () => (await db.pool.query(`SELECT 1 FROM agents a WHERE a.id=$1 AND ${roomAgentUseSql('a', '$2', '$3')}`, [helper, me, main])).rows.length > 0;
    expect(await usable()).toBe(true);

    as(team, other);
    const stop = await app.inject({method: 'PATCH', url: `/api/v1/agents/${helper}`, headers: {'idempotency-key': randomUUID()}, payload: {status: 'disabled'}});
    expect(stop.statusCode, stop.body).toBe(200);
    // New requests refuse from every entry: direct chat, Rooms, any new Run.
    expect(await new PgAgentChatRepository(db.pool).getAgentForChat(team, other, helper)).toBeNull();
    expect(await usable()).toBe(false);
    await expect(new PgRunRepository(db.pool).createQueuedRun({execution_kind: 'agent', space_id: team, agent_id: helper, user_id: other,
      mode: 'live', run_type: 'agent', trigger_origin: 'manual'})).rejects.toMatchObject({statusCode: 409, message: expect.stringContaining('is not active')});
    // Its configuration, Room seat and Project link are kept; it stays listed for those who still reach it.
    expect((await db.pool.query(`SELECT current_version_id FROM agents WHERE id=$1`, [helper])).rows[0]!.current_version_id).toBe(version);
    expect((await db.pool.query(`SELECT status FROM room_agent_members WHERE agent_id=$1`, [helper])).rows[0]!.status).toBe('active');
    expect((await db.pool.query(`SELECT status FROM project_agent_links WHERE agent_id=$1`, [helper])).rows[0]!.status).toBe('active');
    as(home, me);
    expect(byName(await mine())['Team helper']).toMatchObject({status: 'disabled', usable_room_count: 0, can_direct_chat: false, locations: []});

    as(team, other);
    const restore = await app.inject({method: 'PATCH', url: `/api/v1/agents/${helper}`, headers: {'idempotency-key': randomUUID()}, payload: {status: 'active'}});
    expect(restore.statusCode, restore.body).toBe(200);
    expect(await usable()).toBe(true);
    // Restoring follows the authority that holds now: I left the Room meanwhile, so it is not usable for me there.
    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`, [main, me]);
    as(home, me);
    expect(byName(await mine())['Team helper']).toMatchObject({status: 'active', usable_room_count: 0});
    // Removing it from one Room is not stopping it.
    await db.pool.query(`UPDATE room_agent_members SET status='removed' WHERE agent_id=$1`, [helper]);
    expect((await db.pool.query(`SELECT status FROM agents WHERE id=$1`, [helper])).rows[0]!.status).toBe('active');
  });

  it('counts a plugin Agent usable only where its plugin is set up, Room by Room', async (ctx) => {
    if (!db.available) return ctx.skip();
    const second = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Backup','active',now(),now())`, [second, team, other]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), team, second, me]);
    const assistant = await agent(team, other, 'Applications assistant', {source_role_id: roleId, access_project_id: project});
    const a = await room(team, project, 'Mainline', [other, me]);
    const b = await room(team, second, 'Backup room', [other, me]);
    await seat(team, a, assistant);
    await seat(team, b, assistant, {to: me, by: other});
    await bind(project);
    await bind(second, 'unbound');

    // Not enabled for me yet: nowhere usable, but still listed with where it sits.
    let item = byName(await mine())['Applications assistant']!;
    expect(item).toMatchObject({plugin_id: pid, can_direct_chat: false, usable_room_count: 0});
    expect(item.locations.map(location => location.plugin_state)).toEqual(['disabled', 'disabled']);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, me, {}));
    item = byName(await mine())['Applications assistant']!;
    expect(item.usable_room_count).toBe(1);
    expect(Object.fromEntries(item.locations.map(location => [location.project_name, location.plugin_state]))).toEqual({Applications: 'ready', Backup: 'unbound'});
    expect(item.home_project).toMatchObject({project_id: project, plugin_state: 'ready'});
    expect((await mine('?source=plugin')).items.map(entry => entry.name)).toEqual(['Applications assistant']);
  });
});

describe('a plugin assistant is created only from its bound Project', () => {
  const ids = async (query = '') => ((await app.inject({method: 'GET', url: `/api/v1/agent-roles${query}`})).json() as Array<{id: string}>).map(role => role.id);
  const create = (payload: Record<string, unknown>) => app.inject({method: 'POST', url: `/api/v1/agent-roles/${roleId}/agents`, headers: {'idempotency-key': randomUUID()}, payload});

  it('offers and creates it only with a readable, bound Project where the plugin is enabled, by a Project writer', async (ctx) => {
    if (!db.available) return ctx.skip();
    as(team, other);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, other, {}));
    // The global Role library and New Agent never offer it.
    expect(await ids()).not.toContain(roleId);
    expect((await app.inject({method: 'GET', url: `/api/v1/agent-roles/${roleId}`})).statusCode).toBe(404);
    // Even in the person's own Space, without a Project there is nowhere to set it up.
    as(home, me);
    const unplaced = await create({});
    expect(unplaced.statusCode, unplaced.body).toBe(422);
    as(team, other);
    // A Project the plugin is not bound to has no such Role.
    expect(await ids(`?project_id=${project}`)).not.toContain(roleId);
    expect((await create({project_id: project})).statusCode).toBe(404);

    await bind(project);
    expect(await ids(`?project_id=${project}`)).toContain(roleId);
    expect((await app.inject({method: 'GET', url: `/api/v1/agent-roles/${roleId}?project_id=${project}`})).statusCode).toBe(200);
    const created = await create({project_id: project});
    expect(created.statusCode, created.body).toBe(201);

    // Someone who only reads the Project, or for whom the plugin is off, cannot create it.
    const viewer = randomUUID();
    await seedSpaceMember(db.pool, {space: team, user: viewer});
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), team, project, viewer]);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, viewer, {}));
    as(team, viewer);
    expect((await create({project_id: project})).statusCode).toBe(404);
    // A Project the person cannot read offers nothing, even bound and with the plugin on.
    as(team, me);
    await bind(hidden);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, me, {}));
    expect(await ids(`?project_id=${project}`)).toContain(roleId);
    expect(await ids(`?project_id=${hidden}`)).not.toContain(roleId);
    expect((await create({project_id: hidden})).statusCode).toBe(404);
    // With the plugin off for them, a Project writer finds no such Role either.
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, team, me));
    expect(await ids(`?project_id=${project}`)).not.toContain(roleId);
    expect((await create({project_id: project})).statusCode).toBe(404);
  });
});

/** Wait until some other backend of this test database is blocked on a lock. */
async function lockWaiters(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const waiting = (await db.pool.query<{n: string}>(`SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0]!.n;
    if (Number(waiting) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('no backend ever waited on a lock');
}
/** The stop's own transaction (`agent.update`'s Agent row lock, then the write), left open. */
async function openStop(agentId: string): Promise<PoolClient> {
  const tx = await db.pool.connect();
  await tx.query('BEGIN');
  await tx.query(`SELECT id FROM agents WHERE id=$1 FOR UPDATE`, [agentId]);
  await tx.query(`UPDATE agents SET status='disabled', updated_at=now() WHERE id=$1`, [agentId]);
  return tx;
}
const runInput = (agentId: string, user: string) => ({execution_kind: 'agent' as const, space_id: team, agent_id: agentId, user_id: user,
  mode: 'live', run_type: 'agent', trigger_origin: 'manual'});

describe('a stop shares one lock boundary with Run admission', () => {
  it('a stop committed while a Run is being queued refuses it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const stop = await openStop(helper);
    try {
      const queued = new PgRunRepository(db.pool).createQueuedRun(runInput(helper, other)).then(() => 'queued', (error: {statusCode?: number}) => error.statusCode);
      await lockWaiters();
      await stop.query('COMMIT');
      expect(await queued).toBe(409);
    } finally { await stop.query('ROLLBACK').catch(() => {}); stop.release(); }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM runs WHERE agent_id=$1`, [helper])).rows[0]!.n).toBe(0);
  });

  it('a stop waits for a Run being queued in its transaction', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const enqueue = await db.pool.connect();
    const stop = await db.pool.connect();
    try {
      await enqueue.query('BEGIN');
      await new PgRunRepository(enqueue).createQueuedRun(runInput(helper, other));
      await stop.query('BEGIN');
      await stop.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(stop.query(`SELECT id FROM agents WHERE id=$1 FOR UPDATE`, [helper])).rejects.toMatchObject({code: '55P03'});
      await stop.query('ROLLBACK');
      await enqueue.query('COMMIT');
    } finally {
      await enqueue.query('ROLLBACK').catch(() => {}); await stop.query('ROLLBACK').catch(() => {});
      enqueue.release(); stop.release();
    }
  });

  it('a queued direct Run whose Agent is stopped during its claim is not started', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const run = await new PgRunRepository(db.pool).createQueuedRun(runInput(helper, other));
    const stop = await openStop(helper);
    try {
      const claim = new PgRunRepository(db.pool).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()});
      await lockWaiters();
      await stop.query('COMMIT');
      expect(await claim).toMatchObject({outcome: 'authorization_rejected', error_code: 'agent_not_active'});
    } finally { await stop.query('ROLLBACK').catch(() => {}); stop.release(); }
    expect((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [run.id])).rows[0]!.status).toBe('queued');
  });

  it('a queued Room Run whose Agent is stopped during its claim is not started', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, helper);
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,project_id,room_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Room chat','active',now(),now())`, [session, team, project, main]);
    const run = await new PgRunRepository(db.pool).createQueuedRun({...runInput(helper, me), project_id: project, session_id: session});
    const stop = await openStop(helper);
    try {
      const claim = new PgRunRepository(db.pool).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()});
      await lockWaiters();
      await stop.query('COMMIT');
      expect(await claim).toMatchObject({outcome: 'authorization_rejected', error_code: 'agent_not_active'});
    } finally { await stop.query('ROLLBACK').catch(() => {}); stop.release(); }
    expect((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [run.id])).rows[0]!.status).toBe('queued');
  });

  it('a claim that holds the Agent first starts the Run, and the stop waits for it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const helper = await agent(team, other, 'Team helper');
    const run = await new PgRunRepository(db.pool).createQueuedRun(runInput(helper, other));
    // Routed as the orchestrator does before claim: the Agent's default Runtime Profile.
    await db.pool.query(`UPDATE runs r SET runtime_profile_id=p.id, runtime_profile_selection_source='default', runtime_key=p.runtime_key,
        runtime_profile_snapshot_json='{"backend_mode":"runtime_native"}'::jsonb
       FROM agent_runtime_profiles p WHERE r.id=$1 AND p.agent_id=r.agent_id AND p.is_default`, [run.id]);
    const claim = await db.pool.connect();
    const stop = await db.pool.connect();
    try {
      await claim.query('BEGIN');
      const claimed = await new PgRunRepository(claim).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()});
      expect(claimed.outcome).toBe('started');
      await stop.query('BEGIN');
      await stop.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(stop.query(`SELECT id FROM agents WHERE id=$1 FOR UPDATE`, [helper])).rejects.toMatchObject({code: '55P03'});
      await stop.query('ROLLBACK');
      await claim.query('COMMIT');
    } finally {
      await claim.query('ROLLBACK').catch(() => {}); await stop.query('ROLLBACK').catch(() => {});
      claim.release(); stop.release();
    }
    expect((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [run.id])).rows[0]!.status).toBe('running');
  });
});

describe('an archive shares the Project lock with a Room Run claim', () => {
  /**
   * A queued Run in a Room conversation of `project`, routed as the orchestrator routes it before claim.
   * `runProject` is the Project the Run names: the Room's, none, or (`stored`, a record from before
   * enqueue refused it) another one.
   */
  async function queuedRoomRun(runProject: {id: string | null; stored?: boolean} = {id: project}, helper?: string) {
    helper ??= await agent(team, other, 'Team helper');
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, helper);
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,project_id,room_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Room chat','active',now(),now())`, [session, team, project, main]);
    const run = await new PgRunRepository(db.pool).createQueuedRun({...runInput(helper, me), project_id: runProject.stored ? project : runProject.id, session_id: session});
    if (runProject.stored) await db.pool.query(`UPDATE runs SET project_id=$2 WHERE id=$1`, [run.id, runProject.id]);
    await db.pool.query(`UPDATE runs r SET runtime_profile_id=p.id, runtime_profile_selection_source='default', runtime_key=p.runtime_key,
        runtime_profile_snapshot_json='{"backend_mode":"runtime_native"}'::jsonb
       FROM agent_runtime_profiles p WHERE r.id=$1 AND p.agent_id=r.agent_id AND p.is_default`, [run.id]);
    return run;
  }
  /** A second active Project of the team Space that `me` works in too. */
  async function secondProject() {
    const second = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Backup','active',now(),now())`, [second, team, other]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), team, second, me]);
    return second;
  }
  const claimOf = (runId: string, client: {query: PoolClient['query']} = db.pool) =>
    new PgRunRepository(client as PoolClient, config).claimRunExecution({run_id: runId, space_id: team, started_at: new Date().toISOString()});
  const statusOf = async (runId: string) => (await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [runId])).rows[0]!.status;
  const archiveIdentity = () => ({spaceId: team, userId: other});

  it('an archive committed while a queued Room Run is being claimed refuses it, and the archive stays readable', async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = await queuedRoomRun();
    const archive = await db.pool.connect();
    try {
      await archive.query('BEGIN');
      // The real archive entry, its transaction left open.
      await new PgProjectRepository(archive).archive(archiveIdentity(), project);
      const claim = new PgRunRepository(db.pool).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()});
      await lockWaiters();
      await archive.query('COMMIT');
      expect(await claim).toMatchObject({outcome: 'authorization_rejected', error_code: 'project_not_active'});
    } finally { await archive.query('ROLLBACK').catch(() => {}); archive.release(); }
    expect((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [run.id])).rows[0]!.status).toBe('queued');
    expect((await db.pool.query(`SELECT status FROM projects WHERE id=$1`, [project])).rows[0]!.status).toBe('archived');
    // Its members still read the archived Project's history.
    expect(await canReadProject(db.pool, team, project, me)).toBe(true);
    expect(await canReadProject(db.pool, team, project, other)).toBe(true);
  });

  it('a claim that holds the Project first starts the Run, and the archive waits for it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = await queuedRoomRun();
    const claim = await db.pool.connect();
    const archive = await db.pool.connect();
    try {
      await claim.query('BEGIN');
      expect((await new PgRunRepository(claim).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()})).outcome).toBe('started');
      await archive.query('BEGIN');
      await archive.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(new PgProjectRepository(archive).archive(archiveIdentity(), project)).rejects.toMatchObject({code: '55P03'});
      await archive.query('ROLLBACK');
      await claim.query('COMMIT');
    } finally {
      await claim.query('ROLLBACK').catch(() => {}); await archive.query('ROLLBACK').catch(() => {});
      claim.release(); archive.release();
    }
    expect((await db.pool.query(`SELECT status FROM runs WHERE id=$1`, [run.id])).rows[0]!.status).toBe('running');
  });

  it('a Room Run queued before an archive is never started after it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const run = await queuedRoomRun();
    await new PgProjectRepository(db.pool).archive(archiveIdentity(), project);
    expect(await new PgRunRepository(db.pool).claimRunExecution({run_id: run.id, space_id: team, started_at: new Date().toISOString()}))
      .toMatchObject({outcome: 'authorization_rejected', error_code: 'project_not_active'});
  });

  it('a Room Run naming no Project takes its Room\'s Project lock: an archive committed meanwhile refuses it, one that waits lets it start', async (ctx) => {
    if (!db.available) return ctx.skip();
    const refusedRun = await queuedRoomRun({id: null});
    expect((await db.pool.query(`SELECT project_id FROM runs WHERE id=$1`, [refusedRun.id])).rows[0]!.project_id).toBeNull();
    const archive = await db.pool.connect();
    try {
      await archive.query('BEGIN');
      await new PgProjectRepository(archive).archive(archiveIdentity(), project);
      const claim = claimOf(refusedRun.id);
      await lockWaiters();
      await archive.query('COMMIT');
      expect(await claim).toMatchObject({outcome: 'authorization_rejected', error_code: 'project_not_active'});
    } finally { await archive.query('ROLLBACK').catch(() => {}); archive.release(); }
    expect(await statusOf(refusedRun.id)).toBe('queued');
    await db.pool.query(`UPDATE projects SET status='active', archived_at=NULL WHERE id=$1`, [project]);

    const startedRun = await queuedRoomRun({id: null});
    const claim = await db.pool.connect();
    const later = await db.pool.connect();
    try {
      await claim.query('BEGIN');
      expect((await claimOf(startedRun.id, claim)).outcome).toBe('started');
      await later.query('BEGIN');
      await later.query(`SET LOCAL lock_timeout = '300ms'`);
      await expect(new PgProjectRepository(later).archive(archiveIdentity(), project)).rejects.toMatchObject({code: '55P03'});
      await later.query('ROLLBACK');
      await claim.query('COMMIT');
    } finally {
      await claim.query('ROLLBACK').catch(() => {}); await later.query('ROLLBACK').catch(() => {});
      claim.release(); later.release();
    }
    expect(await statusOf(startedRun.id)).toBe('running');
  });

  it('a stored Room Run naming another Project waits on its Room\'s Project lock and is never started', async (ctx) => {
    if (!db.available) return ctx.skip();
    const second = await secondProject();
    const run = await queuedRoomRun({id: second, stored: true});
    // Its claim waits for an archive of the Room's Project, not of the Project it names.
    const archive = await db.pool.connect();
    try {
      await archive.query('BEGIN');
      await new PgProjectRepository(archive).archive(archiveIdentity(), project);
      const claim = claimOf(run.id);
      await lockWaiters();
      await archive.query('ROLLBACK');
      // Both Projects active and readable: the mismatch alone refuses it.
      expect(await claim).toMatchObject({outcome: 'authorization_rejected', error_code: 'run_project_mismatch'});
    } finally { await archive.query('ROLLBACK').catch(() => {}); archive.release(); }
    expect(await statusOf(run.id)).toBe('queued');
  });

  it('refuses to queue a Room Run that names a Project other than its Room\'s', async (ctx) => {
    if (!db.available) return ctx.skip();
    const second = await secondProject();
    const helper = await agent(team, other, 'Team helper');
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, helper);
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,project_id,room_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Room chat','active',now(),now())`, [session, team, project, main]);
    await expect(new PgRunRepository(db.pool).createQueuedRun({...runInput(helper, me), project_id: second, session_id: session}))
      .rejects.toMatchObject({statusCode: 409});
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM runs WHERE agent_id=$1`, [helper])).rows[0]!.n).toBe(0);
  });

  it('a plugin assistant set up in the Room\'s Project is not admitted by a Run naming no Project or another set-up one', async (ctx) => {
    if (!db.available) return ctx.skip();
    const second = await secondProject();
    const assistant = await agent(team, other, 'Applications assistant', {source_role_id: roleId});
    await bind(project);
    await bind(second);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, me, {}));
    // In its Room's Project the plugin is ready, so the same Run naming that Project starts.
    const admitted = await queuedRoomRun({id: project}, assistant);
    expect((await claimOf(admitted.id)).outcome).toBe('started');
    const none = await queuedRoomRun({id: null}, assistant);
    expect(await claimOf(none.id)).toMatchObject({outcome: 'authorization_rejected', error_code: 'plugin_agent_project_required'});
    const elsewhere = await queuedRoomRun({id: second, stored: true}, assistant);
    expect(await claimOf(elsewhere.id)).toMatchObject({outcome: 'authorization_rejected', error_code: 'run_project_mismatch'});
    expect([await statusOf(none.id), await statusOf(elsewhere.id)]).toEqual(['queued', 'queued']);
  });
});

describe('a plugin disable and an assistant creation take one lock order', () => {
  it('a disable committed while the assistant is being created refuses the creation', async (ctx) => {
    if (!db.available) return ctx.skip();
    as(team, other);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, other, {}));
    await bind(project);
    const disable = await db.pool.connect();
    try {
      await disable.query('BEGIN');
      await applyOperationPluginEnabledIn(disable, config, pid, team, other, false, {});
      const created = app.inject({method: 'POST', url: `/api/v1/agent-roles/${roleId}/agents`, headers: {'idempotency-key': randomUUID()}, payload: {project_id: project}});
      await lockWaiters();
      await disable.query('COMMIT');
      const response = await created;
      expect(response.statusCode, response.body).toBe(404);
    } finally { await disable.query('ROLLBACK').catch(() => {}); disable.release(); }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agents WHERE space_id=$1 AND source_role_id=$2`, [team, roleId])).rows[0]!.n).toBe(0);
  });

  it('an archived Project offers no assistant and admits no Room-only entry', async (ctx) => {
    if (!db.available) return ctx.skip();
    as(team, other);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, other, {}));
    await bind(project);
    const roles = async () => ((await app.inject({method: 'GET', url: `/api/v1/agent-roles?project_id=${project}`})).json() as Array<{id: string}>).map(role => role.id);
    expect(await roles()).toContain(roleId);
    const privateOther = await agent(team, other, 'Private helper', {visibility: 'private', access_project_id: project});
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, privateOther, {to: me, by: other});
    as(home, me);
    expect(byName(await mine())['Private helper']).toMatchObject({access: 'room_only', usable_room_count: 1});

    await db.pool.query(`UPDATE projects SET status='archived' WHERE id=$1`, [project]);
    as(team, other);
    expect(await roles()).not.toContain(roleId);
    as(home, me);
    expect(byName(await mine())['Private helper']).toBeUndefined();
  });
});

describe('a Room-only entry never reveals its plugin source', () => {
  it('omits the plugin id and state, names only usable Rooms, and never matches source=plugin', async (ctx) => {
    if (!db.available) return ctx.skip();
    const assistant = await agent(team, other, 'Applications assistant', {source_role_id: roleId, visibility: 'private', access_project_id: hidden});
    const a = await room(team, project, 'Mainline', [other, me]);
    await seat(team, a, assistant, {to: me, by: other});
    await bind(project);
    // The plugin is off for me: the Room does not work for me, and nothing says why.
    let item = byName(await mine())['Applications assistant']!;
    expect(item).toMatchObject({access: 'room_only', plugin_id: null, usable_room_count: 0, locations: []});
    expect((await mine('?source=plugin')).items).toEqual([]);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, team, me, {}));
    item = byName(await mine())['Applications assistant']!;
    expect(item).toMatchObject({access: 'room_only', plugin_id: null, home_project: null, usable_room_count: 1});
    expect(item.locations.map(location => location.plugin_state)).toEqual([null]);
    expect((await mine('?source=plugin')).items).toEqual([]);
    expect((await mine('?source=room_only')).items.map(entry => entry.name)).toEqual(['Applications assistant']);
  });
});

describe('My Agents pages carry the revision of the list they were cut from', () => {
  it('pages of one list share a revision; a swap, a lost grant or a role change moves it', async (ctx) => {
    if (!db.available) return ctx.skip();
    const first = await agent(home, me, 'Alpha');
    await agent(home, me, 'Bravo');
    await agent(home, me, 'Charlie');
    const last = await agent(home, me, 'Delta');
    const unowned = await agent(team, other, 'Team helper');
    await db.pool.query(`UPDATE agents SET owner_user_id=NULL WHERE id=$1`, [unowned]);
    const privateOther = await agent(team, other, 'Private helper', {visibility: 'private', access_project_id: project});
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, privateOther, {to: me, by: other});
    const pages = async () => Promise.all([0, 2, 4].map(offset => mine(`?limit=2&offset=${offset}`)));

    const before = await pages();
    const revision = before[0]!.revision;
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(before.map(page => page.revision)).toEqual([revision, revision, revision]);
    expect(before.flatMap(page => page.items.map(item => item.name)))
      .toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Private helper', 'Team helper']);
    expect(before.map(page => page.total)).toEqual([6, 6, 6]);
    // The same list read again answers the same revision.
    expect((await mine()).revision).toBe(revision);

    // The first and last entries trade names: the middle pages read the same, the list does not.
    await db.pool.query(`UPDATE agents SET name = CASE WHEN id=$1 THEN 'Delta' ELSE 'Alpha' END WHERE id = ANY($2::varchar[])`, [first, [first, last]]);
    const swapped = (await mine()).revision;
    expect(swapped).not.toBe(revision);
    expect((await mine('?limit=2&offset=2')).items.map(item => item.name)).toEqual(['Charlie', 'Delta']);

    // A role change that keeps every entry in place still changes what the person may do, and the revision.
    await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [team, me]);
    const promoted = await mine();
    expect(byName(promoted)['Team helper']!.management).toBe('manage');
    expect(promoted.total).toBe(6);
    expect(promoted.revision).not.toBe(swapped);

    // A Room grant withdrawn: the Room-only entry is gone at once, and so is the revision.
    await db.pool.query(`DELETE FROM room_agent_access_grants WHERE agent_id=$1`, [privateOther]);
    const revoked = await mine();
    expect(revoked.items.map(item => item.name)).not.toContain('Private helper');
    expect(revoked.total).toBe(5);
    expect(revoked.revision).not.toBe(promoted.revision);
    // Past the end: no entries, the same list's revision and total.
    expect(await mine('?limit=2&offset=10')).toMatchObject({items: [], total: 5, revision: revoked.revision});
  });
});

/** The list as the person sees it, digested as the server does: one JSON array per entry, in order. */
const shownDigest = (items: MyAgent[]) => createHash('sha256').update(`[${items.map(item => `[${[
  item.agent_id, item.space_id, item.space_name, item.name, item.status, item.description, item.access, item.management,
  item.plugin_id, item.home_project?.project_id ?? null, item.home_project?.project_name ?? null,
].map(value => JSON.stringify(value)).join(', ')}]`).join(', ')}]`, 'utf8').digest('hex');

describe('the My Agents revision digests only what the person is shown', () => {
  it('ignores a Room-only entry\'s hidden source, description and home Project', async (ctx) => {
    if (!db.available) return ctx.skip();
    await agent(team, other, 'Team helper');
    const privateOther = await agent(team, other, 'Private helper', {visibility: 'private', access_project_id: project});
    const main = await room(team, project, 'Mainline', [other, me]);
    await seat(team, main, privateOther, {to: me, by: other});
    const before = await mine();
    expect(byName(before)['Private helper']).toMatchObject({access: 'room_only', management: 'room_only', description: null, plugin_id: null, home_project: null});
    const roomOnly = await mine('?source=room_only');
    // What a Room-only person cannot see changes: the Agent's role source, its description and home Project.
    for (const [sql, args] of [
      [`UPDATE agents SET source_role_id=$2, source_role_version_id=$3 WHERE id=$1`, [privateOther, roleId, `${roleId}:v1`]],
      [`UPDATE agents SET source_role_id=$2, source_role_version_id=$3 WHERE id=$1`, [privateOther, 'other_plugin.helper', 'other_plugin.helper:v1']],
      [`UPDATE agents SET description=$2 WHERE id=$1`, [privateOther, 'Reads the secret plans']],
      [`UPDATE agents SET access_project_id=$2 WHERE id=$1`, [privateOther, hidden]],
    ] as const) {
      await db.pool.query(sql, [...args]);
      const after = await mine();
      expect(byName(after)['Private helper']).toMatchObject({access: 'room_only', management: 'room_only', description: null, plugin_id: null, home_project: null});
      expect(after.revision).toBe(before.revision);
      expect((await mine('?source=room_only')).revision).toBe(roomOnly.revision);
    }
    // Each revision is exactly the digest of the entries shown, so nothing else can reach it.
    for (const page of [before, roomOnly, await mine()]) expect(page.revision).toBe(shownDigest(page.items));
  });

  it('keeps a null and an empty description, separators and field boundaries apart', async (ctx) => {
    if (!db.available) return ctx.skip();
    const one = await agent(home, me, 'Alpha');
    const two = await agent(home, me, 'Bravo');
    const read = async () => { const page = await mine(); expect(page.revision).toBe(shownDigest(page.items)); return page; };
    const empty = await read();
    expect(empty.items.map(item => item.description)).toEqual([null, null]);
    await db.pool.query(`UPDATE agents SET description='' WHERE id=$1`, [one]);
    const blank = await read();
    expect(byName(blank)['Alpha']!.description).toBe('');
    expect(blank.revision).not.toBe(empty.revision);
    // Text that would join the same under a separator-joined digest stays apart in a structured one.
    await db.pool.query(`UPDATE agents SET description=$2 WHERE id=$1`, [one, `x${String.fromCharCode(31)}y`]);
    await db.pool.query(`UPDATE agents SET description=NULL WHERE id=$1`, [two]);
    const joined = await read();
    await db.pool.query(`UPDATE agents SET description='x' WHERE id=$1`, [one]);
    await db.pool.query(`UPDATE agents SET description=$2 WHERE id=$1`, [two, `${String.fromCharCode(30)}y "quoted" ${String.fromCharCode(31)}`]);
    const split = await read();
    expect(split.revision).not.toBe(joined.revision);
    // The same list read again answers the same revision, and an empty list has one too.
    expect((await read()).revision).toBe(split.revision);
    expect((await mine('?source=shared')).revision).toBe(shownDigest([]));
  });
});

describe('My Agents over a real session ignores the browsed Space', () => {
  it('answers with a stale, left or unknown Space header and with none', async (ctx) => {
    if (!db.available) return ctx.skip();
    __setAuthIdentityForTests(null);
    await agent(home, me, 'Own helper');
    await agent(team, other, 'Team helper');
    const raw = `my-agents-session-${randomUUID()}`;
    await db.pool.query(`INSERT INTO user_sessions (id,user_id,token_hash,created_at,expires_at,updated_at) VALUES ($1,$2,$3,now(),now()+interval '1 day',now())`,
      [randomUUID(), me, createHash('sha256').update(raw).digest('hex')]);
    const cookie = `${sessionCookieName(config)}=${raw}`;
    const get = (headers: Record<string, string> = {}, query = '') => app.inject({method: 'GET', url: `/api/v1/me/agents${query}`, headers: {cookie, ...headers}});
    const names = (response: Awaited<ReturnType<typeof get>>) => {
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as MyAgentsPage).items.map(item => item.name).sort();
    };
    expect(names(await get())).toEqual(['Own helper', 'Team helper']);
    expect(names(await get({'x-rainver-space-id': 'personal'}))).toEqual(['Own helper', 'Team helper']);
    expect(names(await get({'x-rainver-space-id': randomUUID()}))).toEqual(['Own helper', 'Team helper']);
    expect(names(await get({}, `?space_id=${randomUUID()}`))).toEqual(['Own helper', 'Team helper']);
    // Leaving the team Space: its header no longer refuses, and its Agents are gone.
    await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [team, me]);
    expect(names(await get({'x-rainver-space-id': team}))).toEqual(['Own helper']);
    // No session is still refused.
    expect((await app.inject({method: 'GET', url: '/api/v1/me/agents'})).statusCode).toBe(401);
  });

  it('answers a signed-in person with no active Space with an empty page, and still refuses a missing or invalid session', async (ctx) => {
    if (!db.available) return ctx.skip();
    __setAuthIdentityForTests(null);
    const nobody = randomUUID();
    // Once a member of the team Space, now removed: no active Space at all.
    await seedSpaceMember(db.pool, {space: team, user: nobody});
    await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [team, nobody]);
    await agent(team, other, 'Team helper');
    const raw = `my-agents-spaceless-${randomUUID()}`;
    await db.pool.query(`INSERT INTO user_sessions (id,user_id,token_hash,created_at,expires_at,updated_at) VALUES ($1,$2,$3,now(),now()+interval '1 day',now())`,
      [randomUUID(), nobody, createHash('sha256').update(raw).digest('hex')]);
    const get = (cookie?: string, headers: Record<string, string> = {}) =>
      app.inject({method: 'GET', url: '/api/v1/me/agents', headers: {...(cookie ? {cookie} : {}), ...headers}});
    const cookie = `${sessionCookieName(config)}=${raw}`;
    for (const response of [await get(cookie), await get(cookie, {'x-rainver-space-id': team})]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({items: [], total: 0, offset: 0});
    }
    expect((await get()).statusCode).toBe(401);
    expect((await get(`${sessionCookieName(config)}=not-a-session-${randomUUID()}`)).statusCode).toBe(401);
    // An expired session is not a person either.
    await db.pool.query(`UPDATE user_sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1`, [nobody]);
    expect((await get(cookie)).statusCode).toBe(401);
  });
});
