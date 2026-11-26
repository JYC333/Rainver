import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {withTransaction} from '../src/db/tx.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedRun, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {knowledgeModule} from '../src/modules/knowledge/index.js';
import {sourcesModule} from '../src/modules/sources/index.js';
import {RegistrationService} from '../src/modules/auth/registration.js';
import {hashOpaqueToken} from '../src/modules/auth/securityPolicy.js';
import {acceptInvitation} from '../src/modules/spaces/writers.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import {insertInitialNoteRevision, writeNote} from '../src/modules/knowledge/noteRevisionService.js';
import {markdownToPm} from '../src/modules/knowledge/noteDocument.js';
import {__setProviderHttpClientForTests} from '../src/modules/providers/invocation/invocation.js';
import {NOTE_DRAFT_CAPABILITY} from '../src/modules/plugins/noteDraftPort.js';
import {performQueuedProviderTaskJob, providerTaskTestConfig, seedTestModelProvider} from './support/providerTaskFixture.js';
import {JobWorker} from '../src/modules/jobs/worker.js';
import {PgJobQueueRepository} from '../src/modules/jobs/repository.js';
import {buildJobHandlerRegistry} from '../src/modules/jobs/workerRuntime.js';
import {STANDING_COMPARISON_RECONCILE_JOB_TYPE} from '../src/modules/projectResearch/standingComparisonService.js';
import {loadSourceConnectionIdsForTargets} from '../src/modules/retrieval/sourcePolicy.js';
import {waitForBlockedBy, waitForLockWaiter} from './support/lockWait.js';
import {ContentAccessService} from '../src/modules/contentAccess/service.js';
import {lockContentReadAuthority} from '../src/modules/runtimeContext/index.js';
import {readerModule} from '../src/modules/reader/index.js';
import {ProjectResearchAreaService} from '../src/modules/projectResearch/areaService.js';
import {PgAnnotationRepository} from '../src/modules/reader/repository.js';
import {ProjectResearchMonitorComparisonService} from '../src/modules/projectResearch/monitorComparisonService.js';
import {ProjectResearchExecutionProfileService} from '../src/modules/projectResearch/executionProfileService.js';
import {withNoteWrites} from '../src/modules/knowledge/noteWriter.js';
import {PgSessionRepository} from '../src/modules/sessions/repository.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {openAiChatResponse} from './support/piAiHttp.js';
import {seedArxivSourceChain, seedRelevantCorpusItem} from './support/researchSeeds.js';

/**
 * Generated material drafts (P3 stage 3, generation): a person starts a private
 * draft from a material with this application's requirements and pinned source
 * Note versions; the production queue worker claims and performs it (only the
 * provider's HTTP reply is faked); the person previews sources and checks, then saves it
 * through Knowledge's own Note operations, on the shipped package and real PG.
 */
// Lock-race cases hold three sessions while the pool still watches for waiters.
const db = useTestDatabase(import.meta.filename, {max: 6});
const pid = 'phd_application';
const opId = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let space: string, owner: string, member: string, projectA: string, projectB: string, config: ReturnType<typeof providerTaskTestConfig>, app: ReturnType<typeof buildModuleServer>;
/** Provider request bodies seen, and the reply each request gets. */
let requests: string[] = [];
let reply: (body: string) => unknown;  // may return a Promise: awaited before the response

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  await migrateOperationPlugin(db.pool, plugin);
});
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); member = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: projectA, spaceType: 'team'});
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Second','active',now(),now())`, [projectB, space, owner]);
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Person','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [member]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, member]);
  await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, projectA, member]);
  config = providerTaskTestConfig(db.connectionUri, mkdtempSync(join(tmpdir(), 'rainver-drafts-')));
  await seedTestModelProvider(db.pool, {space, owner, config});
  app = buildModuleServer(config, [systemActionsModule, runsModule, knowledgeModule, sourcesModule, readerModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  as(owner);
  await ok(action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: projectA}));
  requests = [];
  reply = () => ({schema: 'rainver.note_draft.v1', draft: 'Draft', verify: [], sources_used: []});
  __setProviderHttpClientForTests({fetch: async (_url: unknown, init?: {body?: unknown}) => {
    const body = String(init?.body ?? '');
    requests.push(body);
    return openAiChatResponse({choices: [{message: {content: JSON.stringify(await reply(body))}}], model: 'test-model', usage: {}});
  }});
});
afterEach(async () => { __setProviderHttpClientForTests(null); __setAuthIdentityForTests(null); await app?.close(); });
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
async function note(title: string, text: string, opts: {visibility?: 'private' | 'space_shared'; project?: string | null; owner?: string} = {}) {
  const id = randomUUID(), at = new Date().toISOString(), doc = markdownToPm(text), by = opts.owner ?? owner;
  await db.pool.query(`INSERT INTO space_objects(id,space_id,object_type,title,visibility,owner_user_id,primary_project_id,created_at,updated_at) VALUES($1,$2,'note',$3,$4,$5,$6,now(),now())`,
    [id, space, title, opts.visibility ?? 'private', by, opts.project ?? null]);
  await db.pool.query(`INSERT INTO notes(object_id,space_id,content_json,content_format,content_schema_version,plain_text) VALUES($1,$2,$3::jsonb,'prosemirror_json',1,$4)`, [id, space, JSON.stringify(doc), text]);
  await insertInitialNoteRevision(db.pool, {spaceId: space, noteId: id, doc, at, userId: by});
  return id;
}
/** This Space as the owner's one-person Personal Space, where the creation rule keeps a new private Note. */
async function personalSpace() {
  await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [space, member]);
  await db.pool.query(`UPDATE spaces SET type='personal' WHERE id=$1`, [space]);
}
/** A Source the Note's content came from (its provenance lineage), owned by `by`, with model egress allowed. */
async function sourceLineage(noteId: string, by: string) {
  const connection = randomUUID();
  // The connector catalog rows are global and keyed; seed them once, then add only this Space's Source.
  const mapping = (await db.pool.query<{id: string}>(`SELECT m.id FROM source_provider_connectors m JOIN source_providers p ON p.id=m.provider_id WHERE p.provider_key='arxiv' LIMIT 1`)).rows[0]?.id;
  if (!mapping) await seedArxivSourceChain(db.pool, {space, owner: by, connector: randomUUID(), connection, channel: randomUUID(), now: new Date().toISOString()});
  else await db.pool.query(`INSERT INTO source_connections(id,space_id,provider_connector_id,owner_user_id,name,status,capture_policy,trust_level,consent_json,policy_json,config_json,created_at,updated_at)
    VALUES($1,$2,$3,$4,'arXiv','active','reference_only','normal',$5::jsonb,'{"schema_version":1,"source_egress_class":"external_provider_allowed"}'::jsonb,'{}'::jsonb,now(),now())`,
  [connection, space, mapping, by, JSON.stringify({schema_version: 1, owner_user_id: by, allowed_reader_user_ids: [], allowed_agent_ids: [], allow_space_admins: true, allow_local_provider_egress: true, allow_external_model_egress: true})]);
  const item = await seedRelevantCorpusItem(db.pool, {space, owner: by, project: projectA});
  await db.pool.query('UPDATE source_items SET connection_id=$2 WHERE id=$1', [item.sourceItemId, connection]);
  await db.pool.query(`INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'note',$3,'source_item',$4,now())`, [randomUUID(), space, noteId, item.sourceItemId]);
  return connection;
}
const withholdExternalEgress = (connection: string) => db.pool.query(
  `UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','false'),policy_json=jsonb_set(policy_json,'{source_egress_class}','"local_provider_allowed"') WHERE id=$1`, [connection]);
const runRead = (runId: string, path = '') => app.inject({method: 'GET', url: `/api/v1/runs/${runId}${path}`});
/** A person's later edit through the single Note content writer. */
const edit = (noteId: string, text: string) => withTransaction(db.pool, tx => writeNote(tx, {spaceId: space, noteId, content: {kind: 'doc', doc: markdownToPm(text)}, source: 'user_edit', userId: owner}));
const noteRow = async (id: string) => (await db.pool.query<{version: number; plain_text: string; visibility: string; owner_user_id: string; primary_project_id: string | null}>(
  'SELECT n.version,n.plain_text,o.visibility,o.owner_user_id,o.primary_project_id FROM notes n JOIN space_objects o ON o.id=n.object_id WHERE n.object_id=$1', [id])).rows[0]!;
async function statement(institution: string) {
  const {application_id} = await ok(command('application.create', {institution, program: 'PhD in Computer Science'}));
  const detail = await ok(read('application.get', {application_id}));
  return {application_id, id: detail.materials.find((m: {kind: string}) => m.kind === 'statement').id as string};
}
/** Starts a draft and lets the real provider_task worker perform its Run. */
async function generate(material: string, input: Record<string, unknown> = {}) {
  const started = await ok(command('material.generate', {material_id: material, requirements: 'About 800 words on research fit', ...input}));
  await performQueuedProviderTaskJob(db.pool, config, started.run_id);
  return started as {generation_id: string; run_id: string};
}
const runOf = async (id: string) => (await db.pool.query<{status: string; visibility: string; instructed_by_user_id: string; capability_id: string; instruction: string; project_id: string}>(
  'SELECT status,visibility,instructed_by_user_id,capability_id,instruction,project_id FROM runs WHERE id=$1', [id])).rows[0]!;

