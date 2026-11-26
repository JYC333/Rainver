import {randomUUID} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import type {PluginOperationId, PluginOperationManifest, RainverPlugin} from '@rainver/protocol';
import {operationPackageIdentity} from '../src/modules/plugins/packageIdentity.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {pluginRoleNames, provisionPluginRoles} from '../src/modules/plugins/operationDb.js';
import {pluginRepository} from '../src/modules/plugins/repository.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {getOfficialPlugin} from '../src/modules/plugins/registry.js';
import {withTransaction} from '../src/db/tx.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {PgProposalApplyService} from '../src/modules/proposals/applyService.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import pg from 'pg';
import {bindPluginProject} from '../src/modules/plugins/projectBindings.js';
import {runActor, sessionActor} from '../src/modules/systemActions/operations/actor.js';
import {operationRuntime} from '../src/modules/systemActions/operations/runtime.js';
import {waitForBlockedBy, waitForLockWaiter} from './support/lockWait.js';
import {pruneOperationRequests} from '../src/modules/systemActions/operations/retention.js';
import {operationProposalDecisionHooks} from '../src/modules/systemActions/operations/approvals.js';
import {pluginOperations} from '../src/modules/plugins/operationRegistry.js';
import {PgSessionRepository} from '../src/modules/sessions/repository.js';
import {RoomRosterService} from '../src/modules/rooms/rosterService.js';
import {RoomService} from '../src/modules/rooms/service.js';

