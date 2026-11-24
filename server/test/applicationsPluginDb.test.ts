import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {getOfficialPlugin} from '../src/modules/plugins/registry.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {PgRunToolIdentityRepository} from '../src/modules/runs/runToolIdentityRepository.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {pruneOperationRequests} from '../src/modules/systemActions/operations/retention.js';
import {PgTaskRepository} from '../src/modules/tasks/repository.js';
import {lockSourceRetrievalReleaseBatch, sourceRetrievalReleaseProjects} from '../src/modules/sources/retrievalReleaseLocks.js';
import {loadProjectChatActionPreviews} from '../src/modules/agents/projectChatActionPreviews.js';
import {pluginToolPins} from '../src/modules/plugins/dataAccess.js';

/**
 * The bundled application management package (`plugins/official/applications`,
 * PhD first track) as shipped: the compiled artifact admitted by the package
 * loader, installed by the offline installer, reached through the real P1 HTTP
 * and Agent tool entries on real PostgreSQL.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'applications';
const opId = (name: string) => name.startsWith('task.') || name.startsWith('knowledge.') ? name : `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let host: PluginHost, space: string, owner: string, writer: string, viewer: string, projectA: string, projectB: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});
async function addPerson(user: string, projectRole: 'member' | 'viewer' | null) {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [user]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, user]);
  if (projectRole) await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, projectA, user, projectRole]);
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
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  as(owner);
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
const bind = (project: string) => ok(action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: project}));
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const rows = async (table: string) => (await db.pool.query(`SELECT * FROM plugin_applications.${table} WHERE space_id=$1 ORDER BY created_at,id`, [space])).rows;
async function agentRun(user: string, project: string | null, tools: string[], session: string | null = null) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
  const grants = tools.map(t => ({action_id: opId(t), approval_behavior: 'none' as const, side_effecting: true}));
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,permission_snapshot_json=$4::jsonb,session_id=$5 WHERE id=$1`,
    [runId, user, project, JSON.stringify({tool_grants: grants, plugin_tool_pins: pluginToolPins(config, grants)}), session]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  return runId;
}
const agentCall = async (runId: string, name: string, args: Record<string, unknown>) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: randomUUID(), name: opId(name), arguments: args})) as OperationToolResponse;
};
/** A Room conversation in Project A that every listed person reads. */
async function sharedRoom(users: string[]) {
  const room = randomUUID(), session = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Pair','active',now(),now(),false)`, [room, space, projectA, users[0]]);
  for (const user of users) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, projectA]);
  return session;
}
const reason = (r: {json(): any}) => r.json().error?.metadata?.reason;
const proposalStatus = async (id: string) => (await db.pool.query<{status: string}>('SELECT status FROM proposals WHERE id=$1', [id])).rows[0]?.status;
const phd = {institution: 'ETH Zurich', program: 'PhD in Computer Science', department: 'Systems Group', intake: 'Fall 2027', source: {label: 'Department call', url: 'https://example.edu/phd'}};

