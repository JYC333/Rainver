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
 * Application materials linked to Notes (P3 stage 3, first part) through the
 * `notes.read` core port, on the shipped `applications` package and real
 * PostgreSQL: a material's own Note, source Notes pinned to a version, recorded
 * reviewed versions, and one Note revision read under the live content ACL and
 * the bound Project's closure.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'applications';
const opId = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let space: string, owner: string, member: string, viewer: string, projectA: string, projectB: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});
async function addPerson(user: string, projectRole: 'member' | 'viewer') {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [user]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, user]);
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active',now(),now())`, [randomUUID(), space, projectA, user, projectRole]);
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); member = randomUUID(); viewer = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: projectA, spaceType: 'team'});
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())`, [projectB, space, owner]);
  await addPerson(member, 'member');
  await addPerson(viewer, 'viewer');
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  as(owner);
  await ok(action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: projectA}));
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });
const as = (user: string) => __setAuthIdentityForTests({spaceId: space, userId: user});
const action = (id: string, payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': key}, payload});
const query = (id: string, input: Record<string, unknown>) => app.inject({method: 'GET', url: `/api/v1/queries/${id}?input=${encodeURIComponent(JSON.stringify(input))}`});
const command = (name: string, input: Record<string, unknown>) => action(opId(name), {project_id: projectA, ...input});
const read = (name: string, input: Record<string, unknown> = {}) => query(opId(name), {project_id: projectA, ...input});
const ok = async <T = any>(response: Promise<{statusCode: number; body: string; json(): any}>): Promise<T> => {
  const r = await response;
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as T;
};
const reason = (r: {json(): any}) => r.json().error?.metadata?.reason;

/** A Note as Knowledge's writer leaves it: root, extension and revision 1. */
async function note(title: string, text: string, opts: {owner?: string; visibility?: 'private' | 'space_shared'; project?: string | null} = {}) {
  const id = randomUUID(), at = new Date().toISOString(), doc = markdownToPm(text);
  await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'note',$3,$4,$5,$6,now(),now())`,
    [id, space, title, opts.visibility ?? 'private', opts.owner ?? owner, opts.project ?? null]);
  await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text) VALUES($1,$2,$3::jsonb,'prosemirror_json',1,$4)`, [id, space, JSON.stringify(doc), text]);
  await insertInitialNoteRevision(db.pool, {spaceId: space, noteId: id, doc, at, userId: opts.owner ?? owner});
  return id;
}
/** A later edit through the single Note content writer. */
const edit = (noteId: string, text: string) => withTransaction(db.pool, tx => writeNote(tx, {spaceId: space, noteId, content: {kind: 'doc', doc: markdownToPm(text)}, source: 'user_edit', userId: owner}));
async function material() {
  const {application_id} = await ok(command('application.create', {institution: 'ETH Zurich', program: 'PhD in Computer Science'}));
  const detail = await ok(read('application.get', {application_id}));
  return {application_id, cv: detail.materials[0].id as string, statement: detail.materials[1].id as string};
}
const materialOf = async (application_id: string, id: string) => (await ok(read('application.get', {application_id}))).materials.find((m: {id: string}) => m.id === id);

async function agentRun(user: string, tools: string[], session: string | null = null) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: user, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,permission_snapshot_json=$4::jsonb,session_id=$5 WHERE id=$1`,
    [runId, user, projectA, JSON.stringify({tool_grants: tools.map(t => ({action_id: opId(t)}))}), session]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  return runId;
}
const agentCall = async (runId: string, name: string, args: Record<string, unknown>) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: randomUUID(), name: opId(name), arguments: args})) as OperationToolResponse;
};
async function sharedRoom(users: string[]) {
  const room = randomUUID(), session = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Pair','active',now(),now(),false)`, [room, space, projectA, users[0]]);
  for (const user of users) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, projectA]);
  return session;
}