describe('Generated material drafts', () => {
  it('generates privately from pinned source versions, previews sources and checks, and saves once as a new private Note', async () => {
    await personalSpace();
    const master = await note('Master CV', 'Alice Example. MSc ETH 2024. Paper on verified compilers.');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    await edit(master, 'Alice Example. CHANGED_AFTER_PIN.');
    reply = () => ({schema: 'rainver.note_draft.v1', draft: '# Statement\n\nAlice studied at ETH and wrote a paper on verified compilers.', verify: ['Confirm the MSc year'],
      sources_used: [{note_id: master, version: 1}, {note_id: 'hallucinated', version: 1}]});
    const parent = randomUUID();
    await seedRun(db.pool, {id: parent, space, owner, agent: randomUUID(), version: randomUUID()});
    await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,
      visibility='private',project_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1`,
      [parent, owner, projectA, JSON.stringify({tool_grants: ['material.generate', 'material.get_generation', 'material.apply_generation'].map(name => ({action_id: opId(name)}))})]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at)
      VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, parent]);
    const active = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [parent])).rows[0]!;
    const transport = new CliAgentToolTransport(config, {actionEventSink: async () => {}});
    const agentDraft = async (name: string, arguments_: Record<string, unknown>) => {
      const result = await transport.call(active, {id: randomUUID(), name: opId(name),
        arguments: {project_id: projectA, ...arguments_}}) as {httpStatus: number; body: {data: Record<string, string>}};
      expect(result.httpStatus, JSON.stringify(result.body)).toBe(200);
      return result.body.data;
    };
    const started = await agentDraft('material.generate', {material_id: material.id, requirements: 'ETH asks for 1000 words on research fit', length_words: 1000});
    // The request commits a private queued Run of the person; Note text is not copied into it.
    const queued = await runOf(started.run_id);
    expect(queued).toMatchObject({status: 'queued', visibility: 'private', instructed_by_user_id: owner, capability_id: NOTE_DRAFT_CAPABILITY, project_id: projectA});
    expect(queued.instruction).toContain('ETH asks for 1000 words on research fit');
    expect(queued.instruction).not.toContain('verified compilers');
    // Before the worker runs there is nothing to preview.
    expect((await ok(read('material.get_generation', {generation_id: started.generation_id}))).draft).toBeNull();
    await performQueuedProviderTaskJob(db.pool, config, started.run_id);
    expect((await runOf(started.run_id)).status).toBe('succeeded');
    // The model saw the pinned revision, not the later edit.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('verified compilers');
    expect(requests[0]).not.toContain('CHANGED_AFTER_PIN');
    const preview = await agentDraft('material.get_generation', {generation_id: started.generation_id});
    expect(preview).toMatchObject({status: 'succeeded', draft: expect.stringContaining('verified compilers'), verify: ['Confirm the MSc year'], base: null, applied: null, length_words: 1000, save_new: true});
    // Only pinned inputs count as used; the newer source version is flagged.
    expect(preview.sources).toEqual([{note_id: master, title: 'Master CV', current_version: 2, available: true, note_version: 1, used: true, updated: true}]);

    const saved = await agentDraft('material.apply_generation', {generation_id: started.generation_id, target: 'new'});
    const written = await noteRow(saved.note_id);
    // A new Note outside every Project and private to the person, written by Knowledge's writer.
    expect(written).toMatchObject({version: 1, visibility: 'private', owner_user_id: owner, primary_project_id: null});
    expect(written.plain_text).toContain('verified compilers');
    expect(saved.note_version).toBe(1);
    const again = await command('material.apply_generation', {generation_id: started.generation_id, target: 'new'});
    expect([again.statusCode, reason(again)]).toEqual([409, 'generation_applied']);
    // The material view tracks the link and the saved draft; the person reviews it as usual.
    const detail = (await ok(read('application.get', {application_id: material.application_id}))).materials.find((m: {id: string}) => m.id === material.id);
    expect(detail.note).toMatchObject({note_id: saved.note_id, title: 'Statement of purpose — ETH Zurich', current_version: 1, available: true});
    expect(detail.generations).toEqual([{id: started.generation_id, requirements: 'ETH asks for 1000 words on research fit', created_at: expect.any(String), applied: {note_id: saved.note_id, note_version: 1, applied_at: expect.any(String)}}]);
    await ok(command('material.mark_reviewed', {material_id: material.id, note_id: saved.note_id, note_version: 1}));
    expect((await noteRow(master)).version).toBe(2);
  });

  it('drafts the same source for two schools independently, each with its own requirements, Note and review', async () => {
    await personalSpace();
    const master = await note('Master CV', 'Alice Example. Robotics and systems research.');
    const eth = await statement('ETH Zurich'), mit = await statement('MIT');
    for (const m of [eth, mit]) await ok(command('material.add_source', {material_id: m.id, note_id: master}));
    reply = body => ({schema: 'rainver.note_draft.v1', draft: body.includes('MIT') ? 'Draft for MIT' : 'Draft for ETH', verify: [], sources_used: [{note_id: master, version: 1}]});
    const a = await generate(eth.id, {requirements: 'ETH: research statement, 2 pages'});
    const b = await generate(mit.id, {requirements: 'MIT: statement of objectives, 1000 words'});
    expect(requests.find(r => r.includes('ETH: research statement'))).not.toContain('MIT: statement');
    const savedA = await ok(command('material.apply_generation', {generation_id: a.generation_id, target: 'new'}));
    const savedB = await ok(command('material.apply_generation', {generation_id: b.generation_id, target: 'new'}));
    expect(savedA.note_id).not.toBe(savedB.note_id);
    expect((await noteRow(savedA.note_id)).plain_text).toContain('Draft for ETH');
    expect((await noteRow(savedB.note_id)).plain_text).toContain('Draft for MIT');
    await ok(command('material.mark_reviewed', {material_id: eth.id, note_id: savedA.note_id, note_version: 1}));
    const get = async (m: {application_id: string; id: string}) => (await ok(read('application.get', {application_id: m.application_id}))).materials.find((x: {id: string}) => x.id === m.id);
    const [ethView, mitView] = [await get(eth), await get(mit)];
    expect([ethView.note.note_id, ethView.reviews.length, ethView.generations[0].requirements]).toEqual([savedA.note_id, 1, 'ETH: research statement, 2 pages']);
    expect([mitView.note.note_id, mitView.reviews.length, mitView.generations[0].requirements]).toEqual([savedB.note_id, 0, 'MIT: statement of objectives, 1000 words']);
    // The shared source is read, never written.
    expect((await noteRow(master)).version).toBe(1);
  });

  it('writes into the linked private Note only at the version the draft started from; a concurrent edit wins', async () => {
    const own = await note('My statement', 'First attempt.');
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'Revised statement.', verify: [], sources_used: [{note_id: own, version: 1}]});
    const first = await generate(material.id);
    // The linked Note's current version was given to the model and is what an apply must still find.
    expect(requests[0]).toContain('First attempt.');
    expect((await ok(read('material.get_generation', {generation_id: first.generation_id}))).base).toMatchObject({note_id: own, note_version: 1, changed: false});
    await edit(own, 'A human edit in the Notes editor.');
    expect((await ok(read('material.get_generation', {generation_id: first.generation_id}))).base).toMatchObject({note_version: 1, current_version: 2, changed: true});
    const refused = await command('material.apply_generation', {generation_id: first.generation_id, target: 'linked'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_changed']);
    expect(await noteRow(own)).toMatchObject({version: 2, plain_text: expect.stringContaining('A human edit')});
    // A fresh draft from the edited version saves as the Note's next version, with its history kept.
    const second = await generate(material.id);
    const saved = await ok(command('material.apply_generation', {generation_id: second.generation_id, target: 'linked'}));
    expect(saved).toEqual({generation_id: second.generation_id, note_id: own, note_version: 3});
    expect(await noteRow(own)).toMatchObject({version: 3, plain_text: expect.stringContaining('Revised statement.')});
    expect((await db.pool.query('SELECT version FROM note_revisions WHERE note_id=$1 ORDER BY version', [own])).rows.map(r => r.version)).toEqual([1, 2, 3]);
    // In a shared Space the creation rule would place a new Note in the Personal Space, and Space
    // text is never moved there: the earlier draft cannot become a new Note here.
    expect((await ok(read('material.get_generation', {generation_id: first.generation_id}))).save_new).toBe(false);
    const placed = await command('material.apply_generation', {generation_id: first.generation_id, target: 'new'});
    expect([placed.statusCode, reason(placed)]).toEqual([409, 'note_placement_unavailable']);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM notes WHERE space_id=$1`, [space])).rows[0].n).toBe(1);
    // In a Personal Space it can.
    await personalSpace();
    expect((await ok(command('material.apply_generation', {generation_id: first.generation_id, target: 'new'}))).note_version).toBe(1);
  });

  it('revises the linked Note at its current version even when an older version of it is a pinned source', async () => {
    const own = await note('My statement', 'OLD_PINNED_TEXT');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: own}));
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    await edit(own, 'CURRENT_TEXT');
    const g = await generate(material.id);
    // The model is given exactly the version a save to the linked Note is checked against.
    expect(requests[0]).toContain('CURRENT_TEXT');
    expect(requests[0]).not.toContain('OLD_PINNED_TEXT');
    const preview = await ok(read('material.get_generation', {generation_id: g.generation_id}));
    expect(preview.sources.map((s: {note_id: string; note_version: number}) => [s.note_id, s.note_version])).toEqual([[own, 2]]);
    expect(preview.base).toMatchObject({note_id: own, note_version: 2, changed: false});
    expect(await ok(command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'}))).toMatchObject({note_id: own, note_version: 3});
    // Without revising the linked Note, the pinned source version is what the model sees.
    requests = [];
    await generate(material.id, {include_linked: false});
    expect(requests[0]).toContain('OLD_PINNED_TEXT');
  });

  it('keeps private results out of shared Notes, other members and Agents', async () => {
    const shared = await note('Team statement', 'Shared text.', {visibility: 'space_shared', project: projectA});
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: shared}));
    const g = await generate(material.id);
    const refused = await command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_not_private']);
    expect((await noteRow(shared)).version).toBe(1);
    // Another member of the Project neither sees the generation nor its Run.
    as(member);
    const hidden = await read('material.get_generation', {generation_id: g.generation_id});
    expect(hidden.statusCode).not.toBe(200);
    expect(hidden.body).not.toContain('Draft');
    expect(await runOf(g.run_id)).toMatchObject({visibility: 'private', instructed_by_user_id: owner});
    expect((await runRead(g.run_id, '/io')).statusCode).toBe(404);
    as(owner);
    // A manual shared turn can start a private draft, while its result preview stays private.
    const run = randomUUID();
    await seedRun(db.pool, {id: run, space, owner, agent: randomUUID(), version: randomUUID()});
    await db.pool.query(`UPDATE runs SET status='running',trigger_origin='manual',instructed_by_user_id=$2,owner_user_id=$2,visibility='space_shared',project_id=$3,permission_snapshot_json=$4::jsonb WHERE id=$1`,
      [run, owner, projectA, JSON.stringify({tool_grants: ['material.generate', 'material.get_generation', 'material.apply_generation'].map(t => ({action_id: opId(t)}))})]);
    await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at)
      VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, run]);
    const agentRun = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [run])).rows[0]!;
    const transport = new CliAgentToolTransport(config, {actionEventSink: async () => {}});
    const started = await transport.call(agentRun, {id: randomUUID(), name: opId('material.generate'),
      arguments: {project_id: projectA, material_id: material.id, requirements: 'Draft through a shared turn'}}) as {
        httpStatus: number; body: {data: {generation_id: string; run_id: string}};
      };
    expect(started.httpStatus, JSON.stringify(started.body)).toBe(200);
    expect(await runOf(started.body.data.run_id)).toMatchObject({visibility: 'private', instructed_by_user_id: owner});
    await performQueuedProviderTaskJob(db.pool, config, started.body.data.run_id);
    const call = await transport.call(agentRun, {id: randomUUID(), name: opId('material.get_generation'), arguments: {project_id: projectA, generation_id: g.generation_id}}) as {httpStatus?: number; body?: unknown};
    expect(call.httpStatus).toBe(404);
    expect(JSON.stringify(call)).not.toContain('Draft');
    // Privacy is the Note's actual audience: once no one else in the Space can read it, a fresh draft saves into it.
    await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [space, member]);
    const fresh = await generate(material.id);
    expect(await ok(command('material.apply_generation', {generation_id: fresh.generation_id, target: 'linked'}))).toMatchObject({note_id: shared, note_version: 2});
  });

  it('never reads a source that left the person or the Project before dispatch, and saves nothing from it', async () => {
    const master = await note('Master CV', 'SECRET_SOURCE_TEXT');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    // The source moves into another Project between the request and the worker.
    await db.pool.query('UPDATE space_objects SET primary_project_id=$2 WHERE id=$1', [master, projectB]);
    await performQueuedProviderTaskJob(db.pool, config, started.run_id);
    expect(requests).toEqual([]);
    expect((await runOf(started.run_id)).status).not.toBe('succeeded');
    const preview = await ok(read('material.get_generation', {generation_id: started.generation_id})).catch(() => null);
    expect(JSON.stringify(preview ?? {})).not.toContain('SECRET_SOURCE_TEXT');
    const apply = await command('material.apply_generation', {generation_id: started.generation_id, target: 'new'});
    expect(apply.statusCode).toBe(409);
    // A source that is already unavailable is refused at the request.
    const again = await command('material.generate', {material_id: material.id, requirements: 'Anything'});
    expect([again.statusCode, reason(again)]).toEqual([409, 'note_unavailable']);
  });
  it('in a team Space with content oversight keeps the draft Run to its starter and saves only where no admin reads', async () => {
    const admin = randomUUID();
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Admin','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [admin]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'admin','active',now(),now())`, [randomUUID(), space, admin]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, projectA, admin]);
    await db.pool.query(`UPDATE spaces SET oversight_mode='content' WHERE id=$1`, [space]);
    const own = await note('My statement', 'First attempt.');
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'PRIVATE_DRAFT_TEXT', verify: [], sources_used: [{note_id: own, version: 1}]});
    const g = await generate(material.id);
    // The starter reads the Run through the generic Run entries; the oversight admin does not.
    expect((await runRead(g.run_id, '/io')).body).toContain('PRIVATE_DRAFT_TEXT');
    as(admin);
    for (const path of ['', '/io', '/status']) expect((await runRead(g.run_id, path)).statusCode).toBe(404);
    const listed = await app.inject({method: 'GET', url: `/api/v1/runs?limit=200`});
    expect(listed.body).not.toContain(g.run_id);
    as(owner);
    // The linked Note is private, but this Space's oversight lets the admin read it: it is not private to the person.
    const refused = await command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_not_private']);
    const placed = await command('material.apply_generation', {generation_id: g.generation_id, target: 'new'});
    expect([placed.statusCode, reason(placed)]).toEqual([409, 'note_placement_unavailable']);
    expect(await noteRow(own)).toMatchObject({version: 1, plain_text: 'First attempt.'});
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM notes WHERE plain_text LIKE '%PRIVATE_DRAFT_TEXT%'`)).rows[0].n).toBe(0);
  });

  it('drafts from material another member shared only when its Sources allow the send; reading it is not consent', async () => {
    // The member's Project Note the person reads, derived from the member's own Source.
    const theirs = await note('Supervisor facts', 'SHARED_SOURCE_TEXT', {visibility: 'space_shared', project: projectA, owner: member});
    const connection = await sourceLineage(theirs, member);
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    // The Source keeps its content away from external models: the person still reads the Note …
    await withholdExternalEgress(connection);
    expect((await ok(read('material.read_note', {material_id: material.id, note_id: theirs}))).text).toBe('SHARED_SOURCE_TEXT');
    // … but no draft starts, no Run is queued and nothing reaches the provider.
    const refused = await command('material.generate', {material_id: material.id, requirements: 'Anything'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_egress_denied']);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM runs WHERE capability_id=$1 AND space_id=$2`, [NOTE_DRAFT_CAPABILITY, space])).rows[0].n).toBe(0);
    expect(requests).toEqual([]);
    // With the owner's consent the same material drafts normally.
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_external_model_egress}','true'),policy_json=jsonb_set(policy_json,'{source_egress_class}','"external_provider_allowed"') WHERE id=$1`, [connection]);
    const g = await generate(material.id);
    expect((await runOf(g.run_id)).status).toBe('succeeded');
    expect(requests[0]).toContain('SHARED_SOURCE_TEXT');
    // A Space that keeps content from external models refuses too, whatever the Source says.
    await db.pool.query(`INSERT INTO settings(id,scope_type,scope_id,settings_key,settings_json,created_at,updated_at) VALUES($1,'space',$2,'retrieval.space.settings','{"external_egress_enabled":false}'::jsonb,now(),now())`, [randomUUID(), space]);
    const off = await command('material.generate', {material_id: material.id, requirements: 'Anything'});
    expect([off.statusCode, reason(off)]).toEqual([409, 'note_egress_denied']);
  });

  it('rechecks Source egress when the Run is dispatched and sends nothing once consent is withdrawn', async () => {
    const master = await note('Master CV', 'DISPATCH_SECRET');
    const connection = await sourceLineage(master, owner);
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    // Consent is withdrawn between the request and the worker.
    await withholdExternalEgress(connection);
    await performQueuedProviderTaskJob(db.pool, config, started.run_id);
    expect(requests).toEqual([]);
    expect((await runOf(started.run_id)).status).toBe('failed');
    const preview = await ok(read('material.get_generation', {generation_id: started.generation_id}));
    expect(preview).toMatchObject({status: 'failed', draft: null});
  });

  it('withholds a draft from every generic Run entry once its source is revoked, as the preview does', async () => {
    const theirs = await note('Shared facts', 'REVOKED_SOURCE_TEXT', {visibility: 'space_shared', project: projectA, owner: member});
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'DERIVED_FROM_REVOKED', verify: [], sources_used: [{note_id: theirs, version: 1}]});
    const g = await generate(material.id);
    expect((await runRead(g.run_id, '/io')).body).toContain('DERIVED_FROM_REVOKED');
    expect((await app.inject({method: 'GET', url: '/api/v1/runs?limit=200'})).body).toContain(g.run_id);
    // The member makes their Note private again: the person no longer reads the source.
    await db.pool.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`, [theirs]);
    for (const path of ['', '/io', '/status']) {
      const r = await runRead(g.run_id, path);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('DERIVED_FROM_REVOKED');
    }
    expect((await app.inject({method: 'GET', url: '/api/v1/runs?limit=200'})).body).not.toContain(g.run_id);
    const preview = await read('material.get_generation', {generation_id: g.generation_id});
    expect(preview.body).not.toContain('DERIVED_FROM_REVOKED');
    // Restored, the same entries serve it again.
    await db.pool.query(`UPDATE space_objects SET visibility='space_shared' WHERE id=$1`, [theirs]);
    expect((await runRead(g.run_id, '/io')).body).toContain('DERIVED_FROM_REVOKED');
  });

  it('the production worker sends nothing and settles nothing once its Job claim moves to another owner', async () => {
    const master = await note('Master CV', 'CLAIM_SECRET');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    // Another worker reclaims the Job right after this worker's attempt started the Run and before its send.
    const fn = `test_reclaim_${randomUUID().replace(/-/g, '')}`;
    await db.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE jobs SET claimed_by='another-worker' WHERE payload_json->>'run_id'=NEW.id; RETURN NEW; END $$`);
    await db.pool.query(`CREATE TRIGGER ${fn} AFTER UPDATE OF status ON runs FOR EACH ROW WHEN (NEW.status='running' AND NEW.id='${started.run_id}') EXECUTE FUNCTION ${fn}()`);
    let result;
    try { result = await performQueuedProviderTaskJob(db.pool, config, started.run_id); }
    finally { await db.pool.query(`DROP TRIGGER ${fn} ON runs`); await db.pool.query(`DROP FUNCTION ${fn}()`); }
    expect(result.status).toBe('failed');
    expect(requests).toEqual([]);
    // The Run is the claim owner's to settle: this worker neither publishes a draft nor fails it.
    expect((await runOf(started.run_id)).status).toBe('running');
    const job = (await db.pool.query<{claimed_by: string; result_json: Record<string, unknown>}>(`SELECT claimed_by,result_json FROM jobs WHERE payload_json->>'run_id'=$1`, [started.run_id])).rows[0]!;
    // The start fence stays, so no later claim sends it again; no send was ever admitted.
    expect(job).toMatchObject({claimed_by: 'another-worker', result_json: {source_dispatch: 'started'}});
    expect(job.result_json.effect_started).toBeUndefined();
    expect((await ok(read('material.get_generation', {generation_id: started.generation_id}))).draft).toBeNull();
  });

  it('counts only Source-authorized Note body matches and keeps visible title matches', async () => {
    const linked = await note('Distinct public title', 'unique lineage search text', {
      visibility: 'space_shared', project: projectA, owner: member,
    });
    await db.pool.query(`UPDATE notes n SET content_hash = r.content_hash
      FROM note_revisions r WHERE r.note_id = n.object_id AND r.version = n.version AND n.object_id = $1`, [linked]);
    const connection = await sourceLineage(linked, member);
    const search = async (query: string, offset = 0) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/knowledge/notes?project_id=${projectA}&q=${encodeURIComponent(query)}&offset=${offset}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    expect(await search('unique lineage search')).toMatchObject({
      total: 1, items: [{id: linked, content_hash: expect.any(String)}],
    });
    expect(await search('unique lineage search', 1)).toMatchObject({total: 1, items: []});
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_space_admins}','false') WHERE id=$1`, [connection]);
    expect(await search('unique lineage search')).toMatchObject({total: 0, items: []});
    expect(await search('distinct public title')).toMatchObject({
      total: 1, items: [{id: linked, content_hash: null}],
    });
  });

  it('withholds a draft once the person loses a Source reader consent, while the Note ACL itself is unchanged', async () => {
    const theirs = await note('Shared facts', 'SOURCE_READ_TEXT', {visibility: 'space_shared', project: projectA, owner: member});
    const connection = await sourceLineage(theirs, member);
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'DERIVED_FROM_SOURCE', verify: [], sources_used: [{note_id: theirs, version: 1}]});
    const g = await generate(material.id);
    expect((await runRead(g.run_id, '/io')).body).toContain('DERIVED_FROM_SOURCE');
    // The Source's owner stops letting Space admins read it; the Note's own ACL is unchanged.
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_space_admins}','false') WHERE id=$1`, [connection]);
    // The Note's own body answers to its Source lineage too: the plugin's Note read is refused.
    const body = await read('material.read_note', {material_id: material.id, note_id: theirs});
    expect([body.statusCode, reason(body)]).toEqual([422, 'note_unavailable']);
    expect(body.body).not.toContain('SOURCE_READ_TEXT');
    for (const path of ['', '/io', '/status']) {
      const r = await runRead(g.run_id, path);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('DERIVED_FROM_SOURCE');
    }
    expect((await app.inject({method: 'GET', url: '/api/v1/runs?limit=200'})).body).not.toContain(g.run_id);
    expect((await read('material.get_generation', {generation_id: g.generation_id})).body).not.toContain('DERIVED_FROM_SOURCE');
    // Nor is it saved anywhere: the source check comes before any placement or audience question.
    const saved = await command('material.apply_generation', {generation_id: g.generation_id, target: 'new'});
    expect([saved.statusCode, reason(saved)]).toEqual([409, 'note_unavailable']);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM notes WHERE plain_text LIKE '%DERIVED_FROM_SOURCE%'`)).rows[0].n).toBe(0);
  });

  it('a saved draft inherits its inputs\' Source lineage, so a later draft from it answers to the same consent', async () => {
    await personalSpace();
    const master = await note('Master CV', 'LINEAGE_TEXT');
    const connection = await sourceLineage(master, owner);
    const own = await note('My statement', 'First attempt.');
    const eth = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: eth.id, note_id: master}));
    await ok(command('material.link_note', {material_id: eth.id, note_id: own}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'Derived from LINEAGE_TEXT.', verify: [], sources_used: [{note_id: master, version: 1}]});
    const lineageOf = async (id: string) => (await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [id])).get(id);
    expect(await lineageOf(own)).toEqual([]);
    // Saved into the linked Note and as a new Note: both now carry the input's Source.
    const linked = await generate(eth.id);
    expect((await ok(command('material.apply_generation', {generation_id: linked.generation_id, target: 'linked'}))).note_version).toBe(2);
    expect(await lineageOf(own)).toEqual([connection]);
    const fresh = await generate(eth.id, {include_linked: false});
    const created = await ok(command('material.apply_generation', {generation_id: fresh.generation_id, target: 'new'}));
    expect(await lineageOf(created.note_id)).toEqual([connection]);
    // Saving into a Note that already carries the Source adds nothing twice (the material now links the new Note).
    const again = await generate(eth.id);
    const resaved = await ok(command('material.apply_generation', {generation_id: again.generation_id, target: 'linked'}));
    expect(resaved.note_id).toBe(created.note_id);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM provenance_links WHERE target_type='note' AND target_id=$1`, [created.note_id])).rows[0].n).toBe(1);
    // The Source withdraws external model egress: a draft from the saved Notes alone is refused before any Run.
    await withholdExternalEgress(connection);
    const mit = await statement('MIT');
    await ok(command('material.link_note', {material_id: mit.id, note_id: own}));
    await ok(command('material.add_source', {material_id: mit.id, note_id: created.note_id}));
    const sent = requests.length;
    const refused = await command('material.generate', {material_id: mit.id, requirements: 'Anything'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_egress_denied']);
    expect(requests).toHaveLength(sent);
  });

  it.each(['share', 'oversight'] as const)('a concurrent %s change that commits while the save waits is seen; the draft never enters a Note someone else now reads', async change => {
    const admin = randomUUID();
    if (change === 'oversight') {
      await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [space, member]);
      await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Admin','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [admin]);
      await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'admin','active',now(),now())`, [randomUUID(), space, admin]);
    }
    const own = await note('My statement', 'First attempt.');
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'RACED_DRAFT', verify: [], sources_used: []});
    const g = await generate(material.id);
    // Another session changes who reads the Note, holding the row it changes as its writer does.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (change === 'share') await client.query(`UPDATE space_objects SET visibility='space_shared' WHERE id=$1`, [own]);
      else await client.query(`UPDATE spaces SET oversight_mode='content' WHERE id=$1`, [space]);
      const pid = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const saving = command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'}).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, pid, {settled: () => settled});
      expect(settled).toBe(false);
      await client.query('COMMIT');
      const r = await saving;
      expect([r.statusCode, reason(r)]).toEqual([409, 'note_not_private']);
    } finally { client.release(); }
    expect(await noteRow(own)).toMatchObject({version: 1, plain_text: 'First attempt.'});
  });

  // --- The Job claim, read authority and Source lineage under concurrency (real entries). ---

  /** Another worker takes the Job over (a reclaim), as the queue's reclaim writes the row. */
  const reclaim = (runId: string) => db.pool.query(`UPDATE jobs SET claimed_by='another-worker' WHERE payload_json->>'run_id'=$1`, [runId]);
  const jobOf = async (runId: string) => (await db.pool.query<{claimed_by: string; status: string}>(`SELECT claimed_by,status FROM jobs WHERE payload_json->>'run_id'=$1`, [runId])).rows[0]!;

  it('a provider failure fails the Run under the current claim, and a worker that lost the claim fails nothing', async () => {
    const master = await note('Master CV', 'FACTS');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    // The ordinary case: the provider fails and this worker still holds the Job.
    __setProviderHttpClientForTests({fetch: async (_url: unknown, init?: {body?: unknown}) => { requests.push(String(init?.body ?? '')); return new Response('{}', {status: 500}); }});
    const failed = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    await performQueuedProviderTaskJob(db.pool, config, failed.run_id);
    expect(requests.length).toBeGreaterThan(0);
    expect((await runOf(failed.run_id)).status).toBe('failed');
    // The provider refuses (no retry, so no later send fence) after another worker reclaimed
    // the Job mid-send: the failure is the new owner's to settle.
    let raced = '';
    __setProviderHttpClientForTests({fetch: async (_url: unknown, init?: {body?: unknown}) => { requests.push(String(init?.body ?? '')); await reclaim(raced); return new Response('{"error":{"message":"bad request"}}', {status: 400}); }});
    const lost = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything else'}));
    raced = lost.run_id;
    await performQueuedProviderTaskJob(db.pool, config, lost.run_id);
    expect((await runOf(lost.run_id)).status).toBe('running');
    expect((await jobOf(lost.run_id)).claimed_by).toBe('another-worker');
  });

  it('a preparer refusal fails the Run under the current claim, and a worker that lost the claim fails nothing', async () => {
    const master = await note('Master CV', 'FACTS');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    const first = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    const second = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything else'}));
    // The input leaves the Project, so the preparer's recheck throws before any claim-bound work.
    await db.pool.query('UPDATE space_objects SET primary_project_id=$2 WHERE id=$1', [master, projectB]);
    await performQueuedProviderTaskJob(db.pool, config, first.run_id);
    expect((await runOf(first.run_id)).status).toBe('failed');
    // The same refusal, but the Job is reclaimed the moment this worker claims it.
    const fn = `test_claim_${randomUUID().replace(/-/g, '')}`;
    await db.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE jobs SET claimed_by='another-worker' WHERE id=NEW.id; RETURN NEW; END $$`);
    await db.pool.query(`CREATE TRIGGER ${fn} AFTER UPDATE OF status ON jobs FOR EACH ROW WHEN (NEW.status='running' AND NEW.claimed_by IS DISTINCT FROM 'another-worker' AND NEW.payload_json->>'run_id'='${second.run_id}') EXECUTE FUNCTION ${fn}()`);
    try { await performQueuedProviderTaskJob(db.pool, config, second.run_id); }
    finally { await db.pool.query(`DROP TRIGGER ${fn} ON jobs`); await db.pool.query(`DROP FUNCTION ${fn}()`); }
    expect((await runOf(second.run_id)).status).toBe('queued');
    expect((await jobOf(second.run_id)).claimed_by).toBe('another-worker');
    expect(requests).toEqual([]);
  });

  it('dispatch holds the input Note read: an unshare that commits while it waits is seen and nothing is sent', async () => {
    const theirs = await note('Shared facts', 'UNSHARED_TEXT', {visibility: 'space_shared', project: projectA, owner: member});
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // The Note's owner makes it private again, holding its root as the sharing writer does.
      await client.query(`UPDATE space_objects SET visibility='private' WHERE id=$1`, [theirs]);
      const holder = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const working = performQueuedProviderTaskJob(db.pool, config, started.run_id).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, holder, {settled: () => settled});
      expect(settled).toBe(false);
      await client.query('COMMIT');
      await working;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect(requests).toEqual([]);
    expect((await runOf(started.run_id)).status).toBe('failed');
  });

  /** The member's Project Note, shared to the owner alone by an explicit grant through `content.access.update`. */
  async function grantedToOwner(text: string) {
    const theirs = await note('Granted facts', text, {project: projectA, owner: member});
    await new ContentAccessService(db.pool).updatePolicy({spaceId: space, userId: member}, 'space_object', theirs,
      {visibility: 'selected_users', access_level: 'full', project_id: projectA, grants: [{user_id: owner, access_level: 'full'}]});
    return theirs;
  }
  /** Narrows the owner's grant to summary through `content.access.update` (not a demotion: visibility stays). */
  const narrowGrant = (db_: ConstructorParameters<typeof ContentAccessService>[0], noteId: string) => new ContentAccessService(db_).updatePolicy({spaceId: space, userId: member}, 'space_object', noteId,
    {visibility: 'selected_users', access_level: 'full', project_id: projectA, grants: [{user_id: owner, access_level: 'summary'}]});

  it('dispatch holds an explicitly granted input: a grant change through content.access.update is seen and nothing is sent', async () => {
    const theirs = await grantedToOwner('GRANTED_TEXT');
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // The real authorization writer, inside a transaction this test commits later.
      await narrowGrant(client, theirs);
      const holder = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let settled = false;
      const working = performQueuedProviderTaskJob(db.pool, config, started.run_id).finally(() => { settled = true; });
      await waitForBlockedBy(db.pool, holder, {settled: () => settled});
      expect(settled).toBe(false);
      await client.query('COMMIT');
      await working;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect(requests).toEqual([]);
    expect((await runOf(started.run_id)).status).toBe('failed');
  });

  it('a held content read and content.access.update on the same Note take root then grant, so they never deadlock', async () => {
    const theirs = await grantedToOwner('GRANTED_TEXT');
    // A Notes editor holds the Note root; the grant writer queues on it first, then a reader.
    const editor = await db.pool.connect(), writer = await db.pool.connect(), reader = await db.pool.connect();
    try {
      await editor.query('BEGIN');
      await editor.query('SELECT id FROM space_objects WHERE id=$1 FOR UPDATE', [theirs]);
      await writer.query('BEGIN');
      const writing = narrowGrant(writer, theirs).then(() => writer.query('COMMIT'));
      await waitForLockWaiter(db.pool);
      // The reader holds what the draft fence holds (content read authority) until it commits.
      await reader.query('BEGIN');
      const reading = lockContentReadAuthority(reader, space, 'space_object', theirs, owner)
        .then(async () => (await reader.query<{n: number}>(`SELECT count(*)::int AS n FROM content_access_grants WHERE resource_id=$1 AND grantee_user_id=$2 AND revoked_at IS NULL AND access_level='full'`, [theirs, owner])).rows[0]!.n)
        .finally(() => reader.query('COMMIT'));
      let read = false; void reading.catch(() => undefined).finally(() => { read = true; });
      await waitForLockWaiter(db.pool, {waiters: 2, settled: () => read});
      expect(read).toBe(false);
      await editor.query('COMMIT');
      // Grant before root, the reader would hold the grant the writer must revoke while
      // waiting on the root the writer holds: PostgreSQL would abort one of them.
      await writing;
      expect(await reading).toBe(0);
    } finally {
      for (const c of [editor, writer, reader]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
  });

  it('publication holds the Project read: a membership removal that commits while it waits rejects the result', async () => {
    as(member);
    const own = await note('My facts', 'MEMBER_FACTS', {project: projectA, owner: member});
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: own}));
    const started = await ok(command('material.generate', {material_id: material.id, requirements: 'Anything'}));
    const client = await db.pool.connect();
    let holder = 0;
    // While the provider answers, the Project's owner removes the person, holding the
    // Project as every membership writer does (`lockProjectAudienceForChange`).
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'PUBLISHED_AFTER_REMOVAL', verify: [], sources_used: []});
    __setProviderHttpClientForTests({fetch: async (_url: unknown, init?: {body?: unknown}) => {
      requests.push(String(init?.body ?? ''));
      await client.query('BEGIN');
      await client.query('SELECT id FROM projects WHERE id=$1 FOR NO KEY UPDATE', [projectA]);
      await client.query(`UPDATE project_members SET status='revoked' WHERE project_id=$1 AND user_id=$2`, [projectA, member]);
      holder = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      return openAiChatResponse({choices: [{message: {content: JSON.stringify(reply(''))}}], model: 'test-model', usage: {}});
    }});
    try {
      let settled = false;
      const working = performQueuedProviderTaskJob(db.pool, config, started.run_id).finally(() => { settled = true; });
      await vi.waitUntil(() => holder !== 0 || settled, {timeout: 10_000, interval: 20});
      await waitForBlockedBy(db.pool, holder, {settled: () => settled});
      expect(settled).toBe(false);
      await client.query('COMMIT');
      await working;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect(requests).toHaveLength(1);
    const run = await db.pool.query<{status: string; output_json: unknown}>('SELECT status,output_json FROM runs WHERE id=$1', [started.run_id]);
    expect(run.rows[0]!.status).toBe('failed');
    expect(JSON.stringify(run.rows[0]!.output_json)).not.toContain('PUBLISHED_AFTER_REMOVAL');
  });

  it.each(['registration', 'invitation'] as const)('an oversight admin joining by %s waits for a save that rests on the current readers', async entry => {
    await db.pool.query(`UPDATE space_memberships SET status='removed' WHERE space_id=$1 AND user_id=$2`, [space, member]);
    await db.pool.query(`UPDATE spaces SET oversight_mode='content' WHERE id=$1`, [space]);
    const own = await note('My statement', 'First attempt.');
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'SAVED_BEFORE_JOIN', verify: [], sources_used: []});
    const g = await generate(material.id);
    // An admin invitation to this Space for a new account.
    const admin = randomUUID(), email = `admin-${randomUUID()}@test.invalid`, token = `token-${randomUUID()}`;
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Admin',$2,now(),now(),$3,'system')`, [admin, entry === 'registration' ? 'pending' : 'active', email]);
    await db.pool.query(`INSERT INTO user_invitations (id,space_id,invited_email,role,token_hash,status,invited_by_user_id,created_at,expires_at) VALUES ($1,$2,$3,'admin',$4,'available',$5,now(),now()+interval '1 day')`,
      [randomUUID(), space, email, hashOpaqueToken(token), owner]);
    const registrations = new RegistrationService(db.pool, config);
    const intent = entry === 'registration' ? await registrations.issueIntent({email, invitationToken: token}) : null;
    // A Notes editor holds the Note's content row, so the save waits after it has read the
    // Space's readers (and holds the Space row) but before it writes.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT version FROM notes WHERE object_id=$1 FOR UPDATE', [own]);
      const holder = (await client.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const saving = command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'});
      await waitForBlockedBy(db.pool, holder);
      const save = (await db.pool.query<{pid: number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))`, [holder])).rows[0]!.pid;
      let joined = false;
      const joining = (entry === 'registration'
        ? registrations.complete({intentId: intent!.intentId, claimSecret: intent!.claimSecret, userId: admin})
        : acceptInvitation(db.pool, admin, token)).finally(() => { joined = true; });
      // The new member waits on the save's own Space hold (the save's backend blocks it).
      await waitForBlockedBy(db.pool, save, {settled: () => joined});
      expect(joined).toBe(false);
      await client.query('COMMIT');
      const saved = await saving;
      expect(saved.statusCode, saved.body).toBe(200);
      await joining;
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect((await db.pool.query(`SELECT status FROM space_memberships WHERE space_id=$1 AND user_id=$2`, [space, admin])).rows[0]?.status).toBe('active');
    // Now that the admin reads it, a further private result is refused.
    const again = await generate(material.id);
    const refused = await command('material.apply_generation', {generation_id: again.generation_id, target: 'linked'});
    expect([refused.statusCode, reason(refused)]).toEqual([409, 'note_not_private']);
  });

  it('a saved derived Note keeps its Source policy in detail and history, even after the item is rebound', async () => {
    await personalSpace();
    const master = await note('Master CV', 'SOURCED_FACTS');
    const connection = await sourceLineage(master, owner);
    const item = (await db.pool.query<{source_id: string}>(`SELECT source_id FROM provenance_links WHERE target_id=$1 AND source_type='source_item'`, [master])).rows[0]!.source_id;
    // A manually saved URL of the person's, which `source.item.update` may rebind or clear.
    await db.pool.query(`UPDATE source_items SET metadata_json='{"created_by":"manual_url"}'::jsonb WHERE id=$1`, [item]);
    const material = await statement('ETH Zurich');
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'DERIVED_SOURCED_TEXT', verify: [], sources_used: [{note_id: master, version: 1}]});
    const g = await generate(material.id);
    const {note_id} = await ok(command('material.apply_generation', {generation_id: g.generation_id, target: 'new'}));
    const detail = () => app.inject({method: 'GET', url: `/api/v1/knowledge/notes/${note_id}`});
    const history = () => app.inject({method: 'GET', url: `/api/v1/knowledge/notes/${note_id}/revisions`});
    expect((await detail()).statusCode).toBe(200);
    expect((await history()).body).toContain('DERIVED_SOURCED_TEXT');
    // The item is detached from its Source through the formal operation.
    await ok(app.inject({method: 'PATCH', url: `/api/v1/sources/items/${item}`, headers: {'idempotency-key': randomUUID()}, payload: {connection_id: null}}));
    expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [master])).get(master)).toEqual([]);
    // The derived Note still answers to the Source its text came from.
    expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [note_id])).get(note_id)).toEqual([connection]);
    expect((await detail()).statusCode).toBe(200);
    // The Source is withdrawn (archived): neither body nor history is read any more.
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`, [connection]);
    for (const r of [await detail(), await history()]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('DERIVED_SOURCED_TEXT');
    }
  });

  it('text saved into an existing Project Note answers to its Sources in the Reader notebook and the Project notebook', async () => {
    await personalSpace();
    const master = await note('Master CV', 'SOURCED_FACTS');
    const connection = await sourceLineage(master, owner);
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: own}));
    await ok(command('material.add_source', {material_id: material.id, note_id: master}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: 'DERIVED_PROJECT_TEXT', verify: [], sources_used: [{note_id: master, version: 1}]});
    const g = await generate(material.id);
    await ok(command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'}));
    const notebook = () => app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${own}`});
    const area = new ProjectResearchAreaService(db.pool, config);
    await area.initializeArea({spaceId: space, userId: owner}, projectA);
    const areaNote = async () => (await area.getArea({spaceId: space, userId: owner}, projectA)).notes.find(n => n.id === own)!;
    expect((await notebook()).body).toContain('DERIVED_PROJECT_TEXT');
    expect(await areaNote()).toMatchObject({body_withheld: false});
    // The Source the text came from is withdrawn; the Note's own ACL is unchanged.
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`, [connection]);
    const r = await notebook();
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('DERIVED_PROJECT_TEXT');
    const withheld = await areaNote();
    expect(withheld.body_withheld).toBe(true);
    expect(JSON.stringify(withheld)).not.toContain('DERIVED_PROJECT_TEXT');
    // Ask-AI would rewrite the Note with its body in the prompt: refused as unreadable.
    await expect(area.askAi({spaceId: space, userId: owner}, projectA, {prompt: 'Rewrite', section_key: 'My statement'})).rejects.toMatchObject({statusCode: 404});
  });
  /**
   * Rewrites `target` (a Project Note) from the member's Note derived from the member's own
   * Source, through the real draft save, so `target` inherits that Source lineage. The owner
   * reads the Source as a Space admin; `withdrawAdminRead` takes only that read away, leaving
   * model egress and both Notes' ACLs unchanged.
   */
  async function derivedFromMembersSource(target: string, text: string) {
    const theirs = await note('Shared facts', 'SOURCE_READ_TEXT', {visibility: 'space_shared', project: projectA, owner: member});
    const connection = await sourceLineage(theirs, member);
    const material = await statement('ETH Zurich');
    await ok(command('material.link_note', {material_id: material.id, note_id: target}));
    await ok(command('material.add_source', {material_id: material.id, note_id: theirs}));
    reply = () => ({schema: 'rainver.note_draft.v1', draft: text, verify: [], sources_used: [{note_id: theirs, version: 1}]});
    const g = await generate(material.id);
    await ok(command('material.apply_generation', {generation_id: g.generation_id, target: 'linked'}));
    expect((await noteRow(target)).plain_text).toContain(text);
    const item = (await db.pool.query<{source_id: string}>(`SELECT source_id FROM provenance_links WHERE target_type='note' AND target_id=$1 AND source_type='source_item'`, [theirs])).rows[0]!.source_id;
    requests = [];
    return {connection, item};
  }
  const withdrawAdminRead = (connection: string) => db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_space_admins}','false') WHERE id=$1`, [connection]);
  const owned = {get spaceId() { return space; }, get userId() { return owner; }};
  const jobError = async (runId: string) => (await db.pool.query<{error: string | null}>(`SELECT error FROM jobs WHERE payload_json->>'run_id'=$1`, [runId])).rows[0]?.error ?? '';

  it('Reader notebook annotations answer to the Note\'s Sources: no quote or anchor once the reader loses a Source', async () => {
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const {connection} = await derivedFromMembersSource(own, 'DERIVED_PROJECT_TEXT');
    const annotation = await new PgAnnotationRepository(db.pool).createAnnotation({spaceId: space, userId: owner}, {
      annotation_type: 'highlight', quote_text: 'DERIVED_PROJECT_TEXT', label: 'MARGIN_LABEL', document_type: 'research_notebook', document_id: own,
      anchor_json: {schema_version: 1, quote_text: 'DERIVED_PROJECT_TEXT', text_range: {start: 0, end: 20, unit: 'utf16'}, before_context: '', after_context: 'DERIVED_PROJECT_TEXT_AFTER'},
    });
    const list = () => app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${own}/annotations`});
    const threads = () => app.inject({method: 'GET', url: `/api/v1/reader/annotations/${annotation.id}/threads`});
    expect((await list()).body).toContain('DERIVED_PROJECT_TEXT');
    expect((await threads()).statusCode).toBe(200);
    await withdrawAdminRead(connection);
    for (const r of [await list(), await threads(), await app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${own}/note`})]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('DERIVED_PROJECT_TEXT');
      expect(r.body).not.toContain('MARGIN_LABEL');
    }
  });

  it('a queued ask-AI Run sends nothing once its Note\'s Source no longer admits the person', async () => {
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const {connection} = await derivedFromMembersSource(own, 'DERIVED_PROJECT_TEXT');
    const queued = await new ProjectResearchAreaService(db.pool, config).askAi(owned, projectA, {prompt: 'Rewrite', section_key: 'My statement'});
    await withdrawAdminRead(connection);
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id as string);
    expect(requests).toEqual([]);
    // The worker's recheck refuses the frozen Note before any provider attempt.
    expect(await jobError(queued.run_id as string)).toContain('no longer readable');
    expect((await runOf(queued.run_id as string)).status).not.toBe('succeeded');
    expect((await noteRow(own)).plain_text).toContain('DERIVED_PROJECT_TEXT');
  });

  it('a queued notebook chat sends nothing once a Note in its context no longer has a Source the person reads', async () => {
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const {connection} = await derivedFromMembersSource(own, 'DERIVED_PROJECT_TEXT');
    const queued = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Summarise my statement'});
    expect((await runOf(queued.run_id)).instruction).toContain('DERIVED_PROJECT_TEXT');
    await withdrawAdminRead(connection);
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id);
    expect(requests).toEqual([]);
    // The attempt admission rechecks the frozen Notes and fails the Run before sending.
    expect((await db.pool.query(`SELECT status,error_json->>'error_text' AS error FROM runs WHERE id=$1`, [queued.run_id])).rows[0])
      .toEqual({status: 'failed', error: 'Notebook context is no longer readable'});
    // A new chat leaves that Note's body out of its context altogether.
    const next = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Again'});
    expect((await runOf(next.run_id)).instruction).not.toContain('DERIVED_PROJECT_TEXT');
  });

  it('an ask-AI Run rechecks its Note before every provider attempt: a correction retry after a Source loss sends nothing', async () => {
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const {connection} = await derivedFromMembersSource(own, 'DERIVED_PROJECT_TEXT');
    const queued = await new ProjectResearchAreaService(db.pool, config).askAi(owned, projectA, {prompt: 'Rewrite', section_key: 'My statement'});
    // The first attempt is admitted and sent; while it is answered (with output the schema
    // rejects, which asks for a correction round-trip) the person loses the Note's Source.
    reply = async () => { await withdrawAdminRead(connection); return {not: 'a notebook_update'}; };
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id as string);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('DERIVED_PROJECT_TEXT');
    expect(await jobError(queued.run_id as string)).toContain('no longer readable');
    expect((await runOf(queued.run_id as string)).status).not.toBe('succeeded');
  });

  it('a notebook chat write-back inherits its context Notes\' Sources, so the written Note is withheld once a Source is', async () => {
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const {connection} = await derivedFromMembersSource(own, 'DERIVED_PROJECT_TEXT');
    const target = await note('Scratch', 'Empty.', {project: projectA});
    const queued = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Copy my statement into Scratch'});
    reply = () => ({answer: 'Copied', notebook_update: {note_id: target, new_note_title: null, refs: [], ops: [{op: 'append', index: null, count: null, markdown: 'COPIED_DERIVED_TEXT'}]}});
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id);
    expect((await runOf(queued.run_id)).status).toBe('succeeded');
    expect((await noteRow(target)).plain_text).toContain('COPIED_DERIVED_TEXT');
    const reader = () => app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${target}/note`});
    expect((await reader()).statusCode).toBe(200);
    // Both Notes are the owner's alone; once the owner loses the Source, the copy goes with the original.
    await withdrawAdminRead(connection);
    const after = await reader();
    expect(after.statusCode).toBe(404);
    expect(after.body).not.toContain('COPIED_DERIVED_TEXT');
    const next = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Again'});
    expect((await runOf(next.run_id)).instruction).not.toContain('COPIED_DERIVED_TEXT');
  });

  it('a monitoring comparison never uses a Source-derived baseline, and a queued Run without a frozen baseline sends nothing', async () => {
    await syncBuiltinPrompts(db.pool, join(process.cwd(), '..', 'catalog'));
    const clean = await note('Plain understanding', 'CLEAN_BASELINE_TEXT', {project: projectA});
    const own = await note('My understanding', 'First attempt.', {project: projectA});
    const {item} = await derivedFromMembersSource(own, 'DERIVED_BASELINE_TEXT');
    const role = (noteId: string) => withNoteWrites(db.pool, scope => scope.setProjectRole({spaceId: space, noteId, actor: {system: true}, role: 'understanding', projectId: projectA}));
    const queue = (standing: boolean) => new ProjectResearchMonitorComparisonService(db.pool).queue({
      spaceId: space, userId: owner, projectId: projectA,
      ...(standing ? {standingBatchId: randomUUID()} : {workflowId: randomUUID(), operationId: randomUUID()}),
      resolveProvider: () => new ProjectResearchExecutionProfileService(db.pool, config).resolveProvider(owned, {}),
      researchQuestion: 'What changed?', sourceItemIds: [item],
    });
    // The person reads the derived Note's Source, but the comparison's outputs are Project-shared.
    await role(own);
    for (const standing of [true, false]) expect(await queue(standing)).toEqual({outcome: 'no_baseline', role: 'understanding', reason: 'source_lineage_withheld'});
    // A lineage-free baseline is admitted, frozen and sent.
    await role(clean);
    const sent = await queue(true);
    if (sent.outcome !== 'queued') throw new Error(`comparison not queued: ${sent.outcome}`);
    await performQueuedProviderTaskJob(db.pool, config, sent.runId);
    expect(requests.some(body => body.includes('CLEAN_BASELINE_TEXT'))).toBe(true);
    // A Run queued before the baseline id was frozen cannot prove what it copied: refused unsent.
    // (The worker may first retry the earlier Run, so the legacy body is told apart by its text.)
    await edit(clean, 'LEGACY_BASELINE_TEXT');
    const legacy = await queue(true);
    if (legacy.outcome !== 'queued') throw new Error(`comparison not queued: ${legacy.outcome}`);
    await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,project_research_standing,baseline_note_id}' WHERE id=$1`, [legacy.runId]);
    expect((await runOf(legacy.runId)).instruction).toContain('LEGACY_BASELINE_TEXT');
    await performQueuedProviderTaskJob(db.pool, config, legacy.runId);
    expect(requests.filter(body => body.includes('LEGACY_BASELINE_TEXT'))).toEqual([]);
    expect(await jobError(legacy.runId)).toContain('baseline was not frozen');
    expect((await runOf(legacy.runId)).status).not.toBe('succeeded');
  });

  /** A member's space-shared Project Note whose text comes from the member's own Source (unpinned lineage). */
  async function membersSourcedNote(text: string) {
    const theirs = await note('Shared facts', text, {visibility: 'space_shared', project: projectA, owner: member});
    const connection = await sourceLineage(theirs, member);
    const item = (await db.pool.query<{source_id: string}>(`SELECT source_id FROM provenance_links WHERE target_type='note' AND target_id=$1 AND source_type='source_item'`, [theirs])).rows[0]!.source_id;
    return {theirs, connection, item};
  }
  /** Detaches an item from its Source after a prompt was frozen (as `source.item.update` may): the Note's live lineage no longer names it. */
  const detach = (item: string) => db.pool.query('UPDATE source_items SET connection_id=NULL WHERE id=$1', [item]);
  const itemLineage = async (noteId: string) => (await db.pool.query<{source_id: string; pins: string[] | null}>(
    `SELECT source_id,evidence_json->'source_connection_ids' AS pins FROM provenance_links WHERE target_type='note' AND target_id=$1 AND source_type='source_item' ORDER BY source_id`, [noteId])).rows;

  it('a queued notebook chat checks the Sources its prompt was frozen under: after a detach, losing the original Source sends nothing', async () => {
    const {theirs, connection, item} = await membersSourcedNote('FROZEN_SOURCE_TEXT');
    const queued = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Summarise the shared facts'});
    expect((await runOf(queued.run_id)).instruction).toContain('FROZEN_SOURCE_TEXT');
    await detach(item);
    expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [theirs])).get(theirs)).toEqual([]);
    await withdrawAdminRead(connection);
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id);
    expect(requests).toEqual([]);
    expect((await db.pool.query(`SELECT status,error_json->>'error_text' AS error FROM runs WHERE id=$1`, [queued.run_id])).rows[0])
      .toEqual({status: 'failed', error: 'Notebook context is no longer readable'});
  });

  it('a notebook chat write-back checks the frozen Sources too: a detach and Source loss while answering writes nothing', async () => {
    const {connection, item} = await membersSourcedNote('FROZEN_SOURCE_TEXT');
    const target = await note('Scratch', 'Empty.', {project: projectA});
    const queued = await new ProjectResearchAreaService(db.pool, config).notebookChat(owned, projectA, {message: 'Copy the shared facts into Scratch'});
    reply = async () => {
      await detach(item);
      await withdrawAdminRead(connection);
      return {answer: 'Copied', notebook_update: {note_id: target, new_note_title: null, refs: [], ops: [{op: 'append', index: null, count: null, markdown: 'COPIED_FROZEN_TEXT'}]}};
    };
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id);
    expect(requests).toHaveLength(1);
    expect((await runOf(queued.run_id)).status).not.toBe('succeeded');
    expect((await noteRow(target)).plain_text).not.toContain('COPIED_FROZEN_TEXT');
  });

  it('notebook chat text written from a directly selected excerpt keeps the item\'s Source in new and existing Notes', async () => {
    await personalSpace();
    await syncBuiltinPrompts(db.pool, join(process.cwd(), '..', 'catalog'));
    // The excerpt's Source is the owner's; the Note it was first saved under is outside this Project.
    const connection = await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    const existing = await note('Scratch', 'Empty.', {project: projectA});
    const area = new ProjectResearchAreaService(db.pool, config);
    const chat = async (message: string, update: Record<string, unknown>) => {
      const queued = await area.notebookChat(owned, projectA, {message, source_item_ids: [item]});
      reply = () => ({answer: 'Done', notebook_update: {refs: [item], ops: [{op: 'append', index: null, count: null, markdown: 'EXCERPT_COPY'}], ...update}});
      await performQueuedProviderTaskJob(db.pool, config, queued.run_id);
      expect((await runOf(queued.run_id)).status).toBe('succeeded');
      return queued.run_id;
    };
    await chat('Put the excerpt into Scratch', {note_id: existing, new_note_title: null});
    await chat('Put the excerpt into a new note', {note_id: null, new_note_title: 'Excerpt'});
    const created = (await db.pool.query<{id: string}>(`SELECT id FROM space_objects WHERE space_id=$1 AND title='Excerpt' AND object_type='note'`, [space])).rows[0]!.id;
    for (const written of [existing, created]) {
      expect((await noteRow(written)).plain_text).toContain('EXCERPT_COPY');
      expect(await itemLineage(written)).toEqual([{source_id: item, pins: [connection]}]);
    }
    // A Source-derived Note is never a monitoring baseline: the copy cannot reach shared outputs.
    await withNoteWrites(db.pool, scope => scope.setProjectRole({spaceId: space, noteId: created, actor: {system: true}, role: 'understanding', projectId: projectA}));
    expect(await new ProjectResearchMonitorComparisonService(db.pool).queue({
      spaceId: space, userId: owner, projectId: projectA, standingBatchId: randomUUID(),
      resolveProvider: () => new ProjectResearchExecutionProfileService(db.pool, config).resolveProvider(owned, {}),
      researchQuestion: 'What changed?', sourceItemIds: [item],
    })).toEqual({outcome: 'no_baseline', role: 'understanding', reason: 'source_lineage_withheld'});
    // The pin survives a detach; withdrawing the Source withholds both copies.
    await detach(item);
    await db.pool.query(`UPDATE source_connections SET status='archived' WHERE id=$1`, [connection]);
    for (const written of [existing, created]) {
      const r = await app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${written}/note`});
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain('EXCERPT_COPY');
    }
  });

  it('a queued notebook chat or ask-AI Run that froze no Source of its selected excerpt is refused rather than sent or written', async () => {
    await personalSpace();
    await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const area = new ProjectResearchAreaService(db.pool, config);
    const chat = await area.notebookChat(owned, projectA, {message: 'Use the excerpt', source_item_ids: [item]});
    const ask = await area.askAi(owned, projectA, {prompt: 'Use the excerpt', section_key: 'My statement', source_item_ids: [item]});
    for (const [runId, key] of [[chat.run_id, 'notebook_chat'], [ask.run_id as string, 'research_adhoc']] as const) {
      expect(Object.keys((await db.pool.query<{frozen: Record<string, unknown>}>(`SELECT contract_snapshot_json->'workflow_input_json'->$2->'source_item_connections' AS frozen FROM runs WHERE id=$1`, [runId, key])).rows[0]!.frozen)).toEqual([item]);
      // As a Run queued before the item connections were frozen.
      await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- ARRAY['workflow_input_json',$2,'source_item_connections'] WHERE id=$1`, [runId, key]);
      await performQueuedProviderTaskJob(db.pool, config, runId);
      expect((await runOf(runId)).status).not.toBe('succeeded');
    }
    expect(requests).toEqual([]);
    expect(await jobError(ask.run_id as string)).toContain('were not frozen');
    expect((await noteRow(own)).plain_text).toBe('First attempt.');
  });

  it('an ask-AI edit from a selected excerpt keeps the item\'s Source on the Note', async () => {
    await personalSpace();
    const connection = await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const queued = await new ProjectResearchAreaService(db.pool, config).askAi(owned, projectA, {prompt: 'Use the excerpt', section_key: 'My statement', source_item_ids: [item]});
    reply = () => ({notebook_update: {refs: [item], ops: [{op: 'append', index: null, count: null, markdown: 'ASKED_EXCERPT'}]}});
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id as string);
    expect((await noteRow(own)).plain_text).toContain('ASKED_EXCERPT');
    expect(await itemLineage(own)).toEqual([{source_id: item, pins: [connection]}]);
  });

  /** The owner's own Project Note whose text comes from the member's Source (unpinned lineage), read as a Space admin. */
  async function ownSourcedNote(text: string) {
    const own = await note('My statement', text, {project: projectA});
    const connection = await sourceLineage(own, member);
    const item = (await db.pool.query<{source_id: string}>(`SELECT source_id FROM provenance_links WHERE target_type='note' AND target_id=$1 AND source_type='source_item'`, [own])).rows[0]!.source_id;
    return {own, connection, item};
  }
  const readerNote = (noteId: string) => app.inject({method: 'GET', url: `/api/v1/reader/documents/research_notebook/${noteId}/note`});

  it('a queued ask-AI Run froze its target Note\'s Sources: after a detach, losing the original Source sends nothing', async () => {
    const {own, connection, item} = await ownSourcedNote('TARGET_SOURCE_TEXT');
    const queued = await new ProjectResearchAreaService(db.pool, config).askAi(owned, projectA, {prompt: 'Rewrite', section_key: 'My statement'});
    expect((await runOf(queued.run_id as string)).instruction).toContain('TARGET_SOURCE_TEXT');
    expect((await db.pool.query(`SELECT contract_snapshot_json->'workflow_input_json'->'research_adhoc'->'note_source_connection_ids' AS ids FROM runs WHERE id=$1`, [queued.run_id])).rows[0]!.ids).toEqual([connection]);
    await detach(item);
    expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [own])).get(own)).toEqual([]);
    await withdrawAdminRead(connection);
    await performQueuedProviderTaskJob(db.pool, config, queued.run_id as string);
    expect(requests).toEqual([]);
    expect(await jobError(queued.run_id as string)).toContain('no longer readable');
    // A Run queued before the target Note's Sources were frozen is refused unsent.
    await db.pool.query(`UPDATE source_items SET connection_id=$2 WHERE id=$1`, [item, connection]);
    await db.pool.query(`UPDATE source_connections SET consent_json=jsonb_set(consent_json,'{allow_space_admins}','true') WHERE id=$1`, [connection]);
    const legacy = await new ProjectResearchAreaService(db.pool, config).askAi(owned, projectA, {prompt: 'LEGACY_REWRITE', section_key: 'My statement'});
    await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,research_adhoc,note_source_connection_ids}' WHERE id=$1`, [legacy.run_id]);
    await performQueuedProviderTaskJob(db.pool, config, legacy.run_id as string);
    // (The worker may first retry the earlier Run, now admissible again; the legacy body is told apart by its prompt.)
    expect(requests.filter(body => body.includes('LEGACY_REWRITE'))).toEqual([]);
    expect(await jobError(legacy.run_id as string)).toContain('were not frozen');
  });

  it('research.ask_ai holds its target Note\'s lineage: a source.item.update detach waits, and the body and frozen Sources agree', async () => {
    const {own, connection, item} = await ownSourcedNote('RACED_TARGET_TEXT');
    // A manually saved URL item, which the real source.item.update entry may detach.
    await db.pool.query(`UPDATE source_items SET item_type='external_url',metadata_json=jsonb_set(COALESCE(metadata_json,'{}'::jsonb),'{created_by}','"manual_url"') WHERE id=$1`, [item]);
    const holder = await db.pool.connect();
    let asked: Awaited<ReturnType<typeof app.inject>> | undefined, detached: Awaited<ReturnType<typeof app.inject>> | undefined;
    try {
      await holder.query('BEGIN');
      // Pauses ask-AI after its target body is read and before its Run is written: only
      // lockProjectAudience there holds every Project member's row, not just the requester's.
      await holder.query('SELECT id FROM project_members WHERE project_id=$1 AND user_id=$2 FOR NO KEY UPDATE', [projectA, member]);
      const holderPid = (await holder.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      as(owner);
      let askSettled = false;
      const asking = action('research.ask_ai', {project_id: projectA, prompt: 'Rewrite', section_key: 'My statement'}).then(r => { asked = r; }).finally(() => { askSettled = true; });
      await waitForBlockedBy(db.pool, holderPid, {settled: () => askSettled});
      expect(askSettled).toBe(false);
      // The item's owner detaches it through the real entry while ask-AI is mid-admission.
      as(member);
      let detachSettled = false;
      const detaching = app.inject({method: 'PATCH', url: `/api/v1/sources/items/${item}`, headers: {'idempotency-key': randomUUID()}, payload: {connection_id: null}})
        .then(r => { detached = r; }).finally(() => { detachSettled = true; });
      await waitForLockWaiter(db.pool, {settled: () => detachSettled, waiters: 2});
      // The detach cannot commit between the body read and the freeze.
      expect(detachSettled, detached?.body).toBe(false);
      await holder.query('COMMIT');
      await Promise.all([asking, detaching]);
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); as(owner); }
    expect(asked!.statusCode, asked!.body).toBe(201);
    expect(detached!.statusCode, detached!.body).toBe(200);
    const runId = asked!.json().data.run_id as string;
    expect((await runOf(runId)).instruction).toContain('RACED_TARGET_TEXT');
    expect((await db.pool.query(`SELECT contract_snapshot_json->'workflow_input_json'->'research_adhoc'->'note_source_connection_ids' AS ids FROM runs WHERE id=$1`, [runId])).rows[0]!.ids).toEqual([connection]);
    expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [own])).get(own)).toEqual([]);
    // The frozen Source still answers for the copied body after the detach.
    await withdrawAdminRead(connection);
    await performQueuedProviderTaskJob(db.pool, config, runId);
    expect(requests).toEqual([]);
    expect(await jobError(runId)).toContain('no longer readable');
  });

  it.each(['ask', 'chat'] as const)('an in-place %s edit keeps the target Note\'s frozen Sources after a detach', async (via) => {
    const area = new ProjectResearchAreaService(db.pool, config);
    {
      const {own, connection, item} = await ownSourcedNote(`IN_PLACE_${via}_SOURCE`);
      const queued = via === 'ask'
        ? await area.askAi(owned, projectA, {prompt: 'Rewrite', section_key: 'My statement'})
        : await area.notebookChat(owned, projectA, {message: 'Extend my statement'});
      const markdown = `IN_PLACE_${via}_EDIT`;
      // The item is detached while the model answers: the Note's live lineage no longer names the Source.
      reply = async () => {
        await detach(item);
        return via === 'ask'
          ? {notebook_update: {refs: [], ops: [{op: 'append', index: null, count: null, markdown}]}}
          : {answer: 'Done', notebook_update: {note_id: own, new_note_title: null, refs: [], ops: [{op: 'append', index: null, count: null, markdown}]}};
      };
      await performQueuedProviderTaskJob(db.pool, config, queued.run_id as string);
      expect((await noteRow(own)).plain_text).toContain(markdown);
      expect((await loadSourceConnectionIdsForTargets(db.pool, space, 'note', [own])).get(own)).toEqual([connection]);
      await withdrawAdminRead(connection);
      const r = await readerNote(own);
      expect(r.statusCode).toBe(404);
      expect(r.body).not.toContain(markdown);
    }
  });

  it('a notebook follow-up leaves out an earlier turn whose Run froze no Source evidence instead of back-filling today\'s', async () => {
    await personalSpace();
    await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    const area = new ProjectResearchAreaService(db.pool, config);
    const contextOf = async (runId: string) => (await db.pool.query<{context: Record<string, unknown>}>(`SELECT contract_snapshot_json->'workflow_input_json'->'notebook_chat' AS context FROM runs WHERE id=$1`, [runId])).rows[0]!.context;
    for (const legacy of [true, false]) {
      const first = await area.notebookChat(owned, projectA, {message: 'Use the excerpt', source_item_ids: [item]});
      reply = () => ({answer: 'PRIOR_ANSWER_FROM_EXCERPT', notebook_update: {note_id: null, new_note_title: null, refs: [], ops: []}});
      await performQueuedProviderTaskJob(db.pool, config, first.run_id);
      expect((await runOf(first.run_id)).status).toBe('succeeded');
      // As a turn answered before the item connections were frozen.
      if (legacy) await db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,notebook_chat,source_item_connections}' WHERE id=$1`, [first.run_id]);
      const next = await area.notebookChat(owned, projectA, {message: 'And then?', session_id: first.session_id});
      const context = await contextOf(next.run_id);
      if (legacy) {
        expect((await runOf(next.run_id)).instruction).not.toContain('PRIOR_ANSWER_FROM_EXCERPT');
        expect(context.source_item_ids).toEqual([]);
        expect(context.source_item_connections).toEqual({});
      } else {
        // Control: a turn with complete freeze evidence is carried forward with its frozen Sources.
        expect((await runOf(next.run_id)).instruction).toContain('PRIOR_ANSWER_FROM_EXCERPT');
        expect(context.source_item_ids).toEqual([item]);
      }
    }
  });

  it('a notebook follow-up leaves out an earlier answer with no Run on its row, even one naming its Run only in metadata', async () => {
    await personalSpace();
    await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    const area = new ProjectResearchAreaService(db.pool, config);
    const first = await area.notebookChat(owned, projectA, {message: 'Use the excerpt', source_item_ids: [item]});
    reply = () => ({answer: 'PROVEN_ANSWER', notebook_update: {note_id: null, new_note_title: null, refs: [], ops: []}});
    await performQueuedProviderTaskJob(db.pool, config, first.run_id);
    // As older synchronous turns left them: an answer whose Run is kept only in metadata, and one with none.
    const sessions = new PgSessionRepository(db.pool);
    await sessions.addMessage(space, owner, first.session_id, {role: 'user', content: 'OLD_QUESTION'});
    const legacy = await sessions.addMessage(space, owner, first.session_id, {role: 'assistant', content: 'METADATA_ONLY_ANSWER'});
    await db.pool.query(`UPDATE messages SET metadata_json=jsonb_build_object('run_id',$2::text) WHERE id=$1`, [legacy!.id, first.run_id]);
    await sessions.addMessage(space, owner, first.session_id, {role: 'assistant', content: 'UNATTRIBUTED_ANSWER'});
    const next = await area.notebookChat(owned, projectA, {message: 'And then?', session_id: first.session_id});
    const instruction = (await runOf(next.run_id)).instruction;
    expect(instruction).not.toContain('METADATA_ONLY_ANSWER');
    expect(instruction).not.toContain('UNATTRIBUTED_ANSWER');
    // The person's own words and the answer whose row names its proven Run stay.
    expect(instruction).toContain('OLD_QUESTION');
    expect(instruction).toContain('PROVEN_ANSWER');
  });

  it('a summary-level reader of a selected item never copies, sends or writes its excerpt', async () => {
    // The owner's own Source; the item in it is the member's, shared with the Space.
    await sourceLineage(await note('Elsewhere', 'Unrelated.'), owner);
    const item = (await db.pool.query<{id: string}>(`SELECT pcis.source_item_id AS id FROM project_corpus_item_sources pcis WHERE pcis.project_id=$1`, [projectA])).rows[0]!.id;
    await db.pool.query(`UPDATE source_items SET excerpt='SUMMARY_ONLY_EXCERPT',owner_user_id=$2 WHERE id=$1`, [item, member]);
    const own = await note('My statement', 'First attempt.', {project: projectA});
    const area = new ProjectResearchAreaService(db.pool, config);
    const summaryOnly = () => db.pool.query(`UPDATE source_items SET access_level='summary' WHERE id=$1`, [item]);
    // Queued while the owner reads the item in full; narrowed to summary before the attempt.
    const ask = await area.askAi(owned, projectA, {prompt: 'Use the excerpt', section_key: 'My statement', source_item_ids: [item]});
    const chat = await area.notebookChat(owned, projectA, {message: 'Use the excerpt', source_item_ids: [item]});
    for (const runId of [ask.run_id as string, chat.run_id]) expect((await runOf(runId)).instruction).toContain('SUMMARY_ONLY_EXCERPT');
    await summaryOnly();
    for (const runId of [ask.run_id as string, chat.run_id]) {
      await performQueuedProviderTaskJob(db.pool, config, runId);
      expect((await runOf(runId)).status).not.toBe('succeeded');
    }
    expect(requests).toEqual([]);
    // A new request at summary level copies nothing of the item into the prompt.
    const later = await area.askAi(owned, projectA, {prompt: 'Use the excerpt', section_key: 'My statement', source_item_ids: [item]});
    const laterChat = await area.notebookChat(owned, projectA, {message: 'Use the excerpt', source_item_ids: [item]});
    for (const runId of [later.run_id as string, laterChat.run_id]) expect((await runOf(runId)).instruction).not.toContain('SUMMARY_ONLY_EXCERPT');
    expect((await noteRow(own)).plain_text).toBe('First attempt.');
  });

  it('an already terminal standing comparison whose baseline was not frozen or is now Source-derived is never merged', async () => {
    await syncBuiltinPrompts(db.pool, join(process.cwd(), '..', 'catalog'));
    const clean = await note('Plain understanding', 'CLEAN_BASELINE_TEXT', {project: projectA});
    const own = await note('My understanding', 'First attempt.', {project: projectA});
    const {item} = await derivedFromMembersSource(own, 'DERIVED_BASELINE_TEXT');
    await withNoteWrites(db.pool, scope => scope.setProjectRole({spaceId: space, noteId: clean, actor: {system: true}, role: 'understanding', projectId: projectA}));
    reply = () => ({comparisons: [{source_item_id: item, stance: 'contradicts', detail: 'MERGED_DETAIL', affected_sections: ['understanding']}]});
    const cards = async () => (await db.pool.query(`SELECT 1 FROM research_evidence_cards WHERE project_id=$1 AND source_item_id=$2`, [projectA, item])).rows.length;
    const batchStatus = async (batch: string) => (await db.pool.query<{status: string; error: string | null}>('SELECT status,error FROM project_research_standing_batches WHERE id=$1', [batch])).rows[0]!;
    /** A standing batch whose Run is sent and finishes; `tamper` runs before the production worker performs its merge Job. */
    const finished = async (tamper: (runId: string) => Promise<unknown>) => {
      const batch = randomUUID();
      const queued = await new ProjectResearchMonitorComparisonService(db.pool).queue({
        spaceId: space, userId: owner, projectId: projectA, standingBatchId: batch,
        resolveProvider: () => new ProjectResearchExecutionProfileService(db.pool, config).resolveProvider(owned, {}),
        researchQuestion: 'What changed?', sourceItemIds: [item],
      });
      if (queued.outcome !== 'queued') throw new Error(`comparison not queued: ${queued.outcome}`);
      await db.pool.query(`INSERT INTO project_research_standing_batches (id,space_id,project_id,status,source_item_ids_json,window_started_at,ready_at,run_id,created_at,updated_at) VALUES ($1,$2,$3,'running',$4::jsonb,now(),now(),$5,now(),now())`,
        [batch, space, projectA, JSON.stringify([item]), queued.runId]);
      await performQueuedProviderTaskJob(db.pool, config, queued.runId);
      expect((await runOf(queued.runId)).status).toBe('succeeded');
      await tamper(queued.runId);
      const worker = new JobWorker(new PgJobQueueRepository(db.pool), buildJobHandlerRegistry(config), `test-worker-${randomUUID()}`, [STANDING_COMPARISON_RECONCILE_JOB_TYPE]);
      while ((await worker.processOne()).status !== 'idle');
      return batch;
    };
    // A Run sent before `baseline_note_id` was frozen (the worker's redelivery reaches the merge).
    const legacy = await finished(runId => db.pool.query(`UPDATE runs SET contract_snapshot_json=contract_snapshot_json #- '{workflow_input_json,project_research_standing,baseline_note_id}' WHERE id=$1`, [runId]));
    expect(await batchStatus(legacy)).toEqual({status: 'failed', error: 'Standing comparison baseline was not frozen'});
    expect(await cards()).toBe(0);
    // A baseline that is Source-derived by the time the result would be merged.
    const derived = await finished(() => db.pool.query(`INSERT INTO provenance_links(id,space_id,target_type,target_id,source_type,source_id,created_at) VALUES($1,$2,'note',$3,'source_item',$4,now())`, [randomUUID(), space, clean, item]));
    expect(await batchStatus(derived)).toEqual({status: 'failed', error: 'Standing comparison baseline is no longer admissible'});
    expect(await cards()).toBe(0);
    // Control: the same comparison against a still-admissible baseline is merged.
    const fresh = await note('Fresh understanding', 'FRESH_BASELINE_TEXT', {project: projectA});
    await withNoteWrites(db.pool, scope => scope.setProjectRole({spaceId: space, noteId: fresh, actor: {system: true}, role: 'understanding', projectId: projectA}));
    const merged = await finished(async () => undefined);
    expect((await batchStatus(merged)).status).toBe('completed');
    expect(await cards()).toBe(1);
  });
});
