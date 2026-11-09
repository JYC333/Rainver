import {getPluginControlPool,getOperationAuditPool} from '../src/db/pool.js';
import { pluginsModule } from '../src/modules/plugins/index.js';
import { BUILT_IN_PLUGINS } from '../src/modules/plugins/builtInPlugins.js';
import { installOfficialPlugin } from '../src/modules/plugins/installer.js';
import { proposalsModule, __setProposalIdentityForTests } from '../src/modules/proposals/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stripTypeScriptTypes } from 'node:module';
import { afterEach, beforeEach, it, describe, expect, inject } from 'vitest';
import type { RainverPlugin } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedRun } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { buildServerDist } from './support/briefingWorkerHarness.js';
import { createLifecycleProbe, jobId, proposalType } from './fixtures/pluginOperation/lifecycleRuntime.js';
import { migrateOperationPlugin, migrateOperationPlugins, reconcileOperationPlugins } from '../src/modules/plugins/operationMigrations.js';
import { pluginOrder } from '../src/modules/plugins/dependencies.js';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { loadConfig } from '../src/config.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { runsModule } from '../src/modules/runs/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { setOperationPluginEnabled } from '../src/modules/plugins/lifecycle.js';
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
  plugin = createLifecycleProbe(x => observed.push(x));
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  });
  app = buildModuleServer(config, [systemActionsModule, runsModule, proposalsModule, pluginsModule]);
  host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  // Each case starts from a clean fixture schema/journal, not product data.
  await db.pool.query('DROP SCHEMA IF EXISTS plugin_operation_probe CASCADE');
  await db.pool.query("DELETE FROM official_plugin_enablements WHERE plugin_id='operation_probe'");
  for (const old of (await db.pool.query<{
    id: string;
  }>("SELECT id FROM jobs WHERE job_type=$1 AND status IN ('pending','claimed','running')", [jobId])).rows) await new PgJobQueueRepository(db.pool).cancelJob(old.id, null);
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
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/plugins/${plugin.id}/disable`,
      payload: {}
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().effective.enabled).toBe(false);
    expect((await call('write')).statusCode).toBe(404);
    const enabled = await app.inject({
      method: 'POST',
      url: `/api/v1/plugins/${plugin.id}/enable`,
      payload: {
        settings: {
          label: 'scope'
        }
      }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().effective.enabled).toBe(true);
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
  it('continues LIFO cleanup after a failure, records the scoped repair event and keeps admission closed', async () => {
    const seen: string[] = [];
    const effects = host.getBackground(plugin.id)!.effects.enter(plugin.id, {
      spaceId: space,
      userId: user
    });
    effects.onDispose(() => {
      seen.push('first');
    });
    effects.onDispose(() => {
      seen.push('second');
      throw new Error('private failure');
    });
    effects.onDispose(() => {
      seen.push('third');
    });
    expect(await setOperationPluginEnabled(config, plugin.id, space, user, false)).toMatchObject({
      cleanup_pending: true
    });
    expect(seen).toEqual(['third', 'second', 'first']);
    expect((await call('write')).statusCode).toBe(404);
    const event = (await db.pool.query("SELECT metadata_json FROM official_plugin_events WHERE plugin_id=$1 AND space_id=$2 AND event_type='scope_cleanup_failed'", [plugin.id, space])).rows;
    expect(event).toEqual([{
      metadata_json: {
        failure_count: 1
      }
    }]);
    await setOperationPluginEnabled(config, plugin.id, space, user, true);
    expect((await call('write')).statusCode).toBe(200);
  });
  it('commits disable after a cleanup deadline and refuses reenable until the old cleanup finishes', async () => {
    const background = host.getBackground(plugin.id)!, scope={spaceId:space,userId:user};
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish=resolve; });
    background.effects.enter(plugin.id,scope).onDispose(()=>held);
    try {
      expect(await setOperationPluginEnabled(config,plugin.id,space,user,false)).toMatchObject({cleanup_pending:true});
      await expect(setOperationPluginEnabled(config,plugin.id,space,user,true)).rejects.toMatchObject({statusCode:409});
      expect((await pluginServiceFor(config).isEnabled(db.pool,plugin.id,space,user)).enabled).toBe(false);
      expect(() => background.effects.enter(plugin.id,scope)).toThrow('closing');
      finish();
      await background.effects.closeWhere(plugin.id,()=>true,'test-drain');
      background.effects.reopenWhere(plugin.id,()=>true,'test-drain');
      await setOperationPluginEnabled(config,plugin.id,space,user,true);
      expect(background.effects.enter(plugin.id,scope).signal.aborted).toBe(false);
    } finally { finish(); }
  });
  it('keeps local resource admission consistent with concurrent enable and disable commits', async () => {
    const background = host.getBackground(plugin.id)!;
    const scope = {spaceId: space, userId: user};
    let cleanupStarted!: () => void, finishCleanup!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    const old = background.effects.enter(plugin.id, scope);
    old.onDispose(async () => { cleanupStarted(); await cleanup; });
    const disabling = setOperationPluginEnabled(config, plugin.id, space, user, false);
    await started;
    const enabling = setOperationPluginEnabled(config, plugin.id, space, user, true);
    // Completion must preserve the order established by the active disposal.
    finishCleanup();
    await Promise.all([disabling, enabling]);
    expect(old.signal.aborted).toBe(true);
    expect((await pluginServiceFor(config).isEnabled(db.pool, plugin.id, space, user)).enabled).toBe(true);
    expect(background.effects.enter(plugin.id, scope).signal.aborted).toBe(false);
    // A later disable still owns its gate, and a failed enable cannot remove it.
    await setOperationPluginEnabled(config, plugin.id, space, user, false);
    expect(() => background.effects.enter(plugin.id, scope)).toThrow('closing');
    await db.pool.query("UPDATE plugin_installs SET manifest_json='{}' WHERE plugin_id=$1", [plugin.id]);
    await expect(setOperationPluginEnabled(config, plugin.id, space, user, true)).rejects.toThrow();
    expect(() => background.effects.enter(plugin.id, scope)).toThrow('closing');
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
