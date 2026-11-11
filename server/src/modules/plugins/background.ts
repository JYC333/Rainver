import type { RainverPlugin, PluginLifecyclePort, PluginScope, PluginOperationExecutor, PluginDb } from '@rainver/protocol';
import type { ServerConfig } from '../../config.js';
import type { JobHandler } from '../jobs/handlerRegistry.js';
import { pluginSchedule } from "./schedules.js";
import { withPolicyAuditRecovery } from "../policy/auditWriter.js";
import type { ScheduledTask } from '../scheduler/registry.js';
import { getDbPool, getPluginControlPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { operationTransaction, runOperationWork, runHostWorkOutsideOperation } from '../../db/operationTransaction.js';
import { PgJobQueueRepository } from '../jobs/repository.js';
import { enforce } from '../policy/service.js';
import { loadActionRegistry } from '../policy/actionRegistry.js';
import { assertCurrentActor, sessionActor } from '../systemActions/operations/actor.js';
import { operationPluginEnabled, lockOperationPluginScope } from './operationEnablement.js';
import { pluginServiceFor } from './service.js';
import { PluginEffectScopes, inJobTransaction } from './effectScopes.js';
import { admitPluginScopeHold, pluginScopeHoldCurrent, pluginScopeLeaseIs, retainPluginScopeHold } from './lifecycle.js';
import { pluginHostWrite, withPluginDb } from './operationDb.js';
export class PluginBackground {
  readonly effects = new PluginEffectScopes();
  readonly jobs = new Map<string, JobHandler>();
  readonly tasks: ScheduledTask[] = [];
  readonly proposalExecutors = new Map<string, PluginOperationExecutor>();
  private readonly disposers: (() => void)[] = [];
  constructor(readonly config: ServerConfig, readonly plugin: RainverPlugin) {}
  private get pool() {
    if (!this.config.databaseUrl) throw new Error('Plugin database unavailable');
    return getDbPool(this.config.databaseUrl);
  }
  intents(db: PluginDb, scope: PluginScope) {
    return {
      enqueue: (type: string, payload: Record<string, unknown>) => pluginHostWrite(db, async host => {
        const declared = this.plugin.operationManifest!.jobs?.find(j => j.id === type);
        if (!declared) throw new Error('Undeclared plugin Job');
        const parsed = declared.payload_schema.parse(payload);
        if (!(await operationPluginEnabled(host, this.plugin.id, scope.spaceId, scope.userId, this.config))) throw new Error('Plugin disabled');
        const row = await new PgJobQueueRepository(host).enqueue({
          job_type: type,
          space_id: scope.spaceId,
          user_id: scope.userId,
          payload: parsed
        });
        return {
          jobId: row.id
        };
      })
    };
  }
  readonly port: PluginLifecyclePort = {
    jobs: {
      register: (id, handler, options) => {
        // The bounded contract closes the Job's registration handle when the handler settles; the original one keeps it open.
        const bounded = options?.disposeRegistration === 'handler';
        const declared = this.plugin.operationManifest!.jobs?.find(j => j.id === id);
        if (!declared || this.jobs.has(id)) throw new Error('Undeclared/duplicate plugin Job');
        const wrapped: JobHandler = async envelope => {
          if (this.jobs.get(id) !== wrapped) return {
            skipped: true,
            reason: 'plugin_contribution_disposed'
          };
          const scope = {
            spaceId: envelope.space_id,
            userId: envelope.user_id ?? ''
          };
          // Admitted under this process's durable hold of the scope generation, or not at all.
          const resource = scope.userId ? await this.admit(scope) : null;
          if (!resource) return {
            skipped: true,
            reason: 'plugin_disabled'
          };
          const jobAbort = new AbortController();
          const abortJob = () => jobAbort.abort();
          resource.signal.addEventListener("abort", abortJob, {
            once: true
          });
          const audit = getPluginControlPool(this.config.databaseUrl!);
          // Set until the Job's transaction has ended: an early dispose the handler (or a continuation
          // it started) requests meanwhile is refused, never run inside the transaction.
          let endTransaction = () => {};
          try {
            return await withPolicyAuditRecovery(this.config.databaseUrl, () => withTransaction(this.pool, async client => {
              const actor = {
                ...sessionActor(scope),
                principal: {
                  kind: 'system' as const,
                  id: `plugin.${this.plugin.id}`
                },
                origin: 'system_event' as const,
                effective_origin: 'job',
                surface: 'system_job' as const
              };
              await assertCurrentActor(client, sessionActor(scope));
              const decision = await enforce({
                ...this.config,
                auditTransaction: client
              }, await loadActionRegistry(this.config), {
                action: id,
                actor_type: 'system',
                actor_id: actor.principal.id,
                space_id: scope.spaceId,
                resource_space_id: scope.spaceId,
                resource_type: `plugin.${this.plugin.id}`,
                resource_id: scope.userId,
                force_record: true,
                context: {
                  trigger_origin: 'job',
                  instructed_by_user_id: scope.userId
                }
              });
              if (decision.status !== 'allow') throw new Error('Plugin Job policy denied');
              const {
                pid,
                xid
              } = (await client.query<{
                pid: number;
                xid: string;
              }>('SELECT pg_backend_pid() AS pid,(pg_current_xact_id()::text::numeric % 4294967296)::text AS xid')).rows[0]!;
              let cancellation: Promise<unknown> | undefined;
              const cancel = () => {
                cancellation ??= audit.query('SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=$1 AND backend_xid::text=$2', [pid, xid]).catch(() => {});
              };
              jobAbort.signal.addEventListener('abort', cancel, {
                once: true
              });
              let checking = false;
              const timer = setInterval(() => {
                if (checking) return;
                checking = true;
                void (async () => {
                  const job = await new PgJobQueueRepository(audit).getJob(envelope.job_id);
                  if (job?.status === 'cancelled' || !(await pluginScopeHoldCurrent(audit, this.config, resource.hold, resource.instance)) || !(await operationPluginEnabled(audit, this.plugin.id, scope.spaceId, scope.userId, this.config))) jobAbort.abort();
                })().catch(() => jobAbort.abort()).finally(() => {
                  checking = false;
                });
              }, 1000);
              timer.unref();
              const tx = operationTransaction(client);
              try {
                const settings = (await pluginServiceFor(this.config).getPlugin(client, this.plugin.id, scope.spaceId, scope.userId)).effective.settings;
                const marked = inJobTransaction(() => runOperationWork(() => withPluginDb(tx.db, this.plugin.id, actor, db => handler(declared.payload_schema.parse(envelope.payload), {
                  db,
                  actor,
                  signal: jobAbort.signal,
                  jobId: envelope.job_id,
                  onDispose: resource.onDispose,
                  // The host's own short reservation transaction, not the plugin's: outside the operation work's pool refusal.
                  retain: () => runHostWorkOutsideOperation(() => retainPluginScopeHold(this.config, resource)),
                  jobs: this.intents(db, scope),
                  settings
                }))));
                endTransaction = marked.close;
                const out = await marked.result;
                jobAbort.signal.throwIfAborted();
                await assertCurrentActor(client, sessionActor(scope), true);
                await lockOperationPluginScope(client, this.plugin.id, scope.spaceId, scope.userId, this.config);
                if (!(await operationPluginEnabled(client, this.plugin.id, scope.spaceId, scope.userId, this.config))) throw new Error('Plugin disabled');
                // A disable (even one followed by a new enable) ended this hold's generation, or this
                // process's lease is no longer held by its session: its work never commits. The hold
                // row stays share-locked through this transaction's COMMIT: no transition precedes it.
                if (!(await pluginScopeHoldCurrent(client, this.config, resource.hold, resource.instance))) throw new Error('Plugin scope generation ended');
                return out;
              } finally {
                // Resource disposal waits for the transaction to end (outer finally): no lock is held across it.
                clearInterval(timer);
                jobAbort.signal.removeEventListener('abort', cancel);
                resource.signal.removeEventListener('abort', abortJob);
                await cancellation;
                tx.close();
              }
            }));
          } finally {
            endTransaction();
            resource.signal.removeEventListener("abort", abortJob);
            // What it registered is drained by its hold's claimed attempts (inside a running attempt at
            // once, otherwise at the next one), never here. The bounded contract closes the handle now;
            // under the original one a saved `onDispose` may still register, so the handle stays open
            // (the hold stays an obligation) until this process ends.
            if (bounded) resource.leave();
            else resource.linger();
          }
        };
        this.jobs.set(id, wrapped);
        const dispose = () => {
          this.jobs.delete(id);
        };
        this.disposers.push(dispose);
        return dispose;
      }
    },
    schedules: {
      register: (id, payload) => {
        const declared = this.plugin.operationManifest!.schedules?.find(s => s.id === id);
        if (!declared || this.tasks.some(s => s.name === id)) throw new Error('Undeclared/duplicate plugin schedule');
        const task: ScheduledTask = pluginSchedule(this.config, this.plugin, declared, payload, () => this.tasks.includes(task));
        this.tasks.push(task);
        const dispose = () => {
          const index = this.tasks.indexOf(task);
          if (index >= 0) this.tasks.splice(index, 1);
        };
        this.disposers.push(dispose);
        return dispose;
      }
    },
    proposals: {
      register: (id, apply) => {
        if (!this.plugin.operationManifest!.proposalTypes?.some(t => t.id === id) || this.proposalExecutors.has(id)) throw new Error('Undeclared/duplicate plugin proposal');
        this.proposalExecutors.set(id, apply);
        const dispose = () => {
          this.proposalExecutors.delete(id);
        };
        this.disposers.push(dispose);
        return dispose;
      }
    }
  };
  /** Enters new local work of a scope under this process's current hold, or null when the package is not enabled there. */
  async admit(scope: PluginScope) {
    const admitted = await admitPluginScopeHold(this.config, this.plugin.id, scope);
    if (!admitted) return null;
    // The lease that admitted it was lost (and renewed) since: entering would hold resources nobody tracks.
    if (!pluginScopeLeaseIs(this.config, admitted.instance)) throw new Error('Plugin scope is closing');
    return { ...this.effects.enter(this.plugin.id, scope, admitted.hold), hold: admitted.hold, instance: admitted.instance };
  }
  validate() {
    const m = this.plugin.operationManifest!;
    if ((m.jobs?.length ?? 0) !== this.jobs.size || (m.schedules?.length ?? 0) !== this.tasks.length || (m.proposalTypes?.length ?? 0) !== this.proposalExecutors.size) throw new Error('Lifecycle declarations/registrations mismatch');
  }
  /** Shutdown: nothing new is admitted; the owner's exit round drains what is still held (`lifecycle.ts`). */
  close() {
    this.effects.fence();
    for (const dispose of [...this.disposers].reverse()) dispose();
  }
}
