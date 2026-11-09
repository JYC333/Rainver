import { pluginRoleNames, assertPluginRuntimeRole } from './roleReconcile.js';
export { pluginRoleNames, provisionPluginRoles } from './roleReconcile.js';
import { randomUUID } from 'node:crypto';
import type { PluginDb, OperationActor, Queryable } from '@rainver/protocol';
import { PluginInvocationSerial } from './invocationSerial.js';
import { assertPluginSql } from './operationSqlPolicy.js';
import { operationTransaction, operationTransactionHost } from '../../db/operationTransaction.js';
import { poisonTransaction } from '../../db/tx.js';
const hostInvocations = new WeakMap<PluginDb, {
  host: Queryable;
  role: string;
  path: string;
  runtime: string;
  schema: string;
  serial: PluginInvocationSerial;
}>();
/** Narrow host adapters only: never expose this callback port to plugin code. */
export function pluginHostWrite<T>(db: PluginDb, fn: (host: Queryable) => Promise<T>): Promise<T> {
  const state = hostInvocations.get(db);
  if (!state) {
    const failure = Promise.reject<T>(new Error('Plugin host port expired'));
    void failure.catch(() => {});
    return failure;
  }
  return state.serial.run('host', async () => {
    const point = `host_${randomUUID().replaceAll('-', '')}`;
    await state.host.query(`SAVEPOINT ${point}`);
    const port = operationTransaction(state.host);
    try {
      await state.host.query(`SET LOCAL ROLE ${state.role}`);
      await state.host.query("SELECT set_config('search_path',$1,true)", [state.path]);
      const result = await fn(port.db);
      await state.host.query(`SET LOCAL ROLE ${state.runtime}`);
      await state.host.query(`SET LOCAL search_path=${state.schema},pg_temp`);
      await state.host.query(`RELEASE SAVEPOINT ${point}`);
      return result;
    } catch (e) {
      await state.host.query(`ROLLBACK TO SAVEPOINT ${point}`);
      await state.host.query(`RELEASE SAVEPOINT ${point}`);
      throw e;
    } finally {
      port.close();
    }
  });
}
/** Joins the P1 transaction. Core audit/request writes always resume as the host role. */
export async function withPluginDb<T>(port: Queryable, id: string, actor: OperationActor, fn: (db: PluginDb) => Promise<T>): Promise<T> {
  const host = operationTransactionHost(port),
    {
      schema,
      runtime
    } = pluginRoleNames(id);
  await assertPluginRuntimeRole(host, id);
  const savepoint = `plugin_${randomUUID().replaceAll('-', '')}`;
  const gucs = ['rainver.plugin_id', 'rainver.space_id', 'rainver.user_id'] as const;
  const expected = [id, actor.space_id, actor.on_behalf_of_user_id!];
  const original = (await host.query<{
    role: string;
    path: string;
  }>('SELECT current_user AS role,current_setting(\'search_path\') AS path')).rows[0]!;
  if (!/^[a-z_][a-z0-9_]*$/.test(original.role)) throw new Error('Unsupported host role');
  const old = [];
  for (const g of gucs) old.push(await host.query<{
    v: string | null;
  }>('SELECT current_setting($1,true) AS v', [g]));
  await host.query(`SAVEPOINT ${savepoint}`);
  const bounded = operationTransaction(host);
  let active = true;
  const serial = new PluginInvocationSerial();
  const db: PluginDb = {
    query(sql, params) {
      return serial.run('plugin', async () => {
        if (!active) throw new Error('PluginDb expired');
        assertPluginSql(sql);
        return bounded.db.query(sql, params);
      });
    },
    transaction(scope, work) {
      return serial.run('plugin', async () => {
        if (!active) throw new Error('PluginDb expired');
        if (scope.spaceId !== actor.space_id || scope.userId !== actor.on_behalf_of_user_id) throw new Error('Plugin scope mismatch');
        const point = `nested_${randomUUID().replaceAll('-', '')}`;
        await bounded.db.query(`SAVEPOINT ${point}`);
        try {
          return await serial.scope(() => work(db));
        } catch (error) {
          await bounded.db.query(`ROLLBACK TO SAVEPOINT ${point}`);
          throw error;
        } finally {
          await bounded.db.query(`RELEASE SAVEPOINT ${point}`);
        }
      });
    }
  };
  try {
    await host.query(`SET LOCAL ROLE ${runtime}`);
    await host.query(`SET LOCAL search_path = ${schema}, pg_temp`);
    for (let i = 0; i < gucs.length; i++) await host.query('SELECT set_config($1,$2,true)', [gucs[i], expected[i]]);
    hostInvocations.set(db, {
      host,
      role: original.role,
      path: original.path,
      runtime,
      schema,
      serial
    });
    const output = await serial.scope(() => fn(db));
    const current = (await host.query<{
      role: string;
    }>('SELECT current_user AS role')).rows[0]!.role;
    for (let i = 0; i < gucs.length; i++) {
      const value = (await host.query<{
        v: string;
      }>('SELECT current_setting($1,true) AS v', [gucs[i]])).rows[0]!.v;
      if (value !== expected[i]) {
        poisonTransaction(host);
        throw new Error('Plugin scope tripwire');
      }
    }
    if (current !== runtime) {
      poisonTransaction(host);
      throw new Error('Plugin role tripwire');
    }
    await host.query(`SET LOCAL ROLE ${original.role}`);
    await host.query("SELECT set_config('search_path',$1,true)", [original.path]);
    for (let i = 0; i < gucs.length; i++) await host.query('SELECT set_config($1,$2,true)', [gucs[i], old[i]!.rows[0]!.v ?? '']);
    await host.query(`RELEASE SAVEPOINT ${savepoint}`);
    return output;
  } catch (error) {
    await host.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {
      poisonTransaction(host);
    });
    await host.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {
      poisonTransaction(host);
    });
    throw error;
  } finally {
    hostInvocations.delete(db);
    active = false;
    bounded.close();
  }
}
