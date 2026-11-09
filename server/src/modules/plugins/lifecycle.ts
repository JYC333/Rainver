import type { ServerConfig } from '../../config.js';
import { randomUUID } from 'node:crypto';
import type { PluginBackground } from './background.js';
import { operationPackages } from './operationRegistry.js';
import { dependencyIds, pluginDependenciesEnabled, lockOperationPluginScope } from './operationEnablement.js';
import { pluginServiceFor } from './service.js';
import { getOfficialPlugin } from './registry.js';
import { getDbPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { sessionActor, assertCurrentActor } from '../systemActions/operations/actor.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { HttpError } from '../routeUtils/common.js';
const runtimes = new WeakMap<ServerConfig, ReadonlyMap<string, PluginBackground>>();
// Local resource admission must follow the same order as the DB transitions.
// Keep cleanup outside DB locks: it may cancel a Job holding those very locks.
const transitions = new WeakMap<ServerConfig, Map<string, Promise<void>>>();
export function registerPluginLifecycle(config: ServerConfig, map: ReadonlyMap<string, PluginBackground>) {
  runtimes.set(config, map);
  return () => runtimes.delete(config);
}
async function authorized(config: ServerConfig, id: string, space: string, user: string) {
  const descriptor = getOfficialPlugin(id, config);
  if (!descriptor) throw new HttpError(404, 'Plugin not found');
  const pool = getDbPool(config.databaseUrl!);
  await assertCurrentActor(pool, sessionActor({
    spaceId: space,
    userId: user
  }));
  if (descriptor.scope === 'space' && !(await pool.query("SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')", [space, user])).rows.length) throw new HttpError(403, 'Plugin administration denied');
  return descriptor;
}
export async function setOperationPluginEnabled(config: ServerConfig, id: string, space: string, user: string, enabled: boolean, settings?: Record<string, unknown>) {
  const descriptor = await authorized(config, id, space, user);
  const key = `${id}:${descriptor.scope}:${descriptor.scope === 'space' ? space : user}`;
  let pending = transitions.get(config);
  if (!pending) transitions.set(config, pending = new Map());
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, current);
  await previous;
  try {
    return await applyEnabled(config, id, space, user, enabled, descriptor, key, settings);
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
async function applyEnabled(config: ServerConfig, id: string, space: string, user: string, enabled: boolean, descriptor: NonNullable<ReturnType<typeof getOfficialPlugin>>, token: string, settings?: Record<string, unknown>) {
  const pool = getDbPool(config.databaseUrl!);
  const affected = operationPackages(config).filter(p => dependencyIds(p.id, config).includes(id));
  const predicate = (scope: {
    spaceId: string;
    userId: string;
  }) => descriptor.scope === 'user' ? scope.userId === user : scope.spaceId === space;
  const backgrounds = runtimes.get(config);
  if (enabled && affected.some(p => backgrounds?.get(p.id)?.effects.hasPendingCleanup(p.id, predicate))) {
    throw new HttpError(409, 'Plugin cleanup is still pending');
  }
  const attemptToken = `${token}:${randomUUID()}`;
  const cleanupErrors: unknown[] = [];
  if (!enabled) for (const p of affected) try {
    await backgrounds?.get(p.id)?.effects.closeWhere(p.id, predicate, attemptToken);
  } catch (e) {
    cleanupErrors.push(e);
  }
  let item;
  try {
    item = await withTransaction(pool, async tx => {
      await assertCurrentActor(tx, sessionActor({
        spaceId: space,
        userId: user
      }), true);
      await lockOperationPluginScope(tx, id, space, user, config, true);
      if (descriptor.scope === 'space' && !(await tx.query("SELECT 1 FROM space_memberships WHERE space_id=$1 AND user_id=$2 AND role IN ('owner','admin') AND status='active'", [space, user])).rows.length) throw new HttpError(403, 'Plugin administration denied');
      if (enabled && !(await pluginDependenciesEnabled(tx, id, space, user, config))) throw new HttpError(409, 'Plugin dependency is disabled or unavailable');
      const result = enabled ? await pluginServiceFor(config).enablePlugin(tx, id, space, user, {
        settings
      }) : await pluginServiceFor(config).disablePlugin(tx, id, space, user);
      if (!enabled) {
        const types = affected.flatMap(p => p.operationManifest?.jobs?.map(j => j.id) ?? []);
        const jobs = (await tx.query<{
          id: string;
        }>("SELECT id FROM jobs WHERE job_type=ANY($1::text[]) AND status IN ('pending','claimed','running') AND (($2::boolean AND user_id=$3) OR (NOT $2::boolean AND space_id=$4))", [types, descriptor.scope === 'user', user, space])).rows;
        const queue = new PgJobQueueRepository(tx);
        for (const j of jobs) await queue.cancelJob(j.id, null);
      }
      if (cleanupErrors.length) await tx.query("INSERT INTO official_plugin_events(id,plugin_id,space_id,target_user_id,event_type,actor_user_id,metadata_json,created_at) VALUES(gen_random_uuid(),$1,$2,$3,'scope_cleanup_failed',$3,$4::jsonb,now())", [id, descriptor.scope === 'space' ? space : null, user, JSON.stringify({
        failure_count: cleanupErrors.length
      })]);
      return result;
    });
  } catch (e) {
    if (!enabled) for (const p of affected) backgrounds?.get(p.id)?.effects.reopenWhere(p.id, predicate, attemptToken);
    throw e;
  }
  if (enabled) {
    for (const p of affected) backgrounds?.get(p.id)?.effects.reopenWhere(p.id, predicate, token);
  } else {
    for (const p of affected) {
      const effects = backgrounds?.get(p.id)?.effects;
      effects?.blockWhere(p.id, predicate, token);
      effects?.reopenWhere(p.id, predicate, attemptToken);
    }
  }
  return {
    ...item,
    cleanup_pending: cleanupErrors.length > 0
  };
}
