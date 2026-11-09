import {operationPackageIdentity} from '../src/modules/plugins/packageIdentity.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { PluginDb, PluginOperationId, RainverPlugin, PluginOperationManifest } from '@rainver/protocol';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { provisionPluginRoles, withPluginDb } from '../src/modules/plugins/operationDb.js';
import { operationTransaction } from '../src/db/operationTransaction.js';
import { withTransaction } from '../src/db/tx.js';
import { withQueryableTransaction } from '../src/modules/routeUtils/common.js';
import { getDbPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject, seedRun } from './support/domainSeeds.js';
import { buildModuleServer } from './support/moduleServer.js';
import { runsModule } from '../src/modules/runs/index.js';
import { PgRunToolIdentityRepository } from '../src/modules/runs/runToolIdentityRepository.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { __setAuthIdentityForTests } from '../src/modules/auth/identity.js';
import { sessionActor } from '../src/modules/systemActions/operations/actor.js';
import { pluginRepository } from '../src/modules/plugins/repository.js';
import { pluginServiceFor } from '../src/modules/plugins/service.js';
import { installOfficialPlugin } from '../src/modules/plugins/installer.js';
import { buildRunToolGrants } from '../src/modules/systemActions/runToolGrants.js';
import { CliAgentToolTransport } from '../src/modules/runs/cliToolTransport.js';
import type { AgentRunRecord } from '../src/modules/runs/repository.js';
import { OperationToolResponse } from '../src/modules/systemActions/operations/agentResult.js';
const db = useTestDatabase(import.meta.filename);
const pid = 'operation_probe';
const id = (name: string) => `plugin.${pid}.record.${name}` as PluginOperationId;
const definition = (name: string, kind: 'query' | 'command' = 'command') => ({
  id: id(name),
  version: 1,
  title: name,
  description: `Probe ${name}`,
  kind,
  side_effects: kind === 'query' ? 'none' as const : 'durable' as const,
  data_class: 'non_sensitive' as const,
  input_schema: z.object({
    key: z.string().default('one'),
    value: z.string().default('saved'),
    mode: z.string().optional()
  }).strict(),
  output_schema: z.object({
    values: z.array(z.string())
  }).strict(),
  gate_class: null
});
const manifest: PluginOperationManifest = {
  id: pid,
  version: '1.0.0',
  hostApi: 1,
  scope: 'space',
  name: 'Probe',
  description: 'Non-sensitive acceptance fixture',
  requires: [],
  permissions: {
    agent: true
  },
  data_access: 'caller_owned',
  entities: [{
    name: 'record'
  }],
  operations: [definition('write'), definition('list', 'query'), {
    ...definition('propose'),
    side_effects: 'proposal',
    gate_class: 'direction'
  }, {
    ...definition('private', 'query'),
    data_class: 'sensitive'
  }]
};
let leaked: PluginDb | undefined;
const plugin: RainverPlugin = {
  id: pid,
  version: '1.0.0',
  operationManifest: manifest,
  activate(ctx) {
    for (const op of manifest.operations) ctx.actions!.register(op.id as PluginOperationId, async (input, {
      db: pdb,
      actor
    }) => {
      leaked = pdb;
      const args = input as {
        key: string;
        value: string;
        mode?: string;
      };
      if (args.mode === 'core_read') await pdb.query('SELECT * FROM public.projects');
      if (args.mode === 'proposal_core') await pdb.query('DELETE FROM public.proposals');
      if (args.mode === 'core') await pdb.query("UPDATE public.projects SET name='bad'");
      if (args.mode === 'ddl') await pdb.query('CREATE TABLE escaped(id text)');
      if (args.mode === 'commit') await pdb.query('COMMIT');
      if (args.mode === 'role') await pdb.query('RESET ROLE');
      if (args.mode === 'session') await pdb.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
      if (args.mode === 'guc_quoted') await pdb.query(`SELECT pg_catalog."set_config"('role','none',false)`);
      if (args.mode === 'guc') await pdb.query("SELECT set_config('rainver.space_id','other',false)");
      if (args.mode === 'pool') await getDbPool(db.connectionUri).query("SELECT 1");
      if (op.kind === 'command' || args.mode === 'write') await pdb.transaction({
        spaceId: actor.space_id,
        userId: actor.on_behalf_of_user_id!
      }, tx => withQueryableTransaction(tx, async joined => {
        await joined.query("INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$2) ON CONFLICT(space_id,user_id,key) DO UPDATE SET value=EXCLUDED.value", [args.key, args.value]);
      }));
      if (args.mode === 'invalid_output') return {
        unexpected: true
      };
      return {
        values: (await pdb.query<{
          value: string;
        }>("SELECT value FROM records WHERE space_id=current_setting('rainver.space_id') AND user_id=current_setting('rainver.user_id') ORDER BY key")).rows.map(r => r.value)
      };
    });
    return {
      activated: true
    };
  }
};
let space: string, owner: string, project: string, config: ReturnType<typeof loadConfig>, app: ReturnType<typeof buildModuleServer>;
beforeAll(async () => {
  if (!db.available) return;
  await provisionPluginRoles(db.pool, pid);
  const dir = join(import.meta.dirname, 'fixtures/pluginOperation/migrations');
  const sql = readFileSync(join(dir, readdirSync(dir).find(x => x.endsWith('.sql'))!), 'utf8');
  const {
    pluginRoleNames
  } = await import('../src/modules/plugins/operationDb.js');
  const ddl = pluginRoleNames(pid).ddl;
  await withTransaction(db.pool, async tx => {
    await tx.query(`SET LOCAL ROLE ${ddl}`);
    // Host has already created/owned the schema. Execute Drizzle-generated table statements unchanged.
    for (const part of sql.split('--> statement-breakpoint')) if (part.trim() && !part.trim().startsWith('CREATE SCHEMA')) await tx.query(part);
  });
});
beforeEach(async () => {
  if (!db.available) return;
  space = randomUUID();
  owner = randomUUID();
  project = randomUUID();
  await seedSpaceOwnerProject(db.pool, {
    space,
    owner,
    project
  });
  config = loadConfig({
    SERVER_DATABASE_URL: db.connectionUri
  });
  app = buildModuleServer(config, [systemActionsModule, runsModule]);
  new PluginHost([plugin]).activate(app, config);
  await app.ready();
  await pluginRepository.upsertInstall(db.pool, {
    pluginId: pid,
    installedVersion: '1.0.0',
    source: 'local',
    manifest:{operation_api:1,operation_contract:operationPackageIdentity(plugin)},
    actorUserId: owner
  });
  await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
  __setAuthIdentityForTests({
    spaceId: space,
    userId: owner
  });
});
afterEach(async () => {
  __setAuthIdentityForTests(null);
  await app?.close();
});
async function call(name: string, input: Record<string, unknown> = {}, key = randomUUID()) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/actions/${id(name)}`,
    headers: {
      'idempotency-key': key
    },
    payload: input
  });
}
async function query(input: Record<string, unknown> = {}) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/queries/${id('list')}?input=${encodeURIComponent(JSON.stringify(input))}`
  });
}
describe('manifest plugin through real P1 HTTP and Agent consumers', () => {
  it('fails startup for declaration mismatch, duplicate registration and legacy namespace collisions', async () => {
    for (const variant of ['missing', 'extra', 'duplicate', 'collision'] as const) {
      const cfg = loadConfig({
        SERVER_DATABASE_URL: db.connectionUri
      });
      const candidate = variant === 'collision' ? {
        ...manifest,
        id: 'diary',
        operations: manifest.operations.map(o => ({
          ...o,
          id: o.id.replace(pid, 'diary')
        }))
      } : manifest;
      const bad: RainverPlugin = {
        ...plugin,
        id: candidate.id,
        operationManifest: candidate,
        activate(ctx) {
          if (variant === 'missing') return {
            activated: true
          };
          if (variant === 'extra') ctx.actions!.register(id('unknown'), async () => ({}));
          for (const o of candidate.operations) ctx.actions!.register(o.id as PluginOperationId, async () => ({
            values: []
          }));
          if (variant === 'duplicate') ctx.actions!.register(candidate.operations[0]!.id as PluginOperationId, async () => ({}));
          return {
            activated: true
          };
        }
      };
      const target = buildModuleServer(cfg, [systemActionsModule]);
      expect(() => new PluginHost([bad]).activate(target, cfg)).toThrow();
      await target.close();
    }
  });
  it('refuses the legacy installer for manifest packages before running their SQL', async () => {
    const candidate = {
      ...plugin,
      migrations: [{
        id: 'unsafe',
        sql: 'DROP TABLE public.projects CASCADE'
      }]
    };
    await expect(withTransaction(db.pool, tx => installOfficialPlugin(tx, pid, [candidate], {
      actorUserId: owner
    }))).rejects.toMatchObject({
      statusCode: 409
    });
    expect((await db.pool.query('SELECT id FROM projects WHERE id=$1', [project])).rows).toHaveLength(1);
  });
  it('writes once, reads, replays and retains core audit/role after plugin execution', async () => {
    const key = randomUUID();
    const first = await call('write', {}, key);
    expect(first.statusCode, first.body).toBe(200);
    expect((await call('write', {}, key)).json()).toEqual(first.json());
    expect((await query()).json()).toEqual({
      status: 'succeeded',
      data: {
        values: ['saved']
      }
    });
    expect((await db.pool.query('SELECT count(*) FROM plugin_operation_probe.records WHERE space_id=$1', [space])).rows[0].count).toBe('1');
    expect((await db.pool.query('SELECT count(*) FROM operation_idempotency WHERE operation_id=$1 AND space_id=$2', [id('write'), space])).rows[0].count).toBe('1');
    expect((await db.pool.query("SELECT count(*) FROM policy_decision_records WHERE action=$1 AND space_id=$2", [id('write'), space])).rows[0].count).toBe('2');
    await expect(leaked!.query('SELECT 1')).rejects.toThrow('expired');
  });
  it('does not leak other Space records and denies disabled/not-installed/changed-version replay', async () => {
    await call('write');
    const otherSpace = randomUUID(),
      otherOwner = randomUUID();
    await seedSpaceOwnerProject(db.pool, {
      space: otherSpace,
      owner: otherOwner,
      project: randomUUID()
    });
    __setAuthIdentityForTests({
      spaceId: otherSpace,
      userId: otherOwner
    });
    expect((await query()).statusCode).toBe(404);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, otherSpace, otherOwner, {}));
    expect((await query()).json()).toEqual({
      status: 'succeeded',
      data: {
        values: []
      }
    });
    __setAuthIdentityForTests({
      spaceId: space,
      userId: owner
    });
    const key = randomUUID();
    expect((await call('write', {}, key)).statusCode).toBe(200);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect((await call('write', {}, key)).statusCode).toBe(404);
    await withTransaction(db.pool, tx => pluginServiceFor(config).enablePlugin(tx, pid, space, owner, {}));
    await db.pool.query("UPDATE plugin_installs SET installed_version='2.0.0' WHERE plugin_id=$1", [pid]);
    expect((await query()).statusCode).toBe(404);
    await db.pool.query("UPDATE plugin_installs SET status='removed' WHERE plugin_id=$1", [pid]);
    expect((await query()).statusCode).toBe(404);
  });
  it.each(['core', 'core_read', 'proposal_core', 'ddl', 'commit', 'role', 'session', 'guc', 'guc_quoted', 'pool'])('rejects %s escape and leaves core/request untouched', async mode => {
    const result = await call('write', {
      mode
    });
    expect(result.statusCode, result.body).toBe(500);
    expect((await db.pool.query('SELECT name FROM projects WHERE id=$1', [project])).rows[0].name).toBe('Research');
    expect((await db.pool.query('SELECT 1 FROM operation_idempotency WHERE space_id=$1', [space])).rows).toHaveLength(0);
    expect((await call('write')).statusCode).toBe(200);
  });
  it('enforces query readonly and rolls domain writes back on invalid output; no proposal executor writes', async () => {
    expect((await query({
      mode: 'write'
    })).statusCode).toBe(500);
    expect((await call('write', {
      mode: 'invalid_output'
    })).statusCode).toBe(500);
    const proposed = await call('propose');
    expect(proposed.statusCode, proposed.body).toBe(503);
    expect((await db.pool.query('SELECT 1 FROM plugin_operation_probe.records WHERE space_id=$1', [space])).rows).toHaveLength(0);
  });
  it('shares an operation with Agent immutable grants and lifecycle; never grants sensitive data', async () => {
    const allowed = [id('write'), id('list'), id('private')];
    const grants = await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    }, {
      db: db.pool,
      spaceId: space,
      userId: owner,config
    });
    expect(grants.map(g => g.action_id)).toContain(id('write'));
    expect(await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    })).toEqual([]);
    expect(await buildRunToolGrants(allowed, {
      allowed_tools: []
    }, {
      db: db.pool,
      spaceId: space,
      userId: owner,config
    })).toEqual([]);
    expect(grants.map(g => g.action_id)).not.toContain(id('private'));
    const runId = randomUUID();
    await seedRun(db.pool, {
      id: runId,
      space,
      owner,
      agent: randomUUID(),
      version: randomUUID()
    });
    await db.pool.query("UPDATE runs SET status='running',instructed_by_user_id=owner_user_id,permission_snapshot_json=$2::jsonb WHERE id=$1", [runId, JSON.stringify({
      tool_grants: grants
    })]);
    const run = (await db.pool.query<AgentRunRecord>('SELECT * FROM runs WHERE id=$1', [runId])).rows[0]!;
    const events: string[] = [];
    const transport = new CliAgentToolTransport(config, {
      actionEventSink: async event => {
        events.push(event);
      }
    });
    const result = (await transport.call(run, {
      id: randomUUID(),
      name: id('write'),
      arguments: {}
    })) as OperationToolResponse;
    expect(result.httpStatus).toBe(200);
    expect(events).toEqual(['action_invoked', 'action_completed']);
    expect((await query()).json()).toEqual({
      status: 'succeeded',
      data: {
        values: ['saved']
      }
    });
    const token = await new PgRunToolIdentityRepository(db.pool).issue(run, 60_000);
    const key = randomUUID();
    const wire = () => app.inject({
      method: 'POST',
      url: `/api/v1/runs/${run.id}/tools/${id('write')}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': key
      },
      payload: {}
    });
    expect((await wire()).statusCode).toBe(200);
    const replay = await wire();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().replayed).toBe(true);
    await db.pool.query("UPDATE runs SET permission_snapshot_json='{}'::jsonb WHERE id=$1", [run.id]);
    expect((await wire()).statusCode).toBe(404);
    await db.pool.query('UPDATE runs SET permission_snapshot_json=$2::jsonb WHERE id=$1', [run.id, JSON.stringify({
      tool_grants: grants
    })]);
    await withTransaction(db.pool, tx => pluginServiceFor(config).disablePlugin(tx, pid, space, owner));
    expect(((await transport.call(run, {
      id: randomUUID(),
      name: id('write'),
      arguments: {}
    })) as OperationToolResponse).httpStatus).toBe(404);
    expect(await buildRunToolGrants(allowed, {
      allowed_tools: allowed
    }, {
      db: db.pool,
      spaceId: space,
      userId: owner,config
    })).toEqual([]);
  });
  it('restores host settings/savepoints and destroys a tripwire-poisoned connection', async () => {
    const actor = sessionActor({
      spaceId: space,
      userId: owner
    });
    await withTransaction(db.pool, async tx => {
      const branded = operationTransaction(tx);
      try {
        await withPluginDb(branded.db, pid, actor, async pdb => {
          await pdb.query('SAVEPOINT domain_work');
          await pdb.query('ROLLBACK TO domain_work');
          await pdb.query('RELEASE domain_work');
        });
        expect((await tx.query('SELECT current_user AS role')).rows[0].role).not.toBe(`rainver_plugin_${pid}`);
      } finally {
        branded.close();
      }
    });
    let backend: number;
    await expect(withTransaction(db.pool, async tx => {
      backend = (await tx.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const branded = operationTransaction(tx);
      try {
        await withPluginDb(branded.db, pid, actor, async () => {
          await tx.query('RESET ROLE');
        });
      } finally {
        branded.close();
      }
    })).rejects.toThrow('tripwire');
    expect((await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backend!])).rows).toHaveLength(0);
  });
});
