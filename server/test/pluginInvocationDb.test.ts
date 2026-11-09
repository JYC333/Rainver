import { it, expect } from 'vitest';
import { randomUUID, randomInt } from 'node:crypto';
import type { PluginDb, Queryable } from '@rainver/protocol';
import { useTestDatabase } from './support/testDatabase.js';
import { seedSpaceOwnerProject } from './support/domainSeeds.js';
import { waitForLockWaiter } from './support/lockWait.js';
import { createLifecycleProbe } from './fixtures/pluginOperation/lifecycleRuntime.js';
import { jobId } from './fixtures/pluginOperation/manifest.js';
import { migrateOperationPlugin } from '../src/modules/plugins/operationMigrations.js';
import { withTransaction } from '../src/db/tx.js';
import { operationTransaction } from '../src/db/operationTransaction.js';
import { pluginHostWrite, withPluginDb } from '../src/modules/plugins/operationDb.js';
import { sessionActor } from '../src/modules/systemActions/operations/actor.js';
import { loadConfig } from '../src/config.js';
import { buildModuleServer } from './support/moduleServer.js';
import { systemActionsModule } from '../src/modules/systemActions/index.js';
import { PluginHost } from '../src/modules/plugins/host/index.js';
import { setOperationPluginEnabled } from '../src/modules/plugins/lifecycle.js';

const db = useTestDatabase(import.meta.filename, { max: 3 });
const write = (port: Queryable, value: string) => port.query(
  "INSERT INTO records(space_id,user_id,key,value) VALUES(current_setting('rainver.space_id'),current_setting('rainver.user_id'),$1,$1)", [value]);

async function fixture() {
  const space = randomUUID(), user = randomUUID(), project = randomUUID();
  const scope = { spaceId: space, userId: user }, plugin = createLifecycleProbe();
  await seedSpaceOwnerProject(db.pool, { space, owner: user, project });
  await migrateOperationPlugin(db.pool, plugin);
  const config = loadConfig({ SERVER_DATABASE_URL: db.connectionUri });
  const app = buildModuleServer(config, [systemActionsModule]);
  const host = new PluginHost([plugin]);
  host.activate(app, config);
  await app.ready();
  await setOperationPluginEnabled(config, plugin.id, space, user, true);
  const invoke = <T>(work: (port: PluginDb) => Promise<T>) => withTransaction(db.pool, async tx => {
    const port = operationTransaction(tx);
    try { return await withPluginDb(port.db, plugin.id, sessionActor(scope), work); }
    finally { port.close(); }
  });
  return { app, project, scope, invoke, intents: (port: PluginDb) => host.getBackground(plugin.id)!.intents(port, scope) };
}

async function barrier() {
  const client = await db.pool.connect(), key = randomInt(1, 2147483647);
  await client.query(`CREATE FUNCTION public.invocation_job_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NEW; END $$`);
  await client.query('CREATE TRIGGER invocation_job_hold BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION public.invocation_job_hold()');
  await client.query('SELECT pg_advisory_lock($1)', [key]);
  return {
    release: () => client.query('SELECT pg_advisory_unlock($1)', [key]),
    async close() {
      await client.query('SELECT pg_advisory_unlock_all()');
      await client.query('DROP TRIGGER invocation_job_hold ON jobs');
      await client.query('DROP FUNCTION public.invocation_job_hold()');
      client.release();
    },
  };
}

