import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {convertBundledPluginMigrationHistory} from '../src/modules/plugins/migrationConversion.js';
import {originalPluginMigrations} from '../src/modules/plugins/migrationSql.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {waitForBlockedBy} from './support/lockWait.js';
import {useTestDatabase} from './support/testDatabase.js';
import {retiredApplicationsRelease} from './support/retiredApplicationsRelease.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {insertInitialNoteRevision, writeNote} from '../src/modules/knowledge/noteRevisionService.js';
import {markdownToPm} from '../src/modules/knowledge/noteDocument.js';

/**
 * The application module's four areas on the shipped `applications` package and real
 * PostgreSQL: funding records (track `funding`) linked to any number of program
 * applications and read as the same record from both sides, separate versus automatic
 * submission, the personal material library over existing Notes with use and version
 * status, contacts linked to several applications, and the upgrade migration that keeps
 * every existing contact binding.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'phd_application';
const opId = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
/** The retired `applications` release whose original chain earlier instances applied. */
const legacyRelease = retiredApplicationsRelease();
let space: string, owner: string, writer: string, projectA: string, projectB: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
const legacy = {space: randomUUID(), user: randomUUID(), project: randomUUID(), application: randomUUID(), bound: randomUUID(), general: randomUUID(), event: randomUUID()};
/** Funding records written under 0003, before an approved submission was kept as history (0004). */
const legacyFunding = {submitted: randomUUID(), progressedOnce: randomUUID(), underReview: randomUUID(), movedBack: randomUUID(), edited: randomUUID(), ready: randomUUID(), planned: randomUUID(), automatic: randomUUID(), createdAfter0004: randomUUID(), submittedAfter0004: randomUUID()};

/**
 * The package's roles are cluster-wide while each test file has its own database, so this
 * file's upgrade (which reconciles the roles) can deadlock with another file installing the
 * package at the same moment. A deployment runs the installer alone; here it is retried.
 */
