import {operationPackageIdentity} from '../src/modules/plugins/packageIdentity.js';
import {randomUUID} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {beforeAll, beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {z} from 'zod';
import pg from 'pg';
import type {PluginOperationId, RainverPlugin, PluginOperationManifest, RunToolGrant} from '@rainver/protocol';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {provisionPluginRoles, pluginRoleNames} from '../src/modules/plugins/operationDb.js';
import {withTransaction} from '../src/db/tx.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject, seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {runsModule} from '../src/modules/runs/index.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {pluginRepository} from '../src/modules/plugins/repository.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {buildRunToolGrants} from '../src/modules/systemActions/runToolGrants.js';
import {pluginToolPins, type RunScenario} from '../src/modules/plugins/dataAccess.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {PgRunRepository, type AgentRunRecord} from '../src/modules/runs/repository.js';
import {AuthorizationRequestService} from '../src/modules/policy/authorizationRequestService.js';
import {PluginDataGrantRepository} from '../src/modules/plugins/dataGrantRepository.js';
import {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {releasePluginResult} from '../src/modules/plugins/releaseGate.js';
import {readableIntersection} from '../src/modules/plugins/operationRegistry.js';
import {runActor} from '../src/modules/systemActions/operations/actor.js';
import type {RunRecord} from '../src/modules/runs/repository.js';
import {executeRemoteHostCliAdapter, type RemoteBindingPort} from '../src/modules/runs/remoteHostCliAdapter.js';
import {HostConnectionRegistry, type HostFrameSink} from '../src/modules/hosts/connectionRegistry.js';
import {ProviderProxyLeaseRegistry, setProviderProxyBaseUrlForProcess} from '../src/modules/providers/proxy/lease.js';
import {__setProvidersDbPortForTests} from '../src/modules/providers/dbReader.js';

/**
 * ADR 0030 platform acceptance on real PostgreSQL with a fixture plugin whose
 * three entities are normal, personal and sensitive. No legacy plugin package
 * or private data is used.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'data_probe';
const id = (entity: string, verb: string) => `plugin.${pid}.${entity}.${verb}` as PluginOperationId;
const out = z.object({items: z.array(z.object({id: z.string(), value: z.string(), data_class: z.string().optional()}).strict())}).strict();
const inp = z.object({value: z.string().default('v'), mode: z.string().optional()}).strict();
const op = (entity: string, verb: string, kind: 'query' | 'command', data_class: 'non_sensitive' | 'personal' | 'sensitive') => ({
  id: id(entity, verb), version: 1, title: `${entity} ${verb}`, description: `${entity} ${verb}`, kind,
  side_effects: kind === 'query' ? 'none' as const : 'durable' as const, data_class, input_schema: inp, output_schema: out, gate_class: null,
});
// A schema without `data_class`: Zod strips the label, so classification must read the raw output.
const loose = z.object({items: z.array(z.object({id: z.string(), value: z.string()}))});
// A paged list: besides its rows it reports a total, a cursor and a nested summary of the reader's own result.
const page = z.object({items: z.array(z.object({id: z.string(), value: z.string()}).strict()), total: z.number(), next_cursor: z.string().nullable(), summary: z.object({latest: z.string().nullable()}).strict()}).strict();
const manifest: PluginOperationManifest = {
  id: pid, version: '1.0.0', hostApi: 1, scope: 'space', name: 'Data probe', description: 'ADR 0030 fixture', requires: [],
  permissions: {agent: true}, data_access: 'caller_owned',
  entities: [{name: 'note'}, {name: 'account', data_class: 'personal', exemption: 'read-only fixture'}, {name: 'diary', data_class: 'sensitive', exemption: 'read-only fixture'}, {name: 'loose', exemption: 'read-only fixture'}],
  operations: [op('note', 'list', 'query', 'non_sensitive'), op('note', 'write', 'command', 'non_sensitive'), op('account', 'list', 'query', 'personal'), op('diary', 'list', 'query', 'sensitive'), {...op('loose', 'list', 'query', 'non_sensitive'), output_schema: loose}, {...op('account', 'page', 'query', 'personal'), output_schema: page}],
};
const plugin: RainverPlugin = {
  id: pid, version: '1.0.0', operationManifest: manifest,
  activate(ctx) {
    for (const o of manifest.operations) ctx.actions!.register(o.id as PluginOperationId, async (input, {db: pdb, actor}) => {
      const args = input as {value: string; mode?: string};
      if (o.kind === 'command') await pdb.transaction({spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!}, tx => withQueryableTransaction(tx, async j => {
        await j.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2) ON CONFLICT(space_id,user_id,key) DO UPDATE SET value=EXCLUDED.value", [o.id.split('.')[2], args.value]);
      }));
      const entity = o.id.split('.')[2] === 'loose' ? 'note' : o.id.split('.')[2]!;
      const rows = (await pdb.query<{key: string; value: string}>("SELECT key,value FROM records WHERE space_id=current_setting('rainver.space_id') AND user_id=current_setting('rainver.user_id') AND (key=$1 OR key LIKE $1||'\\_%') ORDER BY key", [entity])).rows;
      const items = rows.map(r => ({id: `${r.key}-row`, value: r.value, ...(args.mode === 'raise' ? {data_class: 'sensitive'} : {})}));
      if (o.id.endsWith('.page')) return {items, total: rows.length, next_cursor: rows.at(-1)?.key ?? null, summary: {latest: rows.at(-1)?.value ?? null}};
      return {items};
    });
    return {activated: true};
  },
};
let space: string, owner: string, member: string, project: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
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
async function personalSpace(user: string, name: string) {
  const personal = randomUUID();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Personal','personal',now(),now())`, [personal]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'owner','active',now(),now())`, [randomUUID(), personal, user]);
  return name;
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); member = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project, spaceType: 'team'});
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Member','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [member]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, member]);
  await personalSpace(owner, 'o'); await personalSpace(member, 'm');
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await pluginRepository.upsertInstall(db.pool, {pluginId: pid, installedVersion: '1.0.0', source: 'local', manifest: {operation_api: 1, operation_contract: operationPackageIdentity(plugin)}, actorUserId: owner});
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  await db.pool.query(`INSERT INTO plugin_${pid}.records(space_id,user_id,key,value) VALUES ($1,$2,'diary','secret diary text'),($1,$2,'account','shared ledger'),($1,$2,'account_private','member only ledger'),($1,$2,'note','note text')`, [space, member]);
  await db.pool.query(`INSERT INTO plugin_${pid}.records(space_id,user_id,key,value) VALUES ($1,$2,'account','shared ledger')`, [space, owner]);
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });

const ALL = [id('note', 'list'), id('note', 'write'), id('account', 'list'), id('account', 'page'), id('diary', 'list'), 'memory.remember'];
const ownerOnly = (user: string, origin: RunScenario['origin'] = 'manual'): RunScenario => ({origin, instructingUserId: user, audience: [user]});
const grants = (scenario?: RunScenario) => buildRunToolGrants(ALL, {allowed_tools: ALL}, {db: db.pool, spaceId: space, userId: member, config, scenario});
type Launch = {egress: 'none' | 'default' | 'install'; hostKind: 'server' | 'remote'} | null;
async function host(kind: 'server' | 'remote') {
  // One built-in Host per instance (uq_hosts_single_server).
  const existing = kind === 'server' ? (await db.pool.query<{id: string}>(`SELECT id FROM hosts WHERE kind='server'`)).rows[0]?.id : undefined;
  if (existing) return existing;
  const hostId = randomUUID();
  await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,$2,'Test machine',$3,now(),now())`, [hostId, kind === 'remote' ? member : null, kind === 'server' ? 'server' : 'desktop']);
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'online',now(),now())`,
    [hostId, kind === 'remote' ? member : null, hostId, kind === 'server' ? 'server' : 'linux_native', kind === 'server' ? 'server' : `remote-${hostId.slice(0, 8)}`, kind]);
  return hostId;
}
/** What the dispatching server records with a launch nonce; tests stand in for the launch itself. */
async function launch(runId: string, how: Launch) {
  if (!how) return;
  const launchId = randomUUID(), hostId = await host(how.hostKind);
  await db.pool.query(`UPDATE run_attempts SET launch_id=$2, launch_isolation_json=$3::jsonb WHERE run_id=$1`, [runId, launchId,
    JSON.stringify({launch_id: launchId, host_id: hostId, host_kind: how.hostKind, egress_profile: how.egress, sandbox_mode: 'read_write'})]);
}
async function agentRun(snapshot: RunToolGrant[], extra: Record<string, unknown> = {}, how: Launch = {egress: 'none', hostKind: 'server'}) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: member, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',permission_snapshot_json=$3::jsonb WHERE id=$1`,
    [runId, member, JSON.stringify({tool_grants: snapshot, plugin_tool_pins: pluginToolPins(config, snapshot), ...extra})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  await launch(runId, how);
  return (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
}
const transport = () => new CliAgentToolTransport(config, {actionEventSink: async () => {}});
const call = async (run: AgentRunRecord, name: string, args: Record<string, unknown> = {}, key = randomUUID()) =>
  (await transport().call((await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run.id])).rows[0]!, {id: key, name, arguments: args})) as OperationToolResponse;
const asUser = (user: string) => __setAuthIdentityForTests({spaceId: space, userId: user});
const userCall = (name: string, payload: Record<string, unknown>) => app.inject({method: 'POST', url: `/api/v1/actions/${name}`, headers: {'idempotency-key': randomUUID()}, payload});
const userQuery = (name: string, input: Record<string, unknown> = {}) => app.inject({method: 'GET', url: `/api/v1/queries/${name}?input=${encodeURIComponent(JSON.stringify(input))}`});
const taint = async (runId: string) => (await db.pool.query<{context_taint_json: Record<string, unknown> | null}>('SELECT context_taint_json FROM runs WHERE id=$1', [runId])).rows[0]!.context_taint_json;

describe('ADR 0030 plugin data access', () => {
  it('admits personal/sensitive tool names only for an eligible owner-only scenario with data-side consent', async () => {
    const names = async (s?: RunScenario) => (await grants(s)).map(g => g.action_id);
    expect(await names()).toEqual(expect.arrayContaining([id('note', 'list'), id('note', 'write')]));
    expect(await names()).not.toContain(id('diary', 'list'));
    const manual = await names(ownerOnly(member));
    expect(manual).toContain(id('diary', 'list'));
    expect(manual).not.toContain(id('account', 'list'));
    // Shared audience (Room/selected users/Space-shared): personal and sensitive names are absent.
    const shared = await names({origin: 'manual', instructingUserId: member, audience: [member, owner].sort()});
    expect(shared).not.toContain(id('diary', 'list'));
    expect(shared).toContain(id('note', 'list'));
    // Without the Space owner's consent no personal tool is admitted, for one reader or many.
    expect(shared).not.toContain(id('account', 'list'));
    expect(await names({...ownerOnly(member), origin: 'delegated'})).not.toContain(id('diary', 'list'));
    expect(await names(ownerOnly(member, 'system'))).not.toContain(id('diary', 'list'));
    expect(await names(ownerOnly(member, 'scheduled'))).not.toContain(id('diary', 'list'));
    // Personal: only the Space owner's consent admits it; a member cannot give it.
    await expect(withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space'}))).rejects.toMatchObject({statusCode: 403});
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: owner}, {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space'}));
    expect(await names(ownerOnly(member))).toContain(id('account', 'list'));
    expect(await names(ownerOnly(member, 'system'))).toContain(id('account', 'list'));
    // A shared audience admits a personal read (released as the readable intersection), never in a delegated Run.
    expect(await names({origin: 'manual', instructingUserId: member, audience: [member, owner].sort()})).toContain(id('account', 'list'));
    expect(await names({origin: 'delegated', instructingUserId: member, audience: [member, owner].sort()})).not.toContain(id('account', 'list'));
    // Background sensitive read: the owner's own explicit opt-in, read-only, expiring.
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background'}));
    expect(await names(ownerOnly(member, 'scheduled'))).toContain(id('diary', 'list'));
    expect(await names(ownerOnly(member, 'system'))).not.toContain(id('diary', 'list'));
  });

  it('offers each person only the consents they may give, and a consent given there admits and revokes like any other', async () => {
    const options = async (user: string) => {
      asUser(user);
      const listed = await userQuery('plugin_data_grant.list', {plugin_id: pid});
      expect(listed.statusCode, listed.body).toBe(200);
      return listed.json().data.consentable as Array<{data_class: string; scope: string; toolset: string; tools: {action_id: string}[]; active_grant_id: string | null; changes: unknown; default_expires_in_seconds: number | null}>;
    };
    // A Space owner may give the Space-wide personal consent and their own background read; a member only the latter.
    const ownerOptions = await options(owner);
    expect(ownerOptions.map(o => [o.data_class, o.scope, o.toolset])).toEqual([['personal', 'space', 'read'], ['sensitive', 'background', 'read']]);
    expect(ownerOptions[0]!.tools.map(t => t.action_id)).toEqual([id('account', 'list'), id('account', 'page')]);
    const memberOptions = await options(member);
    expect(memberOptions).toEqual([expect.objectContaining({data_class: 'sensitive', scope: 'background', toolset: 'read', tools: [expect.objectContaining({action_id: id('diary', 'list')})], active_grant_id: null, changes: null, default_expires_in_seconds: 86_400})]);
    // An option is not a grant: offering it changes nothing until its owner consents.
    expect(await grants(ownerOnly(member, 'scheduled'))).not.toContainEqual(expect.objectContaining({action_id: id('diary', 'list')}));
    asUser(member);
    const contract = operationPackageIdentity(plugin);
    expect(memberOptions[0]).toMatchObject({authority_hash: contract});
    expect((await userCall('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space', authority_hash: contract})).statusCode).toBe(404);
    // The identity is required: a create that names no confirmed option is invalid input, not a default expansion.
    expect((await userCall('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background'})).statusCode).toBe(422);
    const consented = await userCall('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background', expires_in_seconds: 86_400, authority_hash: contract});
    expect(consented.statusCode, consented.body).toBe(201);
    const grant = consented.json().data as {id: string; data_owner_user_id: string; expanded: {action_id: string}[]};
    expect(grant).toMatchObject({data_owner_user_id: member, expanded: [{action_id: id('diary', 'list')}]});
    expect((await options(member))[0]).toMatchObject({active_grant_id: grant.id, changes: null});
    expect(await grants(ownerOnly(member, 'scheduled'))).toContainEqual(expect.objectContaining({action_id: id('diary', 'list')}));
    // The owner sees neither the member's background consent nor its option as theirs.
    expect((await options(owner)).find(o => o.data_class === 'sensitive')!.active_grant_id).toBeNull();
    // Revoked: the next snapshot no longer admits it, and the option reopens.
    asUser(member);
    expect((await userCall('plugin_data_grant.revoke', {grant_id: grant.id})).statusCode).toBe(200);
    expect(await grants(ownerOnly(member, 'scheduled'))).not.toContainEqual(expect.objectContaining({action_id: id('diary', 'list')}));
    expect((await options(member))[0]).toMatchObject({active_grant_id: null, changes: null});
    // After an upgrade changed what a toolset expands to, the option names the difference from the last consent.
    await db.pool.query(`UPDATE plugin_data_grants SET expanded_json='[]'::jsonb WHERE id=$1`, [grant.id]);
    expect((await options(member))[0]!.changes).toEqual({added: [id('diary', 'list')], removed: [], changed: []});
    // A disabled plugin offers nothing.
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect(await options(member)).toEqual([]);
    // A Run's own panel never carries options.
    expect((await userQuery('plugin_data_grant.list', {run_id: randomUUID()})).json().data.consentable).toBeUndefined();
  });

  it('refuses a consent confirmed before an upgrade and freezes only what the refreshed option showed', async () => {
    // A Run that already froze its consent before the upgrade.
    const frozenRun = await agentRun(await grants(ownerOnly(member)));
    const frozen = await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: frozenRun.id}));
    asUser(member);
    const before = (await userQuery('plugin_data_grant.list', {plugin_id: pid})).json().data.consentable[0] as {authority_hash: string; tools: {action_id: string}[]};
    expect(before.tools.map(t => t.action_id)).toEqual([id('diary', 'list')]);
    // Upgrade: the same toolset gains a sensitive read; the instance is recomposed and the install admits the new contract.
    const search = op('diary', 'search', 'query', 'sensitive');
    const upgraded: RainverPlugin = {...plugin, version: '1.1.0', operationManifest: {...manifest, version: '1.1.0', operations: [...manifest.operations, search]},
      activate(ctx) { for (const o of [...manifest.operations, search]) ctx.actions!.register(o.id as PluginOperationId, async () => ({items: []})); return {activated: true}; }};
    const nextConfig = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
    const next = buildModuleServer(nextConfig, [systemActionsModule, runsModule]);
    new PluginHost([upgraded]).activate(next, nextConfig);
    await next.ready();
    try {
      await pluginRepository.upsertInstall(db.pool, {pluginId: pid, installedVersion: '1.1.0', source: 'local', manifest: {operation_api: 1, operation_contract: operationPackageIdentity(upgraded)}, actorUserId: owner});
      const submit = (authority_hash: string) => next.inject({method: 'POST', url: '/api/v1/actions/plugin_data_grant.create', headers: {'idempotency-key': randomUUID()},
        payload: {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash}});
      // The option confirmed before the upgrade: refused, nothing written, never the wider current expansion.
      const stale = await submit(before.authority_hash);
      expect(stale.statusCode, stale.body).toBe(409);
      expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_data_grants WHERE space_id=$1 AND scope='background'`, [space])).rows[0]).toEqual({n: 0});
      // Refreshed: the option names the new tool and its identity; that confirmation freezes exactly those tools.
      const refreshed = (await next.inject({method: 'GET', url: `/api/v1/queries/plugin_data_grant.list?input=${encodeURIComponent(JSON.stringify({plugin_id: pid}))}`})).json().data.consentable[0] as typeof before;
      expect(refreshed.authority_hash).toBe(operationPackageIdentity(upgraded));
      expect(refreshed.tools.map(t => t.action_id)).toEqual([id('diary', 'list'), id('diary', 'search')]);
      const created = await submit(refreshed.authority_hash);
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().data).toMatchObject({plugin_version: '1.1.0', authority_hash: refreshed.authority_hash, expanded: refreshed.tools});
      // The active Run's earlier consent keeps its own frozen pin and hash.
      expect((await db.pool.query(`SELECT status,authority_hash,expanded_json FROM plugin_data_grants WHERE id=$1`, [frozen.id])).rows[0]).toEqual({status: 'active', authority_hash: frozen.authority_hash, expanded_json: frozen.expanded});
    } finally { await next.close(); }
  });

  it('keeps a standing consent revocable while its plugin is disabled; re-enabling never revives it', async () => {
    asUser(member);
    const contract = operationPackageIdentity(plugin);
    const consented = await userCall('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background', authority_hash: contract});
    expect(consented.statusCode, consented.body).toBe(201);
    const grant = consented.json().data as {id: string};
    const run = await agentRun(await grants(ownerOnly(member, 'scheduled')));
    await db.pool.query(`UPDATE runs SET trigger_origin='automation' WHERE id=$1`, [run.id]);
    expect((await call(run, id('diary', 'list'))).httpStatus).toBe(200);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    // Disabled: no option, but the grant is still listed to its owner, and only to them.
    const listed = (await userQuery('plugin_data_grant.list', {})).json().data;
    expect(listed.consentable).toEqual([]);
    expect(listed.items).toEqual([expect.objectContaining({id: grant.id, status: 'active', expanded: [expect.objectContaining({action_id: id('diary', 'list')})]})]);
    asUser(owner);
    expect((await userQuery('plugin_data_grant.list', {})).json().data.items).toEqual([]);
    expect((await userCall('plugin_data_grant.revoke', {grant_id: grant.id})).statusCode).toBe(404);
    asUser(member);
    const revoked = await userCall('plugin_data_grant.revoke', {grant_id: grant.id});
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().data).toMatchObject({id: grant.id, status: 'revoked'});
    // Re-enabled: the same scheduled Run calling again is refused; revocation is final.
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    // (Without the revoke this same call reads the diary again.)
    const again = await call(run, id('diary', 'list'));
    expect(again.httpStatus).not.toBe(200);
    expect(JSON.stringify(again.body)).not.toContain('secret diary text');
    expect(await grants(ownerOnly(member, 'scheduled'))).not.toContainEqual(expect.objectContaining({action_id: id('diary', 'list')}));
  });

  it('requires data-owner consent per Run, records content-free attribution and taint, replays, revokes and blocks egress', async () => {
    const run = await agentRun(await grants(ownerOnly(member)));
    const denied = await call(run, id('diary', 'list'));
    expect(denied.httpStatus).toBe(403);
    expect(denied.body).toMatchObject({ok: false, error: {code: 'operation_consent_required'}});
    expect(JSON.stringify(denied.body)).not.toContain('secret diary text');
    const decisionId = denied.body.policy_decision_record_id as string;
    const requests = new AuthorizationRequestService(db.pool, config);
    const request = await requests.createFromDeniedDecision({spaceId: space, runId: run.id, agentId: run.agent_id!, policyDecisionRecordId: decisionId, reason: 'Read my diary for the summary'});
    expect(request).toMatchObject({request_kind: 'plugin_data', status: 'pending'});
    expect((await requests.listForRun({spaceId: space, userId: member}, run.id))[0]).toMatchObject({approver: 'data_owner'});
    // The Space owner/admin is not the data owner and cannot decide for them.
    await expect(requests.decide({spaceId: space, userId: owner}, request.id, 'approved')).rejects.toMatchObject({statusCode: 403});
    const approved = await requests.decide({spaceId: space, userId: member}, request.id, 'approved');
    expect(approved.resulting_plugin_data_grant_id).toBeTruthy();
    expect(approved.resulting_action_grant_id).toBeNull();
    await db.pool.query(`UPDATE runs SET status='running' WHERE id=$1`, [run.id]);
    // The resumed Run is relaunched; the server records the new launch's isolation.
    await db.pool.query(`UPDATE run_attempts SET status='running' WHERE run_id=$1`, [run.id]);
    await launch(run.id, {egress: 'none', hostKind: 'server'});
    const key = randomUUID();
    const read = await call(run, id('diary', 'list'), {}, key);
    expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
    expect((read.body.data as {items: {value: string}[]}).items[0]!.value).toBe('secret diary text');
    expect(await taint(run.id)).toMatchObject({narrowest_visibility: 'private', plugin_reads: [{plugin_id: pid, data_class: 'sensitive'}]});
    const logs = (await db.pool.query('SELECT owner_user_id,action_id,resource_ids_json,data_class,grant_id FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows;
    expect(logs).toEqual([{owner_user_id: member, action_id: id('diary', 'list'), resource_ids_json: ['diary-row'], data_class: 'sensitive', grant_id: approved.resulting_plugin_data_grant_id}]);
    expect(JSON.stringify(logs)).not.toContain('secret');
    // Owner-visible, content-free; nobody else reads another person's log.
    asUser(member);
    const mine = await userQuery('agent_data_read.list', {run_id: run.id});
    expect(mine.json()).toMatchObject({status: 'succeeded', data: {items: [{run_id: run.id, data_class: 'sensitive'}]}});
    asUser(owner);
    expect((await userQuery('agent_data_read.list', {run_id: run.id})).json()).toMatchObject({data: {items: []}});
    // Outward write after a sensitive read is a hard refusal; a merge-only taint survives later reads.
    const outward = await call(run, id('note', 'write'), {value: 'leak'});
    expect(outward.httpStatus).toBe(404);
    expect((await db.pool.query(`SELECT policy_rule_id FROM policy_decision_records WHERE id=$1`, [outward.body.policy_decision_record_id])).rows[0]).toEqual({policy_rule_id: 'hard_invariant_sensitive_plugin_read_egress'});
    expect((await db.pool.query(`SELECT value FROM plugin_${pid}.records WHERE user_id=$1 AND key='note'`, [member])).rows).toEqual([{value: 'note text'}]);
    await call(run, id('note', 'list'));
    expect(await taint(run.id)).toMatchObject({plugin_reads: [{plugin_id: pid, data_class: 'sensitive'}]});
    // Memory inherits the sensitivity and becomes a gated proposal for the person.
    const remembered = await call(run, 'memory.remember', {content: 'diary detail', memory_type: 'semantic', rationale: 'the person asked'});
    expect(JSON.stringify(remembered)).toContain('proposed');
    expect((await db.pool.query(`SELECT payload_json->>'sensitivity_level' AS level FROM proposals WHERE created_by_run_id=$1`, [run.id])).rows).toEqual([{level: 'sensitive'}]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM memory_entries WHERE space_id=$1 AND content LIKE '%diary detail%'`, [space])).rows[0].n).toBe(0);
    // Queries are not idempotency-replayed: every repeat call is rechecked under current consent.
    expect((await call(run, id('diary', 'list'), {}, key)).body).toMatchObject({ok: true, replayed: false});
    asUser(member);
    const revoked = await userCall('plugin_data_grant.revoke_run', {run_id: run.id});
    expect(revoked.json()).toMatchObject({status: 'succeeded', data: {revoked_grant_ids: [approved.resulting_plugin_data_grant_id]}});
    expect((await call(run, id('diary', 'list'), {}, key)).httpStatus).toBe(403);
    expect((await call(run, id('diary', 'list'))).httpStatus).toBe(403);
  });

  it('serializes revocation against read finalization: a committed revoke withholds the result', async () => {
    const run = await agentRun(await grants(ownerOnly(member)));
    const grant = await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
    const revoker = new pg.Client({connectionString: db.connectionUri});
    await revoker.connect();
    try {
      await revoker.query('BEGIN');
      await new PluginDataGrantRepository(revoker, config).revoke({spaceId: space, userId: member}, grant.id);
      const holder = (await revoker.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const pending = call(run, id('diary', 'list')).finally(() => { settled = true; });
      // The release-time audit transaction must actually wait on the uncommitted revocation.
      await waitForBlockedBy(db.pool, holder, {settled: () => settled});
      expect(settled).toBe(false);
      await revoker.query('COMMIT');
      const result = await pending;
      expect(result.httpStatus).not.toBe(200);
      expect(JSON.stringify(result.body)).not.toContain('secret diary text');
    } finally { await revoker.end(); }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows[0].n).toBe(0);
    expect(await taint(run.id)).toBeNull();
  });

  it('rechecks audience, pins and expiry at call time; an upgrade never widens a frozen snapshot', async () => {
    const run = await agentRun(await grants(ownerOnly(member)));
    const grant = await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
    expect((await call(run, id('diary', 'list'))).httpStatus).toBe(200);
    // Audience widened after the snapshot: refused as a scenario, not requestable.
    await db.pool.query(`UPDATE runs SET visibility='space_shared' WHERE id=$1`, [run.id]);
    const widened = await call(run, id('diary', 'list'));
    expect(widened.httpStatus).toBe(404);
    expect((await db.pool.query(`SELECT policy_rule_id FROM policy_decision_records WHERE id=$1`, [widened.body.policy_decision_record_id])).rows[0]).toEqual({policy_rule_id: 'plugin_data_scenario_refused'});
    await db.pool.query(`UPDATE runs SET visibility='private' WHERE id=$1`, [run.id]);
    // A changed tool contract (as after an upgrade) refuses the frozen pin.
    await db.pool.query(`UPDATE runs SET permission_snapshot_json=jsonb_set(permission_snapshot_json,'{plugin_tool_pins,${id('diary', 'list')},action_version}','2') WHERE id=$1`, [run.id]);
    expect((await call(run, id('diary', 'list'))).body).toMatchObject({error: {code: 'operation_not_granted'}});
    await db.pool.query(`UPDATE runs SET permission_snapshot_json=jsonb_set(permission_snapshot_json,'{plugin_tool_pins,${id('diary', 'list')},action_version}','1') WHERE id=$1`, [run.id]);
    // Consent pinned to a different contract needs re-consent and is listed as such.
    await db.pool.query(`UPDATE plugin_data_grants SET expanded_json=jsonb_set(expanded_json,'{0,side_effects}','"proposal"') WHERE id=$1`, [grant.id]);
    expect((await call(run, id('diary', 'list'))).body).toMatchObject({error: {code: 'operation_consent_required'}});
    asUser(member);
    expect((await userQuery('plugin_data_grant.list', {run_id: run.id})).json()).toMatchObject({data: {items: [{id: grant.id, reconsent: {changed: [id('diary', 'list')]}}]}});
    // Expiry closes access without a status change by any writer.
    await db.pool.query(`UPDATE plugin_data_grants SET expanded_json=$2::jsonb, expires_at=now()-interval '1 second' WHERE id=$1`, [grant.id, JSON.stringify(grant.expanded)]);
    expect((await call(run, id('diary', 'list'))).body).toMatchObject({error: {code: 'operation_consent_required'}});
    expect((await userQuery('plugin_data_grant.list', {run_id: run.id})).json()).toMatchObject({data: {items: [{status: 'expired'}]}});
  });

  it('refuses sensitive data in a Room whose audience includes another member, even with the owner\'s consent', async () => {
    const run = await agentRun(await grants(ownerOnly(member)));
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
    expect((await call(run, id('diary', 'list'))).httpStatus).toBe(200);
    const room = (await db.pool.query<{id: string}>('SELECT id FROM rooms WHERE project_id=$1', [project])).rows[0]!.id;
    const session = randomUUID();
    await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, project]);
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, member]);
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [run.id, session]);
    const inRoom = await call(run, id('diary', 'list'));
    expect(inRoom.httpStatus).toBe(404);
    expect(JSON.stringify(inRoom.body)).not.toContain('secret diary text');
    expect((await db.pool.query(`SELECT policy_rule_id FROM policy_decision_records WHERE id=$1`, [inRoom.body.policy_decision_record_id])).rows[0]).toEqual({policy_rule_id: 'plugin_data_scenario_refused'});
    // The same Room evaluated for a new snapshot lists no sensitive tool name.
    const roomScenario = {origin: 'manual' as const, instructingUserId: member, audience: (await db.pool.query<{user_id: string}>(`SELECT user_id FROM room_user_members WHERE room_id=$1 AND status='active' ORDER BY user_id`, [room])).rows.map(r => r.user_id)};
    expect((await grants(roomScenario)).map(g => g.action_id)).not.toContain(id('diary', 'list'));
  });

  it('keeps user parity, refuses impersonated consent and row-raised classes, and leaves normal tools unchanged', async () => {
    asUser(member);
    expect((await userQuery(id('diary', 'list'))).json()).toMatchObject({status: 'succeeded', data: {items: [{value: 'secret diary text'}]}});
    expect((await userQuery(id('note', 'list'), {mode: 'raise'})).statusCode).toBe(503);
    // An administrator cannot write a sensitive grant for another person's Run.
    const run = await agentRun(await grants(ownerOnly(member)));
    asUser(owner);
    expect((await userCall('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id, authority_hash: operationPackageIdentity(plugin)})).statusCode).toBe(404);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM plugin_data_grants WHERE target_run_id=$1', [run.id])).rows[0].n).toBe(0);
    await expect(db.pool.query(`INSERT INTO plugin_data_grants (id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,target_run_id,plugin_version,authority_hash,expanded_json,status,expires_at,created_at,updated_at)
      VALUES ($1,$2,$3,'read','sensitive','run',$4,$5,$6,'1.0.0','x','[]','active',now()+interval '1 hour',now(),now())`, [randomUUID(), space, pid, member, owner, run.id])).rejects.toThrow(/ck_plugin_data_grants_shape/);
    // Normal tools: unchanged Agent behavior, attributed but not tainted.
    const normal = await call(run, id('note', 'list'));
    expect(normal.httpStatus).toBe(200);
    expect(await taint(run.id)).toBeNull();
    expect((await db.pool.query('SELECT data_class FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows).toEqual([{data_class: 'non_sensitive'}]);
    expect((await call(run, id('note', 'list'), {mode: 'raise'})).httpStatus).toBe(503);
    expect((await call(run, id('note', 'write'), {value: 'ok'})).httpStatus).toBe(200);
  });
  it('classifies from the raw output and releases commands and replays only through the release gate', async () => {
    asUser(member);
    // Parent negative control: a schema without data_class stripped the label and released the row.
    const stripped = await userQuery(id('loose', 'list'), {mode: 'raise'});
    expect(stripped.statusCode).toBe(503);
    expect(stripped.body).not.toContain('note text');
    // A command whose raw output carries a higher class rolls its write back and releases nothing.
    const raised = await userCall(id('note', 'write'), {value: 'raised write', mode: 'raise'});
    expect(raised.statusCode).toBe(503);
    expect(raised.body).not.toContain('raised write');
    expect((await db.pool.query(`SELECT value FROM plugin_${pid}.records WHERE user_id=$1 AND key='note'`, [member])).rows).toEqual([{value: 'note text'}]);
    const run = await agentRun(await grants(ownerOnly(member)));
    const key = randomUUID();
    expect((await call(run, id('note', 'write'), {value: 'v2'}, key)).httpStatus).toBe(200);
    const logs = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1 AND action_id=$2`, [run.id, id('note', 'write')])).rows[0].n;
    expect(await logs()).toBe(1);
    // A failing release audit withholds a replayed receipt and a fresh command's committed result alike.
    await db.pool.query(`CREATE FUNCTION fail_release_${pid}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected release failure'; END $f$`);
    await db.pool.query(`CREATE TRIGGER fail_release BEFORE INSERT ON agent_data_read_logs FOR EACH ROW EXECUTE FUNCTION fail_release_${pid}()`);
    const retryKey = randomUUID();
    try {
      const replay = await call(run, id('note', 'write'), {value: 'v2'}, key);
      expect(replay.httpStatus).toBe(503);
      expect(JSON.stringify(replay.body)).not.toContain('v2');
      const fresh = await call(run, id('note', 'write'), {value: 'v3'}, retryKey);
      expect(fresh.httpStatus).toBe(503);
      expect(JSON.stringify(fresh.body)).not.toContain('v3');
    } finally {
      await db.pool.query('DROP TRIGGER fail_release ON agent_data_read_logs');
      await db.pool.query(`DROP FUNCTION fail_release_${pid}()`);
    }
    // The committed receipt is released by the same gate on retry, once the audit can commit.
    const again = await call(run, id('note', 'write'), {value: 'v3'}, retryKey);
    expect(again.body).toMatchObject({ok: true, replayed: true});
    expect(JSON.stringify(again.body)).toContain('v3');
    expect((await call(run, id('note', 'write'), {value: 'v2'}, key)).body).toMatchObject({ok: true, replayed: true});
    expect(await logs()).toBe(3);
  });

  it('rechecks plugin enablement at release: a disable committed first withholds, a holding release makes disable wait', async () => {
    const run = await agentRun(await grants(ownerOnly(member)));
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [run.id]);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const pending = call(run, id('note', 'list')).finally(() => { settled = true; });
      // The query has executed; its release waits on the Run row.
      await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
      expect(settled).toBe(false);
      await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
      await holder.query('COMMIT');
      const result = await pending;
      expect(result.httpStatus).toBe(503);
      expect(JSON.stringify(result.body)).not.toContain('note text');
    } finally { await holder.end(); }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows[0].n).toBe(0);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    // A release holding its locks: the disable waits for it to commit.
    const releaser = new pg.Client({connectionString: db.connectionUri});
    await releaser.connect();
    try {
      await releaser.query('BEGIN');
      const runRow = (await releaser.query<RunRecord>('SELECT * FROM runs WHERE id=$1', [run.id])).rows[0]!;
      const noteList = manifest.operations.find(o => o.id === id('note', 'list'))!;
      await releasePluginResult(releaser, config, manifest, noteList, await runActor(releaser, runRow), {items: [{id: 'note-row'}]}, null);
      const releaserPid = (await releaser.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let disabled = false;
      const disabling = withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner)).finally(() => { disabled = true; });
      await waitForBlockedBy(db.pool, releaserPid, {settled: () => disabled});
      expect(disabled).toBe(false);
      await releaser.query('COMMIT');
      await disabling;
    } finally { await releaser.end(); }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows[0].n).toBe(1);
    const after = await call(run, id('note', 'list'));
    expect(after.httpStatus).not.toBe(200);
    expect(JSON.stringify(after.body)).not.toContain('note text');
  });

  it('releases a personal read to a shared Room only as what every current reader can read, and rechecks readers at release', async () => {
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: owner}, {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space'}));
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, member]);
    const room = randomUUID(), session = randomUUID();
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Pair','active',now(),now(),false)`, [room, space, project, member]);
    for (const user of [member, owner]) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
    await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, project]);
    const run = await agentRun(await grants({origin: 'manual', instructingUserId: member, audience: [member, owner].sort()}));
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [run.id, session]);
    // Both readers read the shared ledger; the member's private ledger is withheld.
    const both = await call(run, id('account', 'list'));
    expect(both.httpStatus, JSON.stringify(both.body)).toBe(200);
    expect((both.body.data as {items: unknown[]}).items).toEqual([{id: 'account-row', value: 'shared ledger'}]);
    expect(JSON.stringify(both.body)).not.toContain('member only ledger');
    expect(await taint(run.id)).toMatchObject({plugin_reads: [{plugin_id: pid, data_class: 'personal'}]});
    expect((await db.pool.query('SELECT data_class FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows).toEqual([{data_class: 'personal'}]);
    // Sensitive data stays refused in the same Room, whatever the owner consents to.
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
    const diary = await call(run, id('diary', 'list'));
    expect(diary.httpStatus).toBe(403);
    expect(JSON.stringify(diary.body)).not.toContain('secret diary text');
    // A third reader joins: the intersection now also needs their rows, so nothing is released.
    const third = randomUUID();
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Third','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [third]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, third]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, third]);
    await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, third]);
    expect(((await call(run, id('account', 'list'))).body.data as {items: unknown[]}).items).toEqual([]);
    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`, [room, third]);
    // The audience changes between execution and release: the release recheck withholds the result.
    const holder = new pg.Client({connectionString: db.connectionUri});
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM runs WHERE id=$1 FOR UPDATE', [run.id]);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const pending = call(run, id('account', 'list')).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, holderPid, {settled: () => settled});
      await db.pool.query(`UPDATE room_user_members SET status='active' WHERE room_id=$1 AND user_id=$2`, [room, third]);
      await holder.query('COMMIT');
      const changed = await pending;
      expect(changed.httpStatus).toBe(503);
      expect(JSON.stringify(changed.body)).not.toContain('shared ledger');
    } finally { await holder.end(); }
    await db.pool.query(`UPDATE room_user_members SET status='removed' WHERE room_id=$1 AND user_id=$2`, [room, third]);
    // A reader who is no longer an active Space member refuses the read instead of lending the speaker's authority.
    await db.pool.query(`UPDATE space_memberships SET status='suspended' WHERE space_id=$1 AND user_id=$2`, [space, owner]);
    const lost = await call(run, id('account', 'list'));
    expect(lost.httpStatus).not.toBe(200);
    expect(JSON.stringify(lost.body)).not.toContain('shared ledger');
  });
  it('releases a shared-audience page only when its total, cursor and summary are what every reader reads too', async () => {
    await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: owner}, {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space'}));
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, member]);
    const room = randomUUID(), session = randomUUID();
    await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Pair','active',now(),now(),false)`, [room, space, project, member]);
    for (const user of [member, owner]) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
    await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, project]);
    const run = await agentRun(await grants({origin: 'manual', instructingUserId: member, audience: [member, owner].sort()}));
    await db.pool.query('UPDATE runs SET session_id=$2 WHERE id=$1', [run.id, session]);
    // The member's own page counts two rows, points past the private one and summarizes it; the owner's does not.
    const leaked = await call(run, id('account', 'page'));
    expect(leaked.httpStatus).not.toBe(200);
    for (const secret of ['member only ledger', 'account_private', '"total"']) expect(JSON.stringify(leaked.body)).not.toContain(secret);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1', [run.id])).rows[0].n).toBe(0);
    // Once the owner's own page is the same in every non-row field, the page is released whole.
    await db.pool.query(`INSERT INTO plugin_${pid}.records(space_id,user_id,key,value) VALUES ($1,$2,'account_private','member only ledger')`, [space, owner]);
    const same = await call(run, id('account', 'page'));
    expect(same.httpStatus, JSON.stringify(same.body)).toBe(200);
    expect(same.body.data).toEqual({items: [{id: 'account-row', value: 'shared ledger'}, {id: 'account_private-row', value: 'member only ledger'}], total: 2, next_cursor: 'account_private', summary: {latest: 'member only ledger'}});
    // Same total and cursor, but the summary still describes the member's private row: withheld.
    await db.pool.query(`UPDATE plugin_${pid}.records SET value='owner only ledger' WHERE space_id=$1 AND user_id=$2 AND key='account_private'`, [space, owner]);
    const partial = await call(run, id('account', 'page'));
    expect(partial.httpStatus).not.toBe(200);
    expect(JSON.stringify(partial.body)).not.toContain('member only ledger');
  });

  it('withholds every non-row field that differs between readers, nested or empty, and never strips one to fit', () => {
    const row = (n: number) => ({id: `r${n}`});
    const mine = {items: [row(1), row(2)], total: 2, next_cursor: 'c2', page: {size: 2, filters: {kind: ['a']}}};
    // Equal non-row fields: the common rows are released with them.
    expect(readableIntersection(mine, [{...mine, items: [row(2), row(1)]}])).toEqual(mine);
    expect(readableIntersection(mine, [{...mine, items: [row(1)]}])).toEqual({...mine, items: [row(1)]});
    // Empty intersection with agreeing fields is a real (empty) answer; with a differing count it is withheld.
    expect(readableIntersection({...mine, items: [row(1)], total: 1}, [{...mine, items: [row(3)], total: 1}])).toEqual({...mine, items: [], total: 1});
    expect(() => readableIntersection(mine, [{...mine, items: [], total: 0}])).toThrow();
    // Cursor, nested summary, a field only one side has: each withholds.
    expect(() => readableIntersection(mine, [{...mine, next_cursor: null}])).toThrow();
    expect(() => readableIntersection(mine, [{...mine, page: {size: 2, filters: {kind: ['b']}}}])).toThrow();
    expect(() => readableIntersection(mine, [{items: mine.items, total: 2, next_cursor: 'c2'}])).toThrow();
    expect(() => readableIntersection({items: mine.items}, [{items: mine.items, extra: 1}])).toThrow();
    // A reader whose result is not a list, or a result whose rows are nested deeper, needs exact equality.
    expect(() => readableIntersection(mine, [{rows: mine.items}])).toThrow();
    const nested = {page: {items: [row(1)], total: 1}};
    expect(readableIntersection(nested, [structuredClone(nested)])).toEqual(nested);
    expect(() => readableIntersection(nested, [{page: {items: [], total: 0}}])).toThrow();
    // Every reader must agree, not just one.
    expect(() => readableIntersection(mine, [mine, {...mine, total: 3}])).toThrow();
  });

  it('lets the owner see and revoke a background consent a scheduled Run used, and nothing of anyone else', async () => {
    const repo = (user: string, input: Parameters<PluginDataGrantRepository['create']>[1]) => withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: user}, input));
    const background = await repo(member, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background'});
    const run = await agentRun(await grants(ownerOnly(member, 'scheduled')));
    await db.pool.query(`UPDATE runs SET trigger_origin='automation' WHERE id=$1`, [run.id]);
    const first = await call(run, id('diary', 'list'));
    // Parent negative control: the call-time origin check never recognised a scheduled Run.
    expect(first.httpStatus, JSON.stringify(first.body)).toBe(200);
    // Unrelated consents that must survive: another Run's grant, another person's background consent.
    const otherRun = await agentRun(await grants(ownerOnly(member)));
    const otherRunGrant = await repo(member, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: otherRun.id});
    const ownersBackground = await repo(owner, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'background'});
    asUser(member);
    const listed = (await userQuery('plugin_data_grant.list', {run_id: run.id})).json();
    expect(listed.data.items.map((g: {id: string}) => g.id)).toEqual([background.id]);
    const revoked = await userCall('plugin_data_grant.revoke_run', {run_id: run.id});
    expect(revoked.json()).toMatchObject({status: 'succeeded', data: {revoked_grant_ids: [background.id]}});
    const status = async (grantId: string) => (await db.pool.query<{status: string}>('SELECT status FROM plugin_data_grants WHERE id=$1', [grantId])).rows[0]!.status;
    expect([await status(background.id), await status(otherRunGrant.id), await status(ownersBackground.id)]).toEqual(['revoked', 'active', 'active']);
    // The same scheduled Run calling again is refused and releases nothing.
    const again = await call(run, id('diary', 'list'));
    expect(again.httpStatus).not.toBe(200);
    expect(JSON.stringify(again.body)).not.toContain('secret diary text');
  });
  it('never lets consent stand in for network isolation: sensitive data needs a live strict launch without network', async () => {
    const attempt = async (how: Launch) => {
      const run = await agentRun(await grants(ownerOnly(member)), {}, how);
      await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
      const result = await call(run, id('diary', 'list'));
      return {run, result, rule: (await db.pool.query<{policy_rule_id: string | null}>('SELECT policy_rule_id FROM policy_decision_records WHERE id=$1', [result.body.policy_decision_record_id])).rows[0]?.policy_rule_id};
    };
    // Parent negative controls: owner consent alone used to release in each of these launches.
    for (const how of [null, {egress: 'default', hostKind: 'server'}, {egress: 'install', hostKind: 'server'}, {egress: 'none', hostKind: 'remote'}] as Launch[]) {
      const {result, rule} = await attempt(how);
      expect(result.httpStatus, JSON.stringify(how)).toBe(404);
      expect(rule).toBe('plugin_data_scenario_refused');
      expect(JSON.stringify(result.body)).not.toContain('secret diary text');
    }
    // The server's own launch writer records the proof the release accepts.
    const bound = await attempt(null);
    expect(bound.result.httpStatus).toBe(404);
    const launchId = randomUUID();
    expect(await new PgRunRepository(db.pool, config).bindAttemptLaunch({space_id: space, run_id: bound.run.id, launch_id: launchId,
      isolation: {host_id: await host('server'), host_kind: 'server', egress_profile: 'none', sandbox_mode: 'read_write'}})).toBe(true);
    expect((await call(bound.run, id('diary', 'list'))).httpStatus).toBe(200);
    // Relaunching the same attempt without isolation (as a `default` dispatch would) drops the proof.
    expect(await new PgRunRepository(db.pool, config).bindAttemptLaunch({space_id: space, run_id: bound.run.id, launch_id: randomUUID(), expected_launch_id: launchId})).toBe(true);
    expect((await call(bound.run, id('diary', 'list'))).httpStatus).toBe(404);
    // A record that names another launch than the attempt's current nonce proves nothing.
    const stale = await attempt({egress: 'none', hostKind: 'server'});
    expect(stale.result.httpStatus).toBe(200);
    await db.pool.query(`UPDATE run_attempts SET launch_isolation_json=NULL, launch_id=$2 WHERE run_id=$1`, [stale.run.id, randomUUID()]);
    expect((await call(stale.run, id('diary', 'list'))).httpStatus).toBe(404);
    // A record naming a Host that is not the built-in strict one, whatever its claimed kind, proves nothing either.
    const forged = await attempt({egress: 'none', hostKind: 'server'});
    await db.pool.query(`UPDATE run_attempts SET launch_isolation_json=jsonb_set(launch_isolation_json,'{host_id}',to_jsonb($2::text)) WHERE run_id=$1`, [forged.run.id, await host('remote')]);
    expect((await call(forged.run, id('diary', 'list'))).httpStatus).toBe(404);
    // Only the read made under the genuine record was attributed.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE run_id=$1`, [forged.run.id])).rows[0].n).toBe(1);
    // The database refuses a record that does not name the attempt's own launch.
    await expect(db.pool.query(`UPDATE run_attempts SET launch_isolation_json='{"launch_id":"other","egress_profile":"none"}'::jsonb WHERE run_id=$1`, [forged.run.id])).rejects.toThrow(/ck_run_attempts_launch_isolation/);
  });
  it('a real dispatch to the built-in strict Host composes the model-only launch, and only its own record releases sensitive data', async () => {
    // No hand-written launch record: the product dispatcher decides and records it.
    const upstreamMarker = 'UPSTREAM-PROVIDER-KEY-NEVER-SENT';
    __setProvidersDbPortForTests({async getProvider() {
      return {id: 'prov-1', name: 'Synthetic', provider_type: 'anthropic', base_url: 'https://synthetic-model.invalid', claude_compatible_base_url: 'https://synthetic-model.invalid', default_model: 'synthetic-1', api_key_hint: upstreamMarker};
    }} as never);
    setProviderProxyBaseUrlForProcess('http://server:8790', 'http://proxy.example.invalid:8790');
    const bindings: RemoteBindingPort = {
      async resolve() { return {provider_id: 'prov-1', model: 'synthetic-1'}; },
      async record() {},
      async profileScope(r) { return {agent_id: r.agent_id!, container_kind: 'agent', container_id: r.agent_id!}; },
    };
    class Sink implements HostFrameSink { sent: Record<string, unknown>[] = []; send(frame: Record<string, unknown>) { this.sent.push(frame); } close() {} }
    const dispatch = async (hostId: string, sensitive = true) => {
      const run = await agentRun(sensitive ? await grants(ownerOnly(member)) : [], {}, null);
      await db.pool.query(`UPDATE runs SET runtime_key='claude_code' WHERE id=$1`, [run.id]);
      if (sensitive) await withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: member}, {plugin_id: pid, toolset: 'read', data_class: 'sensitive', scope: 'run', target_run_id: run.id}));
      const fresh = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run.id])).rows[0]!;
      const registry = new HostConnectionRegistry(), sink = new Sink(), leases = new ProviderProxyLeaseRegistry();
      registry.registerConnection(hostId, sink);
      const execution = executeRemoteHostCliAdapter({run: fresh, prompt: 'summarize my diary', model: null, resume_session_id: null}, hostId, null,
        {connectionRegistry: registry, bindings, config, db: db.pool, leaseRegistry: leases, policyEnforcer: async () => ({status: 'allow' as const, policy_decision_record_id: null})});
      await Promise.race([vi.waitUntil(() => sink.sent.some(f => f.type === 'launch'), {timeout: 30000}),
        execution.then(result => { throw new Error(`dispatch ended before launch: ${JSON.stringify(result).slice(0, 600)}`); })]);
      const frame = sink.sent.find(f => f.type === 'launch')! as Record<string, any>;
      const record = (await db.pool.query<{launch_isolation_json: Record<string, unknown>; launch_id: string}>(`SELECT launch_isolation_json, launch_id FROM run_attempts WHERE run_id=$1`, [run.id])).rows[0]!;
      const read = await call(fresh, id('diary', 'list'));
      const liveLeases = leases.size();
      const env = (frame.provider_binding?.env ?? {}) as Record<string, string>;
      const leaseId = /\/anthropic\/([^/]+)$/.exec(env.ANTHROPIC_BASE_URL ?? '')?.[1];
      const policy = leaseId ? leases.resolve(leaseId, env.ANTHROPIC_AUTH_TOKEN!)?.request_policy : undefined;
      registry.receiveComplete(hostId, run.id, {exit_code: 0, timed_out: false, error: null}, String(frame.launch_id));
      await execution;
      return {frame, record, read, liveLeases, policy, leasesAfter: leases.size()};
    };
    const strictHost = await host('server');
    // An older built-in daemon (no `model_channel` report): ordinary egress, and the sensitive read refuses.
    await db.pool.query(`UPDATE hosts SET capabilities_json='{}'::jsonb WHERE id=$1`, [strictHost]);
    const old = await dispatch(strictHost);
    expect(old.frame.isolation).toMatchObject({egress_profile: 'default'});
    expect(old.frame.model_channel).toBeUndefined();
    expect(old.read.httpStatus).toBe(404);
    // The current built-in daemon: the dispatcher selects egress `none` plus the Run's model lease channel.
    await db.pool.query(`UPDATE hosts SET capabilities_json='{"model_channel":1}'::jsonb WHERE id=$1`, [strictHost]);
    const isolated = await dispatch(strictHost);
    expect(isolated.frame.isolation).toEqual({sandbox_mode: 'read_write', egress_profile: 'none'});
    const leaseId = isolated.frame.model_channel.lease_id as string;
    expect(isolated.frame.model_channel).toEqual({version: 1, upstream_base_url: 'http://server:8790', route: 'anthropic', lease_id: leaseId, loopback_port: 18790});
    expect(isolated.frame.provider_binding.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:18790/anthropic/${leaseId}`);
    expect(JSON.stringify(isolated.frame)).not.toContain(upstreamMarker);
    expect(JSON.stringify(isolated.frame.argv)).not.toContain(isolated.frame.provider_binding.env.ANTHROPIC_AUTH_TOKEN);
    expect(isolated.record.launch_isolation_json).toEqual({launch_id: isolated.frame.launch_id, host_id: strictHost, host_kind: 'server', egress_profile: 'none', sandbox_mode: 'read_write', model_channel: 'provider_lease', profile_key: isolated.frame.provider_binding.profile_key, host_reset_generation: 0});
    expect(isolated.read.httpStatus, JSON.stringify(isolated.read.body)).toBe(200);
    expect((isolated.read.body.data as {items: {value: string}[]}).items[0]!.value).toBe('secret diary text');
    // The lease (the channel's only destination) lives while the Run runs and is revoked when it ends.
    expect(isolated.liveLeases).toBe(1);
    expect(isolated.leasesAfter).toBe(0);
    // That lease is model-only at the proxy; an ordinary Run's lease is not.
    expect(isolated.policy).toBe('model_only');
    expect(old.policy).toBeNull();
    // A Run that pins no sensitive tool keeps its ordinary egress.
    const ordinary = await dispatch(strictHost, false);
    expect(ordinary.frame.isolation).toMatchObject({egress_profile: 'default'});
    expect(ordinary.frame.model_channel).toBeUndefined();
    expect(ordinary.policy).toBeNull();
    // One backend keeps its CLI state apart by channel (ADR 0036 §11): the isolated launch in its own directory, an
    // ordinary-egress launch (also the older daemon's) in the networked one — never the channel-less one both shared.
    const backendOf = (frame: Record<string, any>) => String(frame.provider_binding.profile_key).split('/').slice(-2).join('/');
    expect(backendOf(isolated.frame)).toBe('claude_code/prov-1.isolated');
    expect(backendOf(ordinary.frame)).toBe('claude_code/prov-1.network');
    expect(backendOf(old.frame)).toBe('claude_code/prov-1.network');
    // A paired Host claiming the capability is never selected; its Run gets no channel and no release.
    const paired = await host('remote');
    await db.pool.query(`UPDATE hosts SET capabilities_json='{"model_channel":1}'::jsonb WHERE id=$1`, [paired]);
    const remote = await dispatch(paired);
    expect(remote.frame.isolation).toMatchObject({egress_profile: 'default'});
    expect(remote.frame.model_channel).toBeUndefined();
    expect(remote.read.httpStatus).toBe(404);
    __setProvidersDbPortForTests(null);
    setProviderProxyBaseUrlForProcess(null);
  });
});
