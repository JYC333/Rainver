import {getPluginControlPool,getOperationAuditPool} from '../src/db/pool.js';
import { pluginsModule } from '../src/modules/plugins/index.js';
import { BUILT_IN_PLUGINS } from '../src/modules/plugins/builtInPlugins.js';
import { installOfficialPlugin } from '../src/modules/plugins/installer.js';
import { proposalsModule, __setProposalIdentityForTests } from '../src/modules/proposals/index.js';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { mkdtemp, writeFile, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, beforeEach, it, describe, expect, inject, vi } from 'vitest';
import type { RainverPlugin } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { waitForBlockedBy, waitForLockWaiter } from './support/lockWait.js';
import { seedSpaceOwnerProject, seedRun } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { buildServerDist } from './support/briefingWorkerHarness.js';
import { createLifecycleProbe, jobId, proposalType, type LegacyResourceConsumer } from './fixtures/pluginOperation/lifecycleRuntime.js';
import { migrateOperationPlugin, migrateOperationPlugins, reconcileOperationPlugins } from '../src/modules/plugins/operationMigrations.js';
import { pluginOrder } from '../src/modules/plugins/dependencies.js';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { loadConfig } from '../src/config.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { runsModule } from '../src/modules/runs/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { applyOperationPluginEnabledIn, registerPluginScopeCleanupHandler, setOperationPluginEnabled, __setPluginScopeOwnerTickForTests, pluginScopeOwnerTick, pluginScopeOwnerInstance, pluginScopeHoldCurrent, pluginScopeLeaseCheck, retainPluginScopeHold } from '../src/modules/plugins/lifecycle.js';
import { lockOperationPluginScope, operationPluginEnabled } from '../src/modules/plugins/operationEnablement.js';
import { pluginServiceFor } from '../src/modules/plugins/service.js';
import { loadSystemActionRegistry } from '../src/modules/systemActions/registry.js';
import { loadActionRegistry } from '../src/modules/policy/actionRegistry.js';
import { grantRunChangeReadTools } from '../src/modules/agentGroups/runChangeBlock.js';
import { buildRunToolGrants } from '../src/modules/systemActions/runToolGrants.js';
import { PgRunToolIdentityRepository } from '../src/modules/runs/runToolIdentityRepository.js';
import { PgProposalApplyService } from '../src/modules/proposals/applyService.js';
import { PgJobQueueRepository } from '../src/modules/jobs/repository.js';
import { JobHandlerRegistry } from '../src/modules/jobs/handlerRegistry.js';
import { JobWorker } from '../src/modules/jobs/worker.js';
import { withTransaction } from '../src/db/tx.js';
import { operationTransaction } from '../src/db/operationTransaction.js';
import { withPluginDb } from '../src/modules/plugins/operationDb.js';
import { PluginRegistrationClosed } from '../src/modules/plugins/effectScopes.js';
import { provisionPluginRoles, reconcilePluginRole, pluginRoleNames } from '../src/modules/plugins/roleReconcile.js';
import { sessionActor } from '../src/modules/systemActions/operations/actor.js';
const db = useTestDatabase(import.meta.filename);
let space: string, user: string, project: string, config: ReturnType<typeof loadConfig>, plugin: RainverPlugin, host: PluginHost, app: ReturnType<typeof buildModuleServer>, observed: string[];
const extraApps: ReturnType<typeof buildModuleServer>[] = [];
const dirs: string[] = [];
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID();
  user = randomUUID();
  project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner: user,
    project
  });
  observed = [];
  // The bounded registration contract, as every in-repository producer uses; original-contract cases run another process.
  plugin = createLifecycleProbe(x => observed.push(x));
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  });
  // Owner recovery passes are driven explicitly (`pluginScopeOwnerTick`), never by a timer here.
  __setPluginScopeOwnerTickForTests(null);
  app = buildModuleServer(config, [systemActionsModule, runsModule, proposalsModule, pluginsModule]);
  host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  // Each case starts from a clean fixture schema/journal, not product data.
  await db.pool.query('DROP SCHEMA IF EXISTS plugin_operation_probe CASCADE');
  await db.pool.query("DELETE FROM official_plugin_enablements WHERE plugin_id='operation_probe'");
  await db.pool.query("DELETE FROM official_plugin_scope_holds WHERE plugin_id='operation_probe'");
  for (const old of (await db.pool.query<{
    id: string;
  }>("SELECT id FROM jobs WHERE job_type=ANY($1::text[]) AND status IN ('pending','claimed','running')", [[jobId, 'official_plugin_scope_cleanup']])).rows) await new PgJobQueueRepository(db.pool).cancelJob(old.id, null);
  await db.pool.query("DELETE FROM plugin_migrations WHERE plugin_id='operation_probe'");
  await db.pool.query("DELETE FROM plugin_installs WHERE plugin_id='operation_probe'");
  await migrateOperationPlugin(db.pool, plugin);
  await setOperationPluginEnabled(config, plugin.id, space, user, true);
  __setAuthIdentityForTests({
    spaceId: space,
    userId: user
  });
});
afterEach(async () => {
  __setAuthIdentityForTests(null);
  __setProposalIdentityForTests(null);
  if (db.available) {
    await db.pool.query("DELETE FROM plugin_installs WHERE plugin_id='probe_dependency'");
    await db.pool.query("DELETE FROM plugin_migrations WHERE plugin_id='probe_dependency'");
    await db.pool.query('DROP SCHEMA IF EXISTS plugin_probe_dependency CASCADE');
  }
  for (const a of extraApps.splice(0)) await a.close();
  await app?.close();
  for (const d of dirs.splice(0)) await rm(d, {
    recursive: true,
    force: true
  });
});
const call = (verb: string, input: unknown = {}, key = randomUUID()) => app.inject({
  method: 'POST',
  url: `/api/v1/actions/plugin.operation_probe.record.${verb}`,
  headers: {
    'idempotency-key': key
  },
  payload: input as object
});
const records = () => db.pool.query<{
  value: string;
}>('SELECT value FROM plugin_operation_probe.records WHERE space_id=$1 AND user_id=$2 ORDER BY key', [space, user]);
async function artifactRoot() {
  await buildServerDist();
  const root = await mkdtemp(join(tmpdir(), 'plugin-lifecycle-'));
  dirs.push(root);
  const pkg = join(root, 'operation_probe');
  await mkdir(join(pkg, 'migrations'), {
    recursive: true
  });
  await symlink(join(import.meta.dirname, '../node_modules'), join(root, 'node_modules'));
  const runtime = readFileSync(join(import.meta.dirname, 'fixtures/pluginOperation/lifecycleRuntime.ts'), 'utf8');
  await writeFile(join(pkg,'manifest.mjs'),stripTypeScriptTypes(readFileSync(join(import.meta.dirname,'fixtures/pluginOperation/manifest.ts'),'utf8'),{mode:'strip'}));
  await writeFile(join(pkg, 'runtime.mjs'), stripTypeScriptTypes(runtime.replaceAll('./manifest.js','./manifest.mjs'), {
    mode: 'strip'
  }));
  await copyFile(join(import.meta.dirname, 'fixtures/pluginOperation/migrations/0000_unusual_joseph.sql'), join(pkg, 'migrations/0000_unusual_joseph.sql'));
  await writeFile(join(pkg, 'plugin.json'), JSON.stringify({
    id: plugin.id,
    version: plugin.version,
    kind: 'official_plugin',
    server: {
      main: 'runtime.mjs'
    }
  }));
  return root;
}
async function offlineCli(root: string, command: string) {
  return promisify(execFile)(process.execPath, ['dist/db/migrateCli.js', command], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      PATH: process.env.PATH,
      SERVER_DATABASE_URL: db.connectionUri,
      SERVER_OFFICIAL_PLUGINS_DIR: root
    }
  });
}
describe('operation package lifecycle through canonical consumers', () => {
  it('uses manifest-scoped lifecycle from the existing plugin HTTP control plane', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/plugins'
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items.find((item: {
      descriptor: {
        id: string;
      };
    }) => item.descriptor.id === plugin.id).effective.enabled).toBe(true);
    // `plugin.disable` through the retained URL: local effects close outside the transaction.
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/plugins/${plugin.id}/disable`,
      headers: {'idempotency-key': 'plugin-disable-1'},
      payload: {}
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({status: 'succeeded', data: {effective: {enabled: false}, cleanup_pending: false}});
    // The same key replays the recorded answer; it is not a second transition.
    const replayed = await app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/disable`, headers: {'idempotency-key': 'plugin-disable-1'}, payload: {}});
    expect(replayed.json()).toEqual(disabled.json());
    expect((await call('write')).statusCode).toBe(404);
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/plugins/${plugin.id}/enable`,
      headers: {'idempotency-key': 'plugin-enable-1'},
      payload: {
        settings: {
          label: 'scope'
        }
      }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().data.effective.enabled).toBe(true);
    expect((await call('write')).statusCode).toBe(200);
  });
  it('deduplicates schedule intent from two actual scheduler processes',async()=>{
    const root=await artifactRoot(),base=new URL('../dist/',import.meta.url).href,driver=join(root,'scheduler.mjs');
    await writeFile(driver,`
      import Fastify from 'fastify';
      import {loadConfig} from '${base}config.js';
      import {closeDbPool} from '${base}db/pool.js';
      import {loadOfficialPluginPackages} from '${base}modules/plugins/packageLoader.js';
      import {PluginHost} from '${base}modules/plugins/host/index.js';
      const config=loadConfig(),app=Fastify(),host=new PluginHost(await loadOfficialPluginPackages(process.env.SERVER_OFFICIAL_PLUGINS_DIR));
      host.activate(app,config);await app.ready();await host.getSchedulerTasks()[0].run();await app.close();await closeDbPool(config.databaseUrl);
    `);
    const invoke=()=>promisify(execFile)(process.execPath,[driver],{env:{PATH:process.env.PATH,SERVER_DATABASE_URL:db.connectionUri,SERVER_OFFICIAL_PLUGINS_DIR:root}});
    await Promise.all([invoke(),invoke()]);
    expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1 AND space_id=$2',[jobId,space])).rows).toHaveLength(1);
  });
  it('keeps audit capacity independent of saturated plugin control probes',async()=>{
    const control=getPluginControlPool(db.connectionUri),audit=getOperationAuditPool(db.connectionUri);
    expect(control).not.toBe(audit);const leases=await Promise.all([control.connect(),control.connect()]);
    try{expect((await audit.query('SELECT 42 AS answer')).rows[0].answer).toBe(42);}finally{for(const lease of leases)lease.release();}
  });
  it('reserves identical schedule intents across independent host compositions and diagnoses lost authority',async()=>{
    const cfg=loadConfig({SERVER_DATABASE_URL:db.connectionUri}),target=buildModuleServer(cfg,[systemActionsModule]),other=new PluginHost([plugin]);other.activate(target,cfg);await target.ready();extraApps.push(target);
    await Promise.all([host.getSchedulerTasks()[0]!.run(),other.getSchedulerTasks()[0]!.run(),host.getSchedulerTasks()[0]!.run()]);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2',[space,jobId])).rows).toHaveLength(1);
    await db.pool.query("UPDATE space_memberships SET status='inactive' WHERE space_id=$1 AND user_id=$2",[space,user]);
    await Promise.all([host.getSchedulerTasks()[0]!.run(),other.getSchedulerTasks()[0]!.run()]);
    expect((await db.pool.query("SELECT id FROM official_plugin_events WHERE space_id=$1 AND event_type='schedule_authority_paused'",[space])).rows).toHaveLength(1);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1 AND job_type=$2',[space,jobId])).rows).toHaveLength(1);
  });
  it('journals failed DDL outside rollback, preserves data/checksums and requires explicit repair', async () => {
    await call('write', {
      value: 'before'
    });
    const bad = {
      ...plugin,
      version: '1.1.0',
      operationManifest: {
        ...plugin.operationManifest!,
        version: '1.1.0',
        migrations: ['0000_unusual_joseph', '0001_bad']
      },
      migrations: [...plugin.migrations!, {
        id: '0001_bad',
        sql: 'ALTER TABLE public.projects ADD COLUMN forbidden text'
      }]
    };
    await expect(migrateOperationPlugin(db.pool, bad)).rejects.toMatchObject({
      code: '42501'
    });
    const state = (await db.pool.query("SELECT lifecycle_state,status FROM plugin_installs WHERE plugin_id=$1", [plugin.id])).rows[0];
    expect(state).toMatchObject({
      lifecycle_state: 'migration_error',
      status: 'disabled'
    });
    expect((await records()).rows.map(r => r.value)).toEqual(['before']);
    expect((await db.pool.query("SELECT status FROM plugin_migrations WHERE plugin_id=$1 AND migration_id='0001_bad'", [plugin.id])).rows[0].status).toBe('failed');
    expect((await db.pool.query("SELECT 1 FROM official_plugin_events WHERE plugin_id=$1 AND event_type='migration_failed'", [plugin.id])).rows.length).toBeGreaterThan(0);
    const failureSummary = (await db.pool.query('SELECT lifecycle_error,installed_version,manifest_json FROM plugin_installs WHERE plugin_id=$1',[plugin.id])).rows;
    const failureJournal = (await db.pool.query("SELECT id,metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND event_type='migration_failed' ORDER BY id",[plugin.id])).rows;
    const migrations = (await db.pool.query('SELECT migration_id,status,error_message FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id',[plugin.id])).rows;
    await expect(migrateOperationPlugin(db.pool, plugin)).rejects.toMatchObject({
      statusCode: 409
    });
    expect((await db.pool.query('SELECT lifecycle_error,installed_version,manifest_json FROM plugin_installs WHERE plugin_id=$1',[plugin.id])).rows).toEqual(failureSummary);
    expect((await db.pool.query("SELECT id,metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND event_type='migration_failed' ORDER BY id",[plugin.id])).rows).toEqual(failureJournal);
    expect((await db.pool.query('SELECT migration_id,status,error_message FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id',[plugin.id])).rows).toEqual(migrations);
    await migrateOperationPlugin(db.pool, plugin, {
      repairFailed: true
    });
    expect((await call('write')).statusCode).toBe(200);
  });
  it('uses nonwaiting install serialization and bounded PostgreSQL lock_timeout', async () => {
    const lock = await db.pool.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`plugin-install:${plugin.id}`]);
    try {
      await expect(migrateOperationPlugin(db.pool, plugin)).rejects.toMatchObject({
        statusCode: 409
      });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const held = await db.pool.connect();
    await held.query('BEGIN');
    await held.query('LOCK TABLE plugin_operation_probe.records IN ACCESS SHARE MODE');
    const update = {
      ...plugin,
      version: '1.1.0',
      operationManifest: {
        ...plugin.operationManifest!,
        version: '1.1.0',
        migrations: ['0000_unusual_joseph', '0001_index']
      },
      migrations: [...plugin.migrations!, {
        id: '0001_index',
        sql: 'ALTER TABLE records ADD COLUMN extra text'
      }]
    };
    try {
      await expect(migrateOperationPlugin(db.pool, update, {
        lockTimeoutMs: 50
      })).rejects.toMatchObject({
        code: '55P03'
      });
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
    expect((await db.pool.query("SELECT lifecycle_state FROM plugin_installs WHERE plugin_id=$1", [plugin.id])).rows[0].lifecycle_state).toBe('migration_error');
  });
  it.each([['installing','install'],['migrated','reconcile']] as const)('attributes %s failures to their lifecycle phase without inventing a failed migration', async (state,phase) => {
    const before = (await db.pool.query('SELECT migration_id,status,checksum FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id',[plugin.id])).rows;
    await db.pool.query(`CREATE FUNCTION public.reject_probe_phase() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.plugin_id='operation_probe' AND NEW.lifecycle_state='${state}' THEN
        RAISE EXCEPTION 'injected lifecycle failure' USING ERRCODE='P9001';
      END IF;
      RETURN NEW;
    END $$`);
    await db.pool.query('CREATE TRIGGER reject_probe_phase BEFORE UPDATE ON plugin_installs FOR EACH ROW EXECUTE FUNCTION public.reject_probe_phase()');
    try {
      await expect(migrateOperationPlugin(db.pool,plugin)).rejects.toMatchObject({code:'P9001'});
      expect((await db.pool.query('SELECT migration_id,status,checksum FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id',[plugin.id])).rows).toEqual(before);
      const event = (await db.pool.query("SELECT metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND event_type='migration_failed' AND metadata_json->>'error_code'='P9001' ORDER BY created_at DESC LIMIT 1",[plugin.id])).rows[0];
      expect(event.metadata_json).toEqual({phase,migration_id:null,error_code:'P9001'});
      expect((await db.pool.query('SELECT lifecycle_state FROM plugin_installs WHERE plugin_id=$1',[plugin.id])).rows[0].lifecycle_state).toBe('migration_error');
    } finally {
      await db.pool.query('DROP TRIGGER reject_probe_phase ON plugin_installs');
      await db.pool.query('DROP FUNCTION public.reject_probe_phase()');
    }
  });
  it('accepts/rejects plugin proposals with the real canonical applier, atomic result and concurrent decisions', async () => {
    const key = randomUUID(),
      created = await call('propose', {
        value: 'approved'
      }, key);
    expect(created.statusCode, created.body).toBe(202);
    expect((await records()).rows).toHaveLength(0);
    const service = PgProposalApplyService.fromConfig(config, host),
      id = created.json().proposal_id as string;
    const results = await Promise.allSettled([service.accept(id, {
      spaceId: space,
      userId: user
    }), service.accept(id, {
      spaceId: space,
      userId: user
    })]);
    expect(results.some(r => r.status === 'fulfilled' && r.value)).toBe(true);
    expect((await records()).rows.map(r => r.value)).toEqual(['approved']);
    expect((await call('propose', {
      value: 'approved'
    }, key)).json()).toEqual({
      status: 'succeeded',
      data: {
        values: ['approved']
      }
    });
    const second = await call('propose', {
      key: 'rejected',
      value: 'no'
    });
    await service.reject(second.json().proposal_id, {
      spaceId: space,
      userId: user
    });
    expect((await records()).rows.map(r => r.value)).toEqual(['approved']);
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [second.json().proposal_id])).rows[0].state).toBe('rejected');
    expect(service.supportedProposalTypes().has(proposalType)).toBe(true);
  });
  it('rolls plugin data/Job/result back on invalid approved output and retains independent failure audit', async () => {
    const created = await call('propose', {
        value: 'bad-output'
      }),
      id = created.json().proposal_id;
    host.getBackground(plugin.id)!.proposalExecutors.set(proposalType, async (_input, ctx) => {
      await ctx.db.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),'bad','bad')");
      await ctx.jobs!.enqueue(jobId, {
        value: 'bad'
      });
      return {
        invalid: true
      };
    });
    await expect(PgProposalApplyService.fromConfig(config, host).accept(id, {
      spaceId: space,
      userId: user
    })).rejects.toThrow();
    expect((await records()).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT 1 FROM jobs WHERE space_id=$1 AND job_type=$2', [space, jobId])).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [id])).rows[0].status).toBe('pending');
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('pending_approval');
    expect((await db.pool.query("SELECT 1 FROM policy_decision_records WHERE action='plugin.operation_probe.record.propose' AND space_id=$1 AND metadata_json->>'operation_outcome'='failed'", [space])).rows).toHaveLength(1);
  });
  it('uses the same config-local canonical applier from the actual REST decision route', async () => {
    const submitted = await call('propose', {
      value: 'rest-approved'
    });
    __setProposalIdentityForTests({
      spaceId: space,
      userId: user
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/proposals/${submitted.json().proposal_id}/accept`,
      payload: {}
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await records()).rows.map(r => r.value)).toEqual(['rest-approved']);
  });
  it('carries a human conversation decision through the real Agent adapter and canonical plugin applier', async () => {
    const allowed = ['plugin.operation_probe.record.propose', 'proposal.list_pending', 'proposal.decide'];
    const grants = await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    }, {
      db: db.pool,
      spaceId: space,
      userId: user,
      config
    });
    const runId = randomUUID(),
      session = randomUUID();
    await seedRun(db.pool, {
      id: runId,
      space,
      owner: user,
      agent: randomUUID(),
      version: randomUUID()
    });
    await db.pool.query("INSERT INTO sessions(id,space_id,user_id,status,created_at,updated_at) VALUES($1,$2,$3,'active',now(),now())", [session, space, user]);
    await db.pool.query("UPDATE runs SET status='running',session_id=$4,project_id=$5,instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1", [runId, user, JSON.stringify({
      tool_grants: grants
    }), session, project]);
    const token = await new PgRunToolIdentityRepository(db.pool).issue({
      id: runId,
      space_id: space
    }, 60000);
    const invoke = (tool: string, payload: object) => app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/tools/${tool}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID()
      },
      payload
    });
    const submitted = await invoke(allowed[0]!, {
      value: 'agent-approved'
    });
    expect(submitted.statusCode, submitted.body).toBe(202);
    const listed = await invoke('proposal.list_pending', {});
    expect(listed.statusCode, listed.body).toBe(200);
    const id = listed.json().proposals[0].proposal_id;
    const decision = await invoke('proposal.decide', {
      proposal_id: id,
      decision: 'accept'
    });
    expect(decision.statusCode, decision.body).toBe(200);
    expect((await records()).rows.map(r => r.value)).toEqual(['agent-approved']);
    expect((await db.pool.query('SELECT state FROM operation_idempotency WHERE proposal_id=$1', [id])).rows[0].state).toBe('succeeded');
  });
  it('preserves frozen plugin grants when adding only change-discovery read tools', async () => {
    const runId = randomUUID();
    await seedRun(db.pool, {
      id: runId,
      space,
      owner: user,
      agent: randomUUID(),
      version: randomUUID()
    });
    const frozen = {
      action_id: 'plugin.operation_probe.record.write',
      approval_behavior: 'none',
      side_effecting: true,
      capability_id: null
    };
    await db.pool.query("UPDATE runs SET status='queued',instructed_by_user_id=$2,capabilities_json=$3::jsonb,permission_snapshot_json=$4::jsonb WHERE id=$1", [runId, user, JSON.stringify([frozen.action_id]), JSON.stringify({
      tool_grants: [frozen],
      scenario_tool_allowance: [frozen.action_id]
    })]);
    await grantRunChangeReadTools(db.pool, {
      space_id: space,
      id: runId
    });
    const grants = (await db.pool.query('SELECT permission_snapshot_json FROM runs WHERE id=$1', [runId])).rows[0].permission_snapshot_json.tool_grants;
    expect(grants).toContainEqual(frozen);
    expect(grants.map((g: {
      action_id: string;
    }) => g.action_id)).toEqual(expect.arrayContaining(['input_resource.read', 'input_resource.search']));
  });
  it('atomically enqueues through a narrow host domain port, then runs the canonical JobWorker', async () => {
    const key = randomUUID(),
      created = await call('enqueue', {
        value: 'job'
      }, key);
    expect(created.statusCode, created.body).toBe(200);
    expect((await call('enqueue', {
      value: 'job'
    }, key)).json()).toEqual(created.json());
    const registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), registry, 'probe-worker', [jobId]);
    expect((await worker.processOne()).status).toBe('completed');
    expect((await records()).rows.map(r => r.value)).toEqual(['job']);
    expect((await db.pool.query('SELECT status FROM jobs WHERE id=$1', [created.json().data.jobId])).rows[0].status).toBe('completed');
    expect((await db.pool.query('SELECT count(*) FROM jobs WHERE job_type=$1 AND space_id=$2', [jobId, space])).rows[0].count).toBe('1');
  });
  it('host schedule fans out only to enabled scopes; disable cancels running SQL and disposes LIFO', async () => {
    const queue = new PgJobQueueRepository(db.pool),
      registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    await host.getSchedulerTasks()[0]!.run();
    const scheduled = (await db.pool.query('SELECT id FROM jobs WHERE job_type=$1 AND space_id=$2', [jobId, space])).rows;
    expect(scheduled).toHaveLength(1);
    await queue.cancelJob(scheduled[0]!.id, null);
    const running = await queue.enqueue({
      job_type: jobId,
      space_id: space,
      user_id: user,
      payload: {
        value: 'cancelled',
        hold: true
      }
    });
    const worker = new JobWorker(queue, registry, 'cancel-worker', [jobId]);
    const execution = worker.processOne();
    await expect.poll(() => observed.includes('started')).toBe(true);
    await setOperationPluginEnabled(config, plugin.id, space, user, false);
    expect(await execution).toMatchObject({
      job_id: running.id
    });
    expect(observed.slice(-2)).toEqual(['second', 'first']);
    expect((await queue.getJob(running.id))!.status).toBe('cancelled');
    expect((await records()).rows).toHaveLength(0);
    const before = (await db.pool.query('SELECT count(*) FROM jobs WHERE job_type=$1 AND space_id=$2', [jobId, space])).rows[0].count;
    await host.getSchedulerTasks()[0]!.run();
    expect((await db.pool.query('SELECT count(*) FROM jobs WHERE job_type=$1 AND space_id=$2', [jobId, space])).rows[0].count).toBe(before);
  });
  const cleanupJobs = () => db.pool.query<{id: string; status: string; attempts: number; payload_json: Record<string, unknown>}>("SELECT id,status,attempts,payload_json FROM jobs WHERE job_type='official_plugin_scope_cleanup' AND space_id=$1 ORDER BY created_at", [space]);
  const cleanupEvents = (type: string) => db.pool.query<{metadata_json: Record<string, unknown>}>("SELECT metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type=$3 ORDER BY created_at", [plugin.id, space, type]);
  const holdRow = (id: string) => db.pool.query<{state: string; attempts: number; needs_attention: boolean; owner_instance: string}>('SELECT state,attempts,needs_attention,owner_instance FROM official_plugin_scope_holds WHERE id=$1', [id]).then(r => r.rows[0]!);
  const cleanupHandler = (cfg = config) => {
    const registry = new JobHandlerRegistry();
    registerPluginScopeCleanupHandler(registry, cfg);
    return registry;
  };
  const cleanupEnvelope = (row: {id: string; payload_json: Record<string, unknown>}, attempts = 1) => ({job_id: row.id, space_id: space, user_id: user, job_type: 'official_plugin_scope_cleanup', attempts, max_attempts: 3, worker_id: 'w', payload: row.payload_json});
  const makeDue = (id: string) => db.pool.query('UPDATE jobs SET scheduled_at=$2 WHERE id=$1', [id, new Date(Date.now() - 60_000).toISOString()]);
  /** The durable clock of a hold's next automatic attempt, moved past (the retry interval elapsed). */
  const holdDue = (id: string) => db.pool.query("UPDATE official_plugin_scope_holds SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [id]);
  /** Admits a resource the way a Job does, then lets that Job end (the resource outlives it). */
  const admitted = async (bg = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user}) => {
    const entry = await bg.admit(scope);
    if (!entry) throw new Error('not admitted');
    return entry;
  };
  const cleanupRead = async (target = app) => (await target.inject({method: 'GET', url: '/api/v1/plugins'})).json().items.find((i: {descriptor: {id: string}}) => i.descriptor.id === plugin.id).cleanup;
  /** Another server process on the same database: its own PluginHost, effects and owner lease. */
  async function otherProcess(withHost = true, legacy?: LegacyResourceConsumer) {
    const cfg = loadConfig({SERVER_DATABASE_URL: db.connectionUri});
    const target = buildModuleServer(cfg, [systemActionsModule, runsModule, proposalsModule, pluginsModule]);
    const seen: string[] = [];
    const processHost = new PluginHost(withHost ? [createLifecycleProbe(x => seen.push(x), legacy)] : []);
    processHost.activate(target, cfg);
    await target.ready();
    extraApps.push(target);
    return {cfg, app: target, seen, host: processHost, background: processHost.getBackground(plugin.id), close: async () => { extraApps.splice(extraApps.indexOf(target), 1); await target.close(); }};
  }
  it('drains a resource a running Job registers after its hold began closing before the disable reports done', async () => {
    const queue = new PgJobQueueRepository(db.pool), registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    const running = await queue.enqueue({job_type: jobId, space_id: space, user_id: user, payload: {value: 'late', hold: true, late: true}});
    const execution = new JobWorker(queue, registry, 'late-worker', [jobId]).processOne();
    await expect.poll(() => observed.includes('started')).toBe(true);
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
    // The Job registered `late` after the drain had run `second`/`first`: it was still drained, before done.
    expect(observed.slice(-3)).toEqual(['second', 'first', 'late']);
    expect(await execution).toMatchObject({job_id: running.id});
    expect((await db.pool.query("SELECT state FROM official_plugin_scope_holds WHERE plugin_id=$1 AND space_id=$2", [plugin.id, space])).rows.map(r => r.state)).toEqual(['released']);
    expect(host.getBackground(plugin.id)!.effects.unreleased(plugin.id)).toEqual({failed: 0, inflight: 0});
  });
  it('retains a failed, unreleased hold and lets the recovery Job retry only what did not finish (partial multi-scope)', async () => {
    const background = host.getBackground(plugin.id)!, other = randomUUID();
    const seen: string[] = [];
    let failOnce = true;
    const mine = await admitted();
    mine.onDispose(() => { seen.push('first'); });
    mine.onDispose(() => {
      seen.push('second');
      if (failOnce) { failOnce = false; throw new Error('private failure'); }
    });
    mine.onDispose(() => { seen.push('third'); });
    mine.leave();
    // A second scope of the same Space plugin, released on the first attempt.
    const theirs = await admitted(background, {spaceId: space, userId: other});
    theirs.onDispose(() => { seen.push('other'); });
    theirs.leave();
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    expect(seen.filter(x => x !== 'other')).toEqual(['third', 'second', 'first']);
    expect(seen.filter(x => x === 'other')).toEqual(['other']);
    expect((await cleanupEvents('scope_cleanup_failed')).rows.map(r => r.metadata_json)).toEqual([{outcome: 'failed', attempts: 1}]);
    expect(await holdRow(theirs.hold)).toMatchObject({state: 'released'});
    expect(await holdRow(mine.hold)).toMatchObject({state: 'releasing', attempts: 1, needs_attention: false});
    // Not released: retained, its old generation admits nothing, reenable refused durably.
    expect(background.effects.unreleased(plugin.id)).toEqual({failed: 1, inflight: 0});
    expect(() => background.effects.enter(plugin.id, {spaceId: space, userId: user}, mine.hold)).toThrow('closing');
    expect(await background.admit({spaceId: space, userId: user})).toBeNull();
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    expect(await cleanupRead()).toEqual({state: 'pending', pending: 1, attention: 0, awaiting_restart: 0, last_attempt_at: expect.any(String)});
    const [job] = (await cleanupJobs()).rows;
    expect(job!.status).toBe('pending');
    // The real worker of the owning process runs the Job once the hold's retry is due: only the failed callback is retried.
    await makeDue(job!.id);
    await holdDue(mine.hold);
    const worker = new JobWorker(new PgJobQueueRepository(db.pool), cleanupHandler(), 'cleanup-worker', ['official_plugin_scope_cleanup']);
    expect((await worker.processOne()).status).toBe('completed');
    expect(seen.slice(4)).toEqual(['second']);
    expect((await db.pool.query('SELECT result_json FROM jobs WHERE id=$1', [job!.id])).rows[0].result_json).toEqual({settled: true, released: 2, owner_gone: 0});
    expect(background.effects.unreleased(plugin.id)).toEqual({failed: 0, inflight: 0});
    expect(await cleanupRead()).toBeNull();
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    expect((await call('write')).statusCode).toBe(200);
    const fresh = await admitted();
    fresh.leave();
    expect(fresh.hold).not.toBe(mine.hold);
    expect(fresh.signal.aborted).toBe(false);
  });
  it('shares one durable attempt counter across timer, Job and request: at most three per round, then only a new round retries', async () => {
    // The owner's recovery runs from its real interval timer under a fake clock; due times are the hold's durable clock.
    vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
    __setPluginScopeOwnerTickForTests(2_000);
    let owner: Awaited<ReturnType<typeof otherProcess>>;
    try { owner = await otherProcess(); } finally { __setPluginScopeOwnerTickForTests(null); }
    try {
      let broken = true, calls = 0;
      const resource = await admitted(owner.background!);
      resource.onDispose(() => {
        calls++;
        if (broken) throw new Error('still held at /srv/private/path');
      });
      resource.leave();
      const queue = new PgJobQueueRepository(db.pool);
      const worker = new JobWorker(queue, cleanupHandler(owner.cfg), 'cleanup-worker', ['official_plugin_scope_cleanup']);
      const timerPass = async () => { await vi.advanceTimersByTimeAsync(2_000); await pluginScopeOwnerTick(owner.cfg); };
      const latestJob = async () => (await cleanupJobs()).rows.at(-1)!;
      const runJob = async () => { const job = await latestJob(); await makeDue(job.id); return (await worker.processOne()).status; };
      // (a) Timer first: request attempt 1, then the timer's two due passes; nothing retries before it is due.
      expect(await setOperationPluginEnabled(owner.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
      expect(calls).toBe(1);
      await timerPass();
      expect(calls).toBe(1);
      for (let i = 0; i < 2; i++) { await holdDue(resource.hold); await timerPass(); }
      expect(calls).toBe(3);
      expect(await holdRow(resource.hold)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
      // The Job then claims nothing: no fourth attempt, it fails visibly once its own attempts run out.
      for (let i = 0; i < 3; i++) { await holdDue(resource.hold); await runJob(); }
      expect(calls).toBe(3);
      expect((await latestJob())).toMatchObject({status: 'failed', attempts: 3});
      await holdDue(resource.hold);
      await timerPass();
      expect(calls).toBe(3);
      expect((await cleanupEvents('scope_cleanup_failed')).rows.map(r => r.metadata_json.attempts)).toEqual([1, 2, 3]);
      expect((await cleanupEvents('scope_cleanup_needs_attention')).rows.map(r => r.metadata_json)).toEqual([{outcome: 'failed', attempts: 3}]);
      const read = await cleanupRead(owner.app);
      expect(read).toEqual({state: 'needs_attention', pending: 0, attention: 1, awaiting_restart: 0, last_attempt_at: expect.any(String)});
      expect(JSON.stringify(read)).not.toMatch(/private|srv|instance|owner/);
      await expect(setOperationPluginEnabled(owner.cfg, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
      expect(await owner.background!.admit({spaceId: space, userId: user})).toBeNull();
      // (b) A new round, Job first: request 1, Job 2 (deferred, not failed), Job 3, then the timer adds none.
      expect(await setOperationPluginEnabled(owner.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
      expect(calls).toBe(4);
      expect(await runJob()).toBe('deferred');
      expect(calls).toBe(4);
      await holdDue(resource.hold);
      expect(await runJob()).toBe('deferred');
      await holdDue(resource.hold);
      expect(await runJob()).toBe('failed');
      expect(calls).toBe(6);
      await holdDue(resource.hold);
      await timerPass();
      expect(calls).toBe(6);
      expect(await holdRow(resource.hold)).toMatchObject({attempts: 3, needs_attention: true});
      // (c) A new round, every entry at once: one claim per due attempt, never a double count or re-entry.
      expect(await setOperationPluginEnabled(owner.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
      expect(calls).toBe(7);
      const handler = cleanupHandler(owner.cfg).get('official_plugin_scope_cleanup')!;
      for (let i = 0; i < 3; i++) {
        await holdDue(resource.hold);
        const job = await latestJob();
        await Promise.allSettled([timerPass(), handler(cleanupEnvelope(job)), handler(cleanupEnvelope(job)), pluginScopeOwnerTick(owner.cfg)]);
      }
      expect(calls).toBe(9);
      expect(await holdRow(resource.hold)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
      // (d) Repair: a new round retries the retained resource; the done callback state never reruns a success.
      broken = false;
      expect(await setOperationPluginEnabled(owner.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
      expect(calls).toBe(10);
      expect(await holdRow(resource.hold)).toMatchObject({state: 'released', needs_attention: false});
      await holdDue(resource.hold);
      await timerPass();
      expect(calls).toBe(10);
      expect(await cleanupRead(owner.app)).toBeNull();
      await setOperationPluginEnabled(owner.cfg, plugin.id, space, user, true);
      const fresh = await admitted(owner.background!);
      fresh.leave();
      expect(fresh.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('disposes outside every DB transaction: callback DB writes do not wait, and a concurrent enable keeps its order', async () => {
    const enablement = (await db.pool.query<{id: string}>("SELECT id FROM official_plugin_enablements WHERE plugin_id=$1 AND space_id=$2", [plugin.id, space])).rows[0]!.id;
    let release!: () => void, inside!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { inside = resolve; });
    const observedLocks: unknown[] = [];
    const resource = await admitted();
    resource.onDispose(async () => {
      // No other backend holds any lock on the enablement or hold tables, nor an open transaction.
      observedLocks.push((await db.pool.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE c.relname IN ('official_plugin_enablements','official_plugin_scope_holds') AND l.pid<>pg_backend_pid()")).rows[0].n);
      observedLocks.push((await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state LIKE 'idle in transaction%'")).rows[0].n);
      // A dispose that writes the same rows in another connection must not wait on the cleanup.
      await withTransaction(db.pool, async tx => {
        await tx.query("SET LOCAL lock_timeout='1s'");
        await tx.query('UPDATE official_plugin_enablements SET updated_at=now() WHERE id=$1', [enablement]);
        await tx.query('UPDATE official_plugin_scope_holds SET updated_at=now() WHERE id=$1', [resource.hold]);
      });
      inside();
      await gate;
    });
    resource.leave();
    const disabling = setOperationPluginEnabled(config, plugin.id, space, user, false);
    await entered;
    const enabling = setOperationPluginEnabled(config, plugin.id, space, user, true);
    // Queued in this process behind the disable's transition (no PostgreSQL wait to observe); a bounded 100ms window.
    await new Promise(resolve => setTimeout(resolve, 100));
    // The enable is ordered behind the slow cleanup: not committed while it runs.
    expect((await pluginServiceFor(config).isEnabled(db.pool, plugin.id, space, user)).enabled).toBe(false);
    release();
    expect(await disabling).toMatchObject({cleanup_pending: false});
    await enabling;
    expect(observedLocks).toEqual([0, 0]);
    expect((await pluginServiceFor(config).isEnabled(db.pool, plugin.id, space, user)).enabled).toBe(true);
    expect((await cleanupJobs()).rows.map(r => r.status)).toEqual(['cancelled']);
  });
  it('fences generations across processes: an old round never closes a newer hold, and old-generation work cannot commit', async () => {
    const b = await otherProcess();
    const a = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    const disposed: string[] = [];
    let openA!: () => void, inA!: () => void;
    const gateA = new Promise<void>(resolve => { openA = resolve; });
    const insideA = new Promise<void>(resolve => { inA = resolve; });
    const holdA1 = await admitted(a, scope);
    holdA1.onDispose(async () => { disposed.push('a1'); inA(); await gateA; });
    holdA1.leave();
    const holdB1 = await admitted(b.background!, scope);
    holdB1.onDispose(() => { disposed.push('b1'); });
    holdB1.leave();
    expect(holdB1.hold).not.toBe(holdA1.hold);
    // Process B disables: it releases its own hold; A's stays an obligation for A (B cannot touch A's memory).
    expect(await setOperationPluginEnabled(b.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    expect(disposed).toEqual(['b1']);
    expect(holdA1.signal.aborted).toBe(false);
    expect(await holdRow(holdA1.hold)).toMatchObject({state: 'releasing'});
    // Cross-process: neither process may reenable while A's resources are not released.
    await expect(setOperationPluginEnabled(b.cfg, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // A's own recovery releases it, with no transaction or lock held across the slow dispose.
    const tick = pluginScopeOwnerTick(config);
    await insideA;
    expect((await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state LIKE 'idle in transaction%'")).rows[0].n).toBe(0);
    await expect(setOperationPluginEnabled(b.cfg, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    openA();
    await tick;
    expect(await holdRow(holdA1.hold)).toMatchObject({state: 'released'});
    const [oldRound] = (await cleanupJobs()).rows;
    // Process B enables; process A admits new work under a new hold of the new generation.
    await setOperationPluginEnabled(b.cfg, plugin.id, space, user, true);
    const holdA2 = await admitted(a, scope);
    holdA2.onDispose(() => { disposed.push('a2'); });
    holdA2.leave();
    expect(holdA2.hold).not.toBe(holdA1.hold);
    expect(await pluginScopeHoldCurrent(db.pool, config, holdA1.hold, holdA1.instance)).toBe(false);
    expect(await pluginScopeHoldCurrent(db.pool, config, holdA2.hold, holdA2.instance)).toBe(true);
    // The old round replayed by either process (a crash retry) and A's recovery again: nothing of the new hold.
    expect(await cleanupHandler().get('official_plugin_scope_cleanup')!(cleanupEnvelope(oldRound!))).toEqual({settled: true, released: 2, owner_gone: 0});
    expect(await cleanupHandler(b.cfg).get('official_plugin_scope_cleanup')!(cleanupEnvelope(oldRound!))).toEqual({settled: true, released: 2, owner_gone: 0});
    await pluginScopeOwnerTick(config);
    expect(holdA2.signal.aborted).toBe(false);
    expect(disposed).toEqual(['b1', 'a1']);
    // A real Job of the old generation that reaches its commit after disable+enable is refused there.
    await withTransaction(db.pool, async tx => {
      await lockOperationPluginScope(tx, plugin.id, space, user, config);
      expect(await operationPluginEnabled(tx, plugin.id, space, user, config)).toBe(true);
      expect(await pluginScopeHoldCurrent(tx, config, holdA1.hold, holdA1.instance)).toBe(false);
    });
    // The next disable (from A) releases exactly the new hold.
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
    expect(disposed).toEqual(['b1', 'a1', 'a2']);
  });
  it('keeps an obligation of a live owner: wrong-worker claims defer, cancel/exhaust keep it visible, a verified owner end settles it as owner_gone', async () => {
    const b = await otherProcess();
    const c = await otherProcess(false);
    const scope = {spaceId: space, userId: user};
    let brokenA = true, brokenB = true, callsA = 0, callsB = 0;
    const holdA = await admitted(host.getBackground(plugin.id)!, scope);
    holdA.onDispose(() => { callsA++; if (brokenA) throw new Error('held A'); });
    holdA.leave();
    const holdB = await admitted(b.background!, scope);
    holdB.onDispose(() => { callsB++; if (brokenB) throw new Error('held B'); });
    holdB.leave();
    // A disables: its own release fails; B's resource is B's to release.
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    expect([callsA, callsB]).toEqual([1, 0]);
    const [round1] = (await cleanupJobs()).rows;
    await makeDue(round1!.id);
    const queue = new PgJobQueueRepository(db.pool);
    // A worker of process C (holding nothing) claims it: both owners are alive, so it defers without spending an attempt.
    const workerC = new JobWorker(queue, cleanupHandler(c.cfg), 'worker-c', ['official_plugin_scope_cleanup']);
    expect((await workerC.processOne()).status).toBe('deferred');
    expect((await queue.getJob(round1!.id))!).toMatchObject({status: 'pending', attempts: 0});
    expect([await holdRow(holdA.hold), await holdRow(holdB.hold)].map(h => h.state)).toEqual(['releasing', 'releasing']);
    expect([callsA, callsB]).toEqual([1, 0]);
    // The Job is cancelled outright: the obligation is the hold, not the Job.
    await queue.cancelJob(round1!.id, null);
    expect(await cleanupRead()).toEqual({state: 'pending', pending: 2, attention: 0, awaiting_restart: 0, last_attempt_at: expect.any(String)});
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // Owner recovery: B releases its own once it can; A keeps failing until its bounded attempts mark attention.
    brokenB = false;
    await pluginScopeOwnerTick(b.cfg);
    expect(await holdRow(holdB.hold)).toMatchObject({state: 'released'});
    for (let i = 0; i < 2; i++) {
      await db.pool.query("UPDATE official_plugin_scope_holds SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [holdA.hold]);
      await pluginScopeOwnerTick(config);
    }
    expect(callsA).toBe(3);
    expect(await holdRow(holdA.hold)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
    expect(await cleanupRead()).toEqual({state: 'needs_attention', pending: 0, attention: 1, awaiting_restart: 0, last_attempt_at: expect.any(String)});
    // A retry round through the product route resets it; C's exhausted attempt never settles A's live hold.
    const retried = await app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/disable`, headers: {'idempotency-key': randomUUID()}, payload: {}});
    expect(retried.json()).toMatchObject({status: 'succeeded', data: {cleanup_pending: true}});
    expect(callsA).toBe(4);
    for (let i = 0; i < 2; i++) {
      await db.pool.query("UPDATE official_plugin_scope_holds SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [holdA.hold]);
      await pluginScopeOwnerTick(config);
    }
    expect(await holdRow(holdA.hold)).toMatchObject({state: 'releasing', needs_attention: true});
    const round2 = (await cleanupJobs()).rows.at(-1)!;
    await expect(cleanupHandler(c.cfg).get('official_plugin_scope_cleanup')!(cleanupEnvelope(round2, 3))).rejects.toThrow('did not release');
    expect(await holdRow(holdA.hold)).toMatchObject({state: 'releasing', needs_attention: true});
    // Owner A ends (its process stops; the failed resource could not be released). Its lease is gone.
    const instanceA = (await holdRow(holdA.hold)).owner_instance;
    await app.close().catch(() => {});
    // A restarted process has a new owner identity: it cannot claim A's hold as its own.
    const restarted = await otherProcess();
    expect(await pluginScopeOwnerInstance(restarted.cfg)).not.toBe(instanceA);
    const handlerC = cleanupHandler(c.cfg).get('official_plugin_scope_cleanup')!;
    // First observation of the free lease: grace, not settled.
    await expect(handlerC(cleanupEnvelope(round2, 1))).rejects.toThrow('waits for its owner');
    expect(await holdRow(holdA.hold)).toMatchObject({state: 'releasing'});
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [holdA.hold]);
    expect(await handlerC(cleanupEnvelope(round2, 1))).toEqual({settled: true, released: 0, owner_gone: 1});
    expect(await holdRow(holdA.hold)).toMatchObject({state: 'owner_gone'});
    expect((await cleanupEvents('scope_cleanup_owner_gone')).rows).toHaveLength(1);
    expect(await cleanupRead(restarted.app)).toBeNull();
    await setOperationPluginEnabled(restarted.cfg, plugin.id, space, user, true);
  });
  const leaseLocks = (instance: string, granted = true) => db.pool.query<{pid: number}>(`SELECT l.pid FROM pg_locks l, (SELECT hashtextextended($1::text,0) AS k) s
      WHERE l.locktype='advisory' AND ($2::boolean IS FALSE OR l.granted) AND l.objsubid=1 AND l.classid::bigint=((s.k>>32)&4294967295) AND l.objid::bigint=(s.k&4294967295)`, [`plugin-scope-owner:${instance}`, granted]);
  it('checks its lease apart from a busy cleanup pass, proves it in every admission and commit, and adopts what a lost lease still holds before any foreign settlement', async () => {
    const background = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    // A second Space of the same owner whose cleanup hangs: the recovery pass is busy on it for its whole deadline.
    const space2 = randomUUID();
    await db.pool.query("INSERT INTO spaces(id,name,type,created_at,updated_at) VALUES($1,'Second','personal',now(),now())", [space2]);
    await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,'owner','active',now(),now())", [space2, user]);
    await setOperationPluginEnabled(config, plugin.id, space2, user, true);
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const disposed: string[] = [];
    const slow = await admitted(background, {spaceId: space2, userId: user});
    slow.onDispose(async () => { disposed.push('slow'); await gate; });
    slow.leave();
    const blocker = await db.pool.connect();
    try {
      expect(await setOperationPluginEnabled(config, plugin.id, space2, user, false)).toMatchObject({cleanup_pending: true});
      // Another scope stays enabled: an active hold and a running Job admitted under the current lease.
      const active = await admitted(background, scope);
      active.onDispose(() => { disposed.push('active'); });
      active.leave();
      const queue = new PgJobQueueRepository(db.pool), registry = new JobHandlerRegistry();
      host.applyJobHandlers(registry);
      await queue.enqueue({job_type: jobId, space_id: space, user_id: user, payload: {value: 'after-loss', hold: true}});
      const execution = new JobWorker(queue, registry, 'lease-worker', [jobId]).processOne();
      await expect.poll(() => observed.includes('started')).toBe(true);
      await holdDue(slow.hold);
      let busyDone = false;
      const busy = pluginScopeOwnerTick(config).finally(() => { busyDone = true; });
      // The pass is inside the slow attempt (claimed, waiting on the in-flight drain) before the lease dies.
      await expect.poll(async () => (await holdRow(slow.hold)).attempts).toBe(2);
      expect(disposed).toEqual(['slow']);
      // The adoption of what this process holds is made to wait (its scope lock is busy): process B can observe the free lease.
      await blocker.query('BEGIN');
      await blocker.query("SELECT 1 FROM plugin_installs WHERE plugin_id=$1 FOR SHARE", [plugin.id]);
      // The lease's backend dies while this process lives (a dropped connection).
      const before = (await pluginScopeOwnerInstance(config))!;
      const killed = await db.pool.query<{ok: boolean}>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [(await leaseLocks(before)).rows.map(r => r.pid)]);
      expect(killed.rows.map(r => r.ok)).toEqual([true]);
      await expect.poll(async () => (await leaseLocks(before, false)).rows.length).toBe(0);
      // No lease check has run yet: the commit check itself refuses, in a transaction after the scope lock.
      await withTransaction(db.pool, async tx => {
        expect(await operationPluginEnabled(tx, plugin.id, space, user, config)).toBe(true);
        expect(await pluginScopeHoldCurrent(tx, config, active.hold, active.instance)).toBe(false);
      });
      // Admission proves the lease in its own write: refused (fail closed), and it triggers the lease check.
      await expect(background.admit(scope)).rejects.toThrow('lease is not held');
      // The lease check answers while the recovery pass is still blocked on the slow cleanup.
      const started = Date.now();
      expect(await pluginScopeLeaseCheck(config)).toBe(false);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(busyDone).toBe(false);
      // Fenced at once: every signal aborts, but no callback runs outside a claimed attempt.
      expect(active.signal.aborted).toBe(true);
      expect(disposed).toEqual(['slow']);
      // The running Job of the lost lease never commits.
      expect(await execution).toMatchObject({status: 'failed'});
      expect((await records()).rows.map(r => r.value)).not.toContain('after-loss');
      await busy;
      const after = (await pluginScopeOwnerInstance(config))!;
      expect(after).not.toBe(before);
      // Another process judges the lost lease only after its grace, as owner_gone.
      const b = await otherProcess();
      await pluginScopeOwnerTick(b.cfg);
      expect(await holdRow(slow.hold)).toMatchObject({state: 'releasing', owner_instance: before});
      await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [slow.hold]);
      await pluginScopeOwnerTick(b.cfg);
      expect(await holdRow(slow.hold)).toMatchObject({state: 'owner_gone'});
      await blocker.query('COMMIT');
      // This process continues under its fresh lease: what it still holds is adopted (scope-locked, visible, enable fenced),
      // a settled hold as a new round; its callbacks then run only in claimed attempts.
      await pluginScopeOwnerTick(config);
      expect(await holdRow(slow.hold)).toMatchObject({state: 'releasing', owner_instance: after});
      expect((await db.pool.query("SELECT metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type='scope_cleanup_reopened'", [plugin.id, space2])).rows.map(r => r.metadata_json)).toEqual([{from: 'owner_gone'}]);
      expect(await holdRow(active.hold)).toMatchObject({owner_instance: after});
      await expect.poll(() => disposed).toEqual(['slow', 'active']);
      expect(await holdRow(active.hold)).toMatchObject({state: 'released', owner_instance: after, attempts: 1});
      await expect(setOperationPluginEnabled(config, plugin.id, space2, user, true)).rejects.toMatchObject({statusCode: 409});
      const next = await admitted(background, scope);
      next.leave();
      expect(next.hold).not.toBe(active.hold);
      expect((await holdRow(next.hold)).owner_instance).toBe(after);
      expect(await pluginScopeHoldCurrent(db.pool, config, next.hold, next.instance)).toBe(true);
      // The old instance never commits again, even when its key is held by someone else (an impersonating session).
      const rogue = await db.pool.connect();
      try {
        await rogue.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`plugin-scope-owner:${before}`]);
        expect(await pluginScopeHoldCurrent(db.pool, config, active.hold, before)).toBe(false);
        await rogue.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`plugin-scope-owner:${before}`]);
      } finally { rogue.release(); }
      open();
      await expect.poll(() => background.effects.holdStatus(plugin.id, slow.hold)).toBe('released');
      await holdDue(slow.hold);
      await pluginScopeOwnerTick(config);
      expect(await holdRow(slow.hold)).toMatchObject({state: 'released', owner_instance: after});
      expect(disposed).toEqual(['slow', 'active']);
      await setOperationPluginEnabled(config, plugin.id, space2, user, true);
    } finally { open(); await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
  });
  it('holds the commit fence through COMMIT: a lease terminated after the check lets no takeover, release or settlement precede it', async () => {
    const background = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    const disposed: string[] = [];
    const resource = await admitted(background, scope);
    resource.onDispose(() => { disposed.push('resource'); });
    resource.leave();
    const b = await otherProcess();
    const job = await db.pool.connect();
    try {
      await job.query('BEGIN');
      await lockOperationPluginScope(job, plugin.id, space, user, config);
      expect(await pluginScopeHoldCurrent(job, config, resource.hold, resource.instance)).toBe(true);
      await job.query("INSERT INTO plugin_operation_probe.records(space_id,user_id,key,value) VALUES($1,$2,'fenced','old')", [space, user]);
      // A failed statement in the same transaction fails closed instead of answering.
      await job.query('SAVEPOINT s');
      await job.query('SELECT 1/0').catch(() => {});
      await expect(pluginScopeHoldCurrent(job, config, resource.hold, resource.instance)).rejects.toThrow();
      await job.query('ROLLBACK TO SAVEPOINT s');
      expect(await pluginScopeHoldCurrent(job, config, resource.hold, resource.instance)).toBe(true);
      // Barrier passed. The owner's lease backend is terminated while the old transaction is still open.
      const killed = await db.pool.query<{ok: boolean}>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [(await leaseLocks(resource.instance)).rows.map(r => r.pid)]);
      expect(killed.rows.map(r => r.ok)).toEqual([true]);
      await expect.poll(async () => (await leaseLocks(resource.instance, false)).rows.length).toBe(0);
      // The owner fences, renews and tries to adopt (and record its old rows); process B disables and runs its
      // foreign pass; a fresh check fails closed.
      expect(await pluginScopeLeaseCheck(config)).toBe(false);
      const disabling = setOperationPluginEnabled(b.cfg, plugin.id, space, user, false);
      let disabled = false, disabledAt = 0;
      void disabling.then(() => { disabled = true; disabledAt = Date.now(); }, () => { disabled = true; });
      await pluginScopeOwnerTick(b.cfg);
      await withTransaction(db.pool, async tx => {
        expect(await pluginScopeHoldCurrent(tx, config, resource.hold, resource.instance)).toBe(false);
      });
      await waitForLockWaiter(db.pool, {settled: () => disabled});
      // Nothing took effect before the old COMMIT: the hold is untouched, the disable waits, no callback ran.
      expect(await holdRow(resource.hold)).toMatchObject({state: 'active', owner_instance: resource.instance});
      expect(disabled).toBe(false);
      expect(disposed).toEqual([]);
      const committing = Date.now();
      await job.query('COMMIT');
      expect(await disabling).toMatchObject({cleanup_pending: true});
      // Every transition is ordered after that commit.
      expect((await db.pool.query("SELECT value FROM plugin_operation_probe.records WHERE key='fenced' AND space_id=$1", [space])).rows).toEqual([{value: 'old'}]);
      expect(disabledAt).toBeGreaterThanOrEqual(committing);
      expect(await holdRow(resource.hold)).toMatchObject({state: 'releasing'});
      await pluginScopeOwnerTick(config);
      expect(disposed).toEqual(['resource']);
      expect(await holdRow(resource.hold)).toMatchObject({state: 'released', attempts: 1});
      expect(await pluginScopeHoldCurrent(db.pool, config, resource.hold, resource.instance)).toBe(false);
    } finally { await job.query('ROLLBACK').catch(() => {}); job.release(); }
  });
  it('reserves the durable obligation before a late resource with retain, never reopens an ended generation, and orders it with enable and disable in either process', async () => {
    const background = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    const disposed: string[] = [];
    const old = await admitted(background, scope);
    old.onDispose(() => { disposed.push('old'); });
    old.leave();
    // (a) The closed entry registers nothing more: refused synchronously (only retain covers a later resource).
    expect(() => old.onDispose(() => { disposed.push('closed'); })).toThrow(PluginRegistrationClosed);
    // (b) The reservation's write fails in PostgreSQL: rejected, nothing pinned (the disable below releases at once).
    const trigger = `probe_fail_${randomUUID().replaceAll('-', '')}`;
    await db.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected hold write failure'; END$$`);
    await db.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON official_plugin_scope_holds FOR EACH ROW WHEN (OLD.id='${old.hold}') EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(retainPluginScopeHold(config, old)).rejects.toThrow('injected hold write failure');
    } finally {
      await db.pool.query(`DROP TRIGGER ${trigger} ON official_plugin_scope_holds`);
      await db.pool.query(`DROP FUNCTION ${trigger}()`);
    }
    // (c) The reservation is stuck inside its transaction (the hold row is busy) while process B disables: B waits
    // behind the scope locks the reservation holds; the reservation confirms the active hold, then B's round makes it
    // releasing, and B's enable is refused until the retained resource is disposed by its owner.
    const b = await otherProcess();
    const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM official_plugin_scope_holds WHERE id=$1 FOR UPDATE', [old.hold]);
      const blockerPid = (await blocker.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let kept: Awaited<ReturnType<typeof retainPluginScopeHold>> | undefined;
      const retaining = retainPluginScopeHold(config, old).then(handle => { kept = handle; return handle; });
      await waitForBlockedBy(db.pool, blockerPid, {settled: () => kept !== undefined});
      let disableSettled = false;
      const disabling = setOperationPluginEnabled(b.cfg, plugin.id, space, user, false).finally(() => { disableSettled = true; });
      await waitForLockWaiter(db.pool, {waiters: 2, settled: () => disableSettled});
      expect(kept).toBeUndefined();
      expect(disableSettled).toBe(false);
      // Pinned locally before the reservation commits: no owner path can record it released meanwhile.
      expect(background.effects.holdStatus(plugin.id, old.hold)).toBe('inflight');
      await blocker.query('COMMIT');
      const handle = await retaining;
      expect(await disabling).toMatchObject({cleanup_pending: true});
      expect(await holdRow(old.hold)).toMatchObject({state: 'releasing', owner_instance: old.instance});
      await expect(setOperationPluginEnabled(b.cfg, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
      // The late resource exists only now, under the durable obligation; same-process enable is refused too.
      handle.onDispose(() => { disposed.push('late'); });
      handle.release();
      expect(() => handle.onDispose(() => { disposed.push('after-release'); })).toThrow(PluginRegistrationClosed);
      await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
      expect(disposed).toEqual([]);
      await pluginScopeOwnerTick(config);
      expect(disposed).toEqual(['late', 'old']);
      expect(await holdRow(old.hold)).toMatchObject({state: 'released', attempts: 1});
      expect((await cleanupEvents('scope_cleanup_reopened')).rows).toEqual([]);
    } finally { await blocker.query('ROLLBACK').catch(() => {}); blocker.release(); }
    // (d) An enable checked but not committed, in this process: a reservation of the ended generation waits for its
    // commit, then is refused (never reopened); the newer generation is never touched.
    let commitEnable!: () => void;
    const enableGate = new Promise<void>(resolve => { commitEnable = resolve; });
    let checked!: () => void;
    const enableChecked = new Promise<void>(resolve => { checked = resolve; });
    const enabling = withTransaction(db.pool, async tx => {
      const out = await applyOperationPluginEnabledIn(tx, config, plugin.id, space, user, true, {});
      checked();
      await enableGate;
      return out;
    });
    await enableChecked;
    let settled = false;
    const retaining = retainPluginScopeHold(config, old).finally(() => { settled = true; });
    retaining.catch(() => {});
    await waitForLockWaiter(db.pool, {settled: () => settled});
    expect(settled).toBe(false);
    commitEnable();
    await enabling;
    await expect(retaining).rejects.toThrow('Plugin scope hold is closed');
    expect(await holdRow(old.hold)).toMatchObject({state: 'released'});
    expect(background.effects.holdStatus(plugin.id, old.hold)).toBe('released');
    expect((await cleanupEvents('scope_cleanup_reopened')).rows).toEqual([]);
    const fresh = await admitted(background, scope);
    fresh.onDispose(() => { disposed.push('fresh'); });
    expect(fresh.hold).not.toBe(old.hold);
    expect(await holdRow(fresh.hold)).toMatchObject({state: 'active'});
    expect(await pluginScopeHoldCurrent(db.pool, config, fresh.hold, fresh.instance)).toBe(true);
    expect((await call('write')).statusCode).toBe(200);
    // (e) Owner exit with a retained resource of the current generation: the exit round drains it in one claimed attempt.
    const third = await retainPluginScopeHold(config, fresh);
    fresh.leave();
    third.onDispose(() => { disposed.push('exit'); });
    third.release();
    await app.close();
    expect(disposed.slice(2)).toEqual(['exit', 'fresh']);
    expect(await holdRow(fresh.hold)).toMatchObject({state: 'released', attempts: 1});
  });
  it('counts the first run of a retained late callback against its round: three attempts across timer, Job and request, then only a new round', async () => {
    const background = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    const old = await admitted(background, scope);
    let broken = true, calls = 0;
    const kept = await retainPluginScopeHold(config, old);
    old.leave();
    kept.onDispose(() => { calls++; if (broken) throw new Error('late failure'); });
    kept.release();
    // Reserved, registered and released: nothing runs before a claimed attempt.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls).toBe(0);
    // Attempt 1 (the disable's request): the first failure already counts.
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    const round = (await db.pool.query<{release_round: string}>('SELECT release_round FROM official_plugin_scope_holds WHERE id=$1', [old.hold])).rows[0]!.release_round;
    const handler = cleanupHandler().get('official_plugin_scope_cleanup')!;
    const envelope = cleanupEnvelope({id: randomUUID(), payload_json: {plugin_id: plugin.id, space_id: space, user_id: user, round}});
    expect(calls).toBe(1);
    expect(await holdRow(old.hold)).toMatchObject({state: 'releasing', attempts: 1, needs_attention: false});
    // Not due yet: neither entry runs it again.
    await pluginScopeOwnerTick(config);
    await pluginScopeOwnerTick(config);
    await expect(handler(envelope)).rejects.toThrow('waits for its retry');
    expect(calls).toBe(1);
    // Attempt 2 (Job), attempt 3 (timer, concurrently with the Job): one claim each.
    await holdDue(old.hold);
    await expect(handler(envelope)).rejects.toThrow('waits for its retry');
    expect(calls).toBe(2);
    await holdDue(old.hold);
    await Promise.allSettled([pluginScopeOwnerTick(config), handler(envelope), pluginScopeOwnerTick(config)]);
    expect(calls).toBe(3);
    expect(await holdRow(old.hold)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
    await holdDue(old.hold);
    await pluginScopeOwnerTick(config);
    await expect(handler(envelope)).rejects.toThrow('did not release');
    expect(calls).toBe(3);
    expect((await cleanupEvents('scope_cleanup_failed')).rows.map(r => r.metadata_json.attempts)).toEqual([1, 2, 3]);
    expect(await cleanupRead()).toEqual({state: 'needs_attention', pending: 0, attention: 1, awaiting_restart: 0, last_attempt_at: expect.any(String)});
    // Only a new round (the product route's retry) runs it again.
    broken = false;
    const retried = await app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/disable`, headers: {'idempotency-key': randomUUID()}, payload: {}});
    expect(retried.json()).toMatchObject({status: 'succeeded', data: {cleanup_pending: false}});
    expect(calls).toBe(4);
    expect(await holdRow(old.hold)).toMatchObject({state: 'released'});
    // A real Job retains through its context before its late resource exists; the resource drains in the disable's attempt.
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    const queue = new PgJobQueueRepository(db.pool), registry = new JobHandlerRegistry();
    host.applyJobHandlers(registry);
    await queue.enqueue({job_type: jobId, space_id: space, user_id: user, payload: {value: 'kept', retain: true}});
    expect((await new JobWorker(queue, registry, 'retain-worker', [jobId]).processOne()).status).toBe('completed');
    expect(observed).not.toContain('retained');
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
    expect(observed.filter(x => x === 'retained')).toEqual(['retained']);
  });
  /** A gate the test opens: the original-contract consumer creates its resource only then. */
  function legacyResource(onDispose: () => void) {
    let open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const saved: (() => Promise<void>)[] = [];
    let created = 0;
    let onRegistered: (() => void) | undefined;
    const consumer: LegacyResourceConsumer = {
      create: async () => { await gate; created++; return { dispose: onDispose }; },
      registered: fn => { saved.push(fn); onRegistered?.(); },
    };
    return { consumer, saved, created: () => created, open, whenRegistered: (fn: () => void) => { onRegistered = fn; } };
  }
  const runLegacyJob = async (payload: Record<string, unknown> = {value: 'legacy', legacy: true}, h = host) => {
    const queue = new PgJobQueueRepository(db.pool), registry = new JobHandlerRegistry();
    h.applyJobHandlers(registry);
    await queue.enqueue({job_type: jobId, space_id: space, user_id: user, payload});
    expect((await new JobWorker(queue, registry, `legacy-${randomUUID()}`, [jobId]).processOne()).status).toBe('completed');
  };
  const scopeHolds = () => db.pool.query<{id: string; state: string; attempts: number; needs_attention: boolean; last_outcome: string | null}>(
    'SELECT id,state,attempts,needs_attention,last_outcome FROM official_plugin_scope_holds WHERE plugin_id=$1 AND user_id=$2 ORDER BY created_at', [plugin.id, user]).then(r => r.rows);
  it('keeps an original-contract Job registration window open after its handler returned: never released, a foreign enable refused throughout, closed only with its process', async () => {
    let disposed = 0;
    const legacy = legacyResource(() => { disposed++; });
    // Process B runs the original-contract producer and owns its hold; this process is the foreign one.
    const b = await otherProcess(true, legacy.consumer);
    await runLegacyJob(undefined, b.host);
    expect(legacy.created()).toBe(0);
    const [hold] = await scopeHolds();
    expect(hold).toMatchObject({state: 'active'});
    expect(b.background!.effects.holdStatus(plugin.id, hold!.id)).toBe('inflight');
    // The disable's request attempt drains what is registered (nothing yet) and ends without waiting on the window.
    const started = Date.now();
    expect(await setOperationPluginEnabled(b.cfg, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(await scopeHolds()).toEqual([expect.objectContaining({state: 'releasing', attempts: 1, last_outcome: 'registering'})]);
    expect(b.background!.effects.holdStatus(plugin.id, hold!.id)).toBe('registering');
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // The resource appears only now, after the handler returned and after the round began: it lands on a hold that
    // was never released, so nothing is reopened and no enable could have seen the scope clean.
    legacy.open();
    await expect.poll(() => legacy.saved.length).toBe(1);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing', attempts: 1});
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    expect(disposed).toBe(0);
    // Its first run is a claimed attempt of the round (the owner's timer pass, once due); the window stays open.
    await pluginScopeOwnerTick(b.cfg);
    expect(disposed).toBe(0);
    await holdDue(hold!.id);
    await pluginScopeOwnerTick(b.cfg);
    expect(disposed).toBe(1);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing', attempts: 2, needs_attention: false});
    // The foreign process's recovery and the cleanup Job settle nothing while the owner's lease is held.
    await pluginScopeOwnerTick(config);
    await holdDue(hold!.id);
    await pluginScopeOwnerTick(b.cfg);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
    // Exhausted, but kept only by the live owner's open window: not retryable, shown as waiting for that process.
    expect(await cleanupRead()).toEqual({state: 'awaiting_restart', pending: 0, attention: 0, awaiting_restart: 1, last_attempt_at: expect.any(String)});
    await expect(setOperationPluginEnabled(b.cfg, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // Its saved early dispose replays the success; no fourth attempt runs anywhere.
    await expect(legacy.saved[0]!()).resolves.toBeUndefined();
    expect(disposed).toBe(1);
    expect((await cleanupEvents('scope_cleanup_reopened')).rows).toEqual([]);
    // The window closes only with its process: B exits (no attempt left to claim), its lease ends, and a live owner
    // judges it owner_gone after the grace (never released); only then may the scope be enabled again.
    await b.close();
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing'});
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    await pluginScopeOwnerTick(config);
    // The owner is known gone: no longer waiting for a restart, it settles on its own (pending).
    expect(await cleanupRead()).toEqual({state: 'pending', pending: 1, attention: 0, awaiting_restart: 0, last_attempt_at: expect.any(String)});
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [hold!.id]);
    await pluginScopeOwnerTick(config);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'owner_gone'});
    // Recovered: nothing is shown any more.
    expect(await cleanupRead()).toBeNull();
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).resolves.toMatchObject({cleanup_pending: false});
    expect(disposed).toBe(1);
  });
  it('keeps an original-contract hold an obligation through a failed round write and owner exit: neither records it released', async () => {
    const seen: string[] = [];
    const legacy = legacyResource(() => { seen.push('disposed'); });
    const b = await otherProcess(true, legacy.consumer);
    await runLegacyJob(undefined, b.host);
    const [hold] = await scopeHolds();
    // Every write to the hold fails: the disable itself (the round) rolls back, nothing local is touched.
    const trigger = `probe_fail_${randomUUID().replaceAll('-', '')}`;
    await db.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected hold write failure'; END$$`);
    await db.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON official_plugin_scope_holds FOR EACH ROW WHEN (OLD.id='${hold!.id}') EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(setOperationPluginEnabled(b.cfg, plugin.id, space, user, false)).rejects.toThrow('injected hold write failure');
      expect(await holdRow(hold!.id)).toMatchObject({state: 'active', attempts: 0});
      expect(seen).toEqual([]);
    } finally {
      await db.pool.query(`DROP TRIGGER ${trigger} ON official_plugin_scope_holds`);
      await db.pool.query(`DROP FUNCTION ${trigger}()`);
    }
    // The owner exits while its window is open: the exit attempt opens a round, the hold stays releasing.
    await b.close();
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing', attempts: 1});
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // A resource that its saved context registers after the exit lands on that still-releasing hold: tracked, not
    // disposed (no lease remains), and settled owner_gone elsewhere after the grace, never released.
    legacy.open();
    await expect.poll(() => legacy.saved.length).toBe(1);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'releasing'});
    await expect(legacy.saved[0]!()).rejects.toMatchObject({name: 'PluginDisposeRefused'});
    await pluginScopeOwnerTick(config);
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [hold!.id]);
    await pluginScopeOwnerTick(config);
    expect(await holdRow(hold!.id)).toMatchObject({state: 'owner_gone'});
    expect(seen).toEqual([]);
    expect((await cleanupEvents('scope_cleanup_reopened')).rows).toEqual([]);
  });
  it('refuses a registration after a bounded-contract handler settled, so its scope is released by the disable round', async () => {
    await runLegacyJob({value: 'bounded', legacy: true});
    await expect.poll(() => observed.find(x => x.startsWith('after-return'))).toBe('after-return-refused:PluginRegistrationClosed');
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
    expect(await scopeHolds()).toEqual([expect.objectContaining({state: 'released', attempts: 1})]);
    expect(observed).not.toContain('after-return');
  });
  it('routes every early dispose through the hold\'s SQL claim: one invocation per claimed attempt across saved calls, timer and Job, at most three per round', async () => {
    const background = host.getBackground(plugin.id)!;
    const first = await admitted(background);
    first.leave();
    const hold = first.hold;
    /** Each invocation records the durable round and attempt it ran under. */
    const runs: {name: string; round: string | null; attempts: number}[] = [];
    const record = async (name: string) => {
      const row = (await db.pool.query<{release_round: string | null; attempts: number}>('SELECT release_round,attempts FROM official_plugin_scope_holds WHERE id=$1', [hold])).rows[0]!;
      runs.push({name, round: row.release_round, attempts: row.attempts});
    };
    const holdState = () => db.pool.query<{state: string; attempts: number; needs_attention: boolean; release_round: string | null; last_outcome: string | null}>(
      'SELECT state,attempts,needs_attention,release_round,last_outcome FROM official_plugin_scope_holds WHERE id=$1', [hold]).then(r => r.rows[0]!);
    // (a) Active hold: two concurrent early disposes join one claim; success resets the active counter.
    const pair = await admitted(background);
    const one = pair.onDispose(() => record('one')), two = pair.onDispose(() => record('two'));
    pair.leave();
    await Promise.all([one(), two(), one()]);
    expect(runs).toEqual([{name: 'one', round: null, attempts: 1}, {name: 'two', round: null, attempts: 1}]);
    expect(await holdState()).toMatchObject({state: 'active', attempts: 0, needs_attention: false, last_outcome: 'disposed'});
    await expect(one()).resolves.toBeUndefined();
    expect(runs).toHaveLength(2);
    // Sequential requests right after the previous caller settled: each claims its own attempt, none left pending.
    const seq = await admitted(background);
    const s1 = seq.onDispose(() => record('s1')), s2 = seq.onDispose(() => record('s2'));
    seq.leave();
    await s1();
    await s2();
    expect(runs.slice(2)).toEqual([{name: 's1', round: null, attempts: 1}, {name: 's2', round: null, attempts: 1}]);
    expect(await holdState()).toMatchObject({state: 'active', attempts: 0, last_outcome: 'disposed'});
    // (b) A failing resource: its first early run is claimed attempt 1; a repeat before it is due is refused unrun.
    let broken = true;
    const entry = await admitted(background);
    const dispose = entry.onDispose(async () => { await record('failing'); if (broken) throw new Error('early failure'); });
    entry.leave();
    await expect(dispose()).rejects.toThrow('early failure');
    expect(await holdState()).toMatchObject({state: 'active', attempts: 1, last_outcome: 'failed'});
    await expect(dispose()).rejects.toMatchObject({name: 'PluginDisposeRefused'});
    // Due: concurrent saved calls share one claim and one invocation.
    await holdDue(hold);
    const shared = await Promise.allSettled([dispose(), dispose(), dispose()]);
    expect(shared.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await holdState()).toMatchObject({attempts: 2});
    // (c) The disable opens a durable round: its request attempt 1 runs it once more.
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    const round = (await holdState()).release_round!;
    expect(await holdState()).toMatchObject({state: 'releasing', attempts: 1});
    const [job] = (await cleanupJobs()).rows;
    const handler = cleanupHandler().get('official_plugin_scope_cleanup')!;
    // Not due: saved calls, the timer and the Job all claim nothing.
    await Promise.allSettled([dispose(), pluginScopeOwnerTick(config), handler(cleanupEnvelope(job!))]);
    expect(await holdState()).toMatchObject({attempts: 1});
    // Due: a saved call, the timer pass and the Job at once claim exactly one attempt (2).
    await holdDue(hold);
    await Promise.allSettled([dispose(), pluginScopeOwnerTick(config), handler(cleanupEnvelope(job!)), dispose()]);
    expect(await holdState()).toMatchObject({attempts: 2, needs_attention: false});
    // Due: the saved call alone claims attempt 3, which marks attention.
    await holdDue(hold);
    await expect(dispose()).rejects.toThrow('early failure');
    expect(await holdState()).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
    // After attention nothing runs a fourth time, from any entry.
    await holdDue(hold);
    const after = await Promise.allSettled([dispose(), dispose(), pluginScopeOwnerTick(config), handler(cleanupEnvelope(job!))]);
    expect(after.slice(0, 2).map(r => r.status === 'rejected' && (r.reason as Error).name)).toEqual(['PluginDisposeRefused', 'PluginDisposeRefused']);
    // Every invocation corresponds to one claimed attempt: per round distinct, at most three, equal to the durable count.
    const failing = runs.filter(r => r.name === 'failing');
    expect(failing.filter(r => r.round === null).map(r => r.attempts)).toEqual([1, 2]);
    expect(failing.filter(r => r.round === round).map(r => r.attempts)).toEqual([1, 2, 3]);
    expect(await holdState()).toMatchObject({attempts: 3});
    // (d) Only a new round (the product route's retry) runs it again; its success is never repeated.
    broken = false;
    const retried = await app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/disable`, headers: {'idempotency-key': randomUUID()}, payload: {}});
    expect(retried.json()).toMatchObject({status: 'succeeded', data: {cleanup_pending: false}});
    expect(runs.filter(r => r.name === 'failing')).toHaveLength(6);
    expect(runs.at(-1)).toMatchObject({name: 'failing', attempts: 1});
    expect(runs.at(-1)!.round).not.toBe(round);
    await expect(dispose()).resolves.toBeUndefined();
    expect(runs.filter(r => r.name === 'failing')).toHaveLength(6);
    expect(await holdState()).toMatchObject({state: 'released'});
  });
  it('refuses an early dispose inside the Job transaction without running it there; the host disposes it once afterwards', async () => {
    await runLegacyJob({value: 'txn', dispose_in_txn: true});
    expect(observed).toContain('in-txn-refused:PluginDisposeRefused');
    expect(observed).not.toContain('in-txn-resolved');
    expect(observed).not.toContain('txn-disposed');
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: false});
    expect(observed.filter(x => x === 'txn-disposed')).toEqual(['txn-disposed']);
  });
  it('visits every foreign owner in rotation: twenty live owners in need of attention never starve a crashed one, a DB fault settles nothing', async () => {
    const live = Array.from({length: 20}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const crashed = 'ffffffff-0000-4000-8000-000000000000';
    // Each live owner's lease on its own connection (not the test pool's).
    const leases = live.map(() => new Client({connectionString: db.connectionUri}));
    await Promise.all(leases.map(c => c.connect()));
    const round = randomUUID();
    try {
      for (const [i, instance] of live.entries()) await leases[i]!.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`plugin-scope-owner:${instance}`]);
      // The live owners' holds are the oldest and are never updated by a probe; the crashed owner's is the newest.
      await db.pool.query(`INSERT INTO official_plugin_scope_holds(id,plugin_id,space_id,user_id,owner_instance,state,release_plugin_id,release_round,attempts,needs_attention,next_attempt_at,created_at,updated_at)
        SELECT gen_random_uuid(),$1,$2,$3,o,'releasing',$1,$4,3,true,now(),now()-interval '1 day',now()-interval '1 day' FROM unnest($5::text[]) AS o`, [plugin.id, space, user, round, live]);
      const lost = (await db.pool.query<{id: string}>(`INSERT INTO official_plugin_scope_holds(id,plugin_id,space_id,user_id,owner_instance,state,release_plugin_id,release_round,attempts,next_attempt_at,created_at,updated_at)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,'releasing',$1,$5,1,now(),now(),now()) RETURNING id`, [plugin.id, space, user, crashed, round])).rows[0]!.id;
      const crashedRow = () => db.pool.query<{state: string; owner_lost_at: string | null}>('SELECT state,owner_lost_at FROM official_plugin_scope_holds WHERE id=$1', [lost]).then(r => r.rows[0]!);
      const liveRows = () => db.pool.query<{state: string; owner_lost_at: string | null}>('SELECT state,owner_lost_at FROM official_plugin_scope_holds WHERE owner_instance=ANY($1::text[])', [live]).then(r => r.rows);
      // A DB fault on the crashed owner's rows: the pass ends there, nothing is marked lost or settled, and it returns.
      const trigger = `probe_fail_${randomUUID().replaceAll('-', '')}`;
      await db.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected judge failure'; END$$`);
      await db.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON official_plugin_scope_holds FOR EACH ROW WHEN (OLD.owner_instance='${crashed}') EXECUTE FUNCTION ${trigger}()`);
      try {
        for (let pass = 0; pass < 3; pass++) await pluginScopeOwnerTick(config);
        expect(await crashedRow()).toMatchObject({state: 'releasing', owner_lost_at: null});
      } finally {
        await db.pool.query(`DROP TRIGGER ${trigger} ON official_plugin_scope_holds`);
        await db.pool.query(`DROP FUNCTION ${trigger}()`);
      }
      // Bounded: the crashed owner is observed within two passes, settled once its grace elapsed, within two more.
      let passes = 0;
      while ((await crashedRow()).owner_lost_at === null && passes < 2) { await pluginScopeOwnerTick(config); passes++; }
      expect((await crashedRow()).owner_lost_at).not.toBeNull();
      await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [lost]);
      passes = 0;
      while ((await crashedRow()).state === 'releasing' && passes < 2) { await pluginScopeOwnerTick(config); passes++; }
      expect(await crashedRow()).toMatchObject({state: 'owner_gone'});
      // Live owners are never judged dead.
      expect((await liveRows()).map(r => [r.state, r.owner_lost_at])).toEqual(live.map(() => ['releasing', null]));
      // One owner's lease ends: it too is reached by the rotation.
      await leases[0]!.query('SELECT pg_advisory_unlock_all()');
      passes = 0;
      while (!(await liveRows()).some(r => r.owner_lost_at !== null) && passes < 2) { await pluginScopeOwnerTick(config); passes++; }
      expect((await liveRows()).filter(r => r.owner_lost_at !== null)).toHaveLength(1);
    } finally {
      for (const lease of leases) await lease.end().catch(() => {});
      await db.pool.query('DELETE FROM official_plugin_scope_holds WHERE release_round=$1', [round]);
    }
  });
  it('recovers a crashed owner releasing hold with no cleanup Job left (cancelled or exhausted) while a live owner still defers', async () => {
    const queue = new PgJobQueueRepository(db.pool);
    // (1) The round's Job is cancelled; its owner is alive: nothing settles it, enable stays fenced.
    const b = await otherProcess();
    const holdB = await admitted(b.background!);
    holdB.onDispose(() => { throw new Error('held by B'); });
    holdB.leave();
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    await queue.cancelJob((await cleanupJobs()).rows.at(-1)!.id, null);
    await pluginScopeOwnerTick(config);
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [holdB.hold]);
    await pluginScopeOwnerTick(config);
    expect(await holdRow(holdB.hold)).toMatchObject({state: 'releasing'});
    expect((await db.pool.query('SELECT owner_lost_at FROM official_plugin_scope_holds WHERE id=$1', [holdB.hold])).rows[0].owner_lost_at).toBeNull();
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({statusCode: 409});
    // B crashes. A fresh process that does not even host the plugin recovers it on its own periodic pass.
    // Its shutdown cannot release the resource (the dispose fails): the hold stays releasing, the lease ends.
    await b.close().catch(() => {});
    const fresh = await otherProcess(false);
    await pluginScopeOwnerTick(fresh.cfg);
    expect(await holdRow(holdB.hold)).toMatchObject({state: 'releasing'});
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [holdB.hold]);
    await pluginScopeOwnerTick(fresh.cfg);
    expect(await holdRow(holdB.hold)).toMatchObject({state: 'owner_gone'});
    expect(await cleanupRead()).toBeNull();
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    // (2) The round's Job exhausted (the live owner marked attention first), then the owner crashes.
    const c = await otherProcess();
    const holdC = await admitted(c.background!);
    holdC.onDispose(() => { throw new Error('held by C'); });
    holdC.leave();
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({cleanup_pending: true});
    for (let i = 0; i < 3; i++) { await holdDue(holdC.hold); await pluginScopeOwnerTick(c.cfg); }
    expect(await holdRow(holdC.hold)).toMatchObject({state: 'releasing', attempts: 3, needs_attention: true});
    const worker = new JobWorker(queue, cleanupHandler(), 'cleanup-worker', ['official_plugin_scope_cleanup']);
    const job = (await cleanupJobs()).rows.at(-1)!;
    for (let i = 0; i < 3; i++) { await makeDue(job.id); await worker.processOne(); }
    expect(await queue.getJob(job.id)).toMatchObject({status: 'failed', attempts: 3});
    await pluginScopeOwnerTick(config);
    expect(await holdRow(holdC.hold)).toMatchObject({state: 'releasing', needs_attention: true});
    await c.close().catch(() => {});
    // The same recovery: first a free observation (grace), then owner_gone, with no Job at all.
    await pluginScopeOwnerTick(config);
    expect(await holdRow(holdC.hold)).toMatchObject({state: 'releasing'});
    await db.pool.query("UPDATE official_plugin_scope_holds SET owner_lost_at=now()-interval '1 minute' WHERE id=$1", [holdC.hold]);
    await pluginScopeOwnerTick(config);
    expect(await holdRow(holdC.hold)).toMatchObject({state: 'owner_gone'});
    expect((await cleanupEvents('scope_cleanup_owner_gone')).rows).toHaveLength(2);
    expect(await cleanupRead()).toBeNull();
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE job_type='official_plugin_scope_cleanup' AND space_id=$1 AND status IN ('pending','claimed','running')", [space])).rows[0].n).toBe(0);
  });
  it('commits disable after a cleanup deadline and refuses reenable until the old cleanup finishes', async () => {
    const background = host.getBackground(plugin.id)!, scope={spaceId:space,userId:user};
    let finish!: () => void, calls = 0;
    const held = new Promise<void>(resolve => { finish=resolve; });
    const resource = await admitted(background, scope);
    resource.onDispose(()=>{ calls++; return held; });
    resource.leave();
    try {
      expect(await setOperationPluginEnabled(config,plugin.id,space,user,false)).toMatchObject({cleanup_pending:true});
      await expect(setOperationPluginEnabled(config,plugin.id,space,user,true)).rejects.toMatchObject({statusCode:409});
      expect((await pluginServiceFor(config).isEnabled(db.pool,plugin.id,space,user)).enabled).toBe(false);
      expect(() => background.effects.enter(plugin.id,scope,resource.hold)).toThrow('closing');
      // The recovery Job while that callback is still in flight: before the retry is due it only defers;
      // once due it claims attempt 2, waits, never re-invokes the callback, never completes.
      const [job] = (await cleanupJobs()).rows;
      const handler = cleanupHandler().get('official_plugin_scope_cleanup')!;
      await expect(handler(cleanupEnvelope(job!))).rejects.toThrow('waits for its retry');
      expect(await holdRow(resource.hold)).toMatchObject({state:'releasing',attempts:1});
      await holdDue(resource.hold);
      await expect(handler(cleanupEnvelope(job!))).rejects.toThrow('waits for its retry');
      expect(calls).toBe(1);
      expect(background.effects.unreleased(plugin.id)).toEqual({failed:0,inflight:1});
      expect(await holdRow(resource.hold)).toMatchObject({state:'releasing',attempts:2});
      await expect(setOperationPluginEnabled(config,plugin.id,space,user,true)).rejects.toMatchObject({statusCode:409});
      finish();
      await holdDue(resource.hold);
      expect(await handler(cleanupEnvelope(job!,2))).toEqual({settled:true,released:1,owner_gone:0});
      expect(calls).toBe(1);
      await setOperationPluginEnabled(config,plugin.id,space,user,true);
      const fresh = await admitted(background, scope);
      fresh.leave();
      expect(fresh.signal.aborted).toBe(false);
    } finally { finish(); }
  });
  it('keeps local resource admission consistent with concurrent enable and disable commits', async () => {
    const background = host.getBackground(plugin.id)!;
    const scope = {spaceId: space, userId: user};
    let cleanupStarted!: () => void, finishCleanup!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const old = await admitted(background, scope);
    old.onDispose(async () => { cleanupStarted(); await cleanup; });
    old.leave();
    const disabling = setOperationPluginEnabled(config, plugin.id, space, user, false);
    await started;
    const enabling = setOperationPluginEnabled(config, plugin.id, space, user, true);
    // Completion must preserve the order established by the active disposal.
    finishCleanup();
    await Promise.all([disabling, enabling]);
    expect(old.signal.aborted).toBe(true);
    expect((await pluginServiceFor(config).isEnabled(db.pool, plugin.id, space, user)).enabled).toBe(true);
    const fresh = await admitted(background, scope);
    fresh.leave();
    expect(fresh.signal.aborted).toBe(false);
    // A later disable ends that generation, and a failed enable cannot readmit it.
    await setOperationPluginEnabled(config, plugin.id, space, user, false);
    expect(fresh.signal.aborted).toBe(true);
    expect(await background.admit(scope)).toBeNull();
    await db.pool.query("UPDATE plugin_installs SET manifest_json='{}' WHERE plugin_id=$1", [plugin.id]);
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toThrow();
    expect(await background.admit(scope)).toBeNull();
    expect(() => background.effects.enter(plugin.id, scope, fresh.hold)).toThrow('closing');
  });
  it('does not accept installed metadata without its exact authority contract, or apply after scope revocation', async () => {
    const created = await call('propose', {
      value: 'disabled'
    });
    await setOperationPluginEnabled(config, plugin.id, space, user, false);
    await expect(PgProposalApplyService.fromConfig(config, host).accept(created.json().proposal_id, {
      spaceId: space,
      userId: user
    })).rejects.toThrow();
    expect((await records()).rows).toHaveLength(0);
    expect((await db.pool.query('SELECT status FROM proposals WHERE id=$1', [created.json().proposal_id])).rows[0].status).toBe('pending');
    await db.pool.query("UPDATE plugin_installs SET manifest_json='{}' WHERE plugin_id=$1", [plugin.id]);
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toMatchObject({
      statusCode: 409
    });
    expect((await call('write')).statusCode).toBe(404);
  });
  it('fans a user-scoped schedule out once per person across multiple memberships', async () => {
    const secondSpace = randomUUID();
    await seedSpaceOwnerProject(db.pool, {
      space: secondSpace,
      owner: randomUUID(),
      project: randomUUID()
    });
    await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'member','active',now(),now())", [randomUUID(), secondSpace, user]);
    const personal = {
      ...plugin,
      operationManifest: {
        ...plugin.operationManifest!,
        scope: 'user' as const
      }
    };
    await migrateOperationPlugin(db.pool, personal);
    const cfg = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      }),
      target = buildModuleServer(cfg, [systemActionsModule]),
      personalHost = new PluginHost([personal]);
    personalHost.activate(target, cfg);
    await target.ready();
    extraApps.push(target);
    await setOperationPluginEnabled(cfg, personal.id, space, user, true);
    await personalHost.getSchedulerTasks()[0]!.run();
    expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1 AND user_id=$2', [jobId, user])).rows).toHaveLength(1);
    await setOperationPluginEnabled(cfg, personal.id, secondSpace, user, false);
    expect((await db.pool.query('SELECT status FROM jobs WHERE job_type=$1 AND user_id=$2', [jobId, user])).rows[0].status).toBe('cancelled');
    await personalHost.getSchedulerTasks()[0]!.run();
    expect((await db.pool.query('SELECT id FROM jobs WHERE job_type=$1 AND user_id=$2', [jobId, user])).rows).toHaveLength(1);
  });
  it('touches no local effect before a new disable commits, and never cleans a newer generation', async () => {
    const background = host.getBackground(plugin.id)!, scope = {spaceId: space, userId: user};
    const disposed: string[] = [];
    const first = (await background.admit(scope))!;
    first.onDispose(() => { disposed.push('first'); });
    first.leave();
    const disable = (headers: Record<string, string>, payload: object = {}) => app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/disable`, headers, payload});
    // No key, a malformed body, a person who may not administer it: refused, nothing local touched.
    expect((await disable({})).statusCode).toBe(422);
    expect((await disable({'idempotency-key': 'k-bad'}, {bogus: true})).statusCode).toBe(422);
    const member = randomUUID();
    await db.pool.query("INSERT INTO users(id,email,display_name,status,created_at,updated_at,registration_source) VALUES($1,$2,'M','active',now(),now(),'system')", [member, `${member}@test.invalid`]);
    await db.pool.query("INSERT INTO space_memberships(id,space_id,user_id,role,status,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,'member','active',now(),now())", [space, member]);
    __setAuthIdentityForTests({spaceId: space, userId: member});
    expect((await disable({'idempotency-key': 'k-member'})).statusCode).toBe(404);
    __setAuthIdentityForTests({spaceId: space, userId: user});
    expect(first.signal.aborted).toBe(false);
    expect(disposed).toEqual([]);
    // The committed disable: cleaned after commit, and its recovery obligation retired.
    const done = await disable({'idempotency-key': 'k-disable'});
    expect(done.json()).toMatchObject({status: 'succeeded', data: {effective: {enabled: false}, cleanup_pending: false}});
    expect(first.signal.aborted).toBe(true);
    expect(disposed).toEqual(['first']);
    const obligations = () => db.pool.query<{id: string; status: string; payload_json: Record<string, unknown>}>("SELECT id,status,payload_json FROM jobs WHERE job_type='official_plugin_scope_cleanup' AND space_id=$1 ORDER BY created_at", [space]);
    expect((await obligations()).rows.map(r => r.status)).toEqual(['cancelled']);
    // A new generation's work, then the old command's replay and a reused key: neither touches it.
    expect((await app.inject({method: 'POST', url: `/api/v1/plugins/${plugin.id}/enable`, headers: {'idempotency-key': 'k-enable'}, payload: {}})).statusCode).toBe(200);
    const second = (await background.admit(scope))!;
    second.onDispose(() => { disposed.push('second'); });
    second.leave();
    expect(second.hold).not.toBe(first.hold);
    const replay = await disable({'idempotency-key': 'k-disable'});
    expect(replay.json()).toEqual(done.json());
    expect((await disable({'idempotency-key': 'k-disable'}, {settings: {x: 1}})).statusCode).toBe(422);
    expect(second.signal.aborted).toBe(false);
    // The old round run again (a crash retry) only ever names the old hold: the new one is untouched.
    const registry = new JobHandlerRegistry();
    registerPluginScopeCleanupHandler(registry, config);
    const handler = registry.get('official_plugin_scope_cleanup')!;
    const envelope = (row: {id: string; payload_json: Record<string, unknown>}) => ({job_id: row.id, space_id: space, user_id: user, job_type: 'official_plugin_scope_cleanup', attempts: 1, max_attempts: 3, worker_id: 'w', payload: row.payload_json});
    expect(await handler(envelope((await obligations()).rows[0]!))).toEqual({settled: true, released: 1, owner_gone: 0});
    expect(second.signal.aborted).toBe(false);
    expect(disposed).toEqual(['first']);
    // A disable committed whose request never cleaned up (a crash after commit): the recovery Job does it, once.
    await withTransaction(db.pool, tx => applyOperationPluginEnabledIn(tx, config, plugin.id, space, user, false, {}));
    expect(second.signal.aborted).toBe(false);
    const pending = (await obligations()).rows.at(-1)!;
    expect(pending.status).toBe('pending');
    expect(await handler(envelope(pending))).toEqual({settled: true, released: 1, owner_gone: 0});
    expect(second.signal.aborted).toBe(true);
    expect(disposed).toEqual(['first', 'second']);
    expect(() => background.effects.enter(plugin.id, scope, second.hold)).toThrow('closing');
    expect(await background.admit(scope)).toBeNull();
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    const third = (await background.admit(scope))!;
    third.leave();
    expect(await handler(envelope(pending))).toEqual({settled: true, released: 1, owner_gone: 0});
    expect(third.signal.aborted).toBe(false);
  });
  it('keeps registry, policy, descriptors and grants isolated between real config compositions', async () => {
    const b = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    });
    const other = {
      ...plugin,
      operationManifest: {
        ...plugin.operationManifest!,
        name: 'B'
      }
    };
    const appB = buildModuleServer(b, [systemActionsModule]);
    new PluginHost([other]).activate(appB, b);
    await appB.ready();
    extraApps.push(appB);
    expect((await pluginServiceFor(config).getPlugin(db.pool, plugin.id, space, user)).descriptor.name).toBe('Lifecycle probe');
    expect((await pluginServiceFor(b).getPlugin(db.pool, plugin.id, space, user)).descriptor.name).toBe('B');
    expect((await loadSystemActionRegistry()).has('plugin.operation_probe.record.write')).toBe(false);
    expect((await loadActionRegistry()).has(jobId)).toBe(false);
    expect((await loadActionRegistry(config)).has(jobId)).toBe(true);
    const c = loadConfig({
      SERVER_DATABASE_URL: db.connectionUri
    });
    expect((await loadSystemActionRegistry(c)).has('plugin.operation_probe.record.write')).toBe(false);
    const allowed = ['plugin.operation_probe.record.write'];
    expect(await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    }, {
      db: db.pool,
      spaceId: space,
      userId: user,
      config: c
    })).toEqual([]);
  });
  it('reports missing dependencies pending and rejects cycles before any activation', async () => {
    const missing = {
      ...plugin,
      operationManifest: {
        ...plugin.operationManifest!,
        requires: ['absent']
      }
    };
    expect(pluginOrder([missing]).pending).toEqual([plugin.id]);
    const pendingConfig = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      }),
      target = buildModuleServer(pendingConfig, [systemActionsModule]),
      pending = new PluginHost([missing]);
    pending.activate(target, pendingConfig);
    await target.ready();
    extraApps.push(target);
    expect(pending.pendingPluginIds).toEqual([plugin.id]);
    expect((await loadSystemActionRegistry(pendingConfig)).has('plugin.operation_probe.record.write')).toBe(false);
    const cycle = {
      ...plugin,
      operationManifest: {
        ...plugin.operationManifest!,
        requires: [plugin.id]
      }
    };
    expect(() => pluginOrder([cycle])).toThrow('cycle');
  });
  it('installs dependencies topologically and makes their scope revocation authoritative', async () => {
    const depId = 'probe_dependency';
    const dep: RainverPlugin = {
      id: depId,
      version: '1.0.0',
      operationManifest: {
        ...plugin.operationManifest!,
        id: depId,
        migrations: [],
        jobs: [],
        schedules: [],
        proposalTypes: [],
        operations: plugin.operationManifest!.operations.filter(o => o.id.endsWith('.write') || o.id.endsWith('.list')).map(o => ({
          ...o,
          id: o.id.replace('operation_probe', depId)
        }))
      },
      migrations: [],
      activate(ctx) {
        for (const o of this.operationManifest!.operations) ctx.actions!.register(o.id as import('@rainver/protocol').PluginOperationId, async () => ({
          values: []
        }));
        return {
          activated: true
        };
      }
    };
    const parent = {
      ...plugin,
      version: '1.1.0',
      operationManifest: {
        ...plugin.operationManifest!,
        version: '1.1.0',
        requires: [depId]
      }
    };
    expect(pluginOrder([parent, dep]).ordered.map(p => p.id)).toEqual([depId, parent.id]);
    await migrateOperationPlugins(db.pool, [parent, dep]);
    const cfg = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      }),
      target = buildModuleServer(cfg, [systemActionsModule]);
    new PluginHost([parent, dep]).activate(target, cfg);
    await target.ready();
    extraApps.push(target);
    await expect(setOperationPluginEnabled(cfg, parent.id, space, user, true)).rejects.toMatchObject({
      statusCode: 409
    });
    await setOperationPluginEnabled(cfg, depId, space, user, true);
    await setOperationPluginEnabled(cfg, parent.id, space, user, true);
    const write = () => target.inject({
      method: 'POST',
      url: '/api/v1/actions/plugin.operation_probe.record.write',
      headers: {
        'idempotency-key': randomUUID()
      },
      payload: {
        value: 'dependent'
      }
    });
    expect((await write()).statusCode).toBe(200);
    await setOperationPluginEnabled(cfg, depId, space, user, false);
    expect((await write()).statusCode).toBe(404);
  });
  it('uses an installed legacy dependency without treating it as an operation contract or rewriting its migrations', async () => {
    const legacy = BUILT_IN_PLUGINS.find(p => p.id === 'diary')!;
    await withTransaction(db.pool, tx => installOfficialPlugin(tx, legacy.id, [legacy], {
      actorUserId: user
    }));
    const checksums = (await db.pool.query('SELECT migration_id,checksum FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id', [legacy.id])).rows;
    const dependent = {
      ...plugin,
      version: '1.1.0',
      operationManifest: {
        ...plugin.operationManifest!,
        version: '1.1.0',
        requires: [legacy.id]
      }
    };
    await migrateOperationPlugins(db.pool, [dependent, legacy]);
    const cfg = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      }),
      target = buildModuleServer(cfg, [systemActionsModule]);
    new PluginHost([dependent, legacy]).activate(target, cfg);
    await target.ready();
    extraApps.push(target);
    await setOperationPluginEnabled(cfg, legacy.id, space, user, true);
    await setOperationPluginEnabled(cfg, dependent.id, space, user, true);
    const write = () => target.inject({
      method: 'POST',
      url: '/api/v1/actions/plugin.operation_probe.record.write',
      headers: {
        'idempotency-key': randomUUID()
      },
      payload: {
        value: 'legacy-dependent'
      }
    });
    expect((await write()).statusCode).toBe(200);
    await setOperationPluginEnabled(cfg, legacy.id, space, user, false);
    expect((await write()).statusCode).toBe(404);
    expect((await db.pool.query('SELECT migration_id,checksum FROM plugin_migrations WHERE plugin_id=$1 ORDER BY migration_id', [legacy.id])).rows).toEqual(checksums);
    await expect(migrateOperationPlugin(db.pool, {
      ...dependent,
      id: legacy.id,
      operationManifest: {
        ...dependent.operationManifest!,
        id: legacy.id
      }
    })).rejects.toThrow('Legacy plugin ids');
  });
  it('recovers isolated role flags/permissions and prevents unsafe runtime admission', async () => {
    const id = `role_probe_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
      names = pluginRoleNames(id);
    await provisionPluginRoles(db.pool, id);
    await db.pool.query(`CREATE TYPE ${names.schema}.probe_status AS ENUM ('ready')`);
    await db.pool.query(`GRANT CREATE ON SCHEMA ${names.schema} TO ${names.runtime}`);
    await db.pool.query(`ALTER ROLE ${names.runtime} SUPERUSER`);
    const invoke = () => withTransaction(db.pool, async tx => {
      const port = operationTransaction(tx);
      try {
        return await withPluginDb(port.db, id, sessionActor({
          spaceId: space,
          userId: user
        }), async () => true);
      } finally {
        port.close();
      }
    });
    try {
      await expect(invoke()).rejects.toThrow('Unsafe');
      await reconcilePluginRole(db.pool, id);
      expect((await db.pool.query('SELECT rolsuper,rolcanlogin,rolinherit FROM pg_roles WHERE rolname=$1', [names.runtime])).rows[0]).toEqual({
        rolsuper: false,
        rolcanlogin: false,
        rolinherit: false
      });
      expect((await db.pool.query("SELECT has_schema_privilege($1,$2,'CREATE') AS create", [names.runtime, names.schema])).rows[0].create).toBe(false);
      expect((await db.pool.query("SELECT r.rolname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_roles r ON r.oid=t.typowner WHERE n.nspname=$1 AND t.typname='probe_status'", [names.schema])).rows[0].rolname).toBe(names.ddl);
      expect(await invoke()).toBe(true);
    } finally {
      await db.pool.query(`ALTER ROLE ${names.runtime} NOSUPERUSER NOLOGIN NOINHERIT`);
      await db.pool.query(`DROP SCHEMA ${names.schema} CASCADE`);
      await db.pool.query(`DROP OWNED BY ${names.runtime},${names.ddl}`);
      await db.pool.query(`DROP ROLE ${names.runtime},${names.ddl}`);
    }
  });
  it('uses the actual offline install CLI and a separate canonical worker process', async () => {
    const root = await artifactRoot();
    await db.pool.query('DROP SCHEMA plugin_operation_probe CASCADE');
    await db.pool.query('DELETE FROM plugin_migrations WHERE plugin_id=$1', [plugin.id]);
    await db.pool.query('DELETE FROM plugin_installs WHERE plugin_id=$1', [plugin.id]);
    await expect(offlineCli(root, 'maintenance-pending')).rejects.toMatchObject({
      code: 10,
      stdout: expect.stringContaining('plugin:operation_probe@1.0.0')
    });
    await offlineCli(root, 'plugin-install');
    await expect(offlineCli(root, 'maintenance-pending')).resolves.toMatchObject({
      stdout: ''
    });
    const enqueued = await call('enqueue', {
      value: 'child-worker'
    });
    expect(enqueued.statusCode, enqueued.body).toBe(200);
    const base = new URL('../dist/', import.meta.url).href;
    const driver = join(root, 'worker.mjs');
    await writeFile(driver, `
    import Fastify from 'fastify';
    import {loadConfig} from '${base}config.js';
    import {getDbPool,closeDbPool} from '${base}db/pool.js';
    import {loadOfficialPluginPackages} from '${base}modules/plugins/packageLoader.js';
    import {PluginHost} from '${base}modules/plugins/host/index.js';
    import {PgJobQueueRepository} from '${base}modules/jobs/repository.js';
    import {JobWorker} from '${base}modules/jobs/worker.js';
    import {JobHandlerRegistry} from '${base}modules/jobs/handlerRegistry.js';
    const config=loadConfig(),app=Fastify(),plugins=await loadOfficialPluginPackages(process.env.SERVER_OFFICIAL_PLUGINS_DIR);
    const host=new PluginHost(plugins);host.activate(app,config);await app.ready();const registry=new JobHandlerRegistry();host.applyJobHandlers(registry);
    const result=await new JobWorker(new PgJobQueueRepository(getDbPool(config.databaseUrl)),registry,'process-worker',['${jobId}']).processOne();
    await app.close();await closeDbPool(config.databaseUrl);process.stdout.write(JSON.stringify(result));
  `);
    const result = await promisify(execFile)(process.execPath, [driver], {
      env: {
        PATH: process.env.PATH,
        SERVER_DATABASE_URL: db.connectionUri,
        SERVER_OFFICIAL_PLUGINS_DIR: root
      }
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'completed',
      job_id: enqueued.json().data.jobId
    });
    expect((await records()).rows.map(r => r.value)).toEqual(['child-worker']);
  });
  it('restores a real no-owner/no-acl dump through the actual offline CLI, restoring schema and table owners', async () => {
    await call('write', {
      value: 'restored'
    });
    const context = inject('sharedPostgres'),
      uri = new URL(db.connectionUri);
    if (!context.containerId) throw new Error('Test container identity missing');
    const dump = execFileSync('docker', ['exec', context.containerId, 'pg_dump', '-U', decodeURIComponent(uri.username), '-d', uri.pathname.slice(1), '-Fc', '--schema=plugin_operation_probe']);
    execFileSync('docker', ['exec', '-i', context.containerId, 'pg_restore', '-U', decodeURIComponent(uri.username), '-d', uri.pathname.slice(1), '--clean', '--if-exists', '--no-owner', '--no-acl'], {
      input: dump
    });
    expect((await db.pool.query("SELECT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='plugin_operation_probe' AND c.relname='records'")).rows[0].rolname).not.toBe('rainver_plugin_operation_probe_ddl');
    const root = await artifactRoot();
    await offlineCli(root, 'plugin-reconcile');
    expect((await db.pool.query("SELECT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='plugin_operation_probe' AND c.relname='records'")).rows[0].rolname).toBe('rainver_plugin_operation_probe_ddl');
    await reconcileOperationPlugins(db.pool, [plugin]);
    expect((await records()).rows.map(r => r.value)).toEqual(['restored']);
    expect((await call('write')).statusCode).toBe(200);
  });
  it('uses an actual Agent Run bearer HTTP call with the same lifecycle operation', async () => {
    const allowed = ['plugin.operation_probe.record.write'];
    const grants = await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    }, {
      db: db.pool,
      spaceId: space,
      userId: user,
      config
    });
    const runId = randomUUID();
    await seedRun(db.pool, {
      id: runId,
      space,
      owner: user,
      agent: randomUUID(),
      version: randomUUID()
    });
    await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=$2,permission_snapshot_json=$3::jsonb WHERE id=$1", [runId, user, JSON.stringify({
      tool_grants: grants
    })]);
    const token = await new PgRunToolIdentityRepository(db.pool).issue({
      id: runId,
      space_id: space
    }, 60000);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/tools/${allowed[0]}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID()
      },
      payload: {
        value: 'agent'
      }
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await records()).rows.map(r => r.value)).toEqual(['agent']);
    const address = await app.listen({
      host: '127.0.0.1',
      port: 0
    });
    const key = randomUUID();
    const argv = [join(import.meta.dirname, '../../packages/agent-cli/dist/rainver.js'), 'call', allowed[0]!, '--idempotency-key', key, JSON.stringify({
      value: 'cli'
    })];
    const options = {
      env: {
        PATH: process.env.PATH,
        RAINVER_API_URL: address,
        RAINVER_RUN_ID: runId,
        RAINVER_TOOL_TOKEN: token
      }
    };
    expect(JSON.parse((await promisify(execFile)(process.execPath, argv, options)).stdout).ok).toBe(true);
    expect(JSON.parse((await promisify(execFile)(process.execPath, argv, options)).stdout).replayed).toBe(true);
    expect((await records()).rows.map(r => r.value)).toEqual(['cli']);
  });
});
