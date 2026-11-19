import {operationPackageIdentity} from '../src/modules/plugins/packageIdentity.js';
import {randomUUID} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {beforeAll, beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {z} from 'zod';
import {PluginOperationManifestSchema, type PluginOperationId, type RainverPlugin, type PluginOperationManifest} from '@rainver/protocol';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {provisionPluginRoles, pluginRoleNames} from '../src/modules/plugins/operationDb.js';
import {withTransaction} from '../src/db/tx.js';
import {withQueryableTransaction} from '../src/modules/routeUtils/common.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedSpaceOwnerProject, seedRun} from './support/domainSeeds.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {pluginRepository} from '../src/modules/plugins/repository.js';
import {pluginService, pluginServiceFor} from '../src/modules/plugins/service.js';
import {operationPluginEnabled} from '../src/modules/plugins/operationEnablement.js';
import {pluginToolMeta} from '../src/modules/plugins/dataAccess.js';
import {SystemActionDispatcher} from '../src/modules/systemActions/systemActionDispatcher.js';
import {buildRunToolGrants} from '../src/modules/systemActions/runToolGrants.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import type {AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {ContentAccessAuditService} from '../src/modules/contentAccess/audit.js';
import {insertKnowledgeItem} from './support/knowledgeFixtures.js';
import {RetrievalProjectionService} from '../src/modules/retrieval/projectionService.js';
import {knowledgeRetrievalRegistry} from '../src/modules/knowledge/retrievalAdapter.js';

/**
 * ADR 0030 typed core-object ports, consumed by a fixture plugin through the
 * real P1 entries (person HTTP and Agent tool transport) on real PostgreSQL.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'port_probe';
const opId = `plugin.${pid}.application.create` as PluginOperationId;
const listId = `plugin.${pid}.application.list` as PluginOperationId;
const ref = z.object({type: z.enum(['task', 'artifact', 'space_object']), id: z.string()}).strict();
const manifest: PluginOperationManifest = {
  id: pid, version: '1.0.0', hostApi: 1, scope: 'space', name: 'Port probe', description: 'Core port fixture', requires: [],
  permissions: {agent: true}, data_access: 'caller_owned', entities: [{name: 'application'}],
  core_ports: ['tasks.create', 'relations.person.create', 'memory.propose', 'artifacts.create', 'references.resolve'],
  operations: [
    {id: opId, version: 1, title: 'Create', description: 'Create an application with core objects', kind: 'command', side_effects: 'durable', data_class: 'non_sensitive',
      input_schema: z.object({project_id: z.string(), fail_after: z.boolean().default(false), artifact_project_id: z.string().optional(), only_artifact: z.boolean().default(false), only_task: z.boolean().default(false), resolve: ref.optional()}).strict(),
      output_schema: z.object({task_id: z.string().nullable(), person_id: z.string().nullable(), proposal_id: z.string().nullable(), artifact_id: z.string()}).strict(), gate_class: null},
    {id: listId, version: 1, title: 'List', description: 'Resolve references', kind: 'query', side_effects: 'none', data_class: 'non_sensitive',
      input_schema: z.object({refs: z.array(ref).default([])}).strict(), output_schema: z.object({items: z.array(z.object({id: z.string(), title: z.string().nullable()}).strict())}).strict(), gate_class: null},
  ],
};
const plugin: RainverPlugin = {
  id: pid, version: '1.0.0', operationManifest: manifest,
  activate(ctx) {
    ctx.actions!.register(opId, async (input, {db: pdb, actor, core}) => {
      const i = input as {project_id: string; fail_after: boolean; artifact_project_id?: string; only_artifact: boolean; only_task: boolean; resolve?: {type: 'task'; id: string}};
      if (i.resolve) await core!.references!.resolve(i.resolve);
      if (i.only_task) {
        const task = await core!.tasks!.create({project_id: i.project_id, title: 'Submit SoP'});
        return {task_id: task.task_id, person_id: null, proposal_id: null, artifact_id: 'none'};
      }
      const task = i.only_artifact ? null : await core!.tasks!.create({project_id: i.project_id, title: 'Submit SoP', due_at: '2027-01-15T00:00:00.000Z'});
      const person = i.only_artifact ? null : await core!.relations!.createPerson({project_id: i.project_id, title: 'Prof. Example'});
      const proposal = i.only_artifact ? null : await core!.memory!.propose({title: 'Research interest', content: 'Interested in robust control'});
      const artifact = await core!.artifacts!.create({project_id: i.artifact_project_id ?? i.project_id, title: 'Application summary', content: '# Summary\nSoP due in January.'});
      await pdb.transaction({spaceId: actor.space_id, userId: actor.on_behalf_of_user_id!}, tx => withQueryableTransaction(tx, j => j.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2)", [artifact.artifact_id, 'application'])));
      if (i.fail_after) throw new Error('injected failure after core writes');
      return {task_id: task?.task_id ?? null, person_id: person?.object_id ?? null, proposal_id: proposal?.proposal_id ?? null, artifact_id: artifact.artifact_id};
    });
    ctx.actions!.register(listId, async (input, {core}) => {
      const items = [];
      for (const r of (input as {refs: {type: 'task'; id: string}[]}).refs) items.push({id: r.id, title: (await core!.references!.resolve(r))?.title ?? null});
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
async function addMember(user: string, projectMember = true) {
  await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Member','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [user]);
  await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, user]);
  if (projectMember) await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, project, user]);
}
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); member = randomUUID(); project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project, spaceType: 'team'});
  await addMember(member);
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await pluginRepository.upsertInstall(db.pool, {pluginId: pid, installedVersion: '1.0.0', source: 'local', manifest: {operation_api: 1, operation_contract: operationPackageIdentity(plugin)}, actorUserId: owner});
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  __setAuthIdentityForTests({spaceId: space, userId: owner});
});
afterEach(async () => { vi.restoreAllMocks(); __setAuthIdentityForTests(null); await app?.close(); });
const as = (user: string, spaceId = space) => __setAuthIdentityForTests({spaceId, userId: user});
const create = (payload: Record<string, unknown>, key = randomUUID()) => app.inject({method: 'POST', url: `/api/v1/actions/${opId}`, headers: {'idempotency-key': key}, payload});
const list = (refs: {type: string; id: string}[]) => app.inject({method: 'GET', url: `/api/v1/queries/${listId}?input=${encodeURIComponent(JSON.stringify({refs}))}`});
const counts = async () => (await db.pool.query(`SELECT
  (SELECT count(*)::int FROM tasks WHERE space_id=$1 AND title='Submit SoP') AS tasks,
  (SELECT count(*)::int FROM space_objects WHERE space_id=$1 AND title='Prof. Example') AS people,
  (SELECT count(*)::int FROM proposals WHERE space_id=$1 AND proposal_type='memory_create') AS proposals,
  (SELECT count(*)::int FROM memory_entries WHERE space_id=$1) AS memories,
  (SELECT count(*)::int FROM artifacts WHERE space_id=$1 AND artifact_type='plugin_output') AS artifacts,
  (SELECT count(*)::int FROM plugin_${pid}.records WHERE space_id=$1) AS records`, [space])).rows[0];
const empty = {tasks: 0, people: 0, proposals: 0, memories: 0, artifacts: 0, records: 0};
async function agentRun(input: {user: string; project?: string | null; session?: string | null; origin?: string}) {
  const runId = randomUUID();
  await seedRun(db.pool, {id: runId, space, owner: input.user, agent: randomUUID(), version: randomUUID()});
  await db.pool.query(`UPDATE runs SET status='running',trigger_origin=$5,instructed_by_user_id=$2,owner_user_id=$2,visibility='private',project_id=$3,session_id=$4,permission_snapshot_json=$6::jsonb WHERE id=$1`,
    [runId, input.user, input.project ?? null, input.session ?? null, input.origin ?? 'manual', JSON.stringify({tool_grants: [{action_id: opId}, {action_id: listId}]})]);
  await db.pool.query(`INSERT INTO run_attempts(id,space_id,run_id,attempt_number,status,created_at,updated_at) VALUES ($1,$2,$3,1,'running',now(),now())`, [randomUUID(), space, runId]);
  return runId;
}
const call = async (runId: string, name: string, args: Record<string, unknown>, key = randomUUID()) => {
  const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
  return (await new CliAgentToolTransport(config, {actionEventSink: async () => {}}).call(run, {id: key, name, arguments: args})) as OperationToolResponse;
};
async function sharedRoom(users: string[]) {
  const room = randomUUID(), session = randomUUID();
  await db.pool.query(`INSERT INTO rooms (id,space_id,project_id,created_by_user_id,title,status,created_at,updated_at,is_mainline) VALUES ($1,$2,$3,$4,'Pair','active',now(),now(),false)`, [room, space, project, users[0]]);
  for (const user of users) await db.pool.query(`INSERT INTO room_user_members (id,space_id,room_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',now(),now())`, [randomUUID(), space, room, user]);
  await db.pool.query(`INSERT INTO sessions (id,space_id,room_id,project_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'active',now(),now())`, [session, space, room, project]);
  return session;
}
const taskOf = async (user: string, visibility: 'private' | 'space_shared') => {
  as(user);
  const made = await create({project_id: project});
  expect(made.statusCode, made.body).toBe(200);
  as(owner);
  const taskId = made.json().data.task_id as string;
  await db.pool.query(`UPDATE tasks SET visibility=$2,owner_user_id=$3 WHERE id=$1`, [taskId, visibility, user]);
  return taskId;
};

describe('plugin typed core-object ports', () => {
  it('writes Task, Relation, Memory proposal, Artifact and the plugin row atomically through canonical owners; replays once', async () => {
    const key = randomUUID();
    const first = await create({project_id: project}, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(await counts()).toEqual({tasks: 1, people: 1, proposals: 1, memories: 0, artifacts: 1, records: 1});
    expect((await db.pool.query('SELECT project_id FROM tasks WHERE id=$1', [first.json().data.task_id])).rows[0].project_id).toBe(project);
    expect((await db.pool.query('SELECT project_id,owner_user_id,visibility,run_id,surface_role,canonical_format FROM artifacts WHERE id=$1', [first.json().data.artifact_id])).rows[0])
      .toEqual({project_id: project, owner_user_id: owner, visibility: 'private', run_id: null, surface_role: 'user_output', canonical_format: 'markdown'});
    // Policy decisions are recorded for each nested canonical write, the Artifact under its own action.
    expect((await db.pool.query(`SELECT action FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'via_plugin_core_port'='true' ORDER BY action`, [space])).rows.map(r => r.action))
      .toEqual(['artifact.plugin_create', 'relation.write', 'task.create']);
    expect((await create({project_id: project}, key)).json()).toEqual(first.json());
    expect(await counts()).toEqual({tasks: 1, people: 1, proposals: 1, memories: 0, artifacts: 1, records: 1});
  });

  it('rolls every core write back on failure and refuses another Space, a Project the person cannot write, and references inside a command', async () => {
    expect((await create({project_id: project, fail_after: true})).statusCode).toBe(500);
    expect(await counts()).toEqual(empty);
    const otherSpace = randomUUID(), otherOwner = randomUUID(), otherProject = randomUUID();
    await seedSpaceOwnerProject(db.pool, {space: otherSpace, owner: otherOwner, project: otherProject});
    expect((await create({project_id: otherProject})).statusCode).toBe(404);
    // Same Space, a Project the member cannot write: the Artifact port refuses and every earlier write rolls back.
    const closed = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Closed','active',now(),now())`, [closed, space, owner]);
    as(member);
    expect((await create({project_id: project, artifact_project_id: closed})).statusCode).toBe(404);
    expect(await counts()).toEqual(empty);
    // References resolve only in queries, where the release gate rechecks them.
    as(owner);
    const own = await taskOf(owner, 'private');
    expect((await create({project_id: project, resolve: {type: 'task', id: own}})).statusCode).toBe(404);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1`, [space])).rows[0].n).toBe(1);
  });

  it('resolves a reference only for what the person reads now; another person\'s readable object is a B11 read', async () => {
    const mine = await taskOf(owner, 'private');
    const theirsPrivate = await taskOf(member, 'private');
    const theirsShared = await taskOf(member, 'space_shared');
    const response = await list([{type: 'task', id: mine}, {type: 'task', id: theirsPrivate}, {type: 'task', id: theirsShared}, {type: 'task', id: randomUUID()}]);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items.map((i: {title: string | null}) => i.title)).toEqual(['Submit SoP', null, 'Submit SoP', null]);
    expect((await db.pool.query(`SELECT resource_id,viewer_user_id,access_type FROM content_access_logs WHERE space_id=$1 AND access_type='plugin_reference'`, [space])).rows)
      .toEqual([{resource_id: theirsShared, viewer_user_id: owner, access_type: 'plugin_reference'}]);
    // A person's own read is never recorded as an Agent read.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE space_id=$1`, [space])).rows[0].n).toBe(0);
  });

  it('gives an Agent a reference only inside its Project and only what every current reader of its output can read', async () => {
    const mine = await taskOf(owner, 'private');
    const shared = await taskOf(owner, 'space_shared');
    const elsewhere = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Elsewhere','active',now(),now())`, [elsewhere, space, owner]);
    const foreignProject = await taskOf(owner, 'private');
    await db.pool.query(`UPDATE tasks SET project_id=$2 WHERE id=$1`, [foreignProject, elsewhere]);
    // Owner-only Run in this Project: own private and shared Tasks resolve, another Project's does not.
    const solo = await agentRun({user: owner, project});
    const soloRead = await call(solo, listId, {refs: [{type: 'task', id: mine}, {type: 'task', id: shared}, {type: 'task', id: foreignProject}]});
    expect(soloRead.httpStatus, JSON.stringify(soloRead.body)).toBe(200);
    expect((soloRead.body.data as {items: {title: string | null}[]}).items.map(i => i.title)).toEqual(['Submit SoP', 'Submit SoP', null]);
    // Same-owner Agent attribution and taint commit before release; no content in the log.
    const logs = (await db.pool.query(`SELECT resource_type,resource_ids_json,action_id FROM agent_data_read_logs WHERE run_id=$1 ORDER BY resource_type`, [solo])).rows;
    expect(logs).toEqual([
      {resource_type: `plugin.${pid}`, resource_ids_json: [foreignProject, mine, shared].sort(), action_id: listId},
      {resource_type: 'task', resource_ids_json: [mine, shared].sort(), action_id: 'plugin.core.references.resolve'},
    ]);
    expect(JSON.stringify(logs)).not.toContain('Submit SoP');
    expect((await db.pool.query(`SELECT context_taint_json->>'narrowest_visibility' AS v FROM runs WHERE id=$1`, [solo])).rows[0].v).toBe('private');
    // A two-person Room: the speaker's private Task is not readable by the other reader and is withheld; the shared one resolves.
    const roomRun = await agentRun({user: owner, project, session: await sharedRoom([owner, member])});
    const roomRead = await call(roomRun, listId, {refs: [{type: 'task', id: mine}, {type: 'task', id: shared}]});
    expect(roomRead.httpStatus, JSON.stringify(roomRead.body)).toBe(200);
    expect((roomRead.body.data as {items: {title: string | null}[]}).items.map(i => i.title)).toEqual([null, 'Submit SoP']);
    // An Agent whose own access is bound to another Project resolves nothing here.
    const isolated = await agentRun({user: owner, project});
    await db.pool.query(`UPDATE agents SET access_project_id=$2 WHERE id=(SELECT agent_id FROM runs WHERE id=$1)`, [isolated, elsewhere]);
    expect(((await call(isolated, listId, {refs: [{type: 'task', id: shared}]})).body.data as {items: {title: string | null}[]}).items[0]!.title).toBeNull();
  });

  it('lets an Agent create an Artifact only in its Run Project from a person\'s own turn, attributed to the Run', async () => {
    const run = await agentRun({user: owner, project});
    const made = await call(run, opId, {project_id: project, only_artifact: true});
    expect(made.httpStatus, JSON.stringify(made.body)).toBe(200);
    expect((await db.pool.query('SELECT run_id,trust_level,visibility FROM artifacts WHERE id=$1', [(made.body.data as {artifact_id: string}).artifact_id])).rows[0]).toEqual({run_id: run, trust_level: 'low', visibility: 'private'});
    const elsewhere = randomUUID();
    await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Elsewhere','active',now(),now())`, [elsewhere, space, owner]);
    expect((await call(run, opId, {project_id: project, only_artifact: true, artifact_project_id: elsewhere})).httpStatus).toBe(404);
    const scheduled = await agentRun({user: owner, project, origin: 'automation'});
    expect((await call(scheduled, opId, {project_id: project, only_artifact: true})).httpStatus).not.toBe(200);
    // After a sensitive plugin read, the egress invariant refuses the Artifact write.
    await db.pool.query(`UPDATE runs SET context_taint_json='{"schema_version":1,"narrowest_visibility":"private","input_owner_user_ids":[],"non_instructing_owner_user_ids":[],"personal_memory_grant_ids":[],"plugin_reads":[{"plugin_id":"x","data_class":"sensitive"}]}'::jsonb WHERE id=$1`, [run]);
    expect((await call(run, opId, {project_id: project, only_artifact: true})).httpStatus).toBe(404);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM artifacts WHERE space_id=$1 AND artifact_type='plugin_output'`, [space])).rows[0].n).toBe(1);
  });

  it('attributes Agent reads released outside the executor (retrieval, runtime context) to the Run; a failed audit releases nothing', async () => {
    const mine = await taskOf(owner, 'private');
    const theirs = await taskOf(member, 'space_shared');
    const run = await agentRun({user: owner, project});
    const agent = (await db.pool.query<{agent_id: string}>('SELECT agent_id FROM runs WHERE id=$1', [run])).rows[0]!.agent_id;
    const audit = (input: {runId?: string | null; actionId?: string | null}) => new ContentAccessAuditService(db.pool).recordReads({
      spaceId: space, resourceType: 'task', resourceIds: [mine, theirs], viewerUserId: owner, agentId: agent, accessType: 'context_injection', reason: 'runtime context retrieval', ...input,
    });
    await audit({runId: run, actionId: 'runtime_context.retrieval'});
    // B11 keeps only the cross-person row; the same-owner row goes to the owner's Agent read log, ids only.
    expect((await db.pool.query(`SELECT resource_id FROM content_access_logs WHERE space_id=$1 AND access_type='context_injection'`, [space])).rows).toEqual([{resource_id: theirs}]);
    expect((await db.pool.query(`SELECT owner_user_id,resource_ids_json,action_id FROM agent_data_read_logs WHERE run_id=$1`, [run])).rows)
      .toEqual([{owner_user_id: owner, resource_ids_json: [mine], action_id: 'runtime_context.retrieval'}]);
    // A person's own read (no Run) is never recorded as an Agent read.
    await audit({runId: null, actionId: null});
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent_data_read_logs WHERE space_id=$1`, [space])).rows[0].n).toBe(1);
    // A failing attribution rolls back the B11 row too, so the caller releases nothing.
    await db.pool.query(`CREATE FUNCTION fail_attr_${pid}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected'; END $f$`);
    await db.pool.query(`CREATE TRIGGER fail_attr BEFORE INSERT ON agent_data_read_logs FOR EACH ROW EXECUTE FUNCTION fail_attr_${pid}()`);
    try {
      await expect(audit({runId: run, actionId: 'retrieval.search'})).rejects.toThrow(/injected/);
    } finally {
      await db.pool.query('DROP TRIGGER fail_attr ON agent_data_read_logs');
      await db.pool.query(`DROP FUNCTION fail_attr_${pid}()`);
    }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM content_access_logs WHERE space_id=$1 AND access_type='context_injection'`, [space])).rows[0].n).toBe(2);
  });

  it('a managed retrieval.search / retrieval.brief through the real tool transport attributes the person\'s own hits to the Run; a failed attribution releases nothing', async () => {
    const mine = randomUUID(), theirs = randomUUID();
    await insertKnowledgeItem(db.pool, {id: mine, spaceId: space, title: 'Orchid watering notes', content: 'Orchid watering schedule kept privately.', visibility: 'private', ownerUserId: owner, createdByUserId: owner});
    await insertKnowledgeItem(db.pool, {id: theirs, spaceId: space, title: 'Orchid shared plan', content: 'Orchid watering plan shared with the Space.', visibility: 'space_shared', ownerUserId: member, createdByUserId: member});
    await new RetrievalProjectionService(db.pool, knowledgeRetrievalRegistry).reindexAll(space);
    const run = await agentRun({user: owner, project});
    await db.pool.query(`UPDATE runs SET model_override_json=$2::jsonb, permission_snapshot_json=$3::jsonb WHERE id=$1`, [run,
      JSON.stringify({retrieval_tool_mode: 'manual_tool_only'}), JSON.stringify({tool_grants: [{action_id: 'retrieval.search'}, {action_id: 'retrieval.brief'}]})]);
    const reads = async () => (await db.pool.query(`SELECT owner_user_id,resource_ids_json,action_id FROM agent_data_read_logs WHERE run_id=$1 ORDER BY action_id`, [run])).rows;
    // The retrieval executor answers the model directly (`{ok, tool, items}`), not with an operation envelope.
    const ids = (result: unknown) => JSON.stringify(result);
    const retrieve = async (tool: string) => (await call(run, tool, {query: 'orchid watering', mode: 'lexical'})) as unknown as {ok: boolean};
    const search = await retrieve('retrieval.search');
    expect(search.ok, ids(search)).toBe(true);
    expect(ids(search)).toContain(mine);
    // B11 keeps the cross-person row; the person's own hit is the Run's Agent read, under the action it was admitted as.
    expect((await db.pool.query(`SELECT resource_id,run_id FROM content_access_logs WHERE space_id=$1 AND access_type='search_hit'`, [space])).rows).toEqual([{resource_id: theirs, run_id: run}]);
    expect(await reads()).toEqual([{owner_user_id: owner, resource_ids_json: [mine], action_id: 'retrieval.search'}]);
    const brief = await retrieve('retrieval.brief');
    expect(brief.ok, ids(brief)).toBe(true);
    expect(ids(brief)).toContain(mine);
    expect(await reads()).toEqual([
      {owner_user_id: owner, resource_ids_json: [mine], action_id: 'retrieval.brief'},
      {owner_user_id: owner, resource_ids_json: [mine], action_id: 'retrieval.search'},
    ]);
    // A failing attribution fails the call: neither hit reaches the model, and the B11 row rolls back with it.
    await db.pool.query(`CREATE FUNCTION fail_retr_${pid}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected'; END $f$`);
    await db.pool.query(`CREATE TRIGGER fail_retr BEFORE INSERT ON agent_data_read_logs FOR EACH ROW EXECUTE FUNCTION fail_retr_${pid}()`);
    try {
      for (const tool of ['retrieval.search', 'retrieval.brief']) {
        const failed = await retrieve(tool);
        expect(failed.ok).toBe(false);
        expect(ids(failed)).not.toContain(mine);
        expect(ids(failed)).not.toContain(theirs);
        expect(ids(failed)).not.toContain('Orchid');
      }
    } finally {
      await db.pool.query('DROP TRIGGER fail_retr ON agent_data_read_logs');
      await db.pool.query(`DROP FUNCTION fail_retr_${pid}()`);
    }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM content_access_logs WHERE space_id=$1 AND access_type='search_hit'`, [space])).rows[0].n).toBe(2);
    expect(await reads()).toHaveLength(2);
  });

  it('runs a declared port under the plugin operation\'s grant, never widening the Run: no task.create grant, the core\'s own actor rules', async () => {
    // ADR 0030 §9: the manifest's declared core_ports are the plugin's reviewed
    // host ceiling. A Run granted the plugin operation reaches the canonical
    // Task owner only through that port, under the core's own resolve/authorize
    // and policy action; the core tool itself stays ungranted.
    const run = await agentRun({user: owner, project});
    const direct = await call(run, 'task.create', {project_id: project, title: 'Direct'});
    expect(direct.httpStatus, JSON.stringify(direct.body)).toBe(403);
    expect(JSON.stringify(direct.body)).toContain('system_action_not_granted');
    const made = await call(run, opId, {project_id: project, only_task: true});
    expect(made.httpStatus, JSON.stringify(made.body)).toBe(200);
    expect((await db.pool.query(`SELECT action,actor_type FROM policy_decision_records WHERE space_id=$1 AND metadata_json->>'via_plugin_core_port'='true'`, [space])).rows)
      .toEqual([{action: 'task.create', actor_type: 'agent'}]);
    // A declared port keeps the core's actor eligibility: user-only Relations stay closed to the Agent,
    // and the refusal rolls the command's earlier Task write back with it.
    expect((await call(run, opId, {project_id: project})).httpStatus).toBe(404);
    expect(await counts()).toMatchObject({tasks: 1, people: 0, records: 0});
    // Nor does a port lift the core's per-turn Task fan-out limit.
    for (let made = 1; made < 5; made++) expect((await call(run, opId, {project_id: project, only_task: true})).httpStatus).toBe(200);
    const sixth = await call(run, opId, {project_id: project, only_task: true});
    expect(sixth.httpStatus, JSON.stringify(sixth.body)).not.toBe(200);
    expect(await counts()).toMatchObject({tasks: 5});
  });

  it('keeps a nested core refusal\'s code and rolls the whole command back', async () => {
    await db.pool.query(`UPDATE projects SET status='archived' WHERE id=$1`, [project]);
    const refused = await create({project_id: project, only_task: true});
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({code: 'operation_conflict', domain: 'tasks'});
    expect(await counts()).toEqual(empty);
  });

  it('caches only immutable package facts per composition; install contract, enablement and unload stay live', async () => {
    const identity = operationPackageIdentity(plugin);
    const parse = vi.spyOn(PluginOperationManifestSchema, 'parse');
    const meta = pluginToolMeta(config, opId)!;
    // The parsed, frozen manifest operations were registered from, one per composition.
    expect(Object.isFrozen(meta.manifest)).toBe(true);
    expect(pluginToolMeta(config, listId)!.manifest).toBe(meta.manifest);
    expect(meta.authorityHash).toBe(identity);
    expect(meta.pin).toEqual({action_id: opId, action_version: 1, data_class: 'non_sensitive', side_effects: 'durable', gate_class: null});
    for (let i = 0; i < 3; i++) expect(await operationPluginEnabled(db.pool, pid, space, owner, config)).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    // Another config composes nothing and sees nothing.
    expect(pluginToolMeta(loadConfig({SERVER_DATABASE_URL: db.connectionUri}), opId)).toBeUndefined();
    // An installed contract that is not this package's refuses at once; restoring it admits again.
    await db.pool.query(`UPDATE plugin_installs SET manifest_json=jsonb_set(manifest_json,'{operation_contract}','"stale"') WHERE plugin_id=$1`, [pid]);
    expect(await operationPluginEnabled(db.pool, pid, space, owner, config)).toBe(false);
    await db.pool.query(`UPDATE plugin_installs SET manifest_json=jsonb_set(manifest_json,'{operation_contract}',to_jsonb($2::text)) WHERE plugin_id=$1`, [pid, identity]);
    expect(await operationPluginEnabled(db.pool, pid, space, owner, config)).toBe(true);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect(await operationPluginEnabled(db.pool, pid, space, owner, config)).toBe(false);
    // Closing the composition releases its facts.
    await app.close();
    expect(pluginToolMeta(config, opId)).toBeUndefined();
  });

  it('reads each plugin\'s enablement once per Run tool build, only for granted tools, and live each time', async () => {
    const isEnabled = vi.spyOn(pluginService, 'isEnabled');
    const pluginReads = () => isEnabled.mock.calls.filter(c => c[1] === pid).length;
    const runRecord = async (id: string) => (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [id])).rows[0]!;
    const granted = await agentRun({user: owner, project});
    const offered = (await SystemActionDispatcher.create(config, await runRecord(granted))).listGrantedDefinitions().map(t => t.name);
    expect(offered).toEqual(expect.arrayContaining([opId, listId]));
    expect(pluginReads()).toBe(1);
    isEnabled.mockClear();
    const grants = await buildRunToolGrants([opId, listId], {allowed_tools: [opId, listId]}, {db: db.pool, spaceId: space, userId: owner, config});
    expect(grants.map(g => g.action_id)).toEqual(expect.arrayContaining([opId, listId]));
    expect(pluginReads()).toBe(1);
    // A Run granted none of the plugin's tools never reads its enablement.
    isEnabled.mockClear();
    const ungranted = await agentRun({user: owner, project});
    await db.pool.query(`UPDATE runs SET permission_snapshot_json='{"tool_grants":[{"action_id":"task.create"}]}'::jsonb WHERE id=$1`, [ungranted]);
    expect((await SystemActionDispatcher.create(config, await runRecord(ungranted))).listGrantedDefinitions().map(t => t.name)).not.toContain(opId);
    expect(pluginReads()).toBe(0);
    // Disabled now: the next build offers nothing and a call is refused at call time.
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await SystemActionDispatcher.create(config, await runRecord(granted))).listGrantedDefinitions().map(t => t.name)).not.toContain(opId);
    expect((await call(granted, opId, {project_id: project, only_task: true})).httpStatus).not.toBe(200);
    expect(await counts()).toEqual(empty);
  });

  it('fails closed when the plugin is disabled', async () => {
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await create({project_id: project})).statusCode).toBe(404);
    expect(await counts()).toEqual(empty);
  });
});