describe('Application materials in Notes', () => {
  it('declares the Notes port and a person-only review operation that no Agent toolset contains', async () => {
    const m = plugin.operationManifest!;
    expect(m.core_ports).toEqual(['tasks.create', 'references.resolve', 'notes.read', 'notes.draft']);
    const review = m.operations.find(o => o.id === opId('material.mark_reviewed'))!;
    expect(review).toMatchObject({kind: 'command', side_effects: 'durable', data_class: 'non_sensitive', actors: ['user']});
    const {pluginToolsetExpansion} = await import('@rainver/protocol');
    expect(pluginToolsetExpansion(m, 'write', 'non_sensitive').map(p => p.action_id)).not.toContain(opId('material.mark_reviewed'));
    expect(pluginToolsetExpansion(m, 'write', 'non_sensitive').map(p => p.action_id)).toContain(opId('material.link_note'));
    expect(pluginToolsetExpansion(m, 'read', 'non_sensitive').map(p => p.action_id)).toContain(opId('material.read_note'));
  });

  it('links a draft Note, pins source Notes, keeps reviewed versions through later edits and reads any linked revision', async () => {
    const {application_id, statement} = await material();
    // The school-specific draft lives in this Project; the master CV is a reusable Project-free personal Note.
    const draft = await note('ETH statement', 'First draft for ETH.', {project: projectA, visibility: 'space_shared'});
    const masterCv = await note('Master CV', 'GNN thesis, AUC 0.87.');
    expect(await ok(command('material.link_note', {material_id: statement, note_id: draft}))).toEqual({material_id: statement, note_id: draft, current_version: 1});
    const source = await ok(command('material.add_source', {material_id: statement, note_id: masterCv}));
    expect(source).toMatchObject({note_id: masterCv, note_version: 1});
    await ok(command('material.mark_reviewed', {material_id: statement, note_id: draft, note_version: 1}));
    let m = await materialOf(application_id, statement);
    expect(m.note).toEqual({note_id: draft, title: 'ETH statement', current_version: 1, available: true});
    expect(m.sources).toEqual([{id: source.source_id, note_id: masterCv, title: 'Master CV', current_version: 1, available: true, note_version: 1, updated: false}]);
    expect(m.reviews).toEqual([expect.objectContaining({note_id: draft, note_version: 1})]);
    // Editing both Notes: the draft gets a new version to review, the source is flagged as updated.
    await edit(draft, 'Second draft for ETH, citing the workshop paper.');
    await edit(masterCv, 'GNN thesis, AUC 0.91; workshop paper accepted.');
    m = await materialOf(application_id, statement);
    expect(m.note.current_version).toBe(2);
    expect(m.sources[0]).toMatchObject({note_version: 1, current_version: 2, updated: true});
    // The reviewed version still reads exactly as reviewed; the current version is the default.
    expect(await ok(read('material.read_note', {material_id: statement, note_id: draft, version: 1}))).toMatchObject({note_id: draft, version: 1, current_version: 2, text: 'First draft for ETH.', truncated: false});
    expect((await ok(read('material.read_note', {material_id: statement, note_id: draft}))).text).toBe('Second draft for ETH, citing the workshop paper.');
    expect((await ok(read('material.read_note', {material_id: statement, note_id: masterCv, version: 1}))).text).toBe('GNN thesis, AUC 0.87.');
    // Reviewing the new version keeps the earlier record; recording it twice does not duplicate it.
    await ok(command('material.mark_reviewed', {material_id: statement, note_id: draft, note_version: 2}));
    await ok(command('material.mark_reviewed', {material_id: statement, note_id: draft, note_version: 2}));
    expect((await materialOf(application_id, statement)).reviews.map((r: {note_version: number}) => r.note_version)).toEqual([2, 1]);
    // Re-adding a source re-pins it to the version given (or the current one).
    await ok(command('material.add_source', {material_id: statement, note_id: masterCv}));
    expect((await materialOf(application_id, statement)).sources).toEqual([expect.objectContaining({id: source.source_id, note_version: 2, updated: false})]);
    // Relinking the material to another Note keeps the reviews of the old one readable.
    const rewrite = await note('ETH statement (rewrite)', 'A fresh start.', {project: projectA, visibility: 'space_shared'});
    await ok(command('material.link_note', {material_id: statement, note_id: rewrite}));
    m = await materialOf(application_id, statement);
    expect(m.note.note_id).toBe(rewrite);
    expect(m.reviews.map((r: {note_id: string}) => r.note_id)).toEqual([draft, draft]);
    // A page opened before the relink confirms the Note it showed: that review is refused, never recorded against the new Note.
    expect(reason(await command('material.mark_reviewed', {material_id: statement, note_id: draft, note_version: 1}))).toBe('note_relinked');
    expect((await materialOf(application_id, statement)).reviews.map((r: {note_id: string}) => r.note_id)).toEqual([draft, draft]);
    expect((await ok(read('material.read_note', {material_id: statement, note_id: draft, version: 1}))).text).toBe('First draft for ETH.');
    // Unlinking clears only the link.
    expect(await ok(command('material.link_note', {material_id: statement, note_id: null}))).toEqual({material_id: statement, note_id: null, current_version: null});
    expect((await materialOf(application_id, statement))).toMatchObject({note: null, reviews: [expect.anything(), expect.anything()]});
  });

  it('refuses another Project\'s Note, a Note shared to another Project, and a linked Note that later leaves this Project', async () => {
    const {application_id, cv} = await material();
    const elsewhere = await note('Other Project draft', 'Belongs to B.', {project: projectB, visibility: 'space_shared'});
    const sharedOut = await note('Shared to B', 'Owned by A, shared to B.', {project: projectA, visibility: 'space_shared'});
    await db.pool.query(`INSERT INTO space_object_project_shares(id,space_id,object_id,project_id,shared_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,now(),now())`, [randomUUID(), space, sharedOut, projectB, owner]);
    for (const noteId of [elsewhere, sharedOut]) {
      expect(reason(await command('material.link_note', {material_id: cv, note_id: noteId}))).toBe('note_unavailable');
      expect(reason(await command('material.add_source', {material_id: cv, note_id: noteId}))).toBe('note_unavailable');
    }
    expect(await db.pool.query(`SELECT note_id FROM plugin_applications.application_materials WHERE id=$1`, [cv]).then(r => r.rows[0].note_id)).toBeNull();
    // A Project-free Note linked here and later bound to another Project shows as unavailable and is not read.
    const personal = await note('Experience', 'Teaching assistant, two terms.');
    await ok(command('material.link_note', {material_id: cv, note_id: personal}));
    await ok(command('material.add_source', {material_id: cv, note_id: personal}));
    await db.pool.query('UPDATE space_objects SET primary_project_id=$2 WHERE id=$1', [personal, projectB]);
    const m = await materialOf(application_id, cv);
    expect(m.note).toEqual({note_id: personal, title: null, current_version: null, available: false});
    expect(m.sources[0]).toMatchObject({note_id: personal, title: null, available: false, updated: false});
    expect(reason(await read('material.read_note', {material_id: cv, note_id: personal}))).toBe('note_unavailable');
    // The Project-bound operation itself never reaches Project B.
    expect((await query(opId('material.read_note'), {project_id: projectB, material_id: cv, note_id: personal})).statusCode).toBe(404);
  });

  it('refuses Notes the person cannot read, trashed Notes, missing versions, unlinked Notes and writes by a viewer', async () => {
    const {cv} = await material();
    const theirs = await note('Member private CV', 'Not yours.', {owner: member});
    expect(reason(await command('material.link_note', {material_id: cv, note_id: theirs}))).toBe('note_unavailable');
    expect(reason(await command('material.add_source', {material_id: cv, note_id: theirs}))).toBe('note_unavailable');
    expect(reason(await command('material.link_note', {material_id: cv, note_id: randomUUID()}))).toBe('note_unavailable');
    const mine = await note('My CV', 'Mine.');
    expect(reason(await command('material.mark_reviewed', {material_id: cv, note_id: mine, note_version: 1}))).toBe('note_not_linked');
    expect(reason(await command('material.add_source', {material_id: cv, note_id: mine, note_version: 5}))).toBe('note_unavailable');
    await ok(command('material.link_note', {material_id: cv, note_id: mine}));
    expect(reason(await command('material.mark_reviewed', {material_id: cv, note_id: mine, note_version: 2}))).toBe('note_unavailable');
    expect(reason(await read('material.read_note', {material_id: cv, note_id: mine, version: 2}))).toBe('note_unavailable');
    // The package reads only Notes this material links, reviewed or draws on.
    const unrelated = await note('Unrelated', 'Not linked.');
    expect(reason(await read('material.read_note', {material_id: cv, note_id: unrelated}))).toBe('note_not_linked');
    // A Note moved to the trash is no longer read or reviewable.
    await db.pool.query(`UPDATE notes SET status='deleted' WHERE object_id=$1`, [mine]);
    expect(reason(await read('material.read_note', {material_id: cv, note_id: mine}))).toBe('note_unavailable');
    expect(reason(await command('material.mark_reviewed', {material_id: cv, note_id: mine, note_version: 1}))).toBe('note_unavailable');
    // A viewer cannot edit the Project. A member can use the shared checklist,
    // while the previous private Note still follows its own ACL.
    as(viewer);
    expect((await command('material.link_note', {material_id: cv, note_id: unrelated})).statusCode).toBe(404);
    as(member);
    expect(reason(await read('material.read_note', {material_id: cv, note_id: mine}))).toBe('note_unavailable');
    const shared = await note('Project draft', 'Team version', {project: projectA, visibility: 'space_shared'});
    await ok(command('material.link_note', {material_id: cv, note_id: shared}));
    const {source_id} = await ok(command('material.add_source', {material_id: cv, note_id: shared}));
    await ok(command('material.mark_reviewed', {material_id: cv, note_id: shared, note_version: 1}));
    await ok(command('material.remove_source', {source_id}));
  });

  it('removing a source reference, and removing the material, leaves every Note untouched', async () => {
    const {application_id, cv} = await material();
    const master = await note('Master CV', 'Master.');
    const draft = await note('CV for ETH', 'Draft.', {project: projectA, visibility: 'space_shared'});
    await ok(command('material.link_note', {material_id: cv, note_id: draft}));
    const {source_id} = await ok(command('material.add_source', {material_id: cv, note_id: master}));
    await ok(command('material.mark_reviewed', {material_id: cv, note_id: draft, note_version: 1}));
    expect(await ok(command('material.remove_source', {source_id}))).toEqual({source_id});
    expect((await materialOf(application_id, cv)).sources).toEqual([]);
    expect(reason(await read('material.read_note', {material_id: cv, note_id: master}))).toBe('note_not_linked');
    expect(reason(await command('material.remove_source', {source_id}))).toBe('source_not_found');
    await ok(command('material.add_source', {material_id: cv, note_id: master}));
    await ok(command('material.remove', {material_id: cv}));
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.application_material_sources WHERE space_id=$1`, [space])).rows[0].n).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.application_material_reviews WHERE space_id=$1`, [space])).rows[0].n).toBe(0);
    const notes = (await db.pool.query(`SELECT n.object_id,n.version,n.status FROM notes n WHERE n.object_id=ANY($1::varchar[]) ORDER BY n.object_id`, [[master, draft]])).rows;
    expect(notes).toEqual(expect.arrayContaining([{object_id: master, version: 1, status: 'active'}, {object_id: draft, version: 1, status: 'active'}]));
  });

  it('an Agent reads a linked Note only for an audience that may read it, and cannot record a review', async () => {
    const {cv} = await material();
    const privateCv = await note('Private CV', 'Private details.');
    await ok(command('material.link_note', {material_id: cv, note_id: privateCv}));
    // In the person's own private Run the Agent reads the Note; the release records it as private context of the Run.
    const run = await agentRun(owner, ['material.read_note', 'material.link_note', 'material.mark_reviewed']);
    const own = await agentCall(run, 'material.read_note', {project_id: projectA, material_id: cv, note_id: privateCv});
    expect(own.httpStatus, JSON.stringify(own.body)).toBe(200);
    expect(JSON.stringify(own)).toContain('Private details.');
    expect((await db.pool.query(`SELECT has_context_taint,context_taint_json->>'narrowest_visibility' AS narrowest FROM runs WHERE id=$1`, [run])).rows[0]).toEqual({has_context_taint: true, narrowest: 'private'});
    // Recording a review is the person's own act: it is no Agent tool.
    const review = await agentCall(run, 'material.mark_reviewed', {project_id: projectA, material_id: cv, note_id: privateCv, note_version: 1});
    expect(review.httpStatus).not.toBe(200);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.application_material_reviews WHERE space_id=$1`, [space])).rows[0].n).toBe(0);
    // In a Room another member also reads, the private Note never reaches the shared output.
    const shared = await agentRun(owner, ['material.read_note', 'material.link_note'], await sharedRoom([owner, member]));
    const refused = await agentCall(shared, 'material.read_note', {project_id: projectA, material_id: cv, note_id: privateCv});
    expect(refused.httpStatus).not.toBe(200);
    expect(JSON.stringify(refused)).not.toContain('Private details.');
    const link = await agentCall(shared, 'material.link_note', {project_id: projectA, material_id: cv, note_id: privateCv});
    expect(link.httpStatus).not.toBe(200);
  });
});