/**
 * Project-level operation packages (manifest `project_binding: 'required'`):
 * persistent bindings, the host's Project gate on every entry, unbind/disable
 * retention, Agent Run Project scope and core-port confinement, through the
 * real P1 HTTP and Agent tool entries on real PostgreSQL.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'bind_probe';
const writeId = `plugin.${pid}.record.write` as PluginOperationId;
const listId = `plugin.${pid}.record.list` as PluginOperationId;
const proposeId = `plugin.${pid}.record.propose` as PluginOperationId;
const proposalType = `plugin.${pid}.record.approve`;
const proposeInput = z.object({project_id: z.string(), key: z.string()}).strict();
const manifest: PluginOperationManifest = {
  id: pid, version: '1.0.0', hostApi: 1, scope: 'space', name: 'Binding probe', description: 'Project-bound fixture', requires: [],
  permissions: {agent: true}, data_access: 'caller_owned', project_binding: 'required', entities: [{name: 'record'}], core_ports: ['tasks.create'],
  proposalTypes: [{id: proposalType, operation: proposeId, payload_schema: proposeInput}],
  web: {entries: [{id: 'records', title: 'Records', icon: 'notebook', placements: ['project.area', 'project.overview.card']}]},
  operations: [
    {id: writeId, version: 1, title: 'Write', description: 'Write a Project record', kind: 'command', side_effects: 'durable', data_class: 'non_sensitive',
      input_schema: z.object({project_id: z.string(), key: z.string(), task_project_id: z.string().optional()}).strict(), output_schema: z.object({key: z.string()}).strict(), gate_class: null},
    {id: listId, version: 1, title: 'List', description: 'List Project records', kind: 'query', side_effects: 'none', data_class: 'non_sensitive',
      input_schema: z.object({project_id: z.string()}).strict(), output_schema: z.object({keys: z.array(z.string())}).strict(), gate_class: null},
    {id: proposeId, version: 1, title: 'Propose', description: 'Propose a Project record', kind: 'command', side_effects: 'proposal', data_class: 'non_sensitive',
      input_schema: proposeInput, output_schema: z.object({key: z.string()}).strict(), gate_class: 'direction', proposal_type: proposalType},
  ],
};
const plugin: RainverPlugin = {
  id: pid, version: '1.0.0', operationManifest: manifest,
  activate(ctx) {
    ctx.actions!.register(writeId, async (input, {db: pdb, actor, core}) => {
      const i = input as {project_id: string; key: string; task_project_id?: string};
      // Plugin rows carry the host-authorized Project target from the input.
      await pdb.transaction({spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!}, tx => withQueryableTransaction(tx, j => j.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2)", [`${i.project_id}:${i.key}`, i.project_id])));
      if (i.task_project_id) await core!.tasks!.create({project_id: i.task_project_id, title: 'Bound task'});
      return {key: i.key};
    });
    const insert = async (input: unknown, {db: pdb, actor}: Parameters<Parameters<NonNullable<typeof ctx.actions>['register']>[1]>[1]) => {
      const i = input as {project_id: string; key: string};
      await pdb.transaction({spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!}, tx => withQueryableTransaction(tx, j => j.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2)", [`${i.project_id}:${i.key}`, i.project_id])));
      return {key: i.key};
    };
    ctx.actions!.register(proposeId, insert);
    ctx.lifecycle!.proposals.register(proposalType, insert);
    ctx.actions!.register(listId, async (input, {db: pdb}) => {
      const rows = (await pdb.query<{key: string}>("SELECT key FROM records WHERE space_id=current_setting('rainver.space_id') AND value=$1 ORDER BY key", [(input as {project_id: string}).project_id])).rows;
      return {keys: rows.map(r => r.key.split(':')[1]!)};
    });
    return {activated: true};
  },
};
let host: PluginHost, space: string, owner: string, writer: string, viewer: string, projectA: string, projectB: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
beforeAll(async () => {
  if (!db.available) return;
  await provisionPluginRoles(db.pool, pid);
  const dir = join(import.meta.dirname, 'fixtures/pluginOperation/migrations');
  const sql = readFileSync(join(dir, readdirSync(dir).find(x => x.endsWith('.sql'))!), 'utf8').replaceAll('plugin_operation_probe', `plugin_${pid}`);
  await withTransaction(db.pool, async tx => {
    await tx.query(`SET LOCAL ROLE ${pluginRoleNames(pid).ddl}`);
    for (const part of sql.split('--> statement-breakpoint')) if (part.trim() && !part.trim().startsWith('CREATE SCHEMA')) await tx.query(part);
  });
});
async function addPerson(user: string, projectRole: 'member' | 'viewer' | null) {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [user]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, user]);
  if (projectRole) for (const project of [projectA, projectB]) await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, project, user, projectRole]);
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); writer = randomUUID(); viewer = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: projectA, spaceType: 'team'});
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())`, [projectB, space, owner]);
  await addPerson(writer, 'member');
  await addPerson(viewer, 'viewer');
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  await pluginRepository.upsertInstall(db.pool, {pluginId: pid, installedVersion: '1.0.0', source: 'local', manifest: {operation_api: 1, operation_contract: operationPackageIdentity(plugin)}, actorUserId: owner});
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  as(owner);
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });
const as = (user: string) => __setAuthIdentityForTests({spaceId: space, userId: user});
const action = (id: string, payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': key}, payload});
const query = (id: string, input: Record<string, unknown>) => app.inject({method: 'GET', url: `/api/v1/queries/${id}?input=${encodeURIComponent(JSON.stringify(input))}`});
const bind = (project: string) => action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: project});
const unbind = (project: string) => action('official_plugin.project_binding.unbind', {plugin_id: pid, project_id: project});
const bindings = (project: string) => query('official_plugin.project_binding.list', {project_id: project});
const write = (project: string, key: string, extra: Record<string, unknown> = {}, idem = randomUUID()) => action(writeId, {project_id: project, key, ...extra}, idem);
const keys = async (project: string) => {
  const out = await query(listId, {project_id: project});
  return out.statusCode === 200 ? out.json().data.keys as string[] : out.statusCode;
};
const records = async () => (await db.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM plugin_${pid}.records WHERE space_id=$1`, [space])).rows[0]!.n;
async function agentRun(user: string, project: string | null) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1`,
    [runId, user, project, JSON.stringify({tool_grants: [{action_id: writeId}, {action_id: listId}]})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  return runId;
}
const call = async (runId: string, name: string, args: Record<string, unknown>) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: randomUUID(), name, arguments: args})) as OperationToolResponse;
};

describe('Project-level plugin binding', () => {
  it('declares the binding on the descriptor and refuses every entry until a Project owner-level person binds it', async () => {
    expect(getOfficialPlugin(pid, config)?.project_binding).toBe('required');
    expect((await write(projectA, 'k1')).statusCode).toBe(404);
    expect(await keys(projectA)).toBe(404);
    const listed = await bindings(projectA);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toMatchObject({project_id: projectA, can_manage: true, items: [{plugin_id: pid, status: 'available', plugin_enabled: true, effective: false}]});
    as(writer);
    // A Project writer is not owner level: binding is Project configuration.
    expect((await bind(projectA)).statusCode).toBe(404);
    expect((await bindings(projectA)).json().data.can_manage).toBe(false);
    as(owner);
    const bound = await bind(projectA);
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().data).toMatchObject({plugin_id: pid, project_id: projectA, status: 'bound', bound_by_user_id: owner});
    expect((await bind(projectA)).json().data.status).toBe('bound');
    expect((await db.pool.query(`SELECT event_type, metadata_json->>'project_id' AS project FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type LIKE 'project_%'`, [pid, space])).rows).toEqual([{event_type: 'project_bound', project: projectA}]);
    expect((await db.pool.query(`SELECT action FROM policy_decision_records WHERE space_id=$1 AND action LIKE 'official_plugin.project_binding.%' ORDER BY action`, [space])).rows.map(r => r.action)).toContain('official_plugin.project_binding.manage');
    expect((await write(projectA, 'k1')).statusCode).toBe(200);
    expect(await keys(projectA)).toEqual(['k1']);
    // Bound to A only: B stays closed.
    expect((await write(projectB, 'k2')).statusCode).toBe(404);
    expect(await keys(projectB)).toBe(404);
    // A package without a Project binding declaration cannot be bound.
    expect((await action('official_plugin.project_binding.bind', {plugin_id: 'diary', project_id: projectA})).statusCode).toBe(404);
  });

  it('applies the Project ACL per entry: a viewer reads, a writer writes, a non-member and another Space reach nothing', async () => {
    await bind(projectA);
    as(writer);
    expect((await write(projectA, 'w')).statusCode).toBe(200);
    as(viewer);
    expect(await keys(projectA)).toEqual(['w']);
    expect((await write(projectA, 'v')).statusCode).toBe(404);
    const outsider = randomUUID();
    await addPerson(outsider, null);
    as(outsider);
    expect(await keys(projectA)).toBe(404);
    expect((await bindings(projectA)).statusCode).toBe(404);
    const otherSpace = randomUUID(), otherOwner = randomUUID(), otherProject = randomUUID();
    await seedSpaceOwnerProject(db.pool, {space: otherSpace, owner: otherOwner, project: otherProject, spaceType: 'team'});
    as(owner);
    expect((await write(otherProject, 'x')).statusCode).toBe(404);
    expect((await bind(otherProject)).statusCode).toBe(404);
  });

  it('unbinding one Project stops it, replay included, keeps its data and leaves the other Project working; rebinding restores it', async () => {
    await bind(projectA);
    await bind(projectB);
    const key = randomUUID();
    expect((await write(projectA, 'a1', {}, key)).statusCode).toBe(200);
    expect((await write(projectB, 'b1')).statusCode).toBe(200);
    const unbound = await unbind(projectA);
    expect(unbound.statusCode, unbound.body).toBe(200);
    expect(unbound.json().data).toMatchObject({status: 'unbound', unbound_by_user_id: owner});
    expect((await write(projectA, 'a2')).statusCode).toBe(404);
    // A stored receipt is not released through an unbound Project.
    expect((await write(projectA, 'a1', {}, key)).statusCode).toBe(404);
    expect(await keys(projectA)).toBe(404);
    expect(await keys(projectB)).toEqual(['b1']);
    expect(await records()).toBe(2);
    expect((await bindings(projectA)).json().data.items[0]).toMatchObject({status: 'unbound', effective: false});
    expect((await bind(projectA)).statusCode).toBe(200);
    expect(await keys(projectA)).toEqual(['a1']);
  });

  it('a plugin disable stops every bound Project and keeps the bindings; binding needs current enablement; unbinding does not', async () => {
    await bind(projectA);
    await write(projectA, 'a1');
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await write(projectA, 'a2')).statusCode).toBe(404);
    expect(await keys(projectA)).toBe(404);
    expect((await bindings(projectA)).json().data.items[0]).toMatchObject({status: 'bound', plugin_enabled: false, effective: false});
    expect((await bind(projectB)).statusCode).toBe(409);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    expect(await keys(projectA)).toEqual(['a1']);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await unbind(projectA)).statusCode).toBe(200);
    expect(await records()).toBe(1);
  });

  it('an archived Project keeps reads, refuses writes and binds, and can still be unbound', async () => {
    await bind(projectA);
    await write(projectA, 'a1');
    await db.pool.query(`UPDATE projects SET status='archived' WHERE id=$1`, [projectA]);
    expect(await keys(projectA)).toEqual(['a1']);
    expect((await write(projectA, 'a2')).statusCode).toBe(409);
    expect((await bind(projectB)).statusCode).toBe(200);
    await db.pool.query(`UPDATE projects SET status='archived' WHERE id=$1`, [projectB]);
    await unbind(projectB);
    expect((await bind(projectB)).statusCode).toBe(409);
    expect((await unbind(projectA)).statusCode).toBe(200);
  });

  it('an Agent reaches only its Run Project, under the same binding', async () => {
    await bind(projectA);
    await bind(projectB);
    const run = await agentRun(owner, projectA);
    const made = await call(run, writeId, {project_id: projectA, key: 'agent'});
    expect(made.httpStatus, JSON.stringify(made.body)).toBe(200);
    expect((await call(run, listId, {project_id: projectA})).body.data).toEqual({keys: ['agent']});
    // Bound and readable for the person, yet another Project than the Run's.
    expect((await call(run, writeId, {project_id: projectB, key: 'cross'})).httpStatus).toBe(404);
    expect((await call(run, listId, {project_id: projectB})).httpStatus).toBe(404);
    expect((await call(await agentRun(owner, null), listId, {project_id: projectA})).httpStatus).toBe(404);
    await unbind(projectA);
    expect((await call(run, listId, {project_id: projectA})).httpStatus).toBe(404);
    expect(await records()).toBe(1);
  });

  it('core ports write only into the bound target Project; a mismatch rolls the command back', async () => {
    await bind(projectA);
    await bind(projectB);
    expect((await write(projectA, 'cross', {task_project_id: projectB})).statusCode).toBe(404);
    expect(await records()).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1 AND title='Bound task'`, [space])).rows[0].n).toBe(0);
    expect((await write(projectA, 'same', {task_project_id: projectA})).statusCode).toBe(200);
    expect((await db.pool.query(`SELECT project_id FROM tasks WHERE space_id=$1 AND title='Bound task'`, [space])).rows).toEqual([{project_id: projectA}]);
  });

  it('a proposal submitted while bound does not apply after its Project is unbound, and applies once rebound', async () => {
    await bind(projectA);
    const submitted = await action(proposeId, {project_id: projectA, key: 'proposed'});
    expect(submitted.statusCode, submitted.body).toBe(202);
    const proposal = submitted.json().proposal_id as string;
    await unbind(projectA);
    await expect(PgProposalApplyService.fromConfig(config, host).accept(proposal, {spaceId: space, userId: owner})).rejects.toThrow();
    expect(await records()).toBe(0);
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [proposal])).rows[0].status).toBe('pending');
    await bind(projectA);
    await PgProposalApplyService.fromConfig(config, host).accept(proposal, {spaceId: space, userId: owner});
    expect(await keys(projectA)).toEqual(['proposed']);
  });

  it('concurrent first binds of one Project make one real change and one audit event', async () => {
    const first = new pg.Client({connectionString: db.connectionUri}), second = new pg.Client({connectionString: db.connectionUri});
    await first.connect(); await second.connect();
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      // No binding row exists yet, so nothing serializes the two before the unique key.
      const made = await bindPluginProject(first, config, sessionActor({spaceId: space, userId: owner}), pid, projectA);
      expect(made.status).toBe('bound');
      const firstPid = (await first.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const racing = bindPluginProject(second, config, sessionActor({spaceId: space, userId: owner}), pid, projectA).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, firstPid, {settled: () => settled});
      expect(settled).toBe(false);
      await first.query('COMMIT');
      expect(await racing).toMatchObject({status: 'bound', bound_by_user_id: owner, bound_at: made.bound_at});
      await second.query('COMMIT');
    } finally { await first.end(); await second.end(); }
    expect((await db.pool.query(`SELECT event_type FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type LIKE 'project_%'`, [pid, space])).rows).toEqual([{event_type: 'project_bound'}]);
    // Through the P1 entry as well: a parallel burst against an existing binding records nothing more.
    await unbind(projectA);
    const burst = await Promise.all([bind(projectA), bind(projectA), bind(projectA)]);
    expect(burst.map(r => r.statusCode)).toEqual([200, 200, 200]);
    expect((await db.pool.query(`SELECT event_type FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type LIKE 'project_%' ORDER BY created_at`, [pid, space])).rows.map(r => r.event_type)).toEqual(['project_bound', 'project_unbound', 'project_bound']);
  });

  it('concurrent commands through the Task core port share the Project write fence without deadlocking', async () => {
    await bind(projectA);
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      // Line the commands up behind the install row so they reach the Project gate together.
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM plugin_installs WHERE plugin_id=$1 FOR UPDATE', [pid]);
      let settled = 0;
      const writes = ['c1', 'c2', 'c3', 'c4'].map(k => write(projectA, k, {task_project_id: projectA}).finally(() => { settled++; }));
      await waitForLockWaiter(db.pool, {waiters: 4, settled: () => settled > 0});
      await holder.query('COMMIT');
      const done = await Promise.all(writes);
      expect(done.map(r => r.statusCode), done.map(r => r.body).join('\n')).toEqual([200, 200, 200, 200]);
    } finally { await holder.end(); }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM tasks WHERE space_id=$1 AND project_id=$2 AND title='Bound task'`, [space, projectA])).rows[0].n).toBe(4);
    expect(await records()).toBe(4);
  });

  it('a Space admin outside the Project manages its bindings but neither reads nor writes its plugin data, fresh or replayed', async () => {
    const admin = randomUUID();
    await addPerson(admin, null);
    await db.pool.query(`UPDATE space_memberships SET role='admin' WHERE space_id=$1 AND user_id=$2`, [space, admin]);
    as(admin);
    const listed = await bindings(projectA);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data).toMatchObject({can_manage: true, items: [{status: 'available', plugin_enabled: true, effective: false}]});
    const key = randomUUID();
    const bound = await action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: projectA}, key);
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().data).toMatchObject({status: 'bound', bound_by_user_id: admin});
    // Configuration is theirs; the Project's plugin content is not: not effective, and every entry refuses before plugin code runs.
    expect((await bindings(projectA)).json().data.items[0]).toMatchObject({status: 'bound', effective: false});
    expect((await write(projectA, 'adm')).statusCode).toBe(404);
    expect(await keys(projectA)).toBe(404);
    expect(await records()).toBe(0);
    as(owner);
    expect((await write(projectA, 'own')).statusCode).toBe(200);
    expect((await bindings(projectA)).json().data.items[0]).toMatchObject({effective: true});
    // Once they read the Project (here as a viewer), their Space admin role is Project write, as for core Project content.
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, projectA, admin]);
    as(admin);
    expect((await bindings(projectA)).json().data.items[0]).toMatchObject({effective: true});
    expect((await write(projectA, 'adm')).statusCode).toBe(200);
    expect(await keys(projectA)).toEqual(['adm', 'own']);
    await db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`, [projectA, admin]);
    // Without owner level the stored bind receipt is not replayed, and nothing is managed.
    await db.pool.query(`UPDATE space_memberships SET role='member' WHERE space_id=$1 AND user_id=$2`, [space, admin]);
    expect((await action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: projectA}, key)).statusCode).toBe(404);
    // Neither reader nor owner level any more: the configuration is not even listed.
    expect((await bindings(projectA)).statusCode).toBe(404);
    expect((await unbind(projectA)).statusCode).toBe(404);
  });

  it('a stored proposal.accept receipt replays only while the plugin target stays bound and readable', async () => {
    await bind(projectA);
    const submitted = await action(proposeId, {project_id: projectA, key: 'proposed'});
    expect(submitted.statusCode, submitted.body).toBe(202);
    const proposal = submitted.json().proposal_id as string;
    const key = randomUUID();
    const accept = () => action('proposal.accept', {proposal_id: proposal}, key);
    const accepted = await accept();
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await keys(projectA)).toEqual(['proposed']);
    expect((await accept()).statusCode).toBe(200);
    await unbind(projectA);
    const unboundReplay = await accept();
    expect(unboundReplay.statusCode).toBe(404);
    expect(unboundReplay.body).not.toContain('proposed');
    await bind(projectA);
    expect((await accept()).statusCode).toBe(200);
    // The reviewer (here also the requester) no longer reads the Project: the receipt is withheld again.
    await db.pool.query(`UPDATE projects SET owner_user_id=$2 WHERE id=$1`, [projectA, writer]);
    expect((await accept()).statusCode).toBe(404);
    expect(await records()).toBe(1);
  });

  it('a stored proposal.accept receipt is refused once retention pruned the original plugin request, unbound or not', async () => {
    await bind(projectA);
    const submitted = await action(proposeId, {project_id: projectA, key: 'pruned'});
    expect(submitted.statusCode, submitted.body).toBe(202);
    const proposal = submitted.json().proposal_id as string;
    // The approval request leaves a durable origin marker on its Proposal.
    expect((await db.pool.query('SELECT operation_request_linked FROM proposals WHERE id=$1', [proposal])).rows[0]).toEqual({operation_request_linked: true});
    const key = randomUUID();
    const accept = () => action('proposal.accept', {proposal_id: proposal}, key);
    expect((await accept()).statusCode).toBe(200);
    expect((await accept()).statusCode).toBe(200);
    // Retention reaches the original request first: the accept receipt shares its terminal_at but is pruned separately.
    await db.pool.query(`UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE proposal_id=$1`, [proposal]);
    expect((await pruneOperationRequests(db.pool)).deleted).toBeGreaterThanOrEqual(1);
    expect((await db.pool.query('SELECT 1 FROM operation_idempotency WHERE proposal_id=$1', [proposal])).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM operation_idempotency WHERE operation_id='proposal.accept' AND idempotency_key=$1", [key])).rowCount).toBe(1);
    await unbind(projectA);
    const unboundReplay = await accept();
    expect(unboundReplay.statusCode).toBe(410);
    expect(unboundReplay.json().error.code).toBe('operation_result_unavailable');
    expect(unboundReplay.body).not.toContain('pruned');
    // Without the frozen requester the gate cannot be rechecked, so rebinding does not release it either.
    await bind(projectA);
    expect((await accept()).statusCode).toBe(410);
    expect(await records()).toBe(1);
  });

  it('after retention, replay origin is the durable marker, not a plugin_proposal result type, even with no registration left', async () => {
    await bind(projectA);
    const submitted = await action(proposeId, {project_id: projectA, key: 'origin'});
    const linkedProposal = submitted.json().proposal_id as string;
    expect((await action('proposal.accept', {proposal_id: linkedProposal})).statusCode).toBe(200);
    await db.pool.query(`UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE proposal_id=$1`, [linkedProposal]);
    await pruneOperationRequests(db.pool);
    expect((await db.pool.query('SELECT 1 FROM operation_idempotency WHERE proposal_id=$1', [linkedProposal])).rowCount).toBe(0);
    // A legacy host applier (ctx.proposals.register, e.g. finance_ledger) also returns plugin_proposal.
    const legacyProposal = randomUUID();
    await db.pool.query(`INSERT INTO proposals (id,space_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at,created_by_user_id,owner_user_id)
      VALUES ($1,$2,'finance_ledger.post_directive','accepted','low','normal','Legacy',$3::jsonb,now(),now(),$4,$4)`, [legacyProposal, space, JSON.stringify({book_id: 'b', directive_id: 'd'}), owner]);
    // Uninstalled plugin: no registration can vouch for either Proposal type.
    const hooks = operationProposalDecisionHooks(config, new Map());
    const identity = {spaceId: space, userId: owner};
    const replay = (id: string, resultType: string) => withTransaction(db.pool, tx => hooks.authorizeAcceptReplay!(tx, id, identity, {resultType}));
    await expect(replay(legacyProposal, 'plugin_proposal')).resolves.toBeUndefined();
    await expect(replay(linkedProposal, 'plugin_proposal')).rejects.toMatchObject({code: 'operation_result_unavailable', httpStatus: 410});
    await expect(replay(legacyProposal, 'operation_failure')).rejects.toMatchObject({code: 'operation_result_unavailable', httpStatus: 410});
  });

  it('the assembled proposal.accept replay stays fail-closed for a marked Proposal with no operation registration left, even with an independent applier', async () => {
    await bind(projectA);
    const linkedProposal = (await action(proposeId, {project_id: projectA, key: 'assembled'})).json().proposal_id as string;
    const key = randomUUID();
    expect((await action('proposal.accept', {proposal_id: linkedProposal}, key)).statusCode).toBe(200);
    await db.pool.query(`UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE proposal_id=$1`, [linkedProposal]);
    await pruneOperationRequests(db.pool);
    expect((await db.pool.query('SELECT 1 FROM operation_idempotency WHERE proposal_id=$1', [linkedProposal])).rowCount).toBe(0);
    // The operation package is gone; a legacy host plugin (ctx.proposals.register) independently
    // applies the same type. The real server assembly has an empty Operation registry.
    const applied: string[] = [];
    const legacyPlugin: RainverPlugin = {
      id: 'legacy_probe', version: '1.0.0',
      activate(ctx) {
        ctx.proposals.register(proposalType, async ({proposal}) => { applied.push(proposal.id); });
        return {activated: true};
      },
    };
    const bare = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
    const bareApp = buildModuleServer(bare, [systemActionsModule, runsModule]);
    new PluginHost([legacyPlugin]).activate(bareApp, bare);
    await bareApp.ready();
    try {
      expect(pluginOperations(bare)).toHaveLength(0);
      expect(PgProposalApplyService.fromConfig(bare).supportedProposalTypes().has(proposalType)).toBe(true);
      const bareAction = (id: string, payload: Record<string, unknown>, idem: string) => bareApp.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': idem}, payload});
      const linkedReplay = await bareAction('proposal.accept', {proposal_id: linkedProposal}, key);
      expect(linkedReplay.statusCode, linkedReplay.body).toBe(410);
      expect(linkedReplay.json().error.code).toBe('operation_result_unavailable');
      // An unlinked ordinary Proposal accepted through the same assembly keeps its replay.
      const legacyProposal = randomUUID();
      await db.pool.query(`INSERT INTO proposals (id,space_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at,created_by_user_id,owner_user_id)
        VALUES ($1,$2,'follow_up_task','pending','low','normal','Legacy',$3::jsonb,now(),now(),$4,$4)`, [legacyProposal, space, JSON.stringify({task: {title: 'Legacy follow-up'}}), owner]);
      const legacyKey = randomUUID();
      const first = await bareAction('proposal.accept', {proposal_id: legacyProposal}, legacyKey);
      expect(first.statusCode, first.body).toBe(200);
      const replayed = await bareAction('proposal.accept', {proposal_id: legacyProposal}, legacyKey);
      expect(replayed.statusCode, replayed.body).toBe(200);
      expect(replayed.json()).toEqual(first.json());
      expect(replayed.json().data.result_type).toBe('follow_up_task');
      expect(applied).toEqual([]);
    } finally {
      await bareApp.close();
    }
  });

  it('the proposal origin migration backfills the origin marker from retained requests and the approval payload, never a legacy Proposal', async () => {
    await bind(projectA);
    const retained = (await action(proposeId, {project_id: projectA, key: 'retained'})).json().proposal_id as string;
    const pruned = (await action(proposeId, {project_id: projectA, key: 'pruned'})).json().proposal_id as string;
    // Identified by its retained request alone: its payload no longer has the approval shape.
    const requestOnly = (await action(proposeId, {project_id: projectA, key: 'request-only'})).json().proposal_id as string;
    const legacy = randomUUID();
    await db.pool.query(`INSERT INTO proposals (id,space_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at,created_by_user_id,owner_user_id)
      VALUES ($1,$2,'finance_ledger.post_directive','accepted','low','normal','Legacy',$3::jsonb,now(),now(),$4,$4)`, [legacy, space, JSON.stringify({book_id: 'b', directive_id: 'd', requester: {}}), owner]);
    const migration = readFileSync(join(import.meta.dirname, '../migrations/0020_gmail_integration.sql'), 'utf8');
    const backfill = migration.match(/^UPDATE "proposals" p SET "operation_request_linked" = true\b[\s\S]*?;/m)?.[0];
    if (!backfill) throw new Error('The consolidated migration is missing the proposal origin backfill');
    const marked = await withTransaction(db.pool, async tx => {
      await tx.query('DELETE FROM operation_idempotency WHERE proposal_id=$1', [pruned]);
      await tx.query(`UPDATE proposals SET payload_json=payload_json - 'requester' WHERE id=$1`, [requestOnly]);
      await tx.query('UPDATE proposals SET operation_request_linked=false WHERE id = ANY($1)', [[retained, pruned, requestOnly, legacy]]);
      await tx.query(backfill);
      const rows = (await tx.query<{id: string; operation_request_linked: boolean}>('SELECT id,operation_request_linked FROM proposals WHERE id = ANY($1)', [[retained, pruned, requestOnly, legacy]])).rows;
      return Object.fromEntries(rows.map(r => [r.id, r.operation_request_linked]));
    });
    expect(marked).toEqual({[retained]: true, [pruned]: true, [requestOnly]: true, [legacy]: false});
  });

  it('a shared result is released only while every reader of its audience still reads the Project', async () => {
    await bind(projectA);
    const outsider = randomUUID();
    await addPerson(outsider, null);
    const runId = await agentRun(owner, projectA);
    const runRow = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
    const actor = await runActor(db.pool, runRow as never);
    const item = (await operationRuntime(config)).registrations.get(listId)!;
    const release = (audit: Parameters<NonNullable<typeof item.releaseGate>>[0], audience: string[]) =>
      item.releaseGate!(audit, {input: {project_id: projectA}, data: {keys: []}, facts: {v: 1, audience: [...audience].sort()}, actor, replayed: false});
    await withTransaction(db.pool, audit => release(audit, [owner, viewer]));
    await expect(withTransaction(db.pool, audit => release(audit, [owner, outsider]))).rejects.toMatchObject({httpStatus: 503});
    // A membership change waits for an open release, then the next release sees it.
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await release(holder, [owner, viewer]);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const removing = db.pool.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`, [projectA, viewer]).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
      expect(settled).toBe(false);
      await holder.query('COMMIT');
      await removing;
    } finally { await holder.end(); }
    await expect(withTransaction(db.pool, audit => release(audit, [owner, viewer]))).rejects.toMatchObject({httpStatus: 503});
  });

  it('a cross-Project Agent result, fresh or replayed, is not released past a Room revocation that commits meanwhile', async () => {
    await bind(projectA);
    // The writer's Agent, from Project B, used in a Room of Project A under the writer's own Room grant.
    const runId = await agentRun(writer, projectA);
    const agent = (await db.pool.query<{agent_id: string}>('SELECT agent_id FROM runs WHERE id=$1', [runId])).rows[0]!.agent_id;
    await db.pool.query('UPDATE agents SET access_project_id=$2 WHERE id=$1', [agent, projectB]);
    const room = randomUUID();
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, projectA, writer]);
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',now(),now())`, [randomUUID(), space, room, writer]);
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, agent]);
    const grant = () => db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$5,now())`, [randomUUID(), space, room, agent, writer]);
    await grant();
    const session = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: projectA, project_folder_id: null, title: 'Applications', metadata: {}});
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [runId, session.id]);
    { const first = await call(runId, listId, {project_id: projectA}); expect(first.httpStatus, JSON.stringify(first.body)).toBe(200); }
    const actor = await runActor(db.pool, (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0] as never);
    const item = (await operationRuntime(config)).registrations.get(listId)!;
    // A fresh result and a stored receipt's replay are both released through this gate, in their own transaction.
    const release = (audit: Parameters<NonNullable<typeof item.releaseGate>>[0], replayed: boolean) =>
      item.releaseGate!(audit, {input: {project_id: projectA}, data: {keys: []}, facts: {v: 1, references: []}, actor, replayed});
    const pidOf = async (client: pg.Client) => (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

    // The revocation is first: it holds the Room row as every Room writer does, and has not committed
    // when the release asks. The release waits for it and then sees the grant gone.
    for (const replayed of [false, true]) {
      await withTransaction(db.pool, audit => release(audit, replayed));
      const revoker = new pg.Client({connectionString: db.connectionUri});
      await revoker.connect();
      try {
        await revoker.query('BEGIN');
        await revoker.query('SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE', [room]);
        await revoker.query('UPDATE room_agent_access_grants SET revoked_at=now() WHERE room_id=$1 AND revoked_at IS NULL', [room]);
        let settled = false;
        const releasing = withTransaction(db.pool, audit => release(audit, replayed)).then(() => 'released', (error: unknown) => error).finally(() => { settled = true; });
        await waitForBlockedBy(db.pool, await pidOf(revoker), {settled: () => settled});
        expect(settled, `replayed=${replayed}: the release did not wait for the Room`).toBe(false);
        await revoker.query('COMMIT');
        expect(await releasing).toMatchObject({httpStatus: 503});
      } finally { await revoker.end(); }
      await grant();
    }
    // The same through the Agent tool entry: the call waits, then withholds.
    const revoker = new pg.Client({connectionString: db.connectionUri});
    await revoker.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('SELECT id FROM rooms WHERE id=$1 FOR NO KEY UPDATE', [room]);
      await revoker.query('UPDATE room_agent_access_grants SET revoked_at=now() WHERE room_id=$1 AND revoked_at IS NULL', [room]);
      let settled = false;
      const calling = call(runId, listId, {project_id: projectA}).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, await pidOf(revoker), {settled: () => settled});
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      const response = await calling;
      expect(response.httpStatus).not.toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('"keys"');
    } finally { await revoker.end(); }
    await grant();
    expect((await call(runId, listId, {project_id: projectA})).httpStatus).toBe(200);

    // The release is first: removing the Agent from the Room waits for it, and every later release refuses.
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await release(holder, false);
      let settled = false;
      const removing = new RoomRosterService(db.pool).removeAgent({spaceId: space, userId: writer}, room, agent).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, await pidOf(holder), {settled: () => settled});
      expect(settled, 'the removal did not wait for the open release').toBe(false);
      await holder.query('COMMIT');
      expect((await removing).detail.revoked_grant_count).toBe(1);
    } finally { await holder.end(); }
    for (const replayed of [false, true]) await expect(withTransaction(db.pool, audit => release(audit, replayed))).rejects.toMatchObject({httpStatus: 503});
    expect((await call(runId, listId, {project_id: projectA})).httpStatus).toBe(404);
  });

  /** A cross-Project Agent's running Run in a Room conversation of Project A, the writer's grant letting it work there. */
  async function crossProjectRoomRun() {
    await bind(projectA);
    const runId = await agentRun(writer, projectA);
    const agent = (await db.pool.query<{agent_id: string}>('SELECT agent_id FROM runs WHERE id=$1', [runId])).rows[0]!.agent_id;
    await db.pool.query('UPDATE agents SET access_project_id=$2 WHERE id=$1', [agent, projectB]);
    const room = randomUUID();
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'Applications','active',now(),now())`, [room, space, projectA, writer]);
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner','active',now(),now())`, [randomUUID(), space, room, writer]);
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'manager','active',now(),now())`, [randomUUID(), space, room, agent]);
    await db.pool.query(`INSERT INTO room_agent_access_grants (id,space_id,room_id,agent_id,grantee_user_id,granted_by_user_id,created_at) VALUES ($1,$2,$3,$4,$5,$5,now())`, [randomUUID(), space, room, agent, writer]);
    const session = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: projectA, project_folder_id: null, title: 'Applications', metadata: {}});
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [runId, session.id]);
    return {runId, agent, room, session};
  }

  /**
   * Holds a Room writer at a row it locks after the Room (`hold`), then sends the Agent's
   * command, which takes the Project FOR UPDATE and then needs the Room. A writer holding the
   * Room before the Project would then need the Project key lock for its insert, and the two
   * would deadlock; Project before Room, the command waits for the writer and both complete.
   */
  async function raceRoomWriterWithCommand(runId: string, hold: (holder: pg.Client) => Promise<unknown>, writing: () => Promise<unknown>, key: string) {
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await hold(holder);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let writerSettled = false;
      const written = writing().then(value => ({value}), (error: unknown) => ({error})).finally(() => { writerSettled = true; });
      await waitForBlockedBy(db.pool, holderPid, {settled: () => writerSettled});
      expect(writerSettled, 'the Room writer did not reach the held row').toBe(false);
      let commandSettled = false;
      const commanding = call(runId, writeId, {project_id: projectA, key}).finally(() => { commandSettled = true; });
      await waitForLockWaiter(db.pool, {settled: () => commandSettled, waiters: 2});
      await holder.query('COMMIT');
      const outcome = await written;
      expect('error' in outcome ? String(outcome.error) : 'written').toBe('written');
      const response = await commanding;
      expect(response.httpStatus, JSON.stringify(response.body)).toBe(200);
      return (outcome as {value: unknown}).value;
    } finally { await holder.end(); }
  }

  it('a cross-Project Agent command and a first Agent add to its Room take Project before Room and both complete', async () => {
    const {runId, room} = await crossProjectRoomRun();
    // Another of the writer's Agents, not yet in the Room or the Project: its add links it to the Project.
    const newcomer = randomUUID();
    await seedRun(db.pool, {id: randomUUID(), space, owner: writer, agent: newcomer, version: randomUUID()});
    expect((await db.pool.query('SELECT 1 FROM project_agent_links WHERE project_id=$1 AND agent_id=$2', [projectA, newcomer])).rows).toHaveLength(0);

    // Held at the Agent row the add locks after the Room; its Project link then needs the Project key lock.
    await raceRoomWriterWithCommand(runId, holder => holder.query('SELECT id FROM agents WHERE id=$1 FOR SHARE', [newcomer]),
      () => new RoomRosterService(db.pool).addExistingAgent({spaceId: space, userId: writer}, room, {agent_id: newcomer}), 'raced');
    expect((await db.pool.query(`SELECT status FROM project_agent_links WHERE project_id=$1 AND agent_id=$2`, [projectA, newcomer])).rows[0]?.status).toBe('active');
    expect(await keys(projectA)).toContain('raced');
  });

  it('an approval that activates a share_history=false invitation and the Agent command take Project before Room', async () => {
    const {runId, room, session} = await crossProjectRoomRun();
    // A private Agent of another member: the invitation waits on its owner's approval.
    const approver = randomUUID(); const invitee = randomUUID(); const specialist = randomUUID();
    await addPerson(approver, 'member');
    await addPerson(invitee, 'member');
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, approver]);
    await db.pool.query(`INSERT INTO agents (id,space_id,owner_user_id,name,status,agent_kind,visibility,created_at,updated_at) VALUES ($1,$2,$3,'Specialist','active','standard','private',now(),now())`, [specialist, space, approver]);
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, specialist]);
    const roster = new RoomRosterService(db.pool);
    const invitation = await roster.inviteUser({spaceId: space, userId: writer}, room, {user_id: invitee, share_history: false, confirm_owned_private_agent_shares: true}) as {id: string; status: string};
    expect(invitation.status).toBe('pending');

    // Held at the invitation row the decision locks after the Room; activation then freezes the
    // existing conversation and opens a draft, both Project-scoped rows.
    const decided = await raceRoomWriterWithCommand(runId, holder => holder.query('SELECT id FROM room_user_invitations WHERE id=$1 FOR SHARE', [invitation.id]),
      () => roster.decideInvitation({spaceId: space, userId: approver}, room, invitation.id, {agent_id: specialist, decision: 'approved'}), 'approved') as {status: string; shared_conversation_id?: string | null};
    expect(decided.status).toBe('active');
    expect((await db.pool.query('SELECT 1 FROM room_conversation_audiences WHERE session_id=$1', [session.id])).rows).toHaveLength(1);
    expect((await db.pool.query(`SELECT 1 FROM sessions WHERE room_id=$1 AND metadata_json->>'opened_for_invitation_id'=$2`, [room, invitation.id])).rows).toHaveLength(1);
    expect(await keys(projectA)).toContain('approved');
  });

  it('opening a conversation draft and the Agent command take Project before Room', async () => {
    const {runId, room} = await crossProjectRoomRun();
    const rooms = new RoomService(config, db.pool);
    const writerIdentity = {spaceId: space, userId: writer};
    const stale = await rooms.createConversationDraft(writerIdentity, room) as {id: string};
    // Held at the open draft the creation locks after the Room; that draft is then used up,
    // so the creation inserts a new conversation, a Project-scoped row.
    const created = await raceRoomWriterWithCommand(runId,
      holder => holder.query(`UPDATE sessions SET metadata_json=metadata_json-'execution_setup_started' WHERE id=$1`, [stale.id]),
      () => rooms.createConversationDraft(writerIdentity, room), 'drafted') as {id: string};
    expect(created.id).not.toBe(stale.id);
    expect(await keys(projectA)).toContain('drafted');
  });
});