it('serializes real enqueue elevation against plugin SQL and commits legal plugin data with its Job', async () => {
  const f = await fixture(), gate = await barrier();
  try {
    const initial = (await db.pool.query('SELECT name FROM projects WHERE id=$1', [f.project])).rows[0].name;
    const job = await f.invoke(async port => {
      const enqueue = f.intents(port).enqueue(jobId, { value: 'legal' });
      await waitForLockWaiter(db.pool, { lockType: 'advisory' });
      const denied = port.transaction(f.scope, nested => nested.query("UPDATE public.projects SET name='escaped' WHERE id=$1", [f.project]));
      // Attach before releasing the real server-side barrier, no timing sleep.
      const refusal = expect(denied).rejects.toMatchObject({ code: '42501' });
      const second = f.intents(port).enqueue(jobId, {value:'second'});
      const legal = write(port, 'legal');
      await gate.release();
      const [result] = await Promise.all([enqueue, refusal, second, legal]);
      expect((await port.query('SELECT current_user AS role')).rows[0].role).toBe('rainver_plugin_operation_probe');
      return result;
    });
    expect((await db.pool.query('SELECT name FROM projects WHERE id=$1', [f.project])).rows[0].name).toBe(initial);
    expect((await db.pool.query('SELECT id FROM jobs WHERE id=$1', [job.jobId])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT value FROM plugin_operation_probe.records WHERE value=$1', ['legal'])).rowCount).toBe(1);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(2);
  } finally { await gate.close(); await f.app.close(); }
});

it('queues concurrent real host ports inside nested transactions and restores savepoints after failures', async () => {
  const f = await fixture();
  try {
    await f.invoke(port => port.transaction(f.scope, () => port.transaction(f.scope, async () => {
      await expect(f.intents(port).enqueue(jobId, {})).rejects.toThrow();
      await Promise.all([f.intents(port).enqueue(jobId, { value: 'one' }), f.intents(port).enqueue(jobId, { value: 'two' }), write(port, 'nested')]);
      await expect(port.transaction(f.scope, async failed => {
        await f.intents(port).enqueue(jobId, { value: 'rolled-back' });
        await write(failed, 'rolled-back');
        throw new Error('nested rollback');
      })).rejects.toThrow('nested rollback');
      expect((await port.query('SELECT current_user AS role')).rows[0].role).toBe('rainver_plugin_operation_probe');
    })));
    expect((await db.pool.query('SELECT payload_json->>\'value\' AS value FROM jobs WHERE space_id=$1 ORDER BY value', [f.scope.spaceId])).rows.map(r => r.value)).toEqual(['one', 'two']);
    expect((await db.pool.query('SELECT value FROM plugin_operation_probe.records WHERE space_id=$1', [f.scope.spaceId])).rows.map(r => r.value)).toEqual(['nested']);
  } finally { await f.app.close(); }
});

it('rolls back plugin data and concurrent Jobs together and expires both retained ports', async () => {
  const f = await fixture();
  let retained!: PluginDb;
  try {
    await expect(f.invoke(async port => {
      retained = port;
      await Promise.all([write(port, 'rollback'), f.intents(port).enqueue(jobId, { value: 'rollback-one' }), f.intents(port).enqueue(jobId, { value: 'rollback-two' })]);
      throw new Error('outer rollback');
    })).rejects.toThrow('outer rollback');
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1', [f.scope.spaceId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT key FROM plugin_operation_probe.records WHERE space_id=$1', [f.scope.spaceId])).rowCount).toBe(0);
    await expect(retained.query('SELECT 1')).rejects.toThrow('expired');
    await expect(retained.transaction(f.scope, nested => nested.query('SELECT 1'))).rejects.toThrow('expired');
    await expect(f.intents(retained).enqueue(jobId, { value: 'expired' })).rejects.toThrow('expired');
  } finally { await f.app.close(); }
});

it('drains an unawaited blocked enqueue before rollback and refuses queued SQL after the callback ends', async () => {
  const f = await fixture(), gate = await barrier();
  let ended!: () => void;
  const callbackEnded = new Promise<void>(resolve => { ended = resolve; });
  let queued!: Promise<unknown>, enqueue!: Promise<unknown>;
  try {
    const invocation = f.invoke(async port => {
      enqueue = f.intents(port).enqueue(jobId, { value: 'detached' });
      await waitForLockWaiter(db.pool, { lockType: 'advisory' });
      queued = write(port, 'detached');
      ended();
      // Deliberately do not await either operation.
    });
    const refusal = expect(invocation).rejects.toThrow('Unawaited plugin invocation work');
    await callbackEnded;
    await gate.release();
    await refusal;
    const results = await Promise.allSettled([enqueue, queued]);
    expect(results[1].status).toBe('rejected');
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1', [f.scope.spaceId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT key FROM plugin_operation_probe.records WHERE space_id=$1', [f.scope.spaceId])).rowCount).toBe(0);
  } finally { await gate.close(); await f.app.close(); }
});


