import {randomUUID} from 'node:crypto';
import {afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {RainverPlugin} from '@rainver/protocol';
import {BUILT_IN_PLUGINS} from '../src/modules/plugins/builtInPlugins.js';
import {PluginHost} from '../src/modules/plugins/host/index.js';
import {migrateOperationPlugin} from '../src/modules/plugins/operationMigrations.js';
import {operationPackageIdentity} from '../src/modules/plugins/packageIdentity.js';
import {pluginServiceFor} from '../src/modules/plugins/service.js';
import {withTransaction} from '../src/db/tx.js';
import {loadConfig} from '../src/config.js';
import {useTestDatabase} from './support/testDatabase.js';
import {seedAgentWithVersion, seedServerRuntimeProfile, seedSpaceOwnerProject} from './support/domainSeeds.js';
import {PgRouteDecisionRepository} from '../src/modules/routing/repository.js';
import {buildModuleServer} from './support/moduleServer.js';
import {systemActionsModule} from '../src/modules/systemActions/index.js';
import {runsModule} from '../src/modules/runs/index.js';
import {__setAuthIdentityForTests} from '../src/modules/auth/identity.js';
import {CliAgentToolTransport} from '../src/modules/runs/cliToolTransport.js';
import {PgRunRepository, type AgentRunRecord} from '../src/modules/runs/repository.js';
import type {OperationToolResponse} from '../src/modules/systemActions/operations/agentResult.js';
import {PROJECT_APPLICATIONS_TOOL_ALLOWANCE, conversationToolGrantInput, dispatchToolAllowance} from '../src/modules/systemActions/scenarioToolAllowance.js';
import {resolve} from 'node:path';
import {RoomService} from '../src/modules/rooms/service.js';
import {AgentGroupRunService} from '../src/modules/agentGroups/service.js';
import {PgAgentGroupRepository} from '../src/modules/agentGroups/repository.js';
import {PgSessionRepository} from '../src/modules/sessions/repository.js';
import {ConversationExecutionContextService} from '../src/modules/sessions/executionContextService.js';
import {syncBuiltinPrompts} from '../src/modules/prompts/builtins.js';
import {seedRoomManager} from './support/domainSeeds.js';

/**
 * The application management package's tools reach an Agent through the Runs Rainver
 * really creates. A Room message (`RoomService.sendMessage`), its delegated child
 * (`AgentGroupRunService.spawnChildRun`) and a Task dispatched to a built-in or a paired
 * Host (the `task.run.create` action) are created by their own entries with the server's
 * configuration, so the permission snapshot they write is the one under test; a direct
 * chat's grant input is the one `agents/chatOperations` passes. Each Run's tools are what
 * `rainver list` shows and its calls go through the Run tool transport, on the shipped
 * package and real PostgreSQL. Binding, the Run's Project, person-only operations and
 * personal-data consent still decide what each call may do; a Task with no Workspace
 * Location is given no Rainver tools at all.
 */
const db = useTestDatabase(import.meta.filename);
const pid = 'applications';
const opId = (name: string) => `plugin.${pid}.${name}`;
const plugin = BUILT_IN_PLUGINS.find(p => p.id === pid) as RainverPlugin;
let space: string, owner: string, projectA: string, projectB: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;

beforeAll(async () => {
  if (!db.available) return;
  expect(plugin?.operationManifest, 'build the official plugins first (server/scripts/build-official-plugins.mjs)').toBeTruthy();
  // The package's roles are cluster-wide while each test file has its own database: a concurrent
  // install in another file can deadlock with this one. A deployment installs alone; here it is retried.
  for (let attempt = 0; ; attempt++) {
    try { await migrateOperationPlugin(db.pool, plugin, attempt ? {repairFailed: true} : {}); break; } catch (error) {
      const e = error as {code?: string; message?: string; cause?: {code?: string}};
      if (attempt >= 4 || ![e.code, e.cause?.code].includes('40P01') && !/deadlock detected/.test(e.message ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
});
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID(); owner = randomUUID(); projectA = randomUUID(); projectB = randomUUID();
  await seedSpaceOwnerProject(db.pool, {space, owner, project: projectA, spaceType: 'team'});
  await db.pool.query(`INSERT INTO projects (id,space_id,owner_user_id,name,status,created_at,updated_at) VALUES ($1,$2,$3,'Unbound','active',now(),now())`, [projectB, space, owner]);
  config = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  __setAuthIdentityForTests({spaceId: space, userId: owner});
  // Only Project A is bound; Project B has the package enabled but not bound.
  const bound = await action('official_plugin.project_binding.bind', {plugin_id: pid, project_id: projectA});
  expect(bound.statusCode, bound.body).toBe(200);
});
afterEach(async () => { __setAuthIdentityForTests(null); await app?.close(); });
const action = (id: string, payload: Record<string, unknown>) => app.inject({method: 'POST', url: `/api/v1/actions/${id}`, headers: {'idempotency-key': randomUUID()}, payload});

type Grant = {capabilities_json: readonly string[]; scenario_tool_allowance: readonly string[]};
/** A direct-chat Run: the grant input `agents/chatOperations` passes, with the config it passes. */
async function startRun(grant: Grant, project: string | null, extra: {session_id?: string} = {}) {
  const agent = randomUUID();
  await seedAgentWithVersion(db.pool, {agent, version: randomUUID(), space, owner, seedDefaultRuntimeProfile: false});
  await seedServerRuntimeProfile(db.pool, {agent, space, hostId: 'server-host'});
  const runs = new PgRunRepository(db.pool, config);
  const created = await runs.createQueuedRun({
    execution_kind: 'agent', agent_id: agent, space_id: space, user_id: owner, mode: 'live', run_type: 'agent', trigger_origin: 'manual',
    visibility: 'private', project_id: project, prompt: 'Track my applications', capabilities_json: [...grant.capabilities_json], scenario_tool_allowance: grant.scenario_tool_allowance, ...extra,
  });
  // The declared package operations are server actions, not runtime capabilities: routing still finds the runtime.
  await new PgRouteDecisionRepository(db.pool).routeRun(created);
  expect(await runs.markRunRunning({run_id: created.id, space_id: space, started_at: new Date().toISOString()})).toBeTruthy();
  return (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [created.id])).rows[0]!;
}
/** Routes and starts a Run an entry created, as the orchestrator does, and reads it back. */
async function started(runId: string) {
  const runs = new PgRunRepository(db.pool, config);
  const run = (await runs.getAgentRun(space, runId))!;
  if (run.status === 'queued') {
    // A paired Host claims its Task Run's requested Profile itself; every other Run is routed.
    if (run.trust_mode === 'trusted_host') {
      await db.pool.query(`UPDATE runs r SET runtime_profile_id=p.id,runtime_key=p.runtime_key,runtime_profile_snapshot_json=jsonb_build_object('id',p.id,'runtime_key',p.runtime_key,'execution_host_id',p.execution_host_id)
        FROM agent_runtime_profiles p WHERE r.id=$1 AND p.id=r.requested_runtime_profile_id`, [runId]);
    } else await new PgRouteDecisionRepository(db.pool).routeRun(run);
    expect(await runs.markRunRunning({run_id: runId, space_id: space, started_at: new Date().toISOString()})).toBeTruthy();
  }
  return (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
}
type Snapshot = {tool_grants?: {action_id: string}[]; plugin_tool_pins?: Record<string, unknown>; scenario_tool_allowance?: string[]};
/** The package tools the entry wrote into the Run's permission snapshot. */
const snapshotTools = (run: AgentRunRecord) => ((run.permission_snapshot_json as Snapshot | null)?.tool_grants ?? []).map(g => g.action_id).filter(id => id.startsWith(`plugin.${pid}.`)).sort();
const transport = () => new CliAgentToolTransport(config, {actionEventSink: async () => {}});
/** What `rainver list` shows this Run: only this package's tools. */
const listed = async (run: AgentRunRecord) => (await transport().list(run)).map(t => t.name).filter(n => n.startsWith(`plugin.${pid}.`)).sort();
const call = async (run: AgentRunRecord, name: string, args: Record<string, unknown>) =>
  (await transport().call(run, {id: randomUUID(), name: opId(name), arguments: args})) as OperationToolResponse;
const phd = {institution: 'ETH Zurich', program: 'PhD in Computer Science'};
const agentEligible = () => plugin.operationManifest!.operations.filter(o => !o.actors).map(o => o.id).sort();
const nonPersonal = () => plugin.operationManifest!.operations.filter(o => !o.actors && o.data_class === 'non_sensitive').map(o => o.id).sort();

describe('Application tools in the Runs Rainver creates', () => {
  it('the allowance names exactly the package\'s Agent-eligible operations, never a person-only one', () => {
    expect([...PROJECT_APPLICATIONS_TOOL_ALLOWANCE].sort()).toEqual(agentEligible());
    for (const name of ['material.mark_reviewed', 'material.generate', 'material.get_generation', 'material.apply_generation']) {
      expect(PROJECT_APPLICATIONS_TOOL_ALLOWANCE).not.toContain(opId(name));
    }
    // Only a Run with a Project carries them: a direct chat outside a Project and a Project-less Room do not.
    expect(conversationToolGrantInput({}).capabilities_json.some(id => id.startsWith('plugin.'))).toBe(false);
    expect(conversationToolGrantInput({room_id: 'room'}).capabilities_json.some(id => id.startsWith('plugin.'))).toBe(false);
    // Nothing else of any plugin is named.
    for (const grant of [conversationToolGrantInput({project_id: 'p'}), conversationToolGrantInput({room_id: 'r', project_id: 'p', delegated: true})]) {
      expect(grant.capabilities_json.filter(id => id.startsWith('plugin.')).sort()).toEqual([...PROJECT_APPLICATIONS_TOOL_ALLOWANCE].sort());
    }
    expect(dispatchToolAllowance().filter(id => id.startsWith('plugin.')).sort()).toEqual([...PROJECT_APPLICATIONS_TOOL_ALLOWANCE].sort());
  });

  it('a direct Project chat lists and calls them in its own bound Project only', async () => {
    const run = await startRun(conversationToolGrantInput({project_id: projectA}), projectA);
    // Personal contacts need the Space owner's consent; person-only operations are never listed.
    expect(await listed(run)).toEqual(nonPersonal());
    const created = await call(run, 'application.create', {project_id: projectA, ...phd, deadlines: [{kind: 'application', due_on: '2027-01-15'}]});
    expect(created.httpStatus, JSON.stringify(created.body)).toBe(200);
    const {application_id} = (created.body as {data: {application_id: string}}).data;
    expect((await db.pool.query(`SELECT user_id,project_id FROM plugin_applications.applications WHERE id=$1`, [application_id])).rows).toEqual([{user_id: owner, project_id: projectA}]);
    const read = await call(run, 'application.list', {project_id: projectA});
    expect((read.body as {data: {items: {id: string}[]}}).data.items.map(i => i.id)).toEqual([application_id]);
    // Never another Project: the Run's own Project decides, and the other one is not even bound.
    const across = await call(run, 'application.create', {project_id: projectB, ...phd});
    expect(across.httpStatus).not.toBe(200);
    // A person-only operation is not callable by name either.
    const generated = await call(run, 'material.generate', {project_id: projectA, material_id: randomUUID(), requirements: 'x'});
    expect(generated.httpStatus).not.toBe(200);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.applications WHERE space_id=$1`, [space])).rows[0].n).toBe(1);
  });

  it('a Room message, its delegated child and Task dispatch to a built-in or a paired Host carry them from their real entries', async () => {
    const now = new Date().toISOString();
    const serverHost = 'server-host', pairedHost = randomUUID(), machine = randomUUID();
    await syncBuiltinPrompts(db.pool, resolve(process.cwd(), '..', 'catalog'));
    // The Project's Assistant manages its Rooms; a specialist is on the roster for a delegation.
    const manager = randomUUID(), specialist = randomUUID();
    await db.pool.query(`INSERT INTO agents (id,space_id,project_id,owner_user_id,name,status,agent_kind,current_version_id,visibility,created_at,updated_at) VALUES ($1,$2,$3,NULL,'Assistant','active','system_assistant',NULL,'space_shared',$4,$4)`, [manager, space, projectA, now]);
    await db.pool.query(`INSERT INTO agent_versions (id,agent_id,space_id,version_label,system_prompt,context_policy_json,memory_policy_json,capabilities_json,tool_permissions_json,risk_level,follows_seed_key,created_at) VALUES ($1,$2,$3,'v1','Coordinate.','{}','{}','[]','{}','low','agent_template.personal_assistant.system',$4)`, [randomUUID(), manager, space, now]);
    await db.pool.query(`UPDATE agents SET current_version_id=(SELECT id FROM agent_versions WHERE agent_id=$1) WHERE id=$1`, [manager]);
    await seedAgentWithVersion(db.pool, {agent: specialist, version: randomUUID(), space, owner, name: 'Specialist', seedDefaultRuntimeProfile: false, now});
    for (const [agent, name] of [[manager, 'Assistant'], [specialist, 'Specialist']]) {
      await db.pool.query(`INSERT INTO actors (id,space_id,actor_type,agent_id,display_name,status,metadata_json,created_at,updated_at) VALUES ($1,$2,'agent',$1,$3,'active','{}',$4,$4) ON CONFLICT DO NOTHING`, [agent, space, name, now]);
    }
    const managerProfile = await seedServerRuntimeProfile(db.pool, {agent: manager, space, hostId: serverHost, runtimeKey: 'claude_code', now});
    await seedServerRuntimeProfile(db.pool, {agent: specialist, space, hostId: serverHost, runtimeKey: 'claude_code', now});
    // The one built-in Host (shared with the other cases): it reports the copy these Runs dispatch to.
    await db.pool.query(`UPDATE hosts SET last_heartbeat_at=now(),capabilities_json=jsonb_set(coalesce(capabilities_json,'{}'),'{installations,claude_code}','[{"id":"managed:1.0.0","version":"1.0.0","logged_in":true,"health_check_protocol":"acp"}]') WHERE id=$1`, [serverHost]);
    const room = (await db.pool.query<{id: string}>(`SELECT id FROM rooms WHERE space_id=$1 AND project_id=$2 AND is_mainline`, [space, projectA])).rows[0]!.id;
    await seedRoomManager(db.pool, {space, room, agent: manager});
    await db.pool.query(`INSERT INTO room_agent_members (id,space_id,room_id,agent_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'member','active',$5,$5)`, [randomUUID(), space, room, specialist, now]);
    const conversation = await new PgSessionRepository(db.pool).createRoomConversation({space_id: space, room_id: room, project_id: projectA, project_folder_id: null, title: 'Applications', metadata: {}});
    await new ConversationExecutionContextService(db.pool).initialize({spaceId: space, userId: owner}, conversation.id, {
      selection: {execution_host_id: serverHost, primary: {kind: 'managed'}},
      runtime: {agent_id: manager, runtime_profile_id: managerProfile, runtime_key: 'claude_code', runtime_installation: 'managed:1.0.0'},
    });
    const identity = {spaceId: space, userId: owner};
    // The Room message, as the person sends it.
    const sent = await new RoomService(config, db.pool).sendMessage(identity, room, conversation.id, {content: 'Track my ETH application.'});
    const roomRun = await started(sent.run_ids[0]!);
    // Its delegation, as the manager's `agent.delegate` call reaches the group service.
    const group = (await new PgAgentGroupRepository(db.pool).getGroup(space, sent.task_group_ids[0]!))!;
    const spawned = await new AgentGroupRunService(config, db.pool).spawnChildRun(identity, {
      workspace_access: 'read', space_id: space, group_id: group.id, parent_run_id: roomRun.id, root_run_id: group.root_run_id!,
      requesting_agent_id: manager, target_agent_id: specialist, manager_user_id: owner, instruction: 'Add the ETH deadline.',
    });
    const childRun = await started(spawned.child_run_id!);

    // Task dispatch: a Folder on the built-in Host and one on the person's paired Host, started by the person.
    const dispatchAgent = randomUUID();
    await seedAgentWithVersion(db.pool, {agent: dispatchAgent, version: randomUUID(), space, owner, name: 'Worker', seedDefaultRuntimeProfile: false, now});
    await db.pool.query(`INSERT INTO machines (id,owner_user_id,display_name,device_kind,created_at,updated_at) VALUES ($1,$2,'Laptop','desktop',$3,$3)`, [machine, owner, now]);
    await db.pool.query(`INSERT INTO hosts (id,owner_user_id,machine_id,name,kind,environment_kind,status,capabilities_json,last_heartbeat_at,created_at,updated_at) VALUES ($1,$2,$3,'Laptop','remote','linux_native','online','{"installations":{"claude_code":[{"id":"own","version":"1.0.0","logged_in":true}]}}',now(),$4,$4)`, [pairedHost, owner, machine, now]);
    const task = async (kind: 'server' | 'remote' | null) => {
      const folder = kind ? randomUUID() : null, location = kind ? randomUUID() : null, taskId = randomUUID();
      if (folder) {
        await db.pool.query(`INSERT INTO project_folders (id,space_id,project_id,name,kind,status,protected,system_managed,created_at,updated_at) VALUES ($1,$2,$3,$4,'code','active',false,false,$5,$5)`, [folder, space, projectA, `repo-${kind}`, now]);
        await db.pool.query(`INSERT INTO workspace_locations (id,space_id,project_folder_id,execution_host_id,execution_host_kind,root_path,display_path,execution_ready,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'/w',true,'active',$7,$7)`, [location, space, folder, kind === 'server' ? serverHost : pairedHost, kind, kind === 'server' ? '/w' : null, now]);
      }
      await db.pool.query(`INSERT INTO tasks (id,space_id,project_id,project_folder_id,title,status,created_by_user_id,owner_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,'Fill in the ETH application','ready',$5,$5,$6,$6)`, [taskId, space, projectA, folder, owner, now]);
      const profile = randomUUID();
      await db.pool.query(`INSERT INTO agent_runtime_profiles (id,space_id,agent_id,name,runtime_key,backend_mode,execution_host_id,workspace_location_id,workspace_mode,runtime_installation,runtime_config_json,runtime_policy_json,enabled,is_default,created_at,updated_at)
        VALUES ($1,$2,$3,$9,'claude_code','runtime_native',$4,$5,$6,$7,'{}','{}',true,false,$8,$8)`,
      [profile, space, dispatchAgent, kind === 'remote' ? pairedHost : serverHost, location, location ? 'location' : 'managed', kind === 'remote' ? 'own' : 'managed:1.0.0', now, `Task ${kind ?? 'none'}`]);
      const created = await action('task.run.create', {task_id: taskId, agent_id: dispatchAgent, runtime_profile_id: profile, prompt: 'Fill it in.'});
      expect(created.statusCode, created.body).toBe(201);
      return (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [created.json().data.run_id])).rows[0]!;
    };
    const localTask = await task('server'), pairedTask = await task('remote'), noLocationTask = await task(null);
    expect([localTask.trust_mode, pairedTask.trust_mode]).toEqual(['sandboxed', 'trusted_host']);

    const runs = {room: roomRun, delegated: childRun, local_task: await started(localTask.id), paired_task: await started(pairedTask.id)};
    for (const [kind, run] of Object.entries(runs)) {
      // The snapshot the entry issued names them, pinned, and `rainver list` shows exactly those.
      expect(snapshotTools(run), kind).toEqual(nonPersonal());
      expect(Object.keys((run.permission_snapshot_json as Snapshot).plugin_tool_pins ?? {}).sort(), kind).toEqual(nonPersonal());
      expect(await listed(run), kind).toEqual(nonPersonal());
      const created = await call(run, 'application.create', {project_id: projectA, ...phd, program: `PhD via ${kind}`});
      expect(created.httpStatus, `${kind}: ${JSON.stringify(created.body)}`).toBe(200);
      // Still never another Project, nor a person-only operation.
      expect((await call(run, 'application.list', {project_id: projectB})).httpStatus, kind).not.toBe(200);
      expect((await call(run, 'material.generate', {project_id: projectA, material_id: randomUUID(), requirements: 'x'})).httpStatus, kind).not.toBe(200);
    }
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM plugin_applications.applications WHERE space_id=$1`, [space])).rows[0].n).toBe(4);
    // A shared Run's audience is live: once another person reads the Project, the Room Run's output
    // reaches them too, so a read returns only rows every reader reads themselves (none of the owner's).
    expect(((await call(roomRun, 'application.list', {project_id: projectA})).body as {data: {items: unknown[]}}).data.items).toHaveLength(4);
    const reader = randomUUID();
    await db.pool.query(`INSERT INTO users (id,display_name,status,created_at,updated_at,email,registration_source) VALUES ($1,'Reader','active',now(),now(),lower(gen_random_uuid()::text||'@test.invalid'),'system')`, [reader]);
    await db.pool.query(`INSERT INTO space_memberships (id,space_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'member','active',now(),now())`, [randomUUID(), space, reader]);
    await db.pool.query(`INSERT INTO project_members (id,space_id,project_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'viewer','active',now(),now())`, [randomUUID(), space, projectA, reader]);
    for (const run of [roomRun, childRun]) {
      const shared = await call(run, 'application.list', {project_id: projectA});
      expect(shared.httpStatus).toBe(200);
      expect((shared.body as {data: {items: unknown[]}}).data.items).toEqual([]);
    }
    // A Task with no Workspace Location keeps the default: it declares nothing, so it is given no Rainver tool.
    expect(noLocationTask.capabilities_json).toEqual([]);
    expect((noLocationTask.permission_snapshot_json as Snapshot).tool_grants).toEqual([]);
    const bare = await started(noLocationTask.id);
    expect(await listed(bare)).toEqual([]);
    expect((await call(bare, 'application.list', {project_id: projectA})).httpStatus).not.toBe(200);
  });

  it('a dispatched Task Run in an unbound Project lists them but reaches nothing there', async () => {
    const unbound = await startRun({capabilities_json: dispatchToolAllowance(), scenario_tool_allowance: dispatchToolAllowance()}, projectB);
    expect((await call(unbound, 'application.list', {project_id: projectB})).httpStatus).not.toBe(200);
  });

  it('contacts stay personal: listed for reading only after the Space owner\'s consent, never as an Agent write', async () => {
    const consent = await action('plugin_data_grant.create', {plugin_id: pid, toolset: 'read', data_class: 'personal', scope: 'space', authority_hash: operationPackageIdentity(plugin)});
    expect(consent.statusCode, consent.body).toBe(201);
    const run = await startRun(conversationToolGrantInput({project_id: projectA}), projectA);
    const tools = await listed(run);
    expect(tools).toEqual(expect.arrayContaining([opId('contact.list'), opId('contact.list_events')]));
    for (const name of ['contact.create', 'contact.update', 'contact.log_event']) expect(tools).not.toContain(opId(name));
    expect((await call(run, 'contact.list', {project_id: projectA})).httpStatus).toBe(200);
  });
});