describe('Application management package (PhD track)', () => {
  it('ships as a disabled-by-default Project-level package; contacts are personal, applications normal', async () => {
    const descriptor = getOfficialPlugin(pid, config)!;
    expect(descriptor).toMatchObject({project_binding: 'required', default_enabled: false, scope: 'space'});
    const classes = Object.fromEntries(plugin.operationManifest!.operations.map(o => [o.id.split('.').slice(2).join('.'), `${o.data_class}/${o.side_effects}`]));
    expect(classes).toMatchObject({'application.create': 'non_sensitive/durable', 'application.propose_status': 'non_sensitive/proposal', 'contact.list': 'personal/none', 'contact.log_event': 'personal/durable'});
    expect(plugin.operationManifest!.core_ports).toEqual(['tasks.create', 'references.resolve', 'notes.read', 'notes.draft']);
    // Every entry is closed until an owner-level person binds the Project.
    expect((await command('application.create', phd)).statusCode).toBe(404);
  });

  it('a person runs an application end to end: deadlines as Board Tasks, checklist, references, progress and an approved decision', async () => {
    await bind(projectA);
    const created = await ok(command('application.create', {...phd, deadlines: [{kind: 'funding', due_on: future(40)}, {kind: 'application', due_on: future(20)}], create_tasks: true}));
    expect(created.task_ids).toHaveLength(2);
    const tasks = (await db.pool.query(`SELECT id,title,project_id,due_at FROM tasks WHERE id=ANY($1::varchar[]) ORDER BY due_at`, [created.task_ids])).rows;
    expect(tasks.map(t => t.project_id)).toEqual([projectA, projectA]);
    expect(tasks[0].title).toBe('Application deadline — ETH Zurich, PhD in Computer Science');
    // The PhD track's checklist.
    const listed = await ok(read('application.list'));
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({status: 'planning', track: 'phd', deadlines: 2, materials: {done: 0, total: 7}, next_deadline: {kind: 'application', due_on: future(20)}, source: phd.source});
    let detail = await ok(read('application.get', {application_id: created.application_id}));
    expect(detail.materials.map((m: {kind: string}) => m.kind)).toEqual(['cv', 'statement', 'research_proposal', 'transcript', 'reference', 'writing_sample', 'language_test']);
    // Edits need the current revision; a stale one is a translated conflict, not an overwrite.
    const updated = await ok(command('application.update', {application_id: created.application_id, revision: 1, notes: 'Ask about funding'}));
    const stale = await command('application.update', {application_id: created.application_id, revision: 1, notes: 'Overwrite'});
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({code: 'operation_conflict', metadata: {reason: 'revision_conflict'}});
    // A material references a core object; its title comes through the core read gate.
    const cv = detail.materials[0];
    await ok(command('material.update', {material_id: cv.id, status: 'ready', reference: {type: 'task', id: tasks[0].id}}));
    detail = await ok(read('application.get', {application_id: created.application_id}));
    expect(detail.application).toMatchObject({notes: 'Ask about funding', revision: updated.revision + 1});
    expect(detail.materials[0]).toMatchObject({status: 'ready', reference: {type: 'task', id: tasks[0].id, title: tasks[0].title, available: true}});
    // Removing a deadline keeps its Board Task.
    await ok(command('deadline.remove', {deadline_id: detail.deadlines[1].id}));
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks WHERE id=$1', [tasks[1].id])).rows[0].n).toBe(1);
    // Reversible progress is direct; a consequential decision waits for approval.
    await ok(command('application.update_status', {application_id: created.application_id, status: 'ready'}));
    expect((await command('application.update_status', {application_id: created.application_id, status: 'submitted'})).statusCode).toBe(422);
    const proposed = await command('application.propose_status', {application_id: created.application_id, status: 'submitted', result_note: 'Portal confirmation 123'});
    expect(proposed.statusCode, proposed.body).toBe(202);
    const proposalId = proposed.json().proposal_id as string;
    expect((await ok(read('application.list'))).items[0].status).toBe('ready');
    await ok(action('proposal.accept', {proposal_id: proposalId}));
    expect((await ok(read('application.list'))).items[0]).toMatchObject({status: 'submitted', result_note: 'Portal confirmation 123'});
    const summary = await ok(read('application.summary'));
    expect(summary).toMatchObject({total: 1, open: 1, by_status: {submitted: 1}, materials: {done: 1, total: 7}});
    expect(summary.upcoming).toEqual([{application_id: created.application_id, track: 'phd', institution: 'ETH Zurich', program: 'PhD in Computer Science', kind: 'application', label: null, due_on: future(20)}]);
    // A recorded final decision is not overwritten by a direct progress edit.
    const accept = await command('application.propose_status', {application_id: created.application_id, status: 'accepted'});
    await ok(action('proposal.accept', {proposal_id: accept.json().proposal_id}));
    const reverted = await command('application.update_status', {application_id: created.application_id, status: 'preparing'});
    expect(reverted.json().error).toMatchObject({code: 'operation_conflict', metadata: {reason: 'status_decided'}});
  });

  it('refuses script links, other Projects and archived records', async () => {
    await bind(projectA);
    expect((await command('application.create', {...phd, source: {url: 'javascript:alert(1)'}})).statusCode).toBe(422);
    expect((await command('application.create', phd, projectB)).statusCode).toBe(404);
    const {application_id} = await ok(command('application.create', {...phd, checklist: 'empty'}));
    expect((await ok(read('application.get', {application_id}))).materials).toEqual([]);
    const {material_id} = await ok(command('material.add', {application_id, kind: 'cv'}));
    await ok(command('application.update', {application_id, revision: 2, archived: true}));
    expect((await ok(read('application.list'))).items).toEqual([]);
    expect((await ok(read('application.list', {include_archived: true}))).items[0]).toMatchObject({archived: true});
    for (const refused of [await command('material.add', {application_id, kind: 'cv'}), await command('material.update', {material_id, status: 'ready'}), await command('material.remove', {material_id})]) {
      expect(refused.json().error).toMatchObject({code: 'operation_conflict', metadata: {reason: 'application_archived'}});
    }
    // Its details are read-only too, also when combined with a restore; restoring alone is allowed.
    for (const edit of [{notes: 'Edited while archived'}, {institution: 'Elsewhere'}, {source: null}, {archived: false, program: 'Changed'}]) {
      const refused = await command('application.update', {application_id, revision: 3, ...edit});
      expect(refused.json().error, JSON.stringify(edit)).toMatchObject({code: 'operation_conflict', metadata: {reason: 'application_archived'}});
    }
    expect((await rows('applications'))[0]).toMatchObject({institution: phd.institution, program: phd.program, notes: null, source_url: phd.source.url, revision: 3});
    expect((await rows('applications'))[0].archived_at).not.toBeNull();
    await ok(command('application.update', {application_id, revision: 3, archived: false}));
    await ok(command('application.update', {application_id, revision: 4, notes: 'Edited after restoring'}));
    await ok(command('material.add', {application_id, kind: 'portfolio', label: 'Code samples', required: false}));
  });

  it('Project writers can maintain another member’s shared application and its child records', async () => {
    await bind(projectA);
    const mine = await ok(command('application.create', phd));
    const privateRecord = await ok(command('application.create', {...phd, program: 'Private legacy record'}));
    await db.pool.query('UPDATE plugin_applications.applications SET project_shared=false WHERE id=$1', [privateRecord.application_id]);
    const contact = await ok(command('contact.create', {name: 'Project supervisor', role: 'supervisor', application_ids: [mine.application_id]}));
    as(writer);
    const theirs = await ok(command('application.create', {...phd, institution: 'EPFL'}));
    expect((await ok(read('application.list'))).items).toEqual(expect.arrayContaining([
      expect.objectContaining({id: mine.application_id, owned_by_caller: false}),
      expect.objectContaining({id: theirs.application_id, owned_by_caller: true}),
    ]));
    const application_id = mine.application_id as string;
    await ok(command('application.update', {application_id, revision: mine.revision, notes: 'Team notes'}));
    await ok(command('application.update_status', {application_id, status: 'preparing'}));
    await ok(command('application.record_submission', {application_id, evidence: 'Verified submission'}));
    const funding = await ok(command('application.create', {track: 'funding', institution: 'Funder', program: 'Scholarship', submission: 'separate', applies_to: [application_id]}));
    const link = {funding_id: funding.application_id, application_id};
    await ok(command('funding.unlink', link));
    await ok(command('funding.link', link));
    const {deadline_id} = await ok(command('deadline.add', {application_id, kind: 'interview', due_on: future(6)}));
    await ok(command('deadline.update', {deadline_id, due_on: future(8)}));
    const {material_id} = await ok(command('material.add', {application_id, kind: 'cv'}));
    await ok(command('material.update', {material_id, status: 'ready'}));
    await ok(command('contact.update', {contact_id: contact.contact_id, application_ids: [application_id, theirs.application_id], affiliation: 'Shared lab'}));
    await ok(command('contact.log_event', {contact_id: contact.contact_id, occurred_on: future(0), channel: 'meeting', direction: 'outbound', response: 'positive', summary: 'Team met the supervisor'}));
    expect((await ok(read('application.get', {application_id}))).funding).toEqual([expect.objectContaining({id: funding.application_id})]);
    expect((await ok(read('contact.list', {application_id: theirs.application_id}))).items).toMatchObject([{id: contact.contact_id, affiliation: 'Shared lab'}]);
    await ok(command('deadline.remove', {deadline_id}));
    await ok(command('material.remove', {material_id}));
    const foreign = await command('application.update_status', {application_id: privateRecord.application_id, status: 'preparing'});
    expect(foreign.json().error).toMatchObject({metadata: {reason: 'application_not_found'}});
    as(viewer);
    expect((await ok(read('application.list'))).items).toHaveLength(3);
    expect((await ok(read('application.get', {application_id: mine.application_id}))).application).toMatchObject({id: mine.application_id, owned_by_caller: false});
    expect((await command('application.create', phd)).statusCode).toBe(404);
    expect((await command('deadline.add', {application_id, kind: 'interview', due_on: future(9)})).statusCode).toBe(404);
    expect((await command('contact.update', {contact_id: contact.contact_id, name: 'Denied'})).statusCode).toBe(404);
    expect((await read('application.list', {}, projectB)).statusCode).toBe(404);
    expect((await db.pool.query(`SELECT owner_user_id,viewer_user_id FROM content_access_logs WHERE space_id=$1 AND resource_type='plugin_applications' AND resource_id=$2`,
      [space, mine.application_id])).rows).toEqual(expect.arrayContaining([
        {owner_user_id: owner, viewer_user_id: writer}, {owner_user_id: owner, viewer_user_id: viewer},
      ]));
  });

  it('contacts and events use Project authority while historical private contacts stay private', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const {contact_id} = await ok(command('contact.create', {application_ids: [application_id], name: 'Prof. Ada Example', role: 'supervisor', email: 'ada@example.edu', affiliation: 'Systems Group'}));
    await ok(command('contact.log_event', {contact_id, occurred_on: future(-3), channel: 'email', direction: 'outbound', summary: 'Sent CV and research interests', response: 'awaiting', next_step: 'Follow up in two weeks'}));
    await ok(command('contact.log_event', {contact_id, occurred_on: future(-1), channel: 'email', direction: 'inbound', summary: 'Invited to a call', response: 'positive'}));
    const contacts = await ok(read('contact.list', {application_id}));
    expect(contacts.items).toEqual([expect.objectContaining({id: contact_id, name: 'Prof. Ada Example', events: 2, last_event: {occurred_on: future(-1), channel: 'email', direction: 'inbound', response: 'positive', next_step: null}})]);
    expect((await ok(read('contact.list_events', {contact_id}))).items.map((e: {summary: string}) => e.summary)).toEqual(['Invited to a call', 'Sent CV and research interests']);
    expect((await command('contact.create', {name: 'Bad', role: 'referee', email: 'not-an-email'})).statusCode).toBe(422);
    const legacy = await ok(command('contact.create', {name: 'Legacy private referee', role: 'referee'}));
    await db.pool.query('UPDATE plugin_applications.application_contacts SET project_shared=false WHERE id=$1', [legacy.contact_id]);
    const run = await agentRun(owner, projectA, ['contact.list', 'contact.log_event', 'application.list']);
    const listed = await agentCall(run, 'contact.list', {project_id: projectA});
    expect(listed.httpStatus, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toMatchObject({items: [{id: contact_id}]});
    expect(JSON.stringify(listed.body)).not.toContain('Legacy private referee');
    const logged = await agentCall(run, 'contact.log_event', {project_id: projectA, contact_id, occurred_on: future(0), channel: 'email', direction: 'outbound', summary: 'Followed up', response: 'awaiting'});
    expect(logged.httpStatus, JSON.stringify(logged.body)).toBe(200);
    expect(logged.body.data).toEqual({event_id: expect.any(String)});
    expect(await rows('application_contact_events')).toHaveLength(3);
    expect((await agentCall(run, 'application.list', {project_id: projectA})).httpStatus).toBe(200);

    const input = {project_id: projectA, name: 'Another Supervisor', role: 'supervisor'};
    const writerRun = await agentRun(writer, projectA, ['application.create', 'contact.create']);
    expect((await agentCall(writerRun, 'application.create', {project_id: projectA, ...phd})).httpStatus).toBe(200);
    expect((await agentCall(writerRun, 'contact.create', input)).httpStatus).toBe(200);
    const viewerRun = await agentRun(viewer, projectA, ['application.create', 'contact.create']);
    expect((await agentCall(viewerRun, 'application.create', {project_id: projectA, ...phd})).httpStatus).toBe(404);
    expect((await agentCall(viewerRun, 'contact.create', input)).httpStatus).toBe(404);
    expect(await rows('application_contacts')).toEqual([
      expect.objectContaining({user_id: owner, project_id: projectA, id: contact_id}),
      expect.objectContaining({user_id: owner, project_id: projectA, id: legacy.contact_id}),
      expect.objectContaining({user_id: writer, project_id: projectA, name: input.name}),
    ]);
  });

  it('a shared Agent Run reads shared applications and a person can share selected legacy rows', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', {...phd, notes: 'Legacy funding plan', deadlines: [{kind: 'application', due_on: future(9)}]}));
    const other = await ok(command('application.create', {...phd, institution: 'Another legacy application'}));
    await db.pool.query(`UPDATE plugin_applications.applications SET project_shared=false WHERE space_id=$1 AND id=ANY($2::text[])`,
      [space, [application_id, other.application_id]]);
    as(writer);
    const theirs = await ok(command('application.create', {...phd, institution: 'EPFL'}));
    expect((await command('application.share', {application_ids: [application_id]})).statusCode).toBe(422);
    as(owner);
    const tools = ['application.list', 'application.get', 'application.summary'];
    const solo = await agentRun(owner, projectA, tools);
    expect((await agentCall(solo, 'application.get', {project_id: projectA, application_id})).httpStatus).toBe(200);
    const room = await agentRun(owner, projectA, tools, await sharedRoom([owner, writer]));
    const publicError = (r: OperationToolResponse) => { const {request_id: _r, ...error} = (r.body as {error: Record<string, unknown>}).error; return {status: r.httpStatus, error}; };
    const get = (id: string) => agentCall(room, 'application.get', {project_id: projectA, application_id: id});
    const hidden = publicError(await get(randomUUID()));
    expect(hidden.status).toBe(404);
    expect(publicError(await get(application_id))).toEqual(hidden);
    const listed = await agentCall(room, 'application.list', {project_id: projectA});
    expect(listed.body).toMatchObject({data: {items: [expect.objectContaining({id: theirs.application_id})]}});

    await ok(command('application.share', {application_ids: [application_id]}));
    const detail = await get(application_id);
    expect(detail.httpStatus, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({data: {application: {id: application_id, notes: 'Legacy funding plan'}, deadlines: [{due_on: future(9)}]}});
    expect(publicError(await get(other.application_id))).toEqual(hidden);
    expect((await agentCall(room, 'application.summary', {project_id: projectA})).body).toMatchObject({data: {total: 2}});
    expect((await db.pool.query(`SELECT viewer_user_id,owner_user_id FROM content_access_logs WHERE space_id=$1 AND run_id=$2 AND resource_id=$3 AND resource_type='plugin_applications'`,
      [space, room, application_id])).rows).toContainEqual({viewer_user_id: writer, owner_user_id: owner});
  });

  it('an older decision Proposal cannot overwrite a newer approved one: it is frozen to the revision it was proposed for', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const older = await command('application.propose_status', {application_id, status: 'submitted'});
    const newer = await command('application.propose_status', {application_id, status: 'withdrawn'});
    expect([older.statusCode, newer.statusCode]).toEqual([202, 202]);
    await ok(action('proposal.accept', {proposal_id: newer.json().proposal_id}));
    expect((await ok(read('application.list'))).items[0].status).toBe('withdrawn');
    // Approving the older draft now applies nothing: its frozen revision no longer matches, so the
    // canonical accept decides it as superseded (committed), and the newer decision stands.
    const olderId = older.json().proposal_id as string, key = randomUUID();
    const stale = await action('proposal.accept', {proposal_id: olderId}, key);
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().data).toMatchObject({proposal: {id: olderId, status: 'superseded'}, result_type: 'operation_failure', result: {error: {code: 'operation_approval_superseded'}}});
    expect(await proposalStatus(olderId)).toBe('superseded');
    const linkedState = async (id: string) => (await db.pool.query<{state: string}>('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0]?.state;
    expect(await linkedState(olderId)).toBe('superseded');
    // A retry of the same accept replays its receipt; a new accept finds nothing left to decide,
    // and nothing is applied either way.
    const replay = await action('proposal.accept', {proposal_id: olderId}, key);
    expect([replay.statusCode, replay.json().data]).toEqual([200, stale.json().data]);
    expect((await action('proposal.accept', {proposal_id: olderId})).statusCode).toBe(404);
    expect((await action('proposal.reject', {proposal_id: olderId})).statusCode).not.toBe(200);
    expect((await ok(read('application.list'))).items[0]).toMatchObject({status: 'withdrawn'});
    expect(await proposalStatus(newer.json().proposal_id)).toBe('accepted');
    // Any edit after proposing (here the facts) also supersedes it; a fresh Proposal applies.
    const pending = await command('application.propose_status', {application_id, status: 'accepted'});
    const current = (await ok(read('application.get', {application_id}))).application.revision;
    await ok(command('application.update', {application_id, revision: current, notes: 'Changed after proposing'}));
    const afterEdit = await action('proposal.accept', {proposal_id: pending.json().proposal_id});
    expect(afterEdit.json().data).toMatchObject({proposal: {status: 'superseded'}, result_type: 'operation_failure'});
    expect(await linkedState(pending.json().proposal_id)).toBe('superseded');
    expect((await ok(read('application.list'))).items[0].status).toBe('withdrawn');
    const fresh = await command('application.propose_status', {application_id, status: 'accepted'});
    await ok(action('proposal.accept', {proposal_id: fresh.json().proposal_id}));
    expect((await ok(read('application.list'))).items[0].status).toBe('accepted');
  });

  it('the first accept of an expired decision Proposal commits its request as expired and applies nothing', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const proposed = await command('application.propose_status', {application_id, status: 'submitted'});
    expect(proposed.statusCode, proposed.body).toBe(202);
    const id = proposed.json().proposal_id as string, key = randomUUID();
    await db.pool.query(`UPDATE proposals SET expires_at=now()-interval '1 second' WHERE id=$1`, [id]);
    const linkedState = async () => (await db.pool.query<{state: string}>('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0]?.state;
    // No cleanup has run: the API accept itself is the first to see the expiry, and its write commits.
    expect(await linkedState()).toBe('pending_approval');
    const expired = await action('proposal.accept', {proposal_id: id}, key);
    expect(expired.statusCode, expired.body).toBe(200);
    expect(expired.json().data).toMatchObject({proposal: {id, status: 'pending', expired: true}, result_type: 'operation_failure', result: {error: {code: 'operation_approval_expired'}}});
    expect(await linkedState()).toBe('expired');
    expect(await proposalStatus(id)).toBe('pending');
    // The same key replays the receipt; a new accept has nothing left to decide.
    const replay = await action('proposal.accept', {proposal_id: id}, key);
    expect([replay.statusCode, replay.json().data]).toEqual([200, expired.json().data]);
    expect((await action('proposal.accept', {proposal_id: id})).statusCode).toBe(404);
    expect(await linkedState()).toBe('expired');
    expect((await ok(read('application.list'))).items[0].status).not.toBe('submitted');
    // An unexpired decision Proposal still applies normally.
    const fresh = await command('application.propose_status', {application_id, status: 'submitted'});
    await ok(action('proposal.accept', {proposal_id: fresh.json().proposal_id}));
    expect((await ok(read('application.list'))).items[0].status).toBe('submitted');
  });

  it('after retention prunes an expired decision request, a new accept or reject cannot decide it; unlinked Proposals still decide', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const propose = async () => { const r = await command('application.propose_status', {application_id, status: 'submitted'}); expect(r.statusCode, r.body).toBe(202); return r.json().proposal_id as string; };
    const linkedRows = async (id: string) => (await db.pool.query('SELECT 1 FROM operation_idempotency WHERE proposal_id=$1', [id])).rowCount;
    const age = (id: string) => db.pool.query(`UPDATE operation_idempotency SET terminal_at=now()-interval '8 days' WHERE proposal_id=$1`, [id]);
    // One was first accepted after expiry (its receipt kept); the other expired untouched and only cleanup saw it.
    const accepted = await propose(), untouched = await propose(), key = randomUUID();
    await db.pool.query(`UPDATE proposals SET expires_at=now()-interval '1 second' WHERE id = ANY($1)`, [[accepted, untouched]]);
    expect((await action('proposal.accept', {proposal_id: accepted}, key)).json().data).toMatchObject({result_type: 'operation_failure', result: {error: {code: 'operation_approval_expired'}}});
    await pruneOperationRequests(db.pool);
    expect((await db.pool.query<{state: string}>('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [untouched])).rows[0]?.state).toBe('expired');
    await age(accepted); await age(untouched);
    await pruneOperationRequests(db.pool);
    for (const id of [accepted, untouched]) {
      expect(await linkedRows(id)).toBe(0);
      expect((await db.pool.query('SELECT operation_request_linked FROM proposals WHERE id=$1', [id])).rows[0]).toEqual({operation_request_linked: true});
      // The frozen revision and requester are gone: no new key reaches the applier or rejects it.
      const accept = await action('proposal.accept', {proposal_id: id});
      expect(accept.statusCode, accept.body).toBe(404);
      const reject = await action('proposal.reject', {proposal_id: id});
      expect(reject.statusCode, reject.body).toBe(404);
      expect(await proposalStatus(id)).toBe('pending');
    }
    // The kept receipt of the first accept is refused too, since its result gate cannot be rechecked.
    expect((await action('proposal.accept', {proposal_id: accepted}, key)).statusCode).toBe(410);
    expect((await ok(read('application.list'))).items[0].status).not.toBe('submitted');
    // An unlinked (legacy) Proposal has no marker and decides normally.
    const legacy = randomUUID();
    await db.pool.query(`INSERT INTO proposals (id,space_id,project_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at,created_by_user_id,owner_user_id)
      VALUES ($1,$2,$3,'follow_up_task','pending','low','normal','Legacy',$4::jsonb,now(),now(),$5,$5)`, [legacy, space, projectA, JSON.stringify({task: {title: 'Legacy follow-up'}}), owner]);
    const rejected = await action('proposal.reject', {proposal_id: legacy});
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await proposalStatus(legacy)).toBe('rejected');
    // A fresh decision Proposal still applies.
    await ok(action('proposal.accept', {proposal_id: await propose()}));
    expect((await ok(read('application.list'))).items[0].status).toBe('submitted');
  });

  it('in the Room, a superseded or expired decision Proposal is never reported or shown as applied, and nothing continues', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const session = await sharedRoom([owner]);
    const run = await agentRun(owner, projectA, ['application.propose_status'], session);
    await db.pool.query(`UPDATE runs SET permission_snapshot_json=jsonb_set(permission_snapshot_json,'{tool_grants}',permission_snapshot_json->'tool_grants' || '[{"action_id":"proposal.decide"},{"action_id":"proposal.list_pending"}]'::jsonb) WHERE id=$1`, [run]);
    // The actual Run tool HTTP route the CLI calls, with this Run's own token.
    const token = await new PgRunToolIdentityRepository(db.pool).issue({id: run, space_id: space}, 60_000);
    const tool = (name: string, args: Record<string, unknown>) => app.inject({method: 'POST', url: `/api/v1/runs/${run}/tools/${name}`, headers: {authorization: `Bearer ${token}`, 'idempotency-key': randomUUID()}, payload: args});
    const propose = async (status: string) => {
      const r = await agentCall(run, 'application.propose_status', {project_id: projectA, application_id, status});
      expect(r.httpStatus, JSON.stringify(r.body)).toBe(202);
      return (r.body as {proposal_id: string}).proposal_id;
    };
    const older = await propose('submitted'), newer = await propose('withdrawn'), stale = await propose('accepted');
    await ok(action('proposal.accept', {proposal_id: newer}));
    await db.pool.query(`UPDATE proposals SET expires_at=now()-interval '1 second' WHERE id=$1`, [stale]);
    // An expired Proposal is neither listed as awaiting a decision nor decided.
    const listed = await tool('proposal.list_pending', {});
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().proposals.map((p: {proposal_id: string}) => p.proposal_id)).toEqual([older]);
    // A refused Room decision is an HTTP 200 receipt with `ok: false`, never an HTTP error status.
    const refusal = (error: string) => ({ok: false, tool: 'proposal.decide', error_code: 'system_action_failed', error});
    const decide = (proposal_id: string, decision: 'accept' | 'reject') => tool('proposal.decide', {proposal_id, decision});
    for (const decision of ['accept', 'reject'] as const) {
      const expired = await decide(stale, decision);
      expect([expired.statusCode, expired.json()]).toEqual([200, refusal('That proposal has expired; nothing was decided or applied. Ask the person whether to propose it again.')]);
      expect(await proposalStatus(stale)).toBe('pending');
    }
    // An unlinked (legacy) expired Proposal of this conversation: the Room and both HTTP decisions
    // refuse it alike, and it stays pending.
    const legacy = randomUUID();
    await db.pool.query(`INSERT INTO proposals (id,space_id,project_id,proposal_type,status,risk_level,urgency,title,payload_json,created_at,updated_at,created_by_user_id,owner_user_id,created_by_run_id,expires_at)
      VALUES ($1,$2,$3,'follow_up_task','pending','low','normal','Legacy',$4::jsonb,now(),now(),$5,$5,$6,now()-interval '1 second')`, [legacy, space, projectA, JSON.stringify({task: {title: 'Legacy follow-up'}}), owner, run]);
    for (const decision of ['accept', 'reject'] as const) {
      const room = await decide(legacy, decision);
      expect([room.statusCode, room.json()]).toEqual([200, refusal('That proposal has expired; nothing was decided or applied. Ask the person whether to propose it again.')]);
      const http = await action(`proposal.${decision}`, {proposal_id: legacy});
      expect([http.statusCode, http.json().error?.code], http.body).toEqual([409, 'operation_approval_expired']);
    }
    expect(await proposalStatus(legacy)).toBe('pending');
    // The older draft's frozen revision no longer holds: the decision commits as superseded, which
    // the Agent must report as not applied, with no continuation.
    const superseded = await decide(older, 'accept');
    expect([superseded.statusCode, superseded.json()]).toEqual([200, refusal('Not applied: the request changed after this proposal was made, so it was closed as superseded. Read the current state before proposing again.')]);
    expect(await proposalStatus(older)).toBe('superseded');
    expect((await ok(read('application.list'))).items[0].status).toBe('withdrawn');
    // The Room card projection offers neither for a decision.
    const cards = await loadProjectChatActionPreviews(db.pool, space, run);
    expect(Object.fromEntries(cards.map(c => [c.proposal_id, c.status]))).toMatchObject({[older]: 'failed', [newer]: 'auto_applied', [stale]: 'failed'});
  });

  it('a material reference is saved only for a readable object of this Project, and is rechecked when read', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const material = (await ok(read('application.get', {application_id}))).materials[0].id as string;
    const taskIn = async (project: string, title: string) => { const r = await action('task.create', {project_id: project, title}); expect(r.statusCode, r.body).toBe(201); return r.json().data.task_id as string; };
    const here = await taskIn(projectA, 'Draft SoP'), elsewhere = await taskIn(projectB, 'Other Project plan');
    // Missing, another Project's (which the person reads) and another person's private object are refused at save.
    as(writer);
    const theirs = await taskIn(projectA, 'Writer private task');
    await db.pool.query(`UPDATE tasks SET visibility='private',owner_user_id=$2 WHERE id=$1`, [theirs, writer]);
    as(owner);
    for (const id of [randomUUID(), elsewhere, theirs]) {
      const refused = await command('material.update', {material_id: material, reference: {type: 'task', id}});
      expect(refused.statusCode, refused.body).toBe(422);
      expect(reason(refused)).toBe('reference_unavailable');
    }
    expect((await rows('application_materials')).find(m => m.id === material)).toMatchObject({ref_type: null, ref_id: null});
    // The Agent entry checks the same at save.
    const run = await agentRun(owner, projectA, ['material.update']);
    const fromAgent = await agentCall(run, 'material.update', {project_id: projectA, material_id: material, reference: {type: 'task', id: elsewhere}});
    expect(fromAgent.httpStatus).toBe(422);
    await ok(command('material.update', {material_id: material, reference: {type: 'task', id: here}}));
    expect((await ok(read('application.get', {application_id}))).materials[0].reference).toEqual({type: 'task', id: here, title: 'Draft SoP', available: true});
    // Moved to another Project after saving: the person's own read no longer resolves it there.
    await db.pool.query('UPDATE tasks SET project_id=$2 WHERE id=$1', [here, projectB]);
    expect((await ok(read('application.get', {application_id}))).materials[0].reference).toEqual({type: 'task', id: here, title: null, available: false});
  });

  it('a reference save waits for a concurrent change to the object and decides on its committed state', async () => {
    await bind(projectA);
    const {application_id} = await ok(command('application.create', phd));
    const material = (await ok(read('application.get', {application_id}))).materials[0].id as string;
    const created = await action('task.create', {project_id: projectA, title: 'Draft SoP'});
    expect(created.statusCode, created.body).toBe(201);
    const task = created.json().data.task_id as string;
    // Readable in this Project when the save starts; made another person's private object by a
    // writer that commits only after the save is waiting on the object's row.
    const writerTx = await db.pool.connect();
    try {
      await writerTx.query('BEGIN');
      await writerTx.query(`UPDATE tasks SET visibility='private',owner_user_id=$2 WHERE id=$1`, [task, writer]);
      const saving = command('material.update', {material_id: material, reference: {type: 'task', id: task}});
      await expect.poll(async () => (await db.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0]!.n, {timeout: 10_000}).toBeGreaterThan(0);
      await writerTx.query('COMMIT');
      const refused = await saving;
      expect(refused.statusCode, refused.body).toBe(422);
      expect(reason(refused)).toBe('reference_unavailable');
    } finally {
      await writerTx.query('ROLLBACK').catch(() => {});
      writerTx.release();
    }
    expect((await rows('application_materials')).find(m => m.id === material)).toMatchObject({ref_type: null, ref_id: null});
  });

  it('a reference to another Project is refused before that Project is locked, so crossed saves never wait on each other', async () => {
    await bind(projectA); await bind(projectB);
    const setup = async (project: string) => {
      const {application_id} = await ok(command('application.create', phd, project));
      const material = (await ok(read('application.get', {application_id}, project))).materials[0].id as string;
      const created = await action('task.create', {project_id: project, title: `Plan ${project}`});
      expect(created.statusCode, created.body).toBe(201);
      return {material, task: created.json().data.task_id as string};
    };
    const a = await setup(projectA), b = await setup(projectB);
    // Another transaction holds Project B as a writer would: a save in A referencing B's Task is
    // refused without ever waiting on B.
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectB]);
      const outcome = await Promise.race([
        command('material.update', {material_id: a.material, reference: {type: 'task', id: b.task}}, projectA),
        new Promise<'waited'>(resolve => setTimeout(() => resolve('waited'), 5_000)),
      ]);
      expect(outcome).not.toBe('waited');
      const refused = outcome as Awaited<ReturnType<typeof command>>;
      expect(refused.statusCode, refused.body).toBe(422);
      expect(reason(refused)).toBe('reference_unavailable');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    // Crossed saves (A references B's Task while B references A's) both refuse, with no lock cycle.
    const crossed = await Promise.all([
      command('material.update', {material_id: a.material, reference: {type: 'task', id: b.task}}, projectA),
      command('material.update', {material_id: b.material, reference: {type: 'task', id: a.task}}, projectB),
    ]);
    for (const refused of crossed) {
      expect(refused.statusCode, refused.body).toBe(422);
      expect(reason(refused)).toBe('reference_unavailable');
    }
    // Each Project's own Task still saves.
    await ok(command('material.update', {material_id: a.material, reference: {type: 'task', id: a.task}}, projectA));
    await ok(command('material.update', {material_id: b.material, reference: {type: 'task', id: b.task}}, projectB));
    expect((await rows('application_materials')).filter(m => [a.material, b.material].includes(m.id)).map(m => m.ref_id).sort()).toEqual([a.task, b.task].sort());
  });

  it('an unplaced Task moved into another Project while a save starts is refused without waiting on that Project', async () => {
    await bind(projectA); await bind(projectB);
    const {application_id} = await ok(command('application.create', phd));
    const material = (await ok(read('application.get', {application_id}))).materials[0].id as string;
    const unplaced = async () => (await new PgTaskRepository(db.pool).createTask({spaceId: space, userId: owner}, {title: 'Unplaced plan', status: 'ready', visibility: 'space_shared'})).id;
    const waitingOnLock = () => expect.poll(async () => (await db.pool.query<{n: number}>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`)).rows[0]!.n, {timeout: 10_000}).toBeGreaterThan(0);
    const race = <T,>(work: Promise<T>) => Promise.race([work, new Promise<'waited'>(resolve => setTimeout(() => resolve('waited'), 5_000))]);
    // The release primitive: a caller discovered the Task unplaced, then the ordinary task.update
    // (which locks only B) moved it. The release's own discovery sees B and refuses before any lock,
    // even while another writer holds B.
    const moved = await unplaced();
    expect(await sourceRetrievalReleaseProjects(db.pool, space, [{object_type: 'task', object_id: moved}], [projectA])).toEqual([projectA]);
    const move = await action('task.update', {task_id: moved, project_id: projectB});
    expect(move.statusCode, move.body).toBe(200);
    const holdB = await db.pool.connect();
    try {
      await holdB.query('BEGIN');
      await holdB.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectB]);
      const confined = await race(withTransaction(db.pool, tx => lockSourceRetrievalReleaseBatch(tx, [{spaceId: space, userId: owner, refs: [{object_type: 'task', object_id: moved}], additionalProjects: [projectA], confineProjects: [projectA]}])).then(() => 'locked', (error: {statusCode?: number}) => error.statusCode));
      expect(confined).toBe(409);
    } finally {
      await holdB.query('ROLLBACK').catch(() => {});
      holdB.release();
    }
    // The real entry: the save waits behind Project A; meanwhile task.update moves the unplaced Task
    // into B and another writer then holds B. The save, released, refuses without waiting on B.
    const task = await unplaced();
    const holdA = await db.pool.connect(), holder = await db.pool.connect();
    try {
      await holdA.query('BEGIN');
      await holdA.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectA]);
      const saving = command('material.update', {material_id: material, reference: {type: 'task', id: task}});
      await waitingOnLock();
      const moving = await action('task.update', {task_id: task, project_id: projectB});
      expect(moving.statusCode, moving.body).toBe(200);
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectB]);
      await holdA.query('COMMIT');
      const outcome = await race(saving);
      expect(outcome).not.toBe('waited');
      const refused = outcome as Awaited<ReturnType<typeof command>>;
      expect(refused.statusCode, refused.body).toBe(422);
      expect(reason(refused)).toBe('reference_unavailable');
    } finally {
      await holdA.query('ROLLBACK').catch(() => {});
      await holder.query('ROLLBACK').catch(() => {});
      holdA.release(); holder.release();
    }
    expect((await rows('application_materials')).find(m => m.id === material)).toMatchObject({ref_type: null, ref_id: null});
  });

  it('edits a deadline without touching its Board Task', async () => {
    await bind(projectA);
    const {application_id, task_ids} = await ok(command('application.create', {...phd, deadlines: [{kind: 'application', due_on: future(20)}], create_tasks: true}));
    const deadline = (await ok(read('application.get', {application_id}))).deadlines[0];
    const before = (await db.pool.query('SELECT title,due_at FROM tasks WHERE id=$1', [task_ids[0]])).rows[0];
    await ok(command('deadline.update', {deadline_id: deadline.id, kind: 'interview', label: 'Panel interview', due_on: future(25)}));
    expect((await ok(read('application.get', {application_id}))).deadlines).toEqual([{id: deadline.id, kind: 'interview', label: 'Panel interview', due_on: future(25), task_id: task_ids[0]}]);
    expect((await db.pool.query('SELECT title,due_at FROM tasks WHERE id=$1', [task_ids[0]])).rows[0]).toEqual(before);
    expect(reason(await command('deadline.update', {deadline_id: randomUUID(), label: 'x'}))).toBe('deadline_not_found');
  });

  it('Project-level contacts and relinking; a contact of only archived applications is read-only until linked elsewhere or made Project-level', async () => {
    await bind(projectA);
    const first = (await ok(command('application.create', phd))).application_id as string;
    const second = (await ok(command('application.create', {...phd, institution: 'EPFL'}))).application_id as string;
    const bound = (await ok(command('contact.create', {application_ids: [first], name: 'Prof. Ada', role: 'supervisor', note: 'Met at NeurIPS'}))).contact_id as string;
    const general = (await ok(command('contact.create', {name: 'Funding office', role: 'admissions'}))).contact_id as string;
    expect((await ok(read('contact.list'))).items.map((c: {id: string; application_ids: string[]}) => [c.id, c.application_ids]).sort()).toEqual([[bound, [first]], [general, []]].sort());
    expect((await ok(read('contact.list', {application_id: first}))).items.map((c: {id: string}) => c.id)).toEqual([bound]);
    // Link a Project-level contact to an application and edit fields.
    await ok(command('contact.update', {contact_id: general, application_ids: [second], affiliation: 'EPFL', note: 'Scholarship questions'}));
    expect((await ok(read('contact.list', {application_id: second}))).items[0]).toMatchObject({id: general, affiliation: 'EPFL', note: 'Scholarship questions'});
    // Archive the first application: its contacts are read-only, a new one cannot join it.
    await ok(command('application.update', {application_id: first, revision: 1, archived: true}));
    for (const refused of [
      await command('contact.create', {application_ids: [first], name: 'Late', role: 'referee'}),
      await command('contact.update', {contact_id: bound, name: 'Prof. Ada Lovelace'}),
      await command('contact.update', {contact_id: bound, application_ids: [first], note: 'x'}),
      await command('contact.log_event', {contact_id: bound, occurred_on: future(0), channel: 'email', direction: 'outbound', summary: 'Hello', response: 'awaiting'}),
      await command('contact.update', {contact_id: general, application_ids: [second, first]}),
    ]) expect(reason(refused), refused.body).toBe('application_archived');
    expect(await rows('application_contact_events')).toEqual([]);
    // Moving it off the archived application (to Project level) is allowed; then it is writable again.
    await ok(command('contact.update', {contact_id: bound, application_ids: [], name: 'Prof. Ada Lovelace'}));
    await ok(command('contact.log_event', {contact_id: bound, occurred_on: future(0), channel: 'email', direction: 'outbound', summary: 'Hello', response: 'awaiting'}));
    expect((await ok(read('contact.list'))).items.find((c: {id: string}) => c.id === bound)).toMatchObject({application_ids: [], name: 'Prof. Ada Lovelace', events: 1});
  });

  it('the UI entry and an Agent in the Project Room produce identical records, each with one policy decision and audit', async () => {
    await bind(projectA);
    await bind(projectB);
    const input = {...phd, deadlines: [{kind: 'application', due_on: future(30)}], create_tasks: true};
    const fromUi = await ok(command('application.create', input));
    const run = await agentRun(owner, projectA, ['application.create', 'deadline.add', 'application.list']);
    const fromAgent = await agentCall(run, 'application.create', {project_id: projectA, ...input});
    expect(fromAgent.httpStatus, JSON.stringify(fromAgent.body)).toBe(200);
    const agentData = (fromAgent.body as {data: {application_id: string; task_ids: string[]}}).data;
    const shape = (r: Record<string, unknown>) => { const {id: _id, created_at: _c, updated_at: _u, date_changed_at: _d, application_id: _a, task_id: _t, ...rest} = r; return rest; };
    const [ui, agent] = [fromUi.application_id, agentData.application_id].map(id => db.pool.query(`SELECT * FROM plugin_applications.applications WHERE id=$1`, [id]));
    expect(shape((await agent).rows[0])).toEqual(shape((await ui).rows[0]));
    const byApp = async (table: string, id: string) => (await db.pool.query(`SELECT * FROM plugin_applications.${table} WHERE application_id=$1 ORDER BY kind,label`, [id])).rows.map(shape);
    for (const table of ['application_deadlines', 'application_materials']) expect(await byApp(table, agentData.application_id)).toEqual(await byApp(table, fromUi.application_id));
    // Both created their Board Task through the same core port, in the same Project.
    const tasks = (await db.pool.query(`SELECT title,project_id,due_at FROM tasks WHERE id=ANY($1::varchar[]) ORDER BY id`, [[...fromUi.task_ids, ...agentData.task_ids]])).rows;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual(tasks[1]);
    const decisions = (await db.pool.query(`SELECT actor_type,decision,run_id FROM policy_decision_records WHERE space_id=$1 AND action=$2 ORDER BY actor_type`, [space, opId('application.create')])).rows;
    expect(decisions).toEqual([{actor_type: 'agent', decision: 'allow', run_id: run}, {actor_type: 'user', decision: 'allow', run_id: null}]);
    // The Agent reaches only its Run's Project, even one the person bound and reads.
    expect((await agentCall(run, 'application.list', {project_id: projectB})).httpStatus).toBe(404);
  });

  it('allows a verified owner Gmail read to feed a shared application in the same Project', async () => {
    await bind(projectA);
    await bind(projectB);
    const [credential, connection, grant] = [randomUUID(), randomUUID(), randomUUID()];
    await db.pool.query("INSERT INTO credentials(id,space_id,owner_user_id,name,credential_type,secret_ref,scopes_json,created_at,updated_at) VALUES($1,$2,$3,'Gmail','gmail_oauth','enc:test','[]',now(),now())", [credential, space, owner]);
    await db.pool.query(`INSERT INTO gmail_connections(id,space_id,owner_user_id,google_subject,mailbox_email,credential_id,status,generation,granted_scopes,connected_at,agent_read_enabled,created_at,updated_at)
      VALUES($1,$2,$3,'test-sub','me@example.test',$4,'active',1,'[]',now(),true,now(),now())`, [connection, space, owner, credential]);
    await db.pool.query(`INSERT INTO plugin_data_grants(id,space_id,plugin_id,toolset,data_class,scope,data_owner_user_id,granted_by_user_id,plugin_version,authority_hash,expanded_json,status,project_id,connection_id,connection_generation,purpose,created_at,updated_at)
      VALUES($1,$2,'core:gmail','read','sensitive','project',$3,$3,'1','test','[]','active',$4,$5,1,'on_demand_read',now(),now())`, [grant, space, owner, projectA, connection]);
    const session = await sharedRoom([owner, viewer]);
    const run = await agentRun(owner, projectA, ['application.create', 'application.update_status', 'application.record_submission', 'application.propose_status', 'contact.create', 'deadline.add', 'material.link_note', 'material.add_source', 'library.add', 'library.update', 'task.create', 'task.update', 'task.create_batch', 'knowledge.note.create'], session);
    const gmailRead = {plugin_id: 'core:gmail', data_class: 'sensitive', owner_user_id: owner, gmail_scope: {project_id: projectA, grant_id: grant}};
    const setReads = (reads: unknown[]) => db.pool.query("UPDATE runs SET context_taint_json=$2::jsonb WHERE id=$1",
      [run, JSON.stringify({schema_version: 1, narrowest_visibility: 'private', plugin_reads: reads})]);
    const input = {...phd, project_id: projectA};
    await setReads([gmailRead]);
    expect((await agentCall(run, 'application.create', {...input, project_id: projectB})).httpStatus).toBe(404);
    await setReads([{...gmailRead, owner_user_id: writer}]);
    expect((await agentCall(run, 'application.create', input)).httpStatus).toBe(404);
    await setReads([gmailRead, {...gmailRead, gmail_scope: undefined}]);
    expect((await agentCall(run, 'application.create', input)).httpStatus).toBe(404);
    await setReads([gmailRead]);
    const result = await agentCall(run, 'application.create', {...input, create_tasks: true, deadlines: [{kind: 'application', due_on: future(7)}]});
    expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
    expect(await rows('applications')).toEqual([expect.objectContaining({user_id: owner, project_id: projectA, project_shared: true})]);
    expect((await agentCall(run, 'task.create', {project_id: projectB, title: 'Different Project'})).httpStatus).toBe(404);
    const task = await agentCall(run, 'task.create', {project_id: projectA, title: 'Follow up on application'});
    expect(task.httpStatus, JSON.stringify(task.body)).toBe(201);
    const taskId = (task.body.data as {task_id: string}).task_id;
    expect((await agentCall(run, 'task.update', {task_id: taskId, title: 'Follow up next week'})).httpStatus).toBe(200);
    const batch = await agentCall(run, 'task.create_batch', {
      request_summary: 'Record both follow-ups', tasks: [{title: 'Request transcript'}, {title: 'Check funding'}],
    });
    expect(batch).toMatchObject({ok: true, created_count: 2});
    const application_id = (result.body.data as {application_id: string}).application_id;
    const owned = {project_id: projectA, application_id};
    const contact = {project_id: projectA, application_ids: [application_id], name: 'Example Supervisor', role: 'supervisor'};
    const createdContact = await agentCall(run, 'contact.create', contact);
    expect(createdContact.httpStatus, JSON.stringify(createdContact.body)).toBe(200);
    const submission = await agentCall(run, 'application.record_submission', {...owned, evidence: 'Verified portal receipt'});
    expect(submission.httpStatus, JSON.stringify(submission.body)).toBe(200);
    expect((await agentCall(run, 'application.update_status', {...owned, status: 'interview'})).httpStatus).toBe(200);
    const deadline = {...owned, kind: 'interview', due_on: future(3)};
    const added = await agentCall(run, 'deadline.add', {...deadline, create_task: true});
    expect(added.httpStatus, JSON.stringify(added.body)).toBe(200);
    expect(added.body.data).toMatchObject({task_id: expect.any(String)});
    const note = await agentCall(run, 'knowledge.note.create', {title: 'Application notes'});
    expect(note.httpStatus, JSON.stringify(note.body)).toBe(201);
    const note_id = (note.body.data as {id: string}).id;
    const detail = await ok(read('application.get', {application_id}));
    const material_id = detail.materials[0].id as string;
    const linkedNote = await agentCall(run, 'material.link_note', {project_id: projectA, material_id, note_id});
    expect(linkedNote.httpStatus, JSON.stringify(linkedNote.body)).toBe(200);
    expect((await agentCall(run, 'material.add_source', {project_id: projectA, material_id, note_id})).httpStatus).toBe(200);
    const library = await agentCall(run, 'library.add', {project_id: projectA, note_id, kind: 'cv'});
    expect(library.httpStatus, JSON.stringify(library.body)).toBe(200);
    expect((await agentCall(run, 'library.update', {project_id: projectA, item_id: (library.body.data as {item_id: string}).item_id, label: 'Team CV'})).httpStatus).toBe(200);
    const decision = await agentCall(run, 'application.propose_status', {...owned, status: 'accepted'});
    expect(decision).toMatchObject({httpStatus: 202, body: {status: 'pending_approval'}});
    await db.pool.query("UPDATE gmail_connections SET agent_read_enabled=false WHERE id=$1", [connection]);
    expect((await agentCall(run, 'application.create', input)).httpStatus).toBe(404);
    expect((await agentCall(run, 'contact.create', contact)).httpStatus).toBe(404);
    expect(await rows('applications')).toHaveLength(1);
    expect((await agentCall(run, 'knowledge.note.create', {title: 'After revocation'})).httpStatus).toBe(404);
    expect((await agentCall(run, 'task.update', {task_id: taskId, title: 'After revocation'})).httpStatus).toBe(404);
  });

  it('disable and unbind stop every entry, keep plugin data and leave core objects useful', async () => {
    await bind(projectA);
    const {application_id, task_ids} = await ok(command('application.create', {...phd, deadlines: [{kind: 'application', due_on: future(10)}], create_tasks: true}));
    await ok(command('contact.create', {application_ids: [application_id], name: 'Referee', role: 'referee'}));
    expect((await db.pool.query(`SELECT 1 FROM plugin_applications.application_contact_links WHERE space_id=$1`, [space])).rows).toHaveLength(1);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await read('application.list')).statusCode).toBe(404);
    expect((await read('contact.list')).statusCode).toBe(404);
    expect((await command('application.create', phd)).statusCode).toBe(404);
    expect(await rows('applications')).toHaveLength(1);
    expect(await rows('application_contacts')).toHaveLength(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks WHERE id=ANY($1::varchar[])', [task_ids])).rows[0].n).toBe(1);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    expect((await ok(read('application.list'))).items).toHaveLength(1);
    await ok(action('official_plugin.project_binding.unbind', {plugin_id: pid, project_id: projectA}));
    expect((await read('application.summary')).statusCode).toBe(404);
    expect(await rows('applications')).toHaveLength(1);
    await bind(projectA);
    expect((await ok(read('application.summary'))).total).toBe(1);
  });
});