it('refuses a direct core query racing actual enqueue and rolls back the entire aborted unit', async () => {
  const f = await fixture(), gate = await barrier();
  try {
    const initial = (await db.pool.query('SELECT name FROM projects WHERE id=$1', [f.project])).rows[0].name;
    await expect(f.invoke(async port => {
      const enqueue = f.intents(port).enqueue(jobId, {value:'direct-race'});
      await waitForLockWaiter(db.pool, {lockType:'advisory'});
      const refusal = expect(port.query("UPDATE public.projects SET name='escaped' WHERE id=$1",[f.project])).rejects.toMatchObject({code:'42501'});
      await gate.release();
      await Promise.all([enqueue,refusal]);
    })).rejects.toMatchObject({code:'25P02'});
    expect((await db.pool.query('SELECT name FROM projects WHERE id=$1',[f.project])).rows[0].name).toBe(initial);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(0);
  } finally { await gate.close(); await f.app.close(); }
});

it('drains detached work before nested savepoint rollback and permits the parent to continue', async () => {
  const f = await fixture(), gate = await barrier();
  let ended!:()=>void;
  const callbackEnded = new Promise<void>(r=>{ended=r;});
  try {
    const invocation = f.invoke(async port => {
      await expect(port.transaction(f.scope,async inner=>{
        void f.intents(port).enqueue(jobId,{value:'nested-detached'});
        await waitForLockWaiter(db.pool,{lockType:'advisory'});
        ended();
      })).rejects.toThrow('Unawaited plugin invocation work');
      await write(port,'after-nested-rollback');
    });
    await callbackEnded;
    await gate.release();
    await invocation;
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT value FROM plugin_operation_probe.records WHERE space_id=$1',[f.scope.spaceId])).rows.map(r=>r.value)).toEqual(['after-nested-rollback']);
  } finally { await gate.close(); await f.app.close(); }
});

it('refuses delayed async descendants after their invocation has returned', async () => {
  const f = await fixture();
  let release!:()=>void, late!:Promise<unknown[]>;
  const resume = new Promise<void>(r=>{release=r;});
  try {
    await f.invoke(async port=>{
      late=resume.then(()=>Promise.allSettled([write(port,'late'), f.intents(port).enqueue(jobId,{value:'late'})]));
      await port.query('SELECT 1');
    });
    release();
    const results = await late as PromiseSettledResult<unknown>[];
    expect(results.map(r=>r.status)).toEqual(['rejected','rejected']);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT key FROM plugin_operation_probe.records WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(0);
  } finally { await f.app.close(); }
});


it('serializes sibling transaction savepoint lifetimes while allowing reentrant host ports', async () => {
  const f = await fixture();
  try {
    await f.invoke(async port => {
      await Promise.all(['left','right'].map(value=>port.transaction(f.scope,async inner=>{
        await write(port,value);
        await f.intents(port).enqueue(jobId,{value});
        await port.transaction(f.scope, nested=>nested.query('SELECT 1'));
      })));
    });
    expect((await db.pool.query('SELECT value FROM plugin_operation_probe.records WHERE space_id=$1 ORDER BY value',[f.scope.spaceId])).rows.map(r=>r.value)).toEqual(['left','right']);
    expect((await db.pool.query('SELECT id FROM jobs WHERE space_id=$1',[f.scope.spaceId])).rowCount).toBe(2);
  } finally { await f.app.close(); }
});


it('refuses plugin SQL reentry from a host callback instead of executing under host authority', async () => {
  const f = await fixture();
  try {
    await f.invoke(async port => {
      await pluginHostWrite(port, async host => {
        await expect(port.query("UPDATE public.projects SET name='escaped' WHERE id=$1",[f.project])).rejects.toThrow('host reentry refused');
        expect((await host.query('SELECT 1 AS value')).rows[0].value).toBe(1);
      });
      expect((await port.query('SELECT current_user AS role')).rows[0].role).toBe('rainver_plugin_operation_probe');
    });
  } finally { await f.app.close(); }
});
