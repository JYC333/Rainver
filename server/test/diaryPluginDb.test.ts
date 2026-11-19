import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {RainverPlugin, RunToolGrant} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {getOfficialPlugin} from '../src/modules/plugins/registry.js';
import {pluginToolPins, type RunScenario} from '../src/modules/plugins/dataAccess.js';
import {PluginDataGrantRepository} from '../src/modules/plugins/dataGrantRepository.js';
import {setOperationPluginEnabled} from '../src/modules/plugins/lifecycle.js';
import {buildRunToolGrants} from '../src/modules/systemActions/runToolGrants.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {proposalsModule, __setProposalIdentityForTests} from '../src/modules/proposals/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {JobHandlerRegistry} from '../src/modules/jobs/handlerRegistry.js';
import {JobWorker} from '../src/modules/jobs/worker.js';

/**
 * The rebuilt Diary package (Plan 7) as shipped: the compiled artifact, the
 * offline installer, the real
 * P1 HTTP, Agent tool and Proposal entries and the canonical Job worker on real
 * PostgreSQL.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'diary';
const op = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
const REFLECTION_JOB = 'plugin.diary.reflection.generate';
beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});

let host: PluginHost, space: string, secondSpace: string, user: string, other: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
async function addPerson(person: string, spaceId: string, role = 'member') {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system') ON CONFLICT DO NOTHING`, [person]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [randomUUID(), spaceId, person, role]);
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); secondSpace = randomUUID(); user = randomUUID(); other = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner: user, project: randomUUID(), spaceType: 'team'});
  await seedSpaceOwnerProject(db.pool, {space: secondSpace, owner: randomUUID(), project: randomUUID(), spaceType: 'team'});
  await addPerson(user, secondSpace);
  await addPerson(other, space);
  // Run-bound consent is recorded in the data owner's Personal Space.
  const personal = randomUUID();
  await db.pool.query(`INSERT INTO spaces (id,name,type,created_at,updated_at) VALUES ($1,'Personal','personal',now(),now())`, [personal]);
  await addPerson(user, personal, 'owner');
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule, proposalsModule]);
  host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  for (const person of [user, other]) await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, person, {}));
  as(user);
});
afterEach(async () => { __setAuthIdentityForTests(null); __setProposalIdentityForTests(null); await app?.close(); });
const as = (person: string, spaceId = space) => { __setAuthIdentityForTests({spaceId, userId: person}); __setProposalIdentityForTests({spaceId, userId: person}); };
const action = (id: string, payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': key}, payload});
const query = (id: string, input: Record<string, unknown>) => app.inject({method: 'GET', url: `/api/v1/queries/${id}?input=${encodeURIComponent(JSON.stringify(input))}`});
const ok = async <T = any>(response: Promise<{statusCode: number; body: string; json(): any}>): Promise<T> => {
  const r = await response;
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as T;
};
const save = (date: string, content: string) => ok(action(op('entry.save'), {date, content}));
const get = (date: string) => ok(query(op('entry.get'), {date}));
const rows = async (table: string) => (await db.pool.query(`SELECT * FROM plugin_diary.${table} ORDER BY id`)).rows;
const accept = (proposal: string, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/proposals/${proposal}/accept`, headers: {'idempotency-key': key}, payload: {}});
const proposalStatus = async (id: string) => (await db.pool.query<{status: string}>('SELECT status FROM proposals WHERE id=$1', [id])).rows[0]?.status;

const ALL = Object.values(plugin?.operationManifest?.operations ?? []).map(o => o.id);
const ownerOnly = (person: string): RunScenario => ({origin: 'manual', instructingUserId: person, audience: [person]});
const grants = (scenario: RunScenario) => buildRunToolGrants(ALL, {allowed_tools: ALL}, {db: db.pool, spaceId: space, userId: user, config, scenario});
async function serverHost() {
  const existing = (await db.pool.query<{id: string}>(`SELECT id FROM hosts WHERE kind='server'`)).rows[0]?.id;
  if (existing) return existing;
  const hostId = randomUUID();
  await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,NULL,'Server','server',now(),now())`, [hostId]);
  await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,environment_kind,name,kind,status,created_at,updated_at) VALUES ($1,NULL,$1,'server','server','server','online',now(),now())`, [hostId]);
  return hostId;
}
/** An owner-only Run of `user` whose latest attempt carries the server's isolated launch record (ADR 0030 §4a). */
async function agentRun(snapshot: RunToolGrant[]) {
  const runId = randomUUID(), launchId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',permission_snapshot_json=$3::jsonb WHERE id=$1`,
    [runId, user, JSON.stringify({tool_grants: snapshot, plugin_tool_pins: pluginToolPins(config, snapshot)})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,launch_id,launch_isolation_json,created_at,updated_at) VALUES ($1,$2,$3,1,'running',$4,$5::jsonb,now(),now())`,
    [randomUUID(), space, runId, launchId, JSON.stringify({launch_id: launchId, host_id: await serverHost(), host_kind: 'server', egress_profile: 'none', sandbox_mode: 'read_write'})]);
  return runId;
}
const agentCall = async (runId: string, name: string, args: Record<string, unknown>, key = randomUUID()) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: key, name: op(name), arguments: args})) as OperationToolResponse;
};
const proposalOf = (r: OperationToolResponse) => {
  const body = r.body as {proposal_id?: string; data?: {proposal_id?: string}};
  return (body.proposal_id ?? body.data?.proposal_id)!;
};
const consent = (runId: string, toolset: 'read' | 'write') => withTransaction(db.pool, tx => new PluginDataGrantRepository(tx, config).create({spaceId: space, userId: user}, {plugin_id: pid, toolset, data_class: 'sensitive', scope: 'run', target_run_id: runId}));

describe('Diary package (Plan 7)', () => {
  it('replaces the legacy descriptor with a user-level package whose every operation is sensitive', async () => {
    expect(getOfficialPlugin(pid)).toBeUndefined();
    expect(getOfficialPlugin(pid, config)).toMatchObject({operation_api: 1, scope: 'user', default_enabled: false, version: '1.0.0'});
    const ops = Object.fromEntries(plugin.operationManifest!.operations.map(o => [o.id.slice(`plugin.${pid}.`.length), `${o.data_class}/${o.side_effects}/${o.actors?.join() ?? 'any'}`]));
    expect(ops).toEqual({
      'entry.get': 'sensitive/none/any', 'entry.list': 'sensitive/none/any', 'entry.on_this_day': 'sensitive/none/any',
      'entry.save': 'sensitive/durable/user', 'entry.delete': 'sensitive/durable/user', 'entry.propose_append': 'sensitive/proposal/any',
      'reflection.list': 'sensitive/none/any',
    });
    // No legacy route is mounted any more.
    expect((await app.inject({method: 'GET', url: '/api/v1/diary/today'})).statusCode).toBe(404);
  });

  it('keeps each Diary to its person across Spaces through the human operations', async () => {
    const written = await save('2026-11-19', 'Today I wrote');
    expect(written.entry).toMatchObject({user_id: user, entry_date: '2026-11-19', content: 'Today I wrote'});
    expect((await save('2026-11-19', 'Rewritten')).entry.id).toBe(written.entry.id);
    await save('2025-11-19', 'Last year');
    expect((await get('2026-11-19')).entry.content).toBe('Rewritten');
    expect((await ok(query(op('entry.list'), {limit: 1}))).entries.map((e: {entry_date: string}) => e.entry_date)).toEqual(['2026-11-19']);
    expect((await ok(query(op('entry.list'), {before: '2026-11-19'}))).entries.map((e: {entry_date: string}) => e.entry_date)).toEqual(['2025-11-19']);
    // User-level: the same person in another Space reads the same Diary.
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, secondSpace, user, {}));
    as(user, secondSpace);
    expect((await get('2026-11-19')).entry.id).toBe(written.entry.id);
    // Another member of the same Space reads and deletes nothing of it.
    as(other);
    expect((await get('2026-11-19')).entry).toBeNull();
    expect((await ok(query(op('entry.list'), {}))).entries).toEqual([]);
    expect(await ok(action(op('entry.delete'), {date: '2026-11-19'}))).toEqual({deleted: false});
    const missing = await query(op('reflection.list'), {date: '2026-11-19'});
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toMatchObject({code: 'operation_invalid_input', metadata: {reason: 'entry_not_found'}});
    as(user);
    expect(await ok(action(op('entry.delete'), {date: '2026-11-19'}))).toEqual({deleted: true});
    // Invalid input is refused by the declared schema before any SQL.
    expect((await action(op('entry.save'), {date: '2026-02-30', content: 'x'})).statusCode).toBe(422);
    // Disabled for this person: every entry is closed and nothing is written.
    await setOperationPluginEnabled(config, pid, space, user, false);
    expect((await action(op('entry.save'), {date: '2026-11-20', content: 'x'})).statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.pool.query(`SELECT 1 FROM plugin_diary.entries WHERE user_id=$1 AND entry_date='2026-11-20'`, [user])).rows).toHaveLength(0);
  });

  it('queues the same-day reflection with the save only while the person enables it', async () => {
    const worker = () => {
      const registry = new JobHandlerRegistry();
      host.applyJobHandlers(registry);
      return new JobWorker(new PgJobQueueRepository(db.pool), registry, `diary-${randomUUID()}`, [REFLECTION_JOB]);
    };
    const jobs = async () => (await db.pool.query<{status: string; result_json: Record<string, unknown> | null}>('SELECT status,result_json FROM jobs WHERE job_type=$1 AND user_id=$2 ORDER BY created_at', [REFLECTION_JOB, user])).rows;
    await save('2025-11-19', 'Last year');
    expect(await jobs()).toEqual([]);
    await ok(action('official_plugin.settings.update', {plugin_id: pid, settings: {ai_reflection_enabled: true}}));
    const today = await save('2026-11-19', 'Today');
    await save('2026-11-19', 'Today, again');
    expect((await jobs()).map(j => j.status)).toEqual(['pending', 'pending']);
    // Two workers on the same entry and day land one reflection.
    await Promise.all([worker().processOne(), worker().processOne()]);
    expect((await jobs()).map(j => j.status)).toEqual(['completed', 'completed']);
    const reflections = (await ok(query(op('reflection.list'), {date: '2026-11-19'}))).reflections;
    expect(reflections).toHaveLength(1);
    expect(reflections[0]).toMatchObject({entry_id: today.entry.id, ai_model: 'stub'});
    expect(reflections[0].content).toContain('**2025-11-19**: Last year');
    expect((await rows('reflections')).filter(r => r.entry_id === today.entry.id).map(r => r.user_id)).toEqual([user]);
    // Turned off before the Job runs: it does nothing.
    await save('2026-11-19', 'Third');
    await ok(action('official_plugin.settings.update', {plugin_id: pid, settings: {ai_reflection_enabled: false}}));
    await worker().processOne();
    expect((await jobs()).at(-1)).toMatchObject({status: 'completed', result_json: {skipped: true, reason: 'reflection_disabled'}});
    // Deleting the entry deletes its reflections.
    await ok(action(op('entry.delete'), {date: '2026-11-19'}));
    expect((await rows('reflections')).filter(r => r.entry_id === today.entry.id)).toEqual([]);
  });

  it('gives an Agent no write tool, only consented isolated reads and append proposals the person decides', async () => {
    await save('2026-11-19', 'Written by me.');
    const snapshot = await grants(ownerOnly(user));
    const names = snapshot.map(g => g.action_id);
    expect(names).toEqual(expect.arrayContaining([op('entry.get'), op('entry.list'), op('entry.propose_append')]));
    expect(names).not.toContain(op('entry.save'));
    expect(names).not.toContain(op('entry.delete'));
    // A shared audience (anyone else reads the conversation) gets no Diary tool at all.
    expect((await grants({origin: 'manual', instructingUserId: user, audience: [user, other].sort()})).map(g => g.action_id).filter(n => n.startsWith(`plugin.${pid}.`))).toEqual([]);
    expect((await grants({...ownerOnly(user), origin: 'delegated'})).map(g => g.action_id).filter(n => n.startsWith(`plugin.${pid}.`))).toEqual([]);

    const runId = await agentRun(snapshot);
    expect((await agentCall(runId, 'entry.get', {date: '2026-11-19'})).body).toMatchObject({ok: false, error: {code: 'operation_consent_required'}});
    expect((await agentCall(runId, 'entry.save', {date: '2026-11-19', content: 'Overwritten'})).body).toMatchObject({ok: false});
    await consent(runId, 'read');
    const read = await agentCall(runId, 'entry.get', {date: '2026-11-19'});
    expect(read.httpStatus, JSON.stringify(read.body)).toBe(200);
    expect(JSON.stringify(read.body)).toContain('Written by me.');
    expect((await db.pool.query('SELECT context_taint_json FROM runs WHERE id=$1', [runId])).rows[0].context_taint_json).toMatchObject({plugin_reads: expect.anything()});
    expect((await db.pool.query('SELECT data_class FROM agent_data_read_logs WHERE run_id=$1', [runId])).rows.map(r => r.data_class)).toContain('sensitive');

    await consent(runId, 'write');
    expect((await agentCall(runId, 'entry.propose_append', {date: '2026-11-19', text: 'Agent note'})).httpStatus).toBe(404);

    // A fresh Run needs separate consent to submit a Proposal for the person.
    const proposalRunId = await agentRun(snapshot);
    await consent(proposalRunId, 'read');
    // Write needs its own consent; a read consent never implies it.
    expect((await agentCall(proposalRunId, 'entry.propose_append', {date: '2026-11-19', text: 'Agent note'})).body).toMatchObject({ok: false, error: {code: 'operation_consent_required'}});
    await consent(proposalRunId, 'write');
    const key = randomUUID();
    const proposed = await agentCall(proposalRunId, 'entry.propose_append', {date: '2026-11-19', text: 'Agent note'}, key);
    expect(proposed.httpStatus, JSON.stringify(proposed.body)).toBe(202);
    const proposalId = proposalOf(proposed);
    expect(await proposalStatus(proposalId)).toBe('pending');
    // Pending: nothing is written; a replay is the same Proposal.
    expect((await get('2026-11-19')).entry.content).toBe('Written by me.');
    expect(JSON.stringify((await agentCall(proposalRunId, 'entry.propose_append', {date: '2026-11-19', text: 'Agent note'}, key)).body)).toContain(proposalId);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE id=$1 OR (payload_json->>'text')='Agent note'`, [proposalId])).rows[0].n).toBe(1);
    // The person approves: the text goes after theirs, once, also on an accept replay.
    const acceptKey = randomUUID();
    const accepted = await accept(proposalId, acceptKey);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await get('2026-11-19')).entry.content).toBe('Written by me.\n\nAgent note');
    expect((await accept(proposalId, acceptKey)).statusCode).toBe(200);
    expect((await get('2026-11-19')).entry.content).toBe('Written by me.\n\nAgent note');
    expect(await proposalStatus(proposalId)).toBe('accepted');
    // Rejected: nothing changes.
    const second = await agentCall(proposalRunId, 'entry.propose_append', {date: '2026-11-20', text: 'Not wanted'});
    const secondId = proposalOf(second);
    expect((await app.inject({method: 'POST', url: `/api/v1/proposals/${secondId}/reject`, headers: {'idempotency-key': randomUUID()}, payload: {}})).statusCode).toBe(200);
    expect((await get('2026-11-20')).entry).toBeNull();
  });

  it('rolls an approved append back with a safe reason when it no longer fits, settling the Proposal as not applied', async () => {
    await save('2026-11-19', 'x'.repeat(199_990));
    const submitted = await action(op('entry.propose_append'), {date: '2026-11-19', text: 'y'.repeat(100)});
    expect(submitted.statusCode, submitted.body).toBe(202);
    const proposalId = submitted.json().proposal_id as string;
    const key = randomUUID();
    const refused = await accept(proposalId, key);
    // The canonical decision commits the refusal (nothing applied) instead of a stale success.
    expect(refused.statusCode).toBe(200);
    expect(refused.json().data).toMatchObject({result_type: 'operation_failure', result: {error: {code: 'operation_conflict', metadata: {reason: 'entry_too_long'}}}});
    expect(refused.body).not.toContain('xxxx');
    expect(refused.body).not.toContain('yyyy');
    expect((await get('2026-11-19')).entry.content).toHaveLength(199_990);
    expect(await proposalStatus(proposalId)).toBe('superseded');
    // The same key replays the receipt; nothing is applied on retry.
    expect((await accept(proposalId, key)).json()).toEqual(refused.json());
    expect((await get('2026-11-19')).entry.content).toHaveLength(199_990);
  });
});