async function withPluginRoleRetry<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(attempt); } catch (error) {
      const e = error as {code?: string; message?: string; cause?: {code?: string}};
      if (attempt >= 4 || ![e.code, e.cause?.code].includes('40P01') && !/deadlock detected/.test(e.message ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
const install = (p: RainverPlugin) => withPluginRoleRetry(attempt => migrateOperationPlugin(db.pool, p, attempt ? {repairFailed: true} : {}));
beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  // An instance that installed the package before this change: migrations 0000–0002 only, with contacts bound through the old column.
  const original = originalPluginMigrations(legacyRelease.migrations![0].sql)!.flatMap(step => originalPluginMigrations(step.sql) ?? [step]);
  const before = original.slice(0, 3);
  await install({...legacyRelease, migrations: before, operationManifest: {...legacyRelease.operationManifest!, migrations: before.map(m => m.id)}});
  const own = [legacy.space, legacy.user, legacy.project];
  await db.pool.query(`INSERT INTO plugin_applications.applications(space_id,user_id,project_id,id,track,institution,program,status) VALUES($1,$2,$3,$4,'phd','ETH Zurich','PhD CS','planning')`, [...own, legacy.application]);
  await db.pool.query(`INSERT INTO plugin_applications.application_contacts(space_id,user_id,project_id,id,application_id,name,role) VALUES($1,$2,$3,$4,$5,'Prof. Ada','supervisor'),($1,$2,$3,$6,NULL,'Funding office','admissions')`, [...own, legacy.bound, legacy.application, legacy.general]);
  await db.pool.query(`INSERT INTO plugin_applications.application_contact_events(space_id,user_id,project_id,id,contact_id,occurred_on,channel,direction,summary,response) VALUES($1,$2,$3,$4,$5,'2026-10-01','email','outbound','Sent CV','awaiting')`, [...own, legacy.event, legacy.bound]);
  // An instance on 0003: funding records as its writers left them. Each was created at `planning`, revision 1,
  // and every later write advanced the revision: one approved submission moved on by ordinary progress, one
  // submitted and moved back to `preparing` (create, submitted, preparing: revision 3), one only edited twice
  // (indistinguishable from the previous one), and records with at most one write.
  const through0003 = original.slice(0, 4);
  await install({...legacyRelease, migrations: through0003, operationManifest: {...legacyRelease.operationManifest!, migrations: through0003.map(m => m.id)}});
  for (const [id, submission, status, revision] of [
    [legacyFunding.submitted, 'separate', 'submitted', 2], [legacyFunding.underReview, 'separate', 'under_review', 3],
    [legacyFunding.progressedOnce, 'separate', 'under_review', 2],
    [legacyFunding.movedBack, 'separate', 'preparing', 3], [legacyFunding.edited, 'separate', 'planning', 3],
    [legacyFunding.ready, 'separate', 'ready', 2], [legacyFunding.planned, 'separate', 'planning', 1], [legacyFunding.automatic, 'automatic', 'offer', 2],
  ] as const) {
    await db.pool.query(`INSERT INTO plugin_applications.applications(space_id,user_id,project_id,id,track,institution,program,submission,status,revision) VALUES($1,$2,$3,$4,'funding','Funder','Grant',$5,$6,$7)`, [...own, id, submission, status, revision]);
  }
  // Install the original 0004. Cutover must preserve its checksum and time in the audit.
  const through0004 = original.slice(0, 5);
  await install({...legacyRelease, migrations: through0004, operationManifest: {...legacyRelease.operationManifest!, migrations: through0004.map(m => m.id)}});
  const oldMark = await db.pool.query(`SELECT submission_recorded_at IS NOT NULL AS recorded FROM plugin_applications.applications WHERE id=$1`, [legacyFunding.progressedOnce]);
  expect(oldMark.rows).toEqual([{recorded: true}]);
  // Rows created with the history column already present can prove whether approval applied,
  // even after other writes advanced their revision.
  await db.pool.query(`INSERT INTO plugin_applications.applications(space_id,user_id,project_id,id,track,institution,program,submission,status,revision,submission_recorded_at)
    VALUES($1,$2,$3,$4,'funding','Funder','New grant','separate','preparing',3,NULL),
          ($1,$2,$3,$5,'funding','Funder','New grant','separate','preparing',3,now())`, [...own, legacyFunding.createdAfter0004, legacyFunding.submittedAfter0004]);
  const migrationJournal = async () => (await db.pool.query(
    `SELECT migration_id,checksum,applied_at::text FROM plugin_migrations WHERE plugin_id=$1 AND status='applied' ORDER BY migration_id`, [legacyRelease.id])).rows;
  const originalJournal = await migrationJournal();
  expect(originalJournal.slice(-2).map(row => row.checksum)).toEqual([
    '8f91046ec2ac39e1efbce4251b1f1321fee21fa58031f7c9ebfb05ac3669432c',
    'b3394692260543054fe729a188b87980bb0a19deeed53198d5b4574111b57827',
  ]);
  expect(await withPluginRoleRetry(() => convertBundledPluginMigrationHistory(db.pool, legacyRelease, {
    apply: true, offline: true, backupReference: 'applications-fixture.dump',
  // Pending: the squashed originals not yet applied, then every package migration after the baseline.
  }))).toMatchObject({state: 'converted', pending: [...original.slice(5), ...legacyRelease.migrations!.slice(1)].map(({id}) => id)});
  const upgradedJournal = await migrationJournal();
  const audit = await db.pool.query(`SELECT metadata_json->'source_records' AS original FROM official_plugin_events
    WHERE plugin_id=$1 AND event_type='migration_squashed'`, [legacyRelease.id]);
  expect(audit.rows[0].original).toMatchObject(originalJournal);
  expect(upgradedJournal.map(row => row.migration_id)).toEqual(legacyRelease.operationManifest!.migrations);
  // A further installer run verifies every applied checksum and skips the historical backfill.
  await install(legacyRelease);
  expect(await migrationJournal()).toEqual(upgradedJournal);
  // Verify that the current package serves the upgraded rows copied from the historical fixture.
  await install(plugin);
  await copyLegacyRows();
});
/** Every upgraded row of the retired schema, column by name, into the renamed package's schema. */
async function copyLegacyRows() {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = replica");
    const tables = (await client.query<{table_name: string}>(`SELECT table_name FROM information_schema.tables WHERE table_schema='plugin_applications' ORDER BY 1`)).rows;
    for (const {table_name: table} of tables) {
      const columns = (await client.query<{list: string}>(`SELECT string_agg(quote_ident(column_name), ',' ORDER BY column_name) AS list
        FROM information_schema.columns WHERE table_schema='plugin_applications' AND table_name=$1`, [table])).rows[0]!.list;
      await client.query(`INSERT INTO plugin_phd_application.${table} (${columns}) SELECT ${columns} FROM plugin_applications.${table}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
async function addPerson(user: string, projectRole: 'member') {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [user]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, user]);
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, projectA, user, projectRole]);
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); writer = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: projectA, spaceType: 'team'});
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())`, [projectB, space, owner]);
  await addPerson(writer, 'member');
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  as(owner);
  for (const project of [projectA, projectB]) await ok(action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: project}));
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });
const as = (user: string) => __setAuthIdentityForTests({spaceId: space, userId: user});
const action = (id: string, payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': key}, payload});
const query = (id: string, input: Record<string, unknown>) => app.inject({method: 'GET', url: `/api/v1/queries/${id}?input=${encodeURIComponent(JSON.stringify(input))}`});
const command = (name: string, input: Record<string, unknown>, project = projectA) => action(opId(name), {project_id: project, ...input});
const read = (name: string, input: Record<string, unknown> = {}, project = projectA) => query(opId(name), {project_id: project, ...input});
const ok = async <T = any>(response: Promise<{statusCode: number; body: string; json(): any}>): Promise<T> => {
  const r = await response;
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as T;
};
const reason = (r: {json(): any}) => r.json().error?.metadata?.reason;
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const create = async (input: Record<string, unknown>, project = projectA) => (await ok(command('application.create', input, project))).application_id as string;
const get = (application_id: string) => ok(read('application.get', {application_id}));
const ids = (rows: {id: string}[]) => rows.map(r => r.id);

async function note(title: string, text: string, opts: {owner?: string; project?: string | null; visibility?: 'space_shared'} = {}) {
  const id = randomUUID(), at = new Date().toISOString(), doc = markdownToPm(text);
  await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'note',$3,$6,$4,$5,now(),now())`,
    [id, space, title, opts.owner ?? owner, opts.project ?? null, opts.visibility ?? 'private']);
  await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text) VALUES($1,$2,$3::jsonb,'prosemirror_json',1,$4)`, [id, space, JSON.stringify(doc), text]);
  await insertInitialNoteRevision(db.pool, {spaceId: space, noteId: id, doc, at, userId: opts.owner ?? owner});
  return id;
}
const edit = (noteId: string, text: string) => withTransaction(db.pool, tx => writeNote(tx, {spaceId: space, noteId, content: {kind: 'doc', doc: markdownToPm(text)}, source: 'user_edit', userId: owner}));
async function agentRun(user: string, tools: string[]) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1`,
    [runId, user, projectA, JSON.stringify({tool_grants: tools.map(t => ({action_id: opId(t)}))})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  return runId;
}
const agentCall = async (runId: string, name: string, args: Record<string, unknown>) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: randomUUID(), name: opId(name), arguments: args})) as OperationToolResponse;
};
const phd = {institution: 'ETH Zurich', program: 'PhD in Computer Science'};

describe('Application module: funding, material library and contacts', () => {
  it('the upgrade keeps every contact binding as a link, Project-level contacts unlinked, and their history', async () => {
    const own = [legacy.space, legacy.user, legacy.project];
    expect((await db.pool.query(`SELECT contact_id,application_id FROM plugin_phd_application.application_contact_links WHERE space_id=$1 AND user_id=$2 AND project_id=$3`, own)).rows)
      .toEqual([{contact_id: legacy.bound, application_id: legacy.application}]);
    expect((await db.pool.query(`SELECT id,name FROM plugin_phd_application.application_contacts WHERE space_id=$1 ORDER BY name`, [legacy.space])).rows.map(r => r.name)).toEqual(['Funding office', 'Prof. Ada']);
    expect((await db.pool.query(`SELECT id FROM plugin_phd_application.application_contact_events WHERE space_id=$1`, [legacy.space])).rows).toEqual([{id: legacy.event}]);
    expect((await db.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='plugin_phd_application' AND table_name='application_contacts' AND column_name='application_id'`)).rows).toEqual([]);
    expect((await db.pool.query(`SELECT submission FROM plugin_phd_application.applications WHERE id=$1`, [legacy.application])).rows).toEqual([{submission: null}]);
  });

  it('the upgrade keeps confirmed and ambiguous history while unlocking records that could not have been submitted', async () => {
    const recorded = async (id: string) => (await db.pool.query<{r: boolean}>(`SELECT submission_recorded_at IS NOT NULL AS r FROM plugin_phd_application.applications WHERE id=$1`, [id])).rows[0]!.r;
    expect(await recorded(legacyFunding.submitted)).toBe(true);
    // Its status no longer says so, and the old rows kept no history: treated as submitted (fail closed).
    expect(await recorded(legacyFunding.underReview)).toBe(true);
    // Submitted and moved back to preparation: enough writes for that, so presumed submitted. A record only
    // edited as often cannot be told apart and is presumed the same way (the documented cost).
    expect(await recorded(legacyFunding.movedBack)).toBe(true);
    expect(await recorded(legacyFunding.edited)).toBe(true);
    // At most one write since creation at `planning`: no earlier submission could be hidden.
    expect(await recorded(legacyFunding.progressedOnce)).toBe(false);
    expect(await recorded(legacyFunding.ready)).toBe(false);
    expect(await recorded(legacyFunding.planned)).toBe(false);
    expect(await recorded(legacyFunding.automatic)).toBe(false);
    expect(await recorded(legacy.application)).toBe(false);
    expect(await recorded(legacyFunding.createdAfter0004)).toBe(false);
    expect(await recorded(legacyFunding.submittedAfter0004)).toBe(true);
    // The table itself refuses an automatic record with a recorded submission, whichever writer tries.
    await expect(db.pool.query(`UPDATE plugin_phd_application.applications SET submission='automatic' WHERE id=$1`, [legacyFunding.underReview])).rejects.toMatchObject({code: '23514'});
  });

  it('after the upgrade the real update entry refuses automatic for a record submitted and moved back, and allows it for one never submitted', async () => {
    // The upgraded instance's person, Project and package binding, reached through the same action route as every other test.
    await seedSpaceOwnerProject(db.pool, {space: legacy.space, owner: legacy.user, project: legacy.project, spaceType: 'team'});
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, legacy.space, legacy.user, {}));
    __setAuthIdentityForTests({spaceId: legacy.space, userId: legacy.user});
    await ok(action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: legacy.project}));
    const row = async (id: string) => (await db.pool.query(`SELECT submission,status,revision,submission_recorded_at IS NOT NULL AS recorded FROM plugin_phd_application.applications WHERE id=$1`, [id])).rows[0];
    const switchToAutomatic = async (id: string) => command('application.update', {application_id: id, revision: (await row(id)).revision, submission: 'automatic'}, legacy.project);
    for (const id of [legacyFunding.movedBack, legacyFunding.underReview, legacyFunding.submitted, legacyFunding.submittedAfter0004]) {
      const before = await row(id);
      const refused = await switchToAutomatic(id);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(reason(refused)).toBe('submission_recorded');
      expect(await row(id)).toEqual(before);
    }
    // Never submitted: the switch stays open.
    for (const id of [legacyFunding.ready, legacyFunding.planned, legacyFunding.progressedOnce, legacyFunding.createdAfter0004]) {
      await ok(switchToAutomatic(id));
      expect(await row(id)).toMatchObject({submission: 'automatic', recorded: false});
    }
  });

  it('one funding record applies to several program applications and both sides read the same record', async () => {
    const cs = await create(phd), stats = await create({...phd, program: 'PhD in Statistics'});
    const fund = await create({track: 'funding', institution: 'ETH Foundation', program: 'Excellence Scholarship', submission: 'separate', applies_to: [cs], deadlines: [{kind: 'funding', due_on: future(15)}]});
    // A separately submitted funding record reuses the application records: its own checklist, deadlines and progress.
    const detail = await get(fund);
    expect(detail.application).toMatchObject({track: 'funding', submission: 'separate', applies_to: [cs], funding_ids: []});
    expect(detail.materials.map((m: {kind: string}) => m.kind)).toEqual(['cv', 'statement', 'reference']);
    expect(ids(detail.applies_to)).toEqual([cs]);
    expect(ids((await get(cs)).funding)).toEqual([fund]);
    // The tabs read by track; an unfiltered list (an Agent's) has both.
    expect(ids((await ok(read('application.list', {track: 'phd'}))).items).sort()).toEqual([cs, stats].sort());
    expect(ids((await ok(read('application.list', {track: 'funding'}))).items)).toEqual([fund]);
    expect((await ok(read('application.list'))).items).toHaveLength(3);
    // Linking to a second program and unlinking from the first; neither record is otherwise changed.
    await ok(command('funding.link', {funding_id: fund, application_id: stats}));
    await ok(command('funding.link', {funding_id: fund, application_id: stats}));
    await ok(command('funding.unlink', {funding_id: fund, application_id: cs}));
    expect((await get(fund)).application.applies_to).toEqual([stats]);
    expect((await get(cs)).funding).toEqual([]);
    expect(reason(await command('funding.unlink', {funding_id: fund, application_id: cs}))).toBe('link_not_found');
    // A change made to the funding record shows in the program application's detail.
    await ok(command('application.update_status', {application_id: fund, status: 'preparing'}));
    const {material_id} = await ok(command('material.add', {application_id: fund, kind: 'research_proposal'}));
    await ok(command('material.update', {material_id, status: 'ready'}));
    const seen = (await get(stats)).funding[0];
    expect(seen).toMatchObject({id: fund, status: 'preparing', materials: {done: 1, total: 4}, next_deadline: {kind: 'funding', due_on: future(15)}});
    // The summary counts program applications and funding separately; funding deadlines are upcoming too.
    const summary = await ok(read('application.summary'));
    expect(summary).toMatchObject({total: 2, open: 2, funding: {total: 1, open: 1}});
    expect(summary.upcoming).toEqual([expect.objectContaining({application_id: fund, track: 'funding', program: 'Excellence Scholarship'})]);
    // A separate submission is a decision like any other: proposed, not recorded directly.
    expect((await command('application.propose_status', {application_id: fund, status: 'submitted'})).statusCode).toBe(202);
  });

  it('independent funding is recorded first and linked later; automatic consideration tracks only its result', async () => {
    const cs = await create(phd);
    const external = await create({track: 'funding', institution: 'National Council', program: 'Doctoral Fellowship', submission: 'separate'});
    expect((await get(external)).application.applies_to).toEqual([]);
    await ok(command('funding.link', {funding_id: external, application_id: cs}));
    const auto = await create({track: 'funding', institution: 'ETH Zurich', program: 'Department stipend', submission: 'automatic', applies_to: [cs]});
    expect((await get(auto)).materials).toEqual([]);
    expect(reason(await command('material.add', {application_id: auto, kind: 'cv'}))).toBe('no_submission');
    // Nothing is submitted: the decision is refused before any Proposal exists; a result is tracked.
    const before = (await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE space_id=$1`, [space])).rows[0].n;
    const submitted = await command('application.propose_status', {application_id: auto, status: 'submitted'});
    expect(submitted.statusCode, submitted.body).toBe(409);
    expect(reason(submitted)).toBe('no_submission');
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM proposals WHERE space_id=$1`, [space])).rows[0].n).toBe(before);
    await ok(command('application.update_status', {application_id: auto, status: 'offer', result_note: 'Full stipend'}));
    expect((await command('application.propose_status', {application_id: auto, status: 'accepted'})).statusCode).toBe(202);
    expect((await get(cs)).funding.map((f: {id: string; submission: string; status: string}) => [f.id, f.submission, f.status]).sort()).toEqual([[auto, 'automatic', 'offer'], [external, 'separate', 'planning']].sort());
    // The mode changes only on a funding record, and to automatic only without a checklist.
    const revision = (id: string) => get(id).then(d => d.application.revision);
    expect(reason(await command('application.update', {application_id: external, revision: await revision(external), submission: 'automatic'}))).toBe('checklist_not_empty');
    await ok(command('application.update', {application_id: auto, revision: await revision(auto), submission: 'separate'}));
    expect(reason(await command('application.update', {application_id: cs, revision: await revision(cs), submission: 'separate'}))).toBe('funding_only');
  });

  it('a new funding record with applies_to and funding.link share both ends\' capacity and its lock', async () => {
    const cs = await create(phd);
    // `cs` already has FUNDING_LINKS_MAX - 1 funding records, written directly to keep the test fast.
    const seeded = Array.from({length: 49}, () => randomUUID());
    await db.pool.query(`INSERT INTO plugin_phd_application.applications(space_id,user_id,project_id,id,track,institution,program,submission,status)
      SELECT $1,$2,$3,unnest($4::text[]),'funding','Funder','Grant','separate','planning'`, [space, owner, projectA, seeded]);
    await db.pool.query(`INSERT INTO plugin_phd_application.application_funding_links(space_id,user_id,project_id,funding_id,application_id)
      SELECT $1,$2,$3,unnest($4::text[]),$5`, [space, owner, projectA, seeded, cs]);
    const linked = async () => (await db.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM plugin_phd_application.application_funding_links WHERE space_id=$1 AND application_id=$2`, [space, cs])).rows[0]!.n;
    const fundingCount = async () => (await db.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM plugin_phd_application.applications WHERE space_id=$1 AND track='funding'`, [space])).rows[0]!.n;
    const existing = await create({track: 'funding', institution: 'Funder', program: 'Open call', submission: 'separate'});
    // The 50th link is taken by whichever of a new linked record and funding.link commits first; the other is refused.
    const results = await Promise.all([
      command('application.create', {track: 'funding', institution: 'Funder', program: 'Racing', submission: 'automatic', applies_to: [cs]}),
      command('funding.link', {funding_id: existing, application_id: cs}),
    ]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(reason(results.find(r => r.statusCode === 409)!)).toBe('link_limit');
    expect(await linked()).toBe(50);
    // Full: a new linked record is refused through the real entry and nothing of it is kept.
    const before = await fundingCount();
    const refused = await command('application.create', {track: 'funding', institution: 'Funder', program: 'Late', submission: 'separate', applies_to: [cs], deadlines: [{kind: 'funding', due_on: future(9)}]});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(reason(refused)).toBe('link_limit');
    expect(await fundingCount()).toBe(before);
    expect(await linked()).toBe(50);
    // Unlinking frees the place for either entry again.
    await ok(command('funding.unlink', {funding_id: seeded[0], application_id: cs}));
    await create({track: 'funding', institution: 'Funder', program: 'Next', submission: 'separate', applies_to: [cs]});
    expect(await linked()).toBe(50);
  });

  it('an approved separate submission keeps funding out of automatic consideration, with its approval and history', async () => {
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Grant', submission: 'separate', checklist: 'empty'});
    const proposed = await command('application.propose_status', {application_id: fund, status: 'submitted', result_note: 'Portal 42'});
    expect(proposed.statusCode, proposed.body).toBe(202);
    const proposalId = proposed.json().proposal_id as string;
    await ok(action('proposal.accept', {proposal_id: proposalId}));
    const accepted = (await db.pool.query<{status: string}>('SELECT status FROM proposals WHERE id=$1', [proposalId])).rows[0]!.status;
    const {revision} = (await get(fund)).application;
    // Switching to automatic would leave an automatic record marked submitted: refused, nothing changes.
    const refused = await command('application.update', {application_id: fund, revision, submission: 'automatic'});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(reason(refused)).toBe('submission_recorded');
    expect((await get(fund)).application).toMatchObject({submission: 'separate', status: 'submitted', result_note: 'Portal 42', revision});
    expect((await db.pool.query<{status: string}>('SELECT status FROM proposals WHERE id=$1', [proposalId])).rows[0]!.status).toBe(accepted);
    // Other edits and later decisions go on as usual; before a submission is recorded the switch is allowed.
    await ok(command('application.update', {application_id: fund, revision, notes: 'Confirmation by email'}));
    expect((await command('application.propose_status', {application_id: fund, status: 'accepted'})).statusCode).toBe(202);
    const planned = await create({track: 'funding', institution: 'Funder', program: 'Other', submission: 'separate', checklist: 'empty'});
    await ok(command('application.update', {application_id: planned, revision: 1, submission: 'automatic'}));
  });

  it('the approved submission outlives later progress: under review, a result or another decision never reopen automatic', async () => {
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Grant', submission: 'separate', checklist: 'empty'});
    const submitted = await command('application.propose_status', {application_id: fund, status: 'submitted'});
    expect(submitted.statusCode, submitted.body).toBe(202);
    await ok(action('proposal.accept', {proposal_id: submitted.json().proposal_id}));
    const switchToAutomatic = async () => command('application.update', {application_id: fund, revision: (await get(fund)).application.revision, submission: 'automatic'});
    // Ordinary progress replaces the status; the recorded submission stays.
    for (const status of ['under_review', 'interview', 'waitlisted', 'rejected', 'preparing']) {
      await ok(command('application.update_status', {application_id: fund, status}));
      const refused = await switchToAutomatic();
      expect(refused.statusCode, `${status}: ${refused.body}`).toBe(409);
      expect(reason(refused)).toBe('submission_recorded');
      expect((await get(fund)).application).toMatchObject({submission: 'separate', status});
    }
    // A later approved decision does not clear it either.
    const withdrawn = await command('application.propose_status', {application_id: fund, status: 'withdrawn'});
    await ok(action('proposal.accept', {proposal_id: withdrawn.json().proposal_id}));
    expect(reason(await switchToAutomatic())).toBe('submission_recorded');
    // An Agent's call is checked the same way.
    const run = await agentRun(owner, ['application.update']);
    const byAgent = await agentCall(run, 'application.update', {project_id: projectA, application_id: fund, revision: (await get(fund)).application.revision, submission: 'automatic'});
    expect(byAgent.httpStatus).toBe(409);
    expect((await get(fund)).application.submission).toBe('separate');
  });

  it('progress without an approved submission keeps the switch open', async () => {
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Fellowship', submission: 'separate', checklist: 'empty'});
    await ok(command('application.update_status', {application_id: fund, status: 'under_review'}));
    await ok(command('application.update', {application_id: fund, revision: (await get(fund)).application.revision, submission: 'automatic'}));
    expect((await get(fund)).application).toMatchObject({submission: 'automatic', status: 'under_review'});
  });

  it.each(['approve', 'switch'] as const)('settles the submission race when %s reaches the record first', async first => {
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Stipend', submission: 'separate', checklist: 'empty'});
    const requestKey = randomUUID();
    const submission = {project_id: projectA, application_id: fund, status: 'submitted', result_note: 'Portal 42'};
    const propose = () => action(opId('application.propose_status'), submission, requestKey);
    const pending = await propose();
    expect(pending.statusCode, pending.body).toBe(202);
    const proposalId = pending.json().proposal_id as string;
    const acceptKey = randomUUID();
    const accept = () => action('proposal.accept', {proposal_id: proposalId}, acceptKey);
    const switchMode = (revision: number) => command('application.update', {application_id: fund, revision, submission: 'automatic'});
    const run = {approve: accept, switch: () => switchMode(1)};
    const second = first === 'approve' ? 'switch' : 'approve';

    // Hold the exact funding row while the first request acquires the Project lock.
    // The second request must queue behind the first before the funding row is released.
    const holder = await db.pool.connect();
    const requests = [];
    try {
      await holder.query('BEGIN');
      const {pid} = (await holder.query<{pid: number}>(`SELECT pg_backend_pid() AS pid FROM plugin_phd_application.applications WHERE id=$1 FOR UPDATE`, [fund])).rows[0]!;
      requests.push(run[first]());
      await waitForBlockedBy(db.pool, pid);
      const front = (await db.pool.query<{pid: number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))`, [pid])).rows[0]!;
      requests.push(run[second]());
      await waitForBlockedBy(db.pool, front.pid);
    } finally {
      await holder.query('ROLLBACK').finally(() => holder.release());
      await Promise.allSettled(requests);
    }

    const [firstResponse, secondResponse] = await Promise.all(requests);
    const [approval, switched] = first === 'approve' ? [firstResponse!, secondResponse!] : [secondResponse!, firstResponse!];
    expect(approval.statusCode, approval.body).toBe(200);
    const receipt = approval.json().data;
    const state = (await db.pool.query(`SELECT p.status AS proposal, r.state AS request, r.terminal_at IS NOT NULL AS terminal,
      a.submission, a.status, a.revision, a.result_note, a.submission_recorded_at IS NOT NULL AS recorded
      FROM proposals p JOIN operation_idempotency r ON r.proposal_id=p.id
      CROSS JOIN plugin_phd_application.applications a WHERE a.id=$1 AND p.id=$2`, [fund, proposalId])).rows[0];
    if (first === 'approve') {
      expect(receipt).toMatchObject({proposal: {id: proposalId, status: 'accepted'}, result_type: 'plugin_proposal',
        result: {application_id: fund, status: 'submitted', revision: 2}});
      expect(switched.statusCode, switched.body).toBe(409);
      expect(reason(switched)).toBe('revision_conflict');
      const retry = await switchMode(2);
      expect(retry.statusCode, retry.body).toBe(409);
      expect(reason(retry)).toBe('submission_recorded');
      expect(state).toEqual({proposal: 'accepted', request: 'succeeded', terminal: true,
        submission: 'separate', status: 'submitted', revision: 2, result_note: 'Portal 42', recorded: true});
    } else {
      expect(receipt).toMatchObject({proposal: {id: proposalId, status: 'superseded'}, result_type: 'operation_failure',
        result: {error: {code: 'operation_approval_superseded', retryable: false}}});
      expect(switched.statusCode, switched.body).toBe(200);
      expect(switched.json().data).toEqual({application_id: fund, revision: 2});
      expect(state).toEqual({proposal: 'superseded', request: 'superseded', terminal: true,
        submission: 'automatic', status: 'planning', revision: 2, result_note: null, recorded: false});
      const replay = await propose();
      expect(replay.statusCode, replay.body).toBe(409);
      expect(replay.json().error.code).toBe('operation_approval_superseded');
      expect(reason(await command('application.propose_status', {application_id: fund, status: 'submitted'}))).toBe('no_submission');
    }
    expect(await ok(accept())).toEqual(receipt);
    expect((await action('proposal.accept', {proposal_id: proposalId})).statusCode).toBe(404);
    expect((await get(fund)).application).toMatchObject({
      submission: state.submission, status: state.status, revision: 2, result_note: state.result_note,
    });
  });

  it('funding links stay within the Project and tracks, and never newly reach archived work', async () => {
    const cs = await create(phd), other = await create(phd, projectB);
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Grant', submission: 'separate'});
    for (const [input, expected] of [
      [{track: 'funding', institution: 'F', program: 'G'}, 'submission_required'],
      [{...phd, submission: 'separate'}, 'funding_only'],
      [{...phd, applies_to: [cs]}, 'funding_only'],
      [{track: 'funding', institution: 'F', program: 'G', submission: 'separate', applies_to: [fund]}, 'not_program_application'],
      [{track: 'funding', institution: 'F', program: 'G', submission: 'separate', applies_to: [other]}, 'application_not_found'],
    ] as const) expect(reason(await command('application.create', input)), JSON.stringify(input)).toBe(expected);
    expect(reason(await command('funding.link', {funding_id: cs, application_id: cs}))).toBe('not_funding');
    expect(reason(await command('funding.link', {funding_id: fund, application_id: fund}))).toBe('not_program_application');
    expect(reason(await command('funding.link', {funding_id: fund, application_id: other}))).toBe('application_not_found');
    as(writer);
    await ok(command('funding.link', {funding_id: fund, application_id: cs}));
    as(owner);
    // Archived: no new link to it; a funding record can still be moved off an archived application.
    await ok(command('funding.link', {funding_id: fund, application_id: cs}));
    const revision = (await get(cs)).application.revision;
    await ok(command('application.update', {application_id: cs, revision, archived: true}));
    const second = await create({...phd, program: 'PhD in Robotics'});
    await ok(command('funding.unlink', {funding_id: fund, application_id: cs}));
    expect(reason(await command('funding.link', {funding_id: fund, application_id: cs}))).toBe('application_archived');
    expect(reason(await command('application.create', {track: 'funding', institution: 'F', program: 'G', submission: 'automatic', applies_to: [cs]}))).toBe('application_archived');
    await ok(command('funding.link', {funding_id: fund, application_id: second}));
    // An Agent of the person reaches the same operations in its Run's Project.
    const run = await agentRun(owner, ['funding.unlink', 'application.get']);
    expect((await agentCall(run, 'funding.unlink', {project_id: projectA, funding_id: fund, application_id: second})).httpStatus).toBe(200);
    expect((await get(fund)).applies_to).toEqual([]);
  });

  it('the material library lists existing Notes with every material that uses them and which versions are behind', async () => {
    const cs = await create(phd);
    const fund = await create({track: 'funding', institution: 'Funder', program: 'Grant', submission: 'separate', applies_to: [cs]});
    const cv = await note('Master CV', '# CV\n\nTeaching assistant 2024.');
    const {item_id} = await ok(command('library.add', {note_id: cv, kind: 'cv', label: 'Master CV'}));
    expect(reason(await command('library.add', {note_id: cv, kind: 'cv'}))).toBe('library_note_exists');
    // Notes' own rules decide what can be registered: another Project's Note and another person's private Note are refused.
    expect(reason(await command('library.add', {note_id: await note('B', 'x', {project: projectB}), kind: 'other'}))).toBe('note_unavailable');
    expect(reason(await command('library.add', {note_id: await note('Theirs', 'x', {owner: writer}), kind: 'other'}))).toBe('note_unavailable');
    // Tailored materials stay in their application (a funding record's included) and pin the version they draw on.
    const statement = (id: string) => get(id).then(d => d.materials.find((m: {kind: string}) => m.kind === 'statement').id as string);
    const csStatement = await statement(cs), fundStatement = await statement(fund);
    for (const material_id of [csStatement, fundStatement]) await ok(command('material.add_source', {material_id, note_id: cv}));
    const cvMaterial = (await get(cs)).materials.find((m: {kind: string}) => m.kind === 'cv').id as string;
    await ok(command('material.link_note', {material_id: cvMaterial, note_id: cv}));
    await edit(cv, '# CV\n\nTeaching assistant 2024. Best paper 2026.');
    let [item] = (await ok(read('library.list'))).items;
    expect(item).toMatchObject({id: item_id, kind: 'cv', label: 'Master CV', note: {note_id: cv, title: 'Master CV', current_version: 2, available: true}});
    const use = (material_id: string, relation: string) => item.uses.find((u: {material_id: string; relation: string}) => u.material_id === material_id && u.relation === relation);
    expect(use(csStatement, 'source')).toMatchObject({application_id: cs, track: 'phd', note_version: 1, updated: true});
    expect(use(fundStatement, 'source')).toMatchObject({application_id: fund, track: 'funding', program: 'Grant', note_version: 1, updated: true});
    expect(use(cvMaterial, 'linked')).toMatchObject({note_version: null, updated: true});
    // Re-pinning and reviewing clear the prompts; the Notes themselves are unchanged.
    await ok(command('material.add_source', {material_id: csStatement, note_id: cv, note_version: 2}));
    await ok(command('material.mark_reviewed', {material_id: cvMaterial, note_id: cv, note_version: 2}));
    [item] = (await ok(read('library.list'))).items;
    expect(use(csStatement, 'source')).toMatchObject({note_version: 2, updated: false});
    expect(use(fundStatement, 'source')).toMatchObject({note_version: 1, updated: true});
    expect(use(cvMaterial, 'linked')).toMatchObject({note_version: 2, updated: false});
    // The library is the person's own; removing an entry leaves the Note and every pinned source.
    as(writer);
    expect((await ok(read('library.list'))).items).toEqual([]);
    expect(reason(await command('library.remove', {item_id}))).toBe('library_item_not_found');
    as(owner);
    await ok(command('library.update', {item_id, kind: 'experience', label: null}));
    await ok(command('library.remove', {item_id}));
    expect((await ok(read('library.list'))).items).toEqual([]);
    expect((await get(fund)).materials.find((m: {id: string}) => m.id === fundStatement).sources).toEqual([expect.objectContaining({note_id: cv, note_version: 1})]);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM note_revisions WHERE note_id=$1`, [cv])).rows[0].n).toBe(2);
  });

  it('Project writers maintain shared library entries through the current Note permissions', async () => {
    const shared = await note('Project reference', 'Shared material', {project: projectA, visibility: 'space_shared'});
    const {item_id} = await ok(command('library.add', {note_id: shared, kind: 'other'}));
    as(writer);
    expect((await ok(read('library.list'))).items).toMatchObject([{id: item_id, note: {note_id: shared, available: true}}]);
    await ok(command('library.update', {item_id, label: 'Team reference'}));
    await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`, [shared]);
    expect((await ok(read('library.list'))).items).toEqual([]);
    expect(reason(await command('library.remove', {item_id}))).toBe('library_item_not_found');
    await db.pool.query(`UPDATE space_objects SET visibility='space_shared' WHERE id=$1`, [shared]);
    await ok(command('library.remove', {item_id}));
    expect((await db.pool.query('SELECT id FROM space_objects WHERE id=$1', [shared])).rowCount).toBe(1);
  });

  it('a supervisor is linked to several applications; the contact stays writable while any linked application is active', async () => {
    const cs = await create(phd), stats = await create({...phd, program: 'PhD in Statistics'}), other = await create(phd, projectB);
    const fund = await create({track: 'funding', institution: 'ETH Foundation', program: 'Scholarship', submission: 'separate'});
    const {contact_id} = await ok(command('contact.create', {application_ids: [cs, stats, fund], name: 'Prof. Ada', role: 'supervisor'}));
    for (const id of [cs, stats, fund]) expect(ids((await ok(read('contact.list', {application_id: id}))).items)).toEqual([contact_id]);
    expect((await ok(read('contact.list'))).items[0].application_ids.sort()).toEqual([cs, stats, fund].sort());
    expect(reason(await command('contact.create', {application_ids: [other], name: 'X', role: 'other'}))).toBe('application_not_found');
    expect(reason(await command('contact.update', {contact_id, application_ids: [cs, other]}))).toBe('application_not_found');
    await ok(command('contact.update', {contact_id, application_ids: [cs, stats]}));
    expect((await ok(read('contact.list', {application_id: fund}))).items).toEqual([]);
    // Archive one: still writable through the other; archive both: read-only until relinked.
    const archive = async (id: string) => ok(command('application.update', {application_id: id, revision: (await get(id)).application.revision, archived: true}));
    await archive(cs);
    await ok(command('contact.log_event', {contact_id, occurred_on: future(-1), channel: 'email', direction: 'outbound', summary: 'Asked about projects', response: 'awaiting'}));
    await archive(stats);
    expect(reason(await command('contact.log_event', {contact_id, occurred_on: future(0), channel: 'email', direction: 'inbound', summary: 'Reply', response: 'positive'}))).toBe('application_archived');
    expect(reason(await command('contact.update', {contact_id, note: 'x'}))).toBe('application_archived');
    await ok(command('contact.update', {contact_id, application_ids: [cs, stats, fund], note: 'Now about the scholarship'}));
    await ok(command('contact.log_event', {contact_id, occurred_on: future(0), channel: 'email', direction: 'inbound', summary: 'Reply', response: 'positive'}));
    expect((await ok(read('contact.list'))).items[0]).toMatchObject({events: 2, note: 'Now about the scholarship', last_event: {response: 'positive'}});
    // Removing an application's link never removes the contact or its history.
    await ok(command('contact.update', {contact_id, application_ids: []}));
    expect((await ok(read('contact.list'))).items[0]).toMatchObject({id: contact_id, application_ids: [], events: 2});
  });
});
